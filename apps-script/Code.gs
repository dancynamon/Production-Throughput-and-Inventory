/* ============================================================================
 *  Aquamentor Inventory & Production — Google Apps Script backend
 *  ----------------------------------------------------------------------------
 *  Stage-based production tracking for XRT rescue tubes.
 *
 *  WHAT IT DOES
 *    • Employees "upload their day": for each pipeline stage (Cut, Glued,
 *      Meshed, Patched, Paint 1/2, Printed, Straps Attached, Boxed) they enter
 *      how many tubes they finished. -> appended to "StageLog".
 *    • Raw materials are DEDUCTED at the stage that consumes them, per the
 *      stage-aware Bill of Materials ("BOM").
 *    • An owner OVERVIEW shows work-in-progress (WIP) at each stage and, using
 *      your throughput rates + daily targets, SUGGESTS next-day goals per stage
 *      — the feed for your manufacturing state machine.
 *
 *  Run setup() once (Extensions > Apps Script > Run) to build every tab.
 *  See README.md for click-by-click deployment.
 *
 *  ---------------------------------------------------------------------------
 *  BUILD:  2026-09-22 16:00 UTC      version 2.23.0
 *  ---------------------------------------------------------------------------
 *  Stamped on every change so you can tell at a glance which paste is sitting
 *  in the editor. Compare against the BUILD line on GitHub before wondering
 *  whether an edit landed. Also reported by whatAmIRunning() and returned to
 *  the app, which shows it in the footer.
 * ========================================================================== */

var TAB = {
  products:  'Products',
  stages:    'Stages',
  materials: 'RawMaterials',
  bom:       'BOM',
  stagelog:  'StageLog',
  receiving: 'ReceivingLog',
  employees: 'Employees',
  planning:  'Planning',
  countlog:  'CountLog',
  wipbase:   'WipBaseline',
  finished:  'FinishedGoods',
  shiplog:   'ShipLog',
  overview:  'Overview'
};

/* Opening work-in-progress.
 *
 * The chain math — waiting = completed(previous stage) − completed(this one) —
 * assumes the floor was EMPTY the day logging started. It never is. Aquamentor's
 * first week of real data shows 151 tubes getting straps when 85 had been
 * meshed and none patched: not sloppy logging, just tubes that were already
 * mid-pipeline before anyone opened the app. Left uncorrected, every WIP
 * figure is wrong, every "upstream short" flag is noise, and any lead time
 * derived from them is confidently wrong.
 *
 * The fix is a baseline, exactly as for materials. What is countable is not
 * "how many have ever passed Patched" — nobody knows that — but the PILE
 * physically sitting at each station waiting to be worked. Cumulative
 * completions are then derived by walking the line backwards from finished
 * goods:
 *
 *   completed(last)  = finished on hand
 *   completed(i)     = completed(i+1) + pile waiting at stage i+1
 *
 * Only the newest baseline per product counts, and StageLog rows are filtered
 * to those AFTER it — anything logged earlier is already embodied in the piles
 * that were counted, so including it would double-count.
 *
 * The first stage of a line is deliberately not asked for: on a variant line
 * its input is the shared blank pool, which computeOverview already derives
 * from the feeder, and on a Blank line it is raw foam, which is not tracked
 * as WIP at all.
 */
var WIPBASE_HEADERS = ['Timestamp', 'ProductID', 'ProductName', 'Stage',
                       'WaitingBefore', 'CountedBy', 'Notes'];

// Pseudo-stage marking units past the final stage — finished, not yet shipped.
var WIP_FINISHED = '(finished)';

/* Estimated vs actual.
 *
 * RawMaterials.OnHand is an ESTIMATE. It moves by recipe: a stage is logged,
 * the BOM says that stage eats 1.78 yd of webbing, 1.78 comes off. It is only
 * ever as good as the BOM, and several BOM figures are openly approximate —
 * the UV ink rate is a top-down guess and the whole 40" column is the 50"
 * column times 0.8. Add scrap, offcuts, miscounts and the odd unlogged day and
 * the estimate drifts from the shelf.
 *
 * A physical count is the ACTUAL. Recording one does three things: it writes
 * the count to CountLog with the variance against the estimate at that moment,
 * it re-baselines OnHand to the counted number, and it stamps LastCounted /
 * LastCountedAt / LastVariance on the material.
 *
 * The variance history is the point. Consistent one-directional drift on a
 * material is not shrinkage, it is a wrong BOM number, and CountLog is the
 * evidence needed to correct it. Typing a corrected number straight into
 * OnHand — which is what you would do without this — throws that away.
 */
// Hours is what turns "we did 60" into "we can do 60". Units per DAY is
// confounded by how many people worked and for how long; units per HOUR is a
// rate you can multiply by planned staffing. It also finally gives the
// Ideal/Floor rate columns something to be compared against.
var STAGELOG_HEADERS = ['Timestamp', 'WorkDate', 'Employee', 'ProductID',
                        'ProductName', 'Stage', 'Qty', 'Hours', 'Notes'];

var COUNTLOG_HEADERS = ['Timestamp', 'MaterialID', 'MaterialName', 'Unit',
                        'EstimatedAtCount', 'CountedQty', 'Variance', 'VariancePct',
                        'CountedBy', 'Notes'];

// Appended to RawMaterials by upgradeSchema() on an existing sheet.
var COUNT_COLUMNS = ['LastCounted', 'LastCountedAt', 'LastVariance'];

/* Manager PIN — unlocks the manager tabs. Employees never see it.
 *
 * It no longer lives in this file. This file is in a public repository, so
 * anything typed here is published; the real PIN sits in Script Properties,
 * which only the sheet's owner can read, and is set from the Aquamentor menu.
 * DEFAULT_PIN is what applies until that has been done once — and the app
 * says so, loudly, for as long as it is still in force. */
var DEFAULT_PIN = '2468';

function managerPin() {
  try {
    var p = PropertiesService.getScriptProperties().getProperty('MANAGER_PIN');
    if (p && String(p).trim()) return String(p).trim();
  } catch (e) { /* no properties service (tests, or a very old runtime) */ }
  return DEFAULT_PIN;
}
function pinIsDefault() { return managerPin() === DEFAULT_PIN; }

/* Per-person PINs, so a count or a reversal carries who did it.
 *
 * Stored hashed in Script Properties under PIN:<name>; the shared manager PIN
 * keeps working as a fallback so nobody is locked out the day this ships —
 * which also means the shared one is still a secret worth changing, and the
 * banner keeps saying so until it is. */
function pinHash(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'aq|' + String(pin), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = (b < 0 ? b + 256 : b).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}
function checkPin(name, pin) {
  name = String(name || '').trim(); pin = String(pin || '');
  if (!pin) return { ok: false };
  if (name) {
    var stored = null;
    try { stored = PropertiesService.getScriptProperties().getProperty('PIN:' + name); } catch (e) { stored = null; }
    if (stored) return withToken({ ok: stored === pinHash(pin), name: name, personal: true });
  }
  // No personal PIN on file for that name (or no name): the shared one.
  return withToken({ ok: pin === managerPin(), name: name || '', personal: false });
}

/* Manager token — the lock has to live HERE, not only in the phone.
 *
 * The app hides the manager tabs behind the PIN, but the web-app URL is in a
 * public repository and every action used to answer whoever called it. Now
 * an unlock returns a token, every manager action requires it, and the
 * token is derived from the credential that earned it: change the shared
 * PIN or a person's PIN and every phone unlocked with the old one is locked
 * again on its next request. Nothing secret is stored on the phone but the
 * token, and the token cannot be turned back into a PIN.
 *
 * Open to the floor without a token: what Log My Day needs (config, today,
 * submitDay), the same-day reversal of a double tap (bounded to what was
 * logged today), and auth itself. Everything else is a manager action. */
// myPace hands a person their OWN rows and nothing else — the crew's Floor
// tab. The whole floor (floorData) is a manager view. wipWalk is the floor
// count — a measurement the crew takes, so it is theirs to record.
var OPEN_ACTIONS = ['config', 'today', 'submitDay', 'reverse', 'auth', 'myPace', 'wipWalk', 'ship'];

function tokenSecret() {
  var props = PropertiesService.getScriptProperties();
  var sec = props.getProperty('TOKEN_SECRET');
  if (!sec) { sec = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', sec); }
  return sec;
}
// The hash of whatever credential this name unlocks with: their personal PIN
// if one is on file, else the shared manager PIN.
function credentialHash(name) {
  var stored = null;
  if (name) { try { stored = PropertiesService.getScriptProperties().getProperty('PIN:' + name); } catch (e) { stored = null; } }
  return stored || pinHash(managerPin());
}
function managerToken(name) {
  name = String(name || '').trim();
  return pinHash('tok|' + tokenSecret() + '|' + name + '|' + credentialHash(name));
}
function tokenIsValid(name, token) {
  if (!token) return false;
  try { return String(token) === managerToken(name); } catch (e) { return false; }
}
function withToken(r) {
  if (r.ok) { try { r.token = managerToken(r.name); } catch (e) { r.token = null; } }
  return r;
}
function setPersonPin() {
  var ui = SpreadsheetApp.getUi();
  var names = readObjects(TAB.employees).filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return String(r.Name || '').trim(); }).filter(Boolean);
  var r1 = ui.prompt('Set a person\'s PIN', 'Name, exactly as on the Employees tab:\n' + names.join(', '), ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var name = String(r1.getResponseText() || '').trim();
  if (names.indexOf(name) === -1) { ui.alert('Not set', name + ' is not an active name on the Employees tab.', ui.ButtonSet.OK); return; }
  var r2 = ui.prompt('PIN for ' + name, 'Digits only, at least 4. Leave blank to REMOVE their personal PIN.', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var pin = String(r2.getResponseText() || '').trim();
  var props = PropertiesService.getScriptProperties();
  if (!pin) { props.deleteProperty('PIN:' + name); SpreadsheetApp.getActive().toast('Personal PIN removed for ' + name, 'Aquamentor', 6); return; }
  if (!/^\d{4,}$/.test(pin)) { ui.alert('Not set', 'The PIN must be digits only and at least 4 long.', ui.ButtonSet.OK); return; }
  props.setProperty('PIN:' + name, pinHash(pin));
  SpreadsheetApp.getActive().toast('PIN set for ' + name, 'Aquamentor', 6);
}

/* Menu: Aquamentor -> Set manager PIN. Digits only, four or more, stored in
 * Script Properties. The old PIN is not asked for: whoever can open this menu
 * already owns the sheet, which is more access than the PIN protects. */
function setManagerPin() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Set manager PIN',
    'Digits only, at least 4. This replaces the PIN the app asks for.'
    + (pinIsDefault() ? '\n\nThe PIN is currently the DEFAULT, which is public.' : ''),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var pin = String(r.getResponseText() || '').trim();
  if (!/^\d{4,}$/.test(pin)) {
    ui.alert('Not set', 'The PIN must be digits only and at least 4 long.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('MANAGER_PIN', pin);
  SpreadsheetApp.getActive().toast('Manager PIN updated. Phones will need it next time they unlock.', 'Aquamentor', 8);
}

// Reported to the app and shown in its footer, so you can tell which backend a
// phone is actually talking to. Bump this when you change this file, and
// remember it only reaches the app after Deploy > Manage deployments >
// Edit > New version.
var BACKEND_VERSION = '2.23.0';

// Matches the BUILD line in the header comment above. Version numbers say what
// changed; this says WHEN this exact text was generated, which is the faster
// answer to "did my paste actually take?".
var BUILD_STAMP = '2026-09-22 16:00 UTC';

// Roster seeded on a FIRST-TIME build only. Day to day, the Employees tab in
// the sheet is the source of truth — setup() preserves whatever is in it (see
// the Employees block in setup()), so add and remove people there, not here.
var DEFAULT_EMPLOYEES = [
  ['Dan', 'YES'], ['John', 'YES'], ['Alex', 'YES'],
  ['Joe', 'YES'], ['Max', 'YES'], ['Francis', 'YES']
];

// Each product belongs to a LINE with its own ordered stages, as
// [stage, ideal/hr, floor/hr]. The two rate figures are carried for reference
// only — nothing reads them. Next-day goals come from the per-stage targets on
// the Planning tab and the WIP actually waiting, not from an hourly rate.
//
// The tube pipeline DIVERGES. A blank off the CNC is a size and nothing more —
// a 50" blank can still become either variant. The commit happens at Meshed:
// a tube that gets meshed is an Exotube, one that doesn't is a Standard. So
// the shared head (Cut, Glued) is its own line, and each variant picks up
// where the blank leaves off. The variant IS the presence of the Meshed stage;
// there is no separate variant field to keep in sync.
//
//   Blank    Cut → Glued ─┬─ TubeExo  Meshed → Patched → … → Boxed
//                         └─ TubeStd           Patched → … → Boxed
//
var LINES = {
  Blank: [ ['Cut', 30, 30], ['Glued', 30, 15] ],
  TubeExo: [
    ['Meshed', 30, 20], ['Patched', 15, 15],
    ['Paint 1', 25, 18], ['Paint 2', 25, 18], ['Printed', 45, 64],
    ['Straps Attached', 25, 20], ['Boxed', 30, 20]
  ],
  TubeStd: [
    ['Patched', 15, 15],
    ['Paint 1', 25, 18], ['Paint 2', 25, 18], ['Printed', 45, 64],
    ['Straps Attached', 25, 20], ['Boxed', 30, 20]
  ],
  Shape: [ ['CNC', 0, 0], ['Clean', 0, 0], ['Box', 0, 0] ],
  Chair: [ ['Cut', 0, 0], ['Assemble', 0, 0], ['Box', 0, 0] ],

  // Shoulder strap with 6' tow line. A SUB-ASSEMBLY: it is made at its own
  // station from webbing and hardware, then consumed whole by a tube at
  // "Straps Attached". One station, because that is what it is.
  Strap: [ ['Made', 0, 0] ],

  // DEPRECATED, and deliberately still here. This is the pre-split single tube
  // line. Removing it meant that deploying this file against a sheet that had
  // not been migrated yet left every tube product with no stages at all — the
  // app can only render stages for a line the backend defines, so the two
  // halves have to be upgraded in lockstep or the floor stops. Keeping the old
  // line means an unmigrated sheet keeps working exactly as before, and the
  // migration becomes something you do when you're ready rather than something
  // you must do within the same minute.
  //
  // Nothing seeds it. migrateToVariantLines() replaces Tube products with the
  // Blank/TubeExo/TubeStd set, after which this is unused and can be deleted.
  Tube: [
    ['Cut', 30, 30], ['Glued', 30, 15], ['Meshed', 30, 20], ['Patched', 15, 15],
    ['Paint 1', 25, 18], ['Paint 2', 25, 18], ['Printed', 45, 64],
    ['Straps Attached', 25, 20], ['Boxed', 30, 20]
  ]
};
function stagesForLine(line) {
  return (LINES[line] || LINES.Blank).map(function (s) { return s[0]; });
}
function stageNames() { return stagesForLine('Blank'); }
// ProductID -> line (defaults to Blank if the Line column is empty).
function productLineMap() {
  var m = {};
  readObjects(TAB.products).forEach(function (r) { m[r.ProductID] = r.Line || 'Blank'; });
  return m;
}
// ProductID -> the blank it draws from ('' for products that start their own
// pipeline). Variants sharing a feeder compete for the same pool of blanks.
function productFeedMap() {
  var m = {};
  readObjects(TAB.products).forEach(function (r) {
    m[r.ProductID] = String(r.FeedsFrom == null ? '' : r.FeedsFrom).trim();
  });
  return m;
}

/* ============================================================================
 *  Seed data — shared by setup() and migrateToVariantLines()
 * ========================================================================== */

// One entry per tube size. Everything that differs between a 50" and a 40"
// lives here; everything that differs between Exo and Standard is the Meshed
// stage alone. Per-end consumables (patch, CA, accelerant) and the hardware /
// box counts do not scale with length, so they are not in this table.
var TUBE_SIZES = [
  { blank: 'BLANK50', exo: 'XRT50EXO', std: 'XRT50STD', label: '50"',
    foam: 0.1333, adhesive: 0.1522, mesh: 0.004,  paint: 0.0769,
    web1red: 1.78,  web1blk: 2.44,  web2blk: 1.58 },
  // 40" is length-scaled ×0.8 on foam / adhesive / paint / webbing.
  // Mesh is ~310 tubes per box rather than ~250.
  { blank: 'BLANK40', exo: 'XRT40EXO', std: 'XRT40STD', label: '40"',
    foam: 0.1067, adhesive: 0.1218, mesh: 0.0032, paint: 0.0615,
    web1red: 1.424, web1blk: 1.952, web2blk: 1.264 }
];

// OutputMaterial: finishing this product's LAST stage ADDS to that material's
// on-hand. It is what makes a sub-assembly work — the strap line produces
// stock, the tube line consumes it. FeedsFrom's mirror image.
/* The shoulder strap is ONE part. It is identical on a 50" and a 40" — a 6'
 * tow line is 6' either way — and every tube consumes exactly one.
 *
 * Its recipe uses the 50" webbing quantities deliberately. The old BOM carried
 * different webbing per size, but the 40" column was never measured: the file
 * documented it as the 50" column x0.8, applied across foam, adhesive, paint
 * AND webbing alike. Since the strap does not actually vary by size, the 50"
 * figures are the measured ones and the 40" figures were an artefact of that
 * blanket scaling. Collapsing to the 50" numbers is therefore a correction,
 * not a compromise — though it does mean a 40" tube now draws the true webbing
 * amount rather than 80% of it, so expect those three items to deplete faster
 * than the old estimate suggested.
 *
 * If a real per-strap measurement says otherwise, this is the one place to
 * change it. */
var STRAP_PRODUCT  = 'STRAP6';
var STRAP_MATERIAL = 'M044';
var STRAP_RECIPE = [
  ['M014', 1.78],   // 1" red webbing, yd
  ['M015', 2.44],   // 1" black webbing, yd
  ['M019', 1.58],   // 2" black webbing, yd
  ['M023', 1],      // 1" D-ring
  ['M024', 1]       // 2" tri-glide
];

/* Family is presentation only. Line already says how a product is built and
 * FeedsFrom says what it draws from — those carry the real relationships and
 * nothing here should depend on Family. It exists so a picker with 22 entries
 * reads as five short lists instead of one long one. Unknown or blank falls
 * into "Other" rather than disappearing. */
var FAMILY_ORDER = ['Rescue Tubes', 'Foam Mats', 'Kickboards',
                    'Lifeguard Chairs', 'Other'];

var PRODUCT_HEADERS = ['ProductID', 'ProductName', 'Line', 'Unit', 'Active',
                       'FeedsFrom', 'OutputMaterial', 'Family'];

var PRODUCT_ROWS = (function () {
  var rows = [];
  TUBE_SIZES.forEach(function (s) {
    rows.push([s.blank, s.label + ' Blank (uncommitted)',   'Blank',   'each', 'YES', '', '', 'Rescue Tubes']);
    rows.push([s.exo,   'XRT-' + s.label.replace('"', '') + ' Exotube (meshed)',
                                                            'TubeExo', 'each', 'YES', s.blank, '', 'Rescue Tubes']);
    rows.push([s.std,   'XRT-' + s.label.replace('"', '') + ' Standard (unmeshed)',
                                                            'TubeStd', 'each', 'YES', s.blank, '', 'Rescue Tubes']);
  });
  // One strap for every tube size.
  rows.push([STRAP_PRODUCT, 'Shoulder Strap w/ 6\' Tow Line',
             'Strap', 'each', 'YES', '', STRAP_MATERIAL, 'Rescue Tubes']);
  return rows.concat([
    // Foam-mat shapes (size buckets) — CNC → Clean → Box, foam by area
    ['SHP16',   'Shape 16x16',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    ['SHP24',   'Shape 24x24',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    ['SHP36',   'Shape 36x36',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    ['SHP4824', 'Shape 48x24',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    ['SHP48',   'Shape 48x48',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    ['SHP7236', 'Shape 72x36',        'Shape', 'each', 'YES', '', '', 'Foam Mats'],
    // Kickboards
    ['KB914',   'Kickboard 9x14',     'Shape', 'each', 'YES', '', '', 'Kickboards'],
    ['KB1116',  'Kickboard 11x16.5',  'Shape', 'each', 'YES', '', '', 'Kickboards'],
    ['KB1220',  'Kickboard 11.8x20',  'Shape', 'each', 'YES', '', '', 'Kickboards'],
    // Lifeguard chairs — Cut → Assemble → Box; lumber + hardware
    ['LGC30',   'Lifeguard Chair 30"','Chair', 'each', 'YES', '', '', 'Lifeguard Chairs'],
    ['LGC40',   'Lifeguard Chair 40"','Chair', 'each', 'YES', '', '', 'Lifeguard Chairs'],
    ['LGC50',   'Lifeguard Chair 50"','Chair', 'each', 'YES', '', '', 'Lifeguard Chairs'],
    ['LGC60',   'Lifeguard Chair 60"','Chair', 'each', 'YES', '', '', 'Lifeguard Chairs'],
    ['LGC72',   'Lifeguard Chair 72"','Chair', 'each', 'YES', '', '', 'Lifeguard Chairs']
  ]);
})();

/* Tube BOM rows. Cut and Glued belong to the blank; everything from Patched on
 * is identical for both variants, so it is generated once per variant rather
 * than transcribed twice — that is the only way the two stay in step when a
 * quantity is corrected. The Meshed row exists for Exotubes only, which is
 * exactly why a Standard never deducts mesh. */
function tubeBomRows() {
  var rows = [];
  TUBE_SIZES.forEach(function (s) {
    rows.push([s.blank, 'Cut',   'M034', s.foam]);
    rows.push([s.blank, 'Glued', 'M035', s.adhesive]);


    [s.exo, s.std].forEach(function (pid) {
      if (pid === s.exo) rows.push([pid, 'Meshed', 'M002', s.mesh]);  // boxes
      rows.push(
        [pid, 'Patched',         'M003', 0.000103],   // rolls (2 patches/tube)
        [pid, 'Patched',         'M004', 0.012571],   // CA glue lb (44lb/3500)
        [pid, 'Patched',         'M005', 0.001429],   // accelerant gal (5gal/3500)
        [pid, 'Paint 1',         'M036', s.paint],
        [pid, 'Paint 2',         'M036', s.paint],
        [pid, 'Printed',         'M037', 0.007],      // ink — ESTIMATE
        // One finished strap, not raw webbing. The webbing and hardware now
        // come off stock at the Strap station instead.
        [pid, 'Straps Attached', STRAP_MATERIAL, 1],
        [pid, 'Boxed',           'M031', 0.002],
        [pid, 'Boxed',           'M033', 0.0833]
      );
    });
  });

  // The strap is size-independent, so its recipe is emitted once rather than
  // per size.
  STRAP_RECIPE.forEach(function (r) {
    rows.push([STRAP_PRODUCT, 'Made', r[0], r[1]]);
  });
  return rows;
}

var BOM_HEADERS = ['ProductID', 'Stage', 'MaterialID', 'QtyPerUnit'];

// Shapes, kickboards and chairs don't branch, so their recipes are flat.
var NON_TUBE_BOM_ROWS = [
  // ---- Shapes & kickboards: 4# foam by area (sq ft) at CNC ----
  ['SHP16',   'CNC', 'M038', 1.78],   // 16x16 = 256 in²
  ['SHP24',   'CNC', 'M038', 4.0],    // 24x24 = 576
  ['SHP36',   'CNC', 'M038', 9.0],    // 36x36 = 1296
  ['SHP4824', 'CNC', 'M038', 8.0],    // 48x24 = 1152
  ['SHP48',   'CNC', 'M038', 16.0],   // 48x48 = 2304
  ['SHP7236', 'CNC', 'M038', 18.0],   // 72x36 = 2592
  ['KB914',   'CNC', 'M038', 0.88],   // 9x14   = 126
  ['KB1116',  'CNC', 'M038', 1.26],   // 11x16.5= 181.5
  ['KB1220',  'CNC', 'M038', 1.64],   // 11.8x20= 236

  // ---- Lifeguard chairs: lumber (boards) at Cut, hardware kit at Assemble ----
  ['LGC30', 'Cut', 'M039', 3.25],  ['LGC30', 'Cut', 'M040', 1.5],   ['LGC30', 'Cut', 'M041', 2.5],  ['LGC30', 'Cut', 'M042', 0.25], ['LGC30', 'Assemble', 'M043', 1],
  ['LGC40', 'Cut', 'M039', 5.25],  ['LGC40', 'Cut', 'M040', 3.75],  ['LGC40', 'Cut', 'M041', 2.875],['LGC40', 'Cut', 'M042', 0.25], ['LGC40', 'Assemble', 'M043', 1],
  ['LGC50', 'Cut', 'M039', 5.25],  ['LGC50', 'Cut', 'M040', 3.0],   ['LGC50', 'Cut', 'M041', 6.0],  ['LGC50', 'Cut', 'M042', 0.25], ['LGC50', 'Assemble', 'M043', 1],
  ['LGC60', 'Cut', 'M039', 5.25],  ['LGC60', 'Cut', 'M040', 3.0],   ['LGC60', 'Cut', 'M041', 11.0], ['LGC60', 'Cut', 'M042', 0.25], ['LGC60', 'Assemble', 'M043', 1],
  ['LGC72', 'Cut', 'M039', 5.25],  ['LGC72', 'Cut', 'M040', 3.0],   ['LGC72', 'Cut', 'M041', 11.0], ['LGC72', 'Cut', 'M042', 0.25], ['LGC72', 'Assemble', 'M043', 1]
];

var STAGES_HEADERS = ['Line', 'Order', 'Stage', 'IdealRate_perHr', 'FloorRate_perHr'];

function stagesTabRows() {
  var rows = [];
  Object.keys(LINES).forEach(function (line) {
    LINES[line].forEach(function (s, i) { rows.push([line, i + 1, s[0], s[1], s[2]]); });
  });
  return rows;
}

var PLANNING_HEADERS = ['ProductID', 'ProductName', 'Stage', 'DailyTarget'];

/* One row per (product, stage) — targets are set per stage, since Cut and
 * Paint do not run at the same rate. Seeded so the numbers are at least
 * self-consistent: a size's blank target equals the sum of its two variants.
 * These are placeholders; tune them on the Planning tab. */
function planningRows() {
  var seedTarget = {};
  TUBE_SIZES.forEach(function (s) {
    var perSize = s.blank === 'BLANK50' ? 60 : 40;
    seedTarget[s.blank] = perSize;
    seedTarget[s.exo]   = Math.round(perSize / 2);
    seedTarget[s.std]   = perSize - Math.round(perSize / 2);
  });

  var rows = [];
  readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .forEach(function (r) {
      stagesForLine(r.Line || 'Blank').forEach(function (stage) {
        rows.push([r.ProductID, r.ProductName, stage, seedTarget[r.ProductID] || 0]);
      });
    });
  return rows;
}

/* ============================================================================
 *  1. SETUP
 * ========================================================================== */
/* The material catalogue the code knows about.
 *
 * Lifted out of setup() so the upgrade path can reach it too: setup() only
 * ever seeds a MISSING tab, so a material added to this list after the sheet
 * was built would otherwise never appear — which is exactly how M044 (the
 * strap) ended up referenced by the BOM with no row to deduct from.
 * addMissingReferencedMaterials() closes that gap. */
var MATERIAL_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint', 'Status', 'Category', 'Notes'];

var MATERIAL_ROWS = [
    ['M001', 'Glue Pods',                'Boxes',         5,    1,    '', 'Glue & Mesh',      ''],
    ['M002', 'Nylon Mesh',               'Boxes',         12,   2,    '', 'Glue & Mesh',      '~250 tubes per box (XRT-50)'],
    ['M003', 'Patch Material',           'Rolls',         0.5,  0.25, '', 'End Patches',      '54"x60yd roll ≈ 9,720 tubes (2x 2"x3" patches/tube)'],
    ['M004', 'Cyanoacrylate (CA glue)',  'lbs',           78,   10,   '', 'End Patches',      '44 lb ≈ 3,500 tubes'],
    ['M005', 'Accelerant',               'Gallons',       8,    2,    '', 'End Patches',      '5 gal ≈ 3,500 tubes'],
    ['M006', 'Raycryl B43293',           '50 Gal Drums',  16,   5,    '', 'Ink & Coating',    ''],
    ['M007', 'Tego',                     '',              '',   '',   '', 'Ink & Coating',    'Marked "Exp." — check if expired'],
    ['M008', 'Siltech C4405',            '',              '',   '',   '', 'Ink & Coating',    'Marked "Full" — needs a count'],
    ['M009', 'Chromatint 3208 PR170',    '50 Gal Drums',  1,    0.25, '', 'Ink & Coating',    ''],
    ['M010', 'Ammonia',                  'Litres',        2,    0,    '', 'Ink & Coating',    ''],
    ['M011', 'Eversorb AQ1',             '',              '',   '',   '', 'Ink & Coating',    'Needs a count'],
    ['M012', 'Acrysol SCT275',           '',              '',   '',   '', 'Ink & Coating',    'Needs a count'],
    ['M013', 'Yellow Paint',             '50 Gal Drum',   1,    0,    '', 'Ink & Coating',    ''],
    ['M014', '1" Red PP Webbing',        'Yards',         96,   1000, '', 'Webbing & Thread', ''],
    ['M015', '1" Black PP Webbing',      'Yards',         109,  1000, '', 'Webbing & Thread', ''],
    ['M016', '1" Yellow PP Webbing',     'Yards',         9,    100,  '', 'Webbing & Thread', ''],
    ['M017', '1-1/2" Black PP Webbing',  'Yards',         4,    100,  '', 'Webbing & Thread', ''],
    ['M018', '1-1/2" Buckles (M&F)',     'Each',          '',   50,   '', 'Webbing & Thread', 'Needs a count'],
    ['M019', '2" Black PP Webbing',      'Yards',         50,   1000, '', 'Webbing & Thread', ''],
    ['M020', '2" Red PP Webbing',        'Yards',         5,    200,  '', 'Webbing & Thread', ''],
    ['M021', '2" Blue PP Webbing',       'Yards',         3,    200,  '', 'Webbing & Thread', ''],
    ['M022', 'Tek-70 Black Thread',      'Spools',        1,    1000, '', 'Webbing & Thread', 'Reorder point looks high — confirm'],
    ['M023', '1" D-Rings',               'Each',          3500, 100,  '', 'Webbing & Thread', ''],
    ['M024', '2" Tri-Glides',            'Each',          4000, 100,  '', 'Webbing & Thread', ''],
    ['M025', '1" Male Buckles',          'Each',          '',   100,  '', 'Webbing & Thread', 'Needs a count'],
    ['M026', '1" Female Buckles',        'Each',          '',   100,  '', 'Webbing & Thread', 'Needs a count'],
    ['M027', '2" Male Buckles',          'Each',          '',   100,  '', 'Webbing & Thread', 'Needs a count'],
    ['M028', '2" Female Buckles',        'Each',          '',   100,  '', 'Webbing & Thread', 'Needs a count'],
    ['M029', 'Brass Buckle',             'Each',          80,   40,   '', 'Webbing & Thread', ''],
    ['M030', 'Brass O-Ring',             'Each',          200,  50,   '', 'Webbing & Thread', ''],
    ['M031', 'PolyBags (50")',           'Box (500/box)', 4,    2,    '', 'Packaging',        ''],
    ['M032', 'Rubber Bands',             'Boxes',         3,    0,    '', 'Packaging',        ''],
    ['M033', 'Rescue Tube Custom Boxes', 'Boxes',         '',   0,    '', 'Packaging',        'Marked "on way" — awaiting delivery'],
    ['M034', 'EVA Foam (2# black)',      'sheet',         '',   10,   '', 'Foam',             'From COGS (7.5 tubes/sheet) — needs count'],
    ['M035', 'Foam Fast 74 Adhesive',    'lb',            '',   30,   '', 'Glue & Mesh',      'From COGS — needs count'],
    ['M036', 'WB Urethane Paint (Red)',  'gal',           '',   10,   '', 'Ink & Coating',    'From COGS (Flexabar WB2571) — needs count'],
    ['M037', 'UV White Ink (print)',     'unit',          '',   1,    '', 'Ink & Coating',    'ESTIMATE 0.007 unit/tube (COGS top-down) — send real ink-per-batch to refine'],
    // ---- Shapes & kickboards ----
    ['M038', '4# 1.5" Foam',             'sq ft',         '',   200,  '', 'Foam',             'Shapes/kickboards deduct by area. Receive a sheet as its sq ft. Confirm kickboard foam.'],
    // ---- Lifeguard chair lumber (8-ft boards) ----
    ['M039', 'Lumber 1x4 (.75x3.5x96)',  'boards',        '',   50,   '', 'Chair Lumber',     'Count needed'],
    ['M040', 'Lumber 1.25x4 (1.125x3.5)','boards',        '',   40,   '', 'Chair Lumber',     'Count needed'],
    ['M041', 'Lumber 2x4 (1.5x3.5x96)',  'boards',        '',   60,   '', 'Chair Lumber',     'Count needed'],
    ['M042', 'Lumber 1x6 (.75x5.5x97)',  'boards',        '',   20,   '', 'Chair Lumber',     'Count needed'],
    // ---- Lifeguard chair hardware ----
    ['M043', 'Chair Hardware Kit',       'kits',          '',   20,   '', 'Chair Hardware',   '1 kit per chair (bolts/nuts/washers/screws). Itemize later if wanted.'],
    // Sub-assemblies. Produced by the Strap line (Products.OutputMaterial),
    // consumed by the tube lines at "Straps Attached".
    ['M044', 'Shoulder Strap w/ 6\' Tow Line', 'each', '', 50, '', 'Sub-assembly', 'Made at the Strap station; 1 per tube, any size'],
];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var kept = [], created = [];

  // A tab that already exists is LEFT ALONE — never cleared, never reseeded.
  // The sheet is the source of truth for everything maintained outside the app:
  // on-hand counts, the roster, daily targets, BOM tweaks, and both logs. Only
  // genuinely missing tabs get created and seeded with the defaults below, so
  // this is safe to re-run. Overview is the one exception — it is derived, not
  // entered, so rebuildOverview() redraws it from StageLog + Planning.
  // For a true factory reset, use resetAllTabs() (Aquamentor menu), which asks
  // for confirmation first.
  function seed(tabName, headers, rows) {
    if (ss.getSheetByName(tabName)) { kept.push(tabName); return; }
    writeTab(ss, tabName, headers, rows);
    created.push(tabName);
  }

  // ---- Products (Line groups them into a process: Tube / Shape / Chair) -----
  seed(TAB.products, PRODUCT_HEADERS, PRODUCT_ROWS);

  // ---- Stages (per line, in order, with rates) -----------------------------
  seed(TAB.stages, STAGES_HEADERS, stagesTabRows());

  // ---- RawMaterials --------------------------------------------------------
  // M001–M033 from your "Raw Material Inventory" sheet (3/1/2023 counts; blank
  // = not yet counted). M034–M037 come from the COGS build (foam, adhesive,
  // paint, ink) — they aren't on the count sheet yet, so count/receive them.
  seed(TAB.materials, MATERIAL_HEADERS, MATERIAL_ROWS);
  setColumnFormula(ss, TAB.materials, 6 /*F*/,
    '=IF(D{r}="","",IF(D{r}<=E{r},"⚠ REORDER","OK"))');

  // ---- BOM: stage-aware recipe. (ProductID, Stage, MaterialID, QtyPerUnit) --
  // Seeded from the COGS "COGS Model" tab plus Dan's conversions (6/2026):
  //   mesh 0.004 box/tube (~250 tubes/box); patch 0.000103 roll/tube (54"x60yd roll, 2x 2"x3"
  //   patches); CA glue 0.012571 lb/tube and accelerant 0.001429 gal/tube
  //   (44 lb + 5 gal ≈ 3,500 tubes); ink 0.007 unit/tube (ESTIMATE, refine).
  // XRT-40 = XRT-50 ×0.8 for length-based materials; patch/CA/accelerant are
  // per-end so identical to 50"; hardware/box identical.
  seed(TAB.bom, BOM_HEADERS, tubeBomRows().concat(NON_TUBE_BOM_ROWS));

  // ---- StageLog: filled by the phone app (start with headers) --------------
  seed(TAB.stagelog, STAGELOG_HEADERS, []);

  // ---- ReceivingLog --------------------------------------------------------
  seed(TAB.receiving,
    ['Timestamp', 'Employee', 'MaterialID', 'MaterialName', 'QtyAdded', 'Notes'],
    []);

  // ---- CountLog: physical stocktakes, appended by submitCount() ------------
  seed(TAB.countlog, COUNTLOG_HEADERS, []);

  // ---- WipBaseline: opening work-in-progress, appended by submitWipBaseline
  seed(TAB.wipbase, WIPBASE_HEADERS, []);

  // ---- Employees -----------------------------------------------------------
  seed(TAB.employees, ['Name', 'Active'], DEFAULT_EMPLOYEES);

  // ---- Planning: daily build target per (product, STAGE) -------------------
  seed(TAB.planning, PLANNING_HEADERS, planningRows());

  rebuildOverview();

  var msg = created.length
    ? 'Created: ' + created.join(', ') + '.'
    : 'Nothing to create — every tab already existed.';
  if (kept.length) msg += ' Left untouched: ' + kept.join(', ') + '.';
  SpreadsheetApp.getActive().toast(msg, 'Aquamentor', 8);
}

/* Factory reset. Deletes the data tabs outright and lets setup() reseed them
 * from the built-in defaults. This is the ONLY path that destroys data entered
 * in the sheet, and it asks first. Nothing calls it automatically. */
function resetAllTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert(
    'Erase and rebuild ALL tabs?',
    'This DELETES everything in Products, Stages, RawMaterials, BOM, StageLog, '
      + 'ReceivingLog, Employees and Planning — including your on-hand counts, '
      + 'your roster, and all production and receiving history — and replaces '
      + 'them with the built-in defaults.\n\n'
      + 'This cannot be undone. Make a copy of this spreadsheet first '
      + '(File → Make a copy) if you are not certain.\n\nContinue?',
    ui.ButtonSet.YES_NO);

  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActive().toast('Cancelled — nothing was changed.', 'Aquamentor', 5);
    return;
  }

  [TAB.products, TAB.stages, TAB.materials, TAB.bom,
   TAB.stagelog, TAB.receiving, TAB.employees, TAB.planning,
   TAB.countlog, TAB.wipbase].forEach(function (t) {
    var sh = ss.getSheetByName(t);
    if (sh) ss.deleteSheet(sh);
  });
  setup();
}

/* Print exactly what this script and this spreadsheet currently are.
 *
 * When the app misbehaves the question is almost always "which half is stale?"
 * — the saved script, the deployed version, or the sheet. Run this from the
 * editor (▶ Run) and read the Execution log; it answers all three at once and
 * needs no deployment, no UI and no arguments. Paste the output when asking
 * for help with a mismatch. */
function whatAmIRunning() {
  var out = [];
  function say(k, v) { out.push(String(k) + ': ' + String(v)); }

  say('Backend version', typeof BACKEND_VERSION === 'undefined'
    ? '(undefined — this editor has pre-1.1.0 code)' : BACKEND_VERSION);
  say('Build stamp', typeof BUILD_STAMP === 'undefined'
    ? '(undefined — this editor has pre-2.4.1 code)' : BUILD_STAMP);
  try {
    var au = PropertiesService.getScriptProperties().getProperty('LAST_AUTO_UPDATE');
    var trig = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoUpdateFromGitHub'; });
    say('Auto-update', (trig ? 'ON (every 30 min)' : 'off') + (au ? ' · last: ' + au : ' · never run'));
  } catch (e3) { say('Auto-update', '(unreadable)'); }
  try {
    var seen = PropertiesService.getScriptProperties().getProperty('schemaStamp');
    say('Schema applied for', seen === BUILD_STAMP ? seen + '  (current)'
        : (seen || '(never)') + '  — will self-apply on the next app request');
  } catch (e2) { say('Schema applied for', '(unreadable)'); }
  say('Lines defined in code', typeof LINES === 'undefined'
    ? '(undefined)' : Object.keys(LINES).join(', '));
  say('Manager PIN', pinIsDefault() ? 'DEFAULT (public) — set it from the Aquamentor menu' : 'set (custom)');
  say('migrateToVariantLines', typeof migrateToVariantLines === 'function' ? 'present' : 'MISSING');
  say('resetAllTabs', typeof resetAllTabs === 'function' ? 'present' : 'MISSING');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  say('Spreadsheet', ss.getName() + '  (' + ss.getId() + ')');
  say('Tabs', ss.getSheets().map(function (s) { return s.getName(); }).join(', '));

  [TAB.products, TAB.planning].forEach(function (tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) { say(tab + ' headers', '(tab missing)'); return; }
    say(tab + ' headers', sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].join(' | '));
  });

  // The actual failure mode: a product pointing at a line the code doesn't have.
  var known = typeof LINES === 'undefined' ? {} : LINES;
  var orphans = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .filter(function (r) { return !known[r.Line || '']; })
    .map(function (r) { return r.ProductID + ' -> "' + (r.Line || '(blank)') + '"'; });
  say('Products whose Line the code does NOT define',
    orphans.length ? orphans.join(', ') : 'none — every active product resolves');

  say('StageLog rows', readObjects(TAB.stagelog).length);

  var text = out.join('\n');
  Logger.log('\n' + text);
  try { SpreadsheetApp.getUi().alert('Aquamentor — current state', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* no UI context (e.g. run headless) — the log still has it */ }
  return text;
}

/* Append any material the recipes reference but RawMaterials does not have.
 *
 * A missing row is not a loud failure. submitDay() looks each material up by
 * ID and simply skips it when there is no row, so the deduction quietly does
 * not happen. M044 is the case in point: the strap line consumed webbing and
 * produced nothing, and every tube that had straps attached deducted a strap
 * that did not exist — for weeks, with no error anywhere. setup() cannot fix
 * it either, since it only ever seeds a tab that is MISSING.
 *
 * Only REFERENCED materials are added, never the whole catalogue. A material
 * the BOM or a product's OutputMaterial points at provably has to exist; one
 * nobody references may have been deleted deliberately, and re-adding it would
 * be overruling a decision rather than repairing a gap.
 *
 * OnHand is left BLANK, not 0. The quantity is genuinely unknown — blank reads
 * as "never counted" everywhere in the app, where 0 would read as "counted,
 * and there are none", which is a different and much more confident claim. */
function addMissingReferencedMaterials() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB.materials);
  if (!sh) return [];

  var have = {};
  readObjects(TAB.materials).forEach(function (m) {
    var id = String(m.MaterialID || '').trim();
    if (id) have[id] = true;
  });

  var wanted = {};
  readObjects(TAB.bom).forEach(function (r) {
    var id = String(r.MaterialID || '').trim();
    if (id) wanted[id] = true;
  });
  readObjects(TAB.products).forEach(function (p) {
    var id = String(p.OutputMaterial || '').trim();
    if (id) wanted[id] = true;
  });

  var seedById = {};
  MATERIAL_ROWS.forEach(function (r) { seedById[r[0]] = r; });

  var added = [];
  Object.keys(wanted).forEach(function (id) {
    if (have[id]) return;
    var seed = seedById[id];
    appendByHeader(sh, seed
      ? { MaterialID: seed[0], MaterialName: seed[1], Unit: seed[2], OnHand: '',
          ReorderPoint: seed[4], Status: '', Category: seed[6], Notes: seed[7] }
      : { MaterialID: id, MaterialName: id, Unit: '', OnHand: '',
          ReorderPoint: '', Status: '', Category: 'Uncategorised',
          Notes: 'Added automatically — a recipe references this material.' });
    added.push(id);
  });

  // The Status cell is a formula per row, so a freshly appended row has none.
  if (added.length) {
    setColumnFormula(ss, TAB.materials, 6 /*F*/,
      '=IF(D{r}="","",IF(D{r}<=E{r},"\u26a0 REORDER","OK"))');
  }
  return added;
}

/* Fill in a BLANK Family cell from the catalogue, so products group.
 *
 * addColumns() can append the Family column but has no way to know what
 * belongs in it, so a sheet that was upgraded rather than rebuilt ends up with
 * the header and a column of empty cells — and getConfig() reads a blank
 * Family as "Other", which silently collapses every group into one. That is
 * indistinguishable from the grouping feature simply not working.
 *
 * Only blank cells are written. A family someone re-typed by hand is theirs. */
function backfillProductFamilies() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB.products);
  if (!sh) return 0;

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return 0;
  var headers = values[0];
  var idCol = headers.indexOf('ProductID'), famCol = headers.indexOf('Family');
  if (idCol === -1 || famCol === -1) return 0;

  var famById = {};
  PRODUCT_ROWS.forEach(function (r) { famById[r[0]] = r[PRODUCT_HEADERS.indexOf('Family')]; });

  var filled = 0;
  for (var i = 1; i < values.length; i++) {
    var id = String(values[i][idCol] || '').trim();
    if (!id || String(values[i][famCol] || '').trim() !== '') continue;
    if (!famById[id]) continue;
    sh.getRange(i + 1, famCol + 1).setValue(famById[id]);
    filled++;
  }
  return filled;
}

/* Bring an older sheet up to the current schema.
 *
 * Deliberately additive: it only ever APPENDS missing columns and creates
 * missing tabs, and touches no existing cell. On-hand numbers, reorder points,
 * categories, notes and every logged row are left exactly as they are — so
 * unlike the other migrations this needs no confirmation and is safe to run
 * as many times as you like. Run it after any update that mentions a new
 * column; if there is nothing to do it says so. */
function upgradeSchema() {
  var did = applySchemaUpgrades();
  SpreadsheetApp.getActive().toast(
    did.length ? did.join('; ') + '. No existing values were changed.'
               : 'Already up to date — nothing to do.',
    'Aquamentor', 8);
}

/* The upgrade itself, with no UI, so it can also run unattended from doGet.
 * Every operation is additive and idempotent — a missing column is appended,
 * a missing tab created, and anything already present is left alone — so
 * running it twice, or concurrently, changes nothing. */
function applySchemaUpgrades() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var did = [];

  /* Append any missing headers to an existing tab without touching a single
   * existing cell. Rows written through appendByHeader() then start filling
   * the new columns; older rows keep blanks, which read as "not recorded"
   * rather than as zero. */
  function addColumns(tabName, wanted) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) return;
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wanted.filter(function (h) { return headers.indexOf(h) === -1; });
    if (!missing.length) return;
    var all = headers.concat(missing);
    sh.getRange(1, 1, 1, all.length).setValues([all])
      .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#ffffff');
    did.push('added ' + missing.join(', ') + ' to ' + tabName);
  }

  addColumns(TAB.products, ['OutputMaterial', 'Family']);
  addColumns(TAB.materials, COUNT_COLUMNS);
  addColumns(TAB.materials, ['Supplier']);   // who to raise the PO on — Buy groups by it
  addColumns(TAB.materials, ['LeadDays']);   // supplier lead time, so Buy can say order-by
  addColumns(TAB.stagelog, ['Hours']);

  var addedMaterials = addMissingReferencedMaterials();
  if (addedMaterials.length) {
    did.push('added missing material row(s) ' + addedMaterials.join(', ') + ' to RawMaterials');
  }

  var familiesFilled = backfillProductFamilies();
  if (familiesFilled) did.push('filled ' + familiesFilled + ' blank Family cell(s)');

  if (!ss.getSheetByName(TAB.countlog)) {
    writeTab(ss, TAB.countlog, COUNTLOG_HEADERS, []);
    did.push('created CountLog');
  }

  if (!ss.getSheetByName(TAB.wipbase)) {
    writeTab(ss, TAB.wipbase, WIPBASE_HEADERS, []);
    did.push('created WipBaseline');
  }
  if (!ss.getSheetByName(TAB.finished)) { finishedSheet(ss); did.push('created FinishedGoods'); }
  else { addColumns(TAB.finished, FINISHED_HEADERS); finishedSheet(ss); }
  if (!ss.getSheetByName(TAB.shiplog)) { writeTab(ss, TAB.shiplog, SHIPLOG_HEADERS, []); did.push('created ShipLog'); }

  SpreadsheetApp.getActive().toast(
    did.length ? did.join('; ') + '. No existing values were changed.'
               : 'Already up to date — nothing to do.',
    'Aquamentor', 8);
}


/* One-time migration from the old single "Tube" line to Blank → Exo/Standard.
 * setup() deliberately never overwrites an existing tab, so a sheet built
 * before the split will not pick the new layout up on its own — this is the
 * explicit path. It rewrites only the four structural tabs and leaves
 * RawMaterials, Employees, StageLog and ReceivingLog alone. */
function migrateToVariantLines() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var logged = readObjects(TAB.stagelog).length;
  var historyNote = logged
    ? '\n\nWARNING: StageLog holds ' + logged + ' row(s) recorded against the OLD '
      + 'product IDs (XRT50 / XRT40). Those rows are NOT rewritten, so they will '
      + 'no longer match any product and will drop out of the Overview. Export '
      + 'StageLog first if you need that history.'
    : '\n\nStageLog is empty, so no production history is affected.';

  var answer = ui.alert(
    'Migrate to Blank → Exotube / Standard?',
    'Products, Stages, BOM and Planning will be REPLACED with the variant-aware '
      + 'layout:\n\n'
      + '   BLANK50 / BLANK40      Cut → Glued\n'
      + '   XRT50EXO / XRT40EXO    Meshed → Patched → … → Boxed\n'
      + '   XRT50STD / XRT40STD    Patched → … → Boxed\n'
      + '   STRAP6                 Made  (sub-assembly, 1 per tube)\n\n'
      + 'Planning also changes shape: one row per product AND STAGE, so targets '
      + 'are set per stage.\n\n'
      + 'RawMaterials (your on-hand counts), Employees, StageLog and ReceivingLog '
      + 'are left untouched.'
      + historyNote
      + '\n\nContinue?',
    ui.ButtonSet.YES_NO);

  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActive().toast('Cancelled — nothing was changed.', 'Aquamentor', 5);
    return;
  }

  // Products first: planningRows() reads it back to know each product's stages.
  writeTab(ss, TAB.products, PRODUCT_HEADERS, PRODUCT_ROWS);
  writeTab(ss, TAB.stages,   STAGES_HEADERS,  stagesTabRows());
  writeTab(ss, TAB.bom,      BOM_HEADERS,     tubeBomRows().concat(NON_TUBE_BOM_ROWS));
  writeTab(ss, TAB.planning, PLANNING_HEADERS, planningRows());

  rebuildOverview();
  SpreadsheetApp.getActive().toast(
    'Migrated to Blank → Exo/Standard. Counts, roster and logs untouched.',
    'Aquamentor', 8);
}

/* ============================================================================
 *  2. API (JSONP)
 *    ?action=config
 *    ?action=stock
 *    ?action=overview
 *    ?action=receive&employee&materialId&qty&notes
 *    ?action=submitDay&workDate&employee&productId&counts={"Cut":40,...}&notes
 * ========================================================================== */
/* Apply pending schema upgrades once per deployed build.
 *
 * "Paste, Save, run upgradeSchema, Deploy" is four steps and the middle one is
 * the easiest to forget — and forgetting it makes the app fail in a way that
 * looks like a code bug rather than a missing column. The upgrade is additive
 * and idempotent, so there is no reason a person has to trigger it.
 *
 * Guarded on BUILD_STAMP in script properties, so it runs on the first request
 * after a deploy and is a single property read on every request after that.
 * Wrapped so a failure here can never take down a request that would otherwise
 * have worked — a missing column degrades one feature, an exception loses the
 * whole call. */
function ensureSchemaCurrent() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('schemaStamp') === BUILD_STAMP) return;
    applySchemaUpgrades();
    props.setProperty('schemaStamp', BUILD_STAMP);
  } catch (err) {
    // Deliberately swallowed. Surfaced via whatAmIRunning() instead.
  }
}

function doGet(e) {
  ensureSchemaCurrent();
  var p = e && e.parameter ? e.parameter : {};
  var action = p.action || 'config';
  var result;
  try {
    if (OPEN_ACTIONS.indexOf(action) === -1 && !tokenIsValid(p.mgrName, p.token)) {
      // The app clears its unlock and asks for the PIN again when it sees this.
      result = { ok: false, locked: true, error: 'Manager PIN needed. Tap the lock and unlock again.' };
    }
    else if (action === 'config')    result = getConfig();
    else if (action === 'stock')     result = getStock();
    else if (action === 'inventory') result = getInventory(p);
    else if (action === 'overview')  result = getOverview();
    else if (action === 'today')     result = getToday(p);
    else if (action === 'submitDay') result = submitDay(p);
    else if (action === 'receive')   result = receiveStock(p);
    else if (action === 'count')     result = submitCount(p);
    else if (action === 'metrics')   result = getMetrics();
    else if (action === 'purchasing') result = computePurchasing();
    else if (action === 'summary')   result = getSummary();
    else if (action === 'capacity')  result = computeCapacity();
    else if (action === 'receiving') result = getReceiving(p);
    else if (action === 'crew')      result = computeCrew(p);
    else if (action === 'export')    result = exportTable(p);
    else if (action === 'reverse')   result = reverseEntry(p);
    else if (action === 'wipWalk')   result = submitWipWalk(p);
    else if (action === 'setTarget') result = setTarget(p);
    else if (action === 'wipBaseline') result = submitWipBaseline(p);
    else if (action === 'auth')      result = checkPin(p.name, p.pin);
    else if (action === 'floorData') result = getFloorData();
    else if (action === 'myPace')    result = getMyPace(p);
    else if (action === 'ship')      result = shipOut(p);
    else if (action === 'finished')  result = getFinished(p);
    else if (action === 'countFinished') result = countFinished(p);
    else if (action === 'salesImport') result = salesImport(p);
    else result = { ok: false, error: 'Unknown action: ' + action };
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return respond(result, p.callback);
}

function getConfig() {
  var products = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) {
      return { id: r.ProductID, name: r.ProductName, line: r.Line || 'Blank',
               family: String(r.Family || '').trim() || 'Other' };
    });
  var employees = readObjects(TAB.employees)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return r.Name; });
  var materials = readObjects(TAB.materials)
    .map(function (m) { return { id: m.MaterialID, name: m.MaterialName, unit: m.Unit }; });
  var lines = {};
  Object.keys(LINES).forEach(function (k) { lines[k] = stagesForLine(k); });
  // Identity of the backend and the spreadsheet it is bound to — the app shows
  // these in its footer so "which sheet am I writing to?" is answerable on the
  // shop floor rather than by reading code.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sellable = sellableProducts().map(function (r) { return r.ProductID; });
  return { ok: true, products: products, employees: employees, materials: materials, sellable: sellable, channels: CHANNELS,
           lines: lines, stages: stageNames(), familyOrder: FAMILY_ORDER,
           backendVersion: BACKEND_VERSION, buildStamp: BUILD_STAMP,
           // Surfaced so the app can nag while the PIN is still the published one.
           pinIsDefault: pinIsDefault(),
           sheetName: ss.getName(), sheetId: ss.getId() };
}

function getStock() {
  var mats = readObjects(TAB.materials).map(function (m) {
    var counted = !(m.OnHand === '' || m.OnHand === null || m.OnHand === undefined);
    var onHand = Number(m.OnHand) || 0, reorder = Number(m.ReorderPoint) || 0;
    return {
      id: m.MaterialID, name: m.MaterialName, unit: m.Unit, category: m.Category || '',
      supplier: String(m.Supplier || '').trim(),
      leadDays: blankish(m.LeadDays) ? null : (Number(m.LeadDays) || 0),
      onHand: onHand, counted: counted, reorderPoint: reorder, low: counted && onHand <= reorder,
      // Reconciliation. onHand is the ESTIMATE; lastCounted is the last actual.
      lastCounted:   m.LastCounted === '' || m.LastCounted === undefined ? null : Number(m.LastCounted),
      lastCountedAt: m.LastCountedAt ? fmtDate(m.LastCountedAt) : null,
      lastVariance:  m.LastVariance === '' || m.LastVariance === undefined ? null : Number(m.LastVariance)
    };
  });
  return { ok: true, materials: mats };
}

/* One screen that answers "how are we doing", assembled from the parts that
 * already exist.
 *
 * Overview is the pipeline, Inventory is the shelf, Buy is the purchase list —
 * each answers its own question well and none of them answers the first
 * question anyone actually asks. This is that top layer, and it is deliberately
 * thin: every number here is computed by the same function that owns it
 * elsewhere, so the summary can never quietly disagree with the screen it
 * summarises.
 *
 * The data-quality block is not filler. Half of these numbers are currently
 * built on figures nobody has established — materials never counted, products
 * with no opening WIP, days logged with no hours. A dashboard that showed the
 * numbers without showing how much of them is guesswork would be worse than
 * no dashboard, because it would be believed.
 */
function getSummary() {
  var today = new Date();
  var since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  var lineMap = productLineMap();

  var productName = {}, productFamily = {}, hasFeeder = {}, isFeeder = {};
  readObjects(TAB.products).forEach(function (p) {
    productName[p.ProductID] = p.ProductName;
    productFamily[p.ProductID] = String(p.Family || '').trim() || 'Other';
    var f = String(p.FeedsFrom || '').trim();
    if (f) { hasFeeder[p.ProductID] = true; isFeeder[f] = true; }
  });

  /* ---- Production over the last 7 days --------------------------------- */
  var byDay = {}, byProduct = {}, events = 0, hoursLogged = 0;
  readObjects(TAB.stagelog).forEach(function (r) {
    var pid = r.ProductID, stage = r.Stage;
    if (!pid || !stage) return;
    var d = fmtDate(r.WorkDate);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) return;
    var when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (when < since) return;

    var stages = stagesForLine(lineMap[pid] || 'Blank');
    var qty = Number(r.Qty) || 0;
    var isFirst = stage === stages[0];
    var isLast  = stage === stages[stages.length - 1];

    events++;
    hoursLogged += Number(r.Hours) || 0;
    /* The HEADLINE counts units entering and leaving the SHOP, which is not
     * the same as entering and leaving a line.
     *
     * A 50" blank is started when it is Cut. When that same blank is later
     * Meshed it starts the Exotube line — but no new object came into the
     * building, and adding both counts the same piece of foam twice. Likewise
     * a Glued blank is not a finished good; it is a tube waiting to happen.
     *
     * So: new units are the first stage of products NOTHING feeds, and
     * finished goods are the last stage of products that feed nothing. The
     * per-product figures below stay line-relative, because at that level
     * "how many did the Exo line start" is exactly the right question. */
    var day = byDay[d] || (byDay[d] = { date: d, started: 0, finished: 0, events: 0 });
    day.events++;
    if (isFirst && !hasFeeder[pid]) day.started += qty;
    if (isLast  && !isFeeder[pid])  day.finished += qty;

    var p = byProduct[pid] || (byProduct[pid] = { id: pid, name: productName[pid] || pid,
                                                 family: productFamily[pid] || 'Other',
                                                 started: 0, finished: 0 });
    if (isFirst) p.started += qty;
    if (isLast)  p.finished += qty;
  });

  var days = Object.keys(byDay).sort().map(function (k) { return byDay[k]; });
  var products = Object.keys(byProduct).map(function (k) { return byProduct[k]; })
    .sort(function (a, b) { return (b.finished - a.finished) || (b.started - a.started); });

  /* ---- Pipeline --------------------------------------------------------- */
  var overview = computeOverview();
  var wipTotal = 0, biggest = null, starved = 0, noBaseline = [];
  overview.forEach(function (pr) {
    if (!pr.baselineAt) noBaseline.push(pr.name);
    pr.stages.forEach(function (st, idx) {
      // Stage 0 of a variant is the shared blank pool — counted once, against
      // the feeder, not again against every variant drawing from it.
      if (idx === 0) return;
      var w = Number(st.waiting) || 0;
      if (st.starved) starved++;
      if (w <= 0) return;
      wipTotal += w;
      if (!biggest || w > biggest.units) {
        biggest = { productId: pr.productId, name: pr.name, stage: st.stage, units: w };
      }
    });
  });

  /* ---- Inventory --------------------------------------------------------- */
  var inv = getInventory({ history: 1 });
  var invSummary = inv.summary;

  /* ---- Buying ------------------------------------------------------------ */
  var buy = computePurchasing();
  var shortList = buy.materials.filter(function (m) {
    return m.counted && m.after < 0;
  }).sort(function (a, b) { return a.after - b.after; });

  /* ---- How much of this can be trusted ---------------------------------- */
  var allRows = readObjects(TAB.stagelog);
  var withBaseline = overview.filter(function (p) { return p.baselineAt; }).length;
  var counted = inv.materials.filter(function (m) { return m.lastCountedAt; }).length;

  return {
    ok: true,
    generatedAt: fmtDate(today),
    backendVersion: BACKEND_VERSION,
    production: {
      windowDays: 7, since: fmtDate(since),
      started:  days.reduce(function (n, d) { return n + d.started; }, 0),
      finished: days.reduce(function (n, d) { return n + d.finished; }, 0),
      events: events, activeDays: days.length, hours: round2(hoursLogged),
      days: days, products: products
    },
    pipeline: {
      wipTotal: wipTotal, biggest: biggest, starvedStages: starved,
      productsTracked: overview.length,
      productsWithoutBaseline: noBaseline
    },
    inventory: {
      materials: invSummary.materials, neverCounted: invSummary.neverCounted,
      negative: invSummary.negative, low: invSummary.low, drifting: invSummary.drifting,
      lastCountAt: invSummary.lastCountAt, daysSinceLastCount: invSummary.daysSinceLastCount
    },
    buying: {
      short: shortList.length,
      biggest: shortList.length ? { id: shortList[0].id, name: shortList[0].name,
                                    unit: shortList[0].unit,
                                    short: round2(-shortList[0].after) } : null,
      pools: buy.pools
    },
    trust: {
      stageLogRows: allRows.length,
      rowsWithHours: allRows.filter(function (r) { return Number(r.Hours) > 0; }).length,
      productsTracked: overview.length,
      productsWithBaseline: withBaseline,
      materialsTotal: invSummary.materials,
      materialsCounted: counted
    }
  };
}

/* Everything the Inventory panel needs in one round trip.
 *
 * getStock() already carries the current numbers. What a stocktake screen adds
 * is CONTEXT for each of them: when this material was last counted, how far off
 * it was that time, and whether it has missed the same way several counts
 * running. One variance is noise — a supplier's yard is not our yard, someone
 * counted a half-roll as whole. Three in the same direction is a BOM number to
 * fix, and that pattern is only visible with the history sitting next to the
 * box you are typing into, while you are still at the shelf.
 *
 *   ?action=inventory[&history=3]
 *
 * Read-only. The write path stays submitCount() — one place where a count
 * re-baselines OnHand and files a CountLog row, whatever screen sent it.
 */
function getInventory(p) {
  var want = Number((p && p.history) || 3);
  var keep = Math.max(1, Math.min(20, isFinite(want) && want > 0 ? want : 3));

  var mats = getStock().materials;
  var now = new Date();

  /* CountLog is append-only, so its natural order is chronological. unshift()
   * turns that into newest-first per material without a sort — and without
   * trusting the Timestamp column, which is blank on any row a human typed. */
  var history = {}, newestAt = null, newestBy = '';
  readObjects(TAB.countlog).forEach(function (r) {
    var id = String(r.MaterialID || '').trim();
    if (!id) return;
    var entry = {
      at: fmtDate(r.Timestamp),
      estimated: Number(r.EstimatedAtCount) || 0,
      counted:   Number(r.CountedQty) || 0,
      variance:  Number(r.Variance) || 0,
      variancePct: blankish(r.VariancePct) ? null : Number(r.VariancePct),
      by: String(r.CountedBy || ''), notes: String(r.Notes || '')
    };
    (history[id] = history[id] || []).unshift(entry);
    if (r.Timestamp instanceof Date && (!newestAt || r.Timestamp > newestAt)) {
      newestAt = r.Timestamp; newestBy = entry.by;
    }
  });

  var received = lastReceivedMap();
  var neverCounted = 0, negative = 0, low = 0, drifting = 0;
  mats.forEach(function (m) {
    var h = history[m.id] || [];
    m.history = h.slice(0, keep);
    var rcv = received[m.id];
    m.lastReceivedAt  = rcv ? rcv.at  : null;
    m.lastReceivedQty = rcv ? rcv.qty : null;
    m.countsRecorded = h.length;
    m.lastVariancePct = h.length ? h[0].variancePct : null;
    m.daysSinceCount = daysSince(m.lastCountedAt, now);

    /* A run of same-signed variances is the signature of a wrong recipe rather
     * than a bad count. An exact match breaks the run: agreement is evidence
     * against drift, not neutral. */
    var run = 0, dir = 0;
    for (var i = 0; i < h.length; i++) {
      var s = h[i].variance > 0 ? 1 : h[i].variance < 0 ? -1 : 0;
      if (!s || (dir && s !== dir)) break;
      dir = s; run++;
    }
    m.driftRun = run;
    m.drifting = run >= 2;

    if (!m.lastCountedAt) neverCounted++;
    if (m.onHand < 0) negative++;
    if (m.low) low++;
    if (m.drifting) drifting++;
  });

  /* Which five to count next. A stocktake that happens once is a baseline;
   * one that happens five materials at a time, every week, is a system. The
   * ranking is deliberately blunt: never counted beats stale, below zero and
   * below reorder pull forward, and among equals the older count goes first.
   * Nobody needs a cleverer order than that — they need a short one. */
  var stale30 = 0;
  var ranked = mats.map(function (m) {
    var score = m.lastCountedAt ? (m.daysSinceCount || 0) : 1000;
    if (m.onHand < 0) score += 100;
    if (m.low) score += 50;
    if (m.lastCountedAt && (m.daysSinceCount || 0) > 30) stale30++;
    return { id: m.id, score: score };
  }).sort(function (a, b) { return b.score - a.score; });

  return {
    ok: true,
    materials: mats,
    countNext: ranked.slice(0, 5).map(function (r) { return r.id; }),
    summary: {
      materials: mats.length,
      stale30: stale30,
      neverCounted: neverCounted,
      // Negative stock is not a count that went wrong, it is a count that never
      // happened: the recipe has been deducting against an opening balance
      // nobody ever set. Surfaced separately so it reads as a to-do, not a bug.
      negative: negative,
      low: low,
      drifting: drifting,
      lastCountAt: newestAt ? fmtDate(newestAt) : null,
      lastCountBy: newestBy,
      daysSinceLastCount: newestAt ? daysSince(fmtDate(newestAt), now) : null
    }
  };
}

function blankish(v) { return v === '' || v === null || v === undefined; }

/* N working days after `from`, Monday to Friday. */
function addWorkDaysServer(from, n) {
  var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  var left = Math.ceil(n);
  while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
  return d;
}

/* Whole days between a 'YYYY-MM-DD' string and `now`, both read as local dates.
 * Parsing the parts by hand rather than through Date(string), which reads a
 * bare date as UTC and can land a day out either side of the dateline. */
function daysSince(dateStr, now) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  var then  = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

/*
 * Today's totals for the employee landing page: per product, how many were
 * finished at each stage on the given work date (all staff combined).
 */
function getToday(p) {
  var workDate = String(p.workDate || '').trim();
  if (!workDate) return { ok: false, error: 'No work date' };
  var lineMap = productLineMap(), byProduct = {}, byPerson = {}, notes = [];
  readObjects(TAB.stagelog).forEach(function (r) {
    if (fmtDate(r.WorkDate) !== workDate) return;
    var pid = r.ProductID;
    var noteText = String(r.Notes || '').trim();
    if (noteText) notes.push({ product: r.ProductName, stage: r.Stage, by: String(r.Employee || ''), note: noteText });
    byProduct[pid] = byProduct[pid] || { name: r.ProductName, stages: {} };
    byProduct[pid].stages[r.Stage] = (byProduct[pid].stages[r.Stage] || 0) + (Number(r.Qty) || 0);
    // The shift-end line: what each person put on the books today. Units
    // are stage-events, deliberately — for a person "I logged 152 today" is
    // the right frame, the shop-level started/finished pair is for the shop.
    var who = String(r.Employee || '').trim();
    if (who) {
      var P = byPerson[who] || (byPerson[who] = { name: who, entries: 0, units: 0, hours: 0 });
      P.entries++; P.units += Number(r.Qty) || 0; P.hours += Number(r.Hours) || 0;
    }
  });
  var products = Object.keys(byProduct).map(function (pid) {
    var stages = stagesForLine(lineMap[pid] || 'Blank');
    /* Deliberately NOT a sum across stages.
     *
     * Summing counts the same physical unit once per station it passed: one
     * chair cut, assembled and boxed in a day reads as three chairs. The tube
     * lines never made that obvious because different tubes sit at different
     * stages, so the figure looked plausible while being just as wrong.
     *
     * A day has two honest headline numbers — how many entered the line and
     * how many came off the end of it — and the per-stage chips carry the
     * rest. */
    return {
      productId: pid, name: byProduct[pid].name,
      rows: stages.map(function (s) { return { stage: s, qty: byProduct[pid].stages[s] || 0 }; }),
      started:  byProduct[pid].stages[stages[0]] || 0,
      finished: byProduct[pid].stages[stages[stages.length - 1]] || 0
    };
  });
  var people = Object.keys(byPerson).map(function (k) {
    var P = byPerson[k]; return { name: P.name, entries: P.entries, units: P.units, hours: round2(P.hours) };
  }).sort(function (a, b) { return b.units - a.units; });
  return { ok: true, workDate: workDate, products: products, people: people, notes: notes };
}

/*
 * Employee uploads a day's work: a count per stage for one product.
 * Appends one StageLog row per non-zero stage and deducts materials the same
 * way for each (stage, qty).
 */
function submitDay(p) {
  var workDate  = String(p.workDate || '').trim();
  var employee  = String(p.employee || '').trim();
  var productId = String(p.productId || '').trim();
  var notes     = String(p.notes || '').trim();
  var counts, hours;
  try { counts = JSON.parse(p.counts || '{}'); } catch (e) { return { ok: false, error: 'Bad counts payload' }; }
  // Hours are OPTIONAL and per stage. A day logged without them still records
  // production; it just cannot contribute to a rate.
  try { hours = JSON.parse(p.hours || '{}'); } catch (e) { hours = {}; }
  // Per-stage notes: "Paint 2: dryer down 2h" belongs on the Paint 2 row, not
  // copied onto every stage the person logged. The shared note still applies
  // to any stage without one of its own.
  var stageNotes;
  try { stageNotes = JSON.parse(p.stageNotes || '{}'); } catch (e3) { stageNotes = {}; }

  if (!workDate)  return { ok: false, error: 'Please pick the work date.' };
  if (!employee)  return { ok: false, error: 'Please pick who you are.' };
  if (!productId) return { ok: false, error: 'Please pick a product.' };

  /* Replay safety. JSONP has no reply on a timeout: the request may have died
   * on the way out, or been processed and died on the way back. A phone that
   * queues the entry and retries cannot tell which, so it sends the same
   * clientId again and this returns the first answer instead of logging the
   * day twice. Six hours is long enough for any plausible retry and short
   * enough that the cache stays tiny. */
  var clientId = String(p.clientId || '').trim();
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e0) { cache = null; }
  if (cache && clientId) {
    var seen = null;
    try { seen = cache.get('day:' + clientId); } catch (e1) { seen = null; }
    if (seen) { var prior = JSON.parse(seen); prior.replayed = true; return prior; }
  }

  var valid = stagesForLine(productLineMap()[productId] || 'Blank');
  var total = 0;
  for (var k in counts) { if (valid.indexOf(k) >= 0 && Number(counts[k]) > 0) total += Number(counts[k]); }
  if (total <= 0) return { ok: false, error: 'Enter at least one stage count.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var product = readObjects(TAB.products).filter(function (r) { return r.ProductID === productId; })[0];
    if (!product) return { ok: false, error: 'Unknown product: ' + productId };

    // Preload materials + BOM once.
    var matSheet = ss.getSheetByName(TAB.materials);
    var matRows  = matSheet.getDataRange().getValues();
    var rowOf = {};                                   // MaterialID -> sheet row index
    for (var i = 1; i < matRows.length; i++) rowOf[matRows[i][0]] = i;
    var bom = readObjects(TAB.bom).filter(function (r) { return r.ProductID === productId; });

    var logSheet = ss.getSheetByName(TAB.stagelog);
    /* What is already on the books for this product today, so a second entry
     * for the same stage can be called out. Not blocked — two batches in a day
     * is normal, and a shift handover legitimately produces two rows — but a
     * double-tap and a real second batch look identical in the data, and only
     * the person who just pressed the button can tell them apart. */
    var priorToday = {};
    readObjects(TAB.stagelog).forEach(function (r) {
      if (r.ProductID !== productId || fmtDate(r.WorkDate) !== workDate) return;
      var k = r.Stage;
      priorToday[k] = priorToday[k] || { qty: 0, by: [] };
      priorToday[k].qty += Number(r.Qty) || 0;
      if (r.Employee && priorToday[k].by.indexOf(r.Employee) === -1) {
        priorToday[k].by.push(r.Employee);
      }
    });

    var logged = [], consumed = {}, warnings = [], produced = [], duplicates = [], stocked = [];
    var missingMaterials = {}, now = new Date();
    var sellable = {}; sellableProducts().forEach(function (r) { sellable[r.ProductID] = true; });

    valid.forEach(function (stage) {
      var qty = Number(counts[stage]) || 0;
      if (qty <= 0) return;
      var prior = priorToday[stage];
      if (prior && prior.qty > 0) {
        duplicates.push({
          stage: stage, priorQty: prior.qty, priorBy: prior.by.join(', '),
          addedQty: qty, newTotal: round2(prior.qty + qty)
        });
      }

      var hrs = Number(hours[stage]);
      hrs = (isFinite(hrs) && hrs > 0) ? round2(hrs) : '';
      var note = String(stageNotes[stage] || '').trim() || notes;
      appendByHeader(logSheet, {
        Timestamp: now, WorkDate: workDate, Employee: employee,
        ProductID: productId, ProductName: product.ProductName,
        Stage: stage, Qty: qty, Hours: hrs, Notes: note
      });
      logged.push({ stage: stage, qty: qty, hours: hrs === '' ? null : hrs, note: note || null });

      // A finished product's LAST stage goes into storage.
      if (stage === valid[valid.length - 1] && !product.OutputMaterial && sellable[productId]) {
        var fgAfter = adjustFinished(ss, productId, qty);
        if (fgAfter !== null) stocked.push({ id: productId, name: product.ProductName, added: qty, onHand: fgAfter });
        else warnings.push('No FinishedGoods tab yet — the ' + qty + ' finished were not added to storage. Run Aquamentor → Add missing columns (safe upgrade).');
      }
      // A sub-assembly's LAST stage PRODUCES stock. Without this the strap
      // line would consume webbing and create nothing, while the tube line
      // consumed straps that never existed.
      if (stage === valid[valid.length - 1] && product.OutputMaterial) {
        var outId = String(product.OutputMaterial).trim();
        var outRi = rowOf[outId];
        if (outRi === undefined) {
          warnings.push('No RawMaterials row for ' + outId + ' — the ' + qty
            + ' made were NOT added to stock. Run Aquamentor \u2192 Add missing '
            + 'columns (safe upgrade) to create it.');
        } else {
          var made = round2((Number(matRows[outRi][3]) || 0) + qty);
          matRows[outRi][3] = made;
          matSheet.getRange(outRi + 1, 4).setValue(made);
          produced.push({ id: matRows[outRi][0], name: matRows[outRi][1],
                          unit: matRows[outRi][2], added: qty, onHand: made });
        }
      }

      bom.filter(function (r) { return r.Stage === stage; }).forEach(function (r) {
        var ri = rowOf[r.MaterialID];
        if (ri === undefined) {
          /* A recipe pointing at a material with no row deducts nothing, and
           * used to do so in total silence — which is how the strap went
           * missing from stock for weeks. Say it out loud instead. */
          if (!missingMaterials[r.MaterialID]) {
            missingMaterials[r.MaterialID] = true;
            warnings.push('No RawMaterials row for ' + r.MaterialID
              + ' — nothing was deducted for it. Run Aquamentor \u2192 Add '
              + 'missing columns (safe upgrade) to create it.');
          }
          return;
        }
        var used = (Number(r.QtyPerUnit) || 0) * qty;
        var before = Number(matRows[ri][3]) || 0;
        var after = round2(before - used);
        matRows[ri][3] = after;                       // update our in-memory copy too
        matSheet.getRange(ri + 1, 4).setValue(after); // col D
        var key = r.MaterialID;
        consumed[key] = consumed[key] || { name: matRows[ri][1], unit: matRows[ri][2], used: 0, onHand: after };
        consumed[key].used = round2(consumed[key].used + used);
        consumed[key].onHand = after;
        var reorder = Number(matRows[ri][4]) || 0;
        if (after <= reorder && warnings.indexOf(matRows[ri][1]) < 0) {
          warnings.push(matRows[ri][1] + ' is low (' + after + ' ' + matRows[ri][2] + ')');
        }
      });
    });

    var result = {
      ok: true,
      message: 'Logged ' + total + ' stage entries for ' + product.ProductName + ' on ' + workDate,
      logged: logged,
      consumed: Object.keys(consumed).map(function (k) {
        return { name: consumed[k].name, used: consumed[k].used, onHand: consumed[k].onHand, unit: consumed[k].unit };
      }),
      produced: produced,
      stocked: stocked,
      duplicates: duplicates,
      warnings: warnings
    };
    if (cache && clientId) {
      try { cache.put('day:' + clientId, JSON.stringify(result), 21600); } catch (e2) { /* best effort */ }
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function receiveStock(p) {
  var employee   = String(p.employee || '').trim();
  var materialId = String(p.materialId || '').trim();
  var qty        = Number(p.qty);
  var notes      = String(p.notes || '').trim();
  if (!employee)   return { ok: false, error: 'Please pick who you are.' };
  if (!materialId) return { ok: false, error: 'Please pick a material.' };
  if (!(qty > 0))  return { ok: false, error: 'Quantity must be greater than 0.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var matSheet = ss.getSheetByName(TAB.materials);
    var matRows  = matSheet.getDataRange().getValues();
    var ri;
    for (var i = 1; i < matRows.length; i++) { if (matRows[i][0] === materialId) { ri = i; break; } }
    if (ri === undefined) return { ok: false, error: 'Unknown material: ' + materialId };
    var name = matRows[ri][1], unit = matRows[ri][2];
    var after = round2((Number(matRows[ri][3]) || 0) + qty);
    matSheet.getRange(ri + 1, 4).setValue(after);
    appendByHeader(ss.getSheetByName(TAB.receiving), {
      Timestamp: new Date(), Employee: employee, MaterialID: materialId,
      MaterialName: name, QtyAdded: qty, Notes: notes
    });
    return { ok: true, message: 'Received ' + round2(qty) + ' ' + unit + ' of ' + name,
             material: { id: materialId, name: name, unit: unit, onHand: after } };
  } finally {
    lock.releaseLock();
  }
}

/* Record a physical count for one or more materials and reconcile.
 *
 *   ?action=count&employee=Dan&counts={"M014":95,"M034":12}&notes=Q3 stocktake
 *
 * Variance is estimate − counted, so POSITIVE means the shelf holds less than
 * the recipe predicted (over-consumption, scrap or shrinkage) and NEGATIVE
 * means the recipe is over-deducting. Only materials present in `counts` are
 * touched; a partial count is normal and leaves everything else alone. */
function submitCount(p) {
  var employee = String(p.employee || '').trim();
  var notes    = String(p.notes || '').trim();
  if (!employee) return { ok: false, error: 'Please pick who you are.' };

  var counts;
  try { counts = JSON.parse(p.counts || '{}'); }
  catch (e) { return { ok: false, error: 'Counts were not valid JSON.' }; }

  var ids = Object.keys(counts).filter(function (id) {
    var v = counts[id];
    return v !== '' && v !== null && v !== undefined && !isNaN(Number(v));
  });
  if (!ids.length) return { ok: false, error: 'Enter at least one counted quantity.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var matSheet = ss.getSheetByName(TAB.materials);
    if (!matSheet) return { ok: false, error: 'RawMaterials tab is missing.' };

    var headers = matSheet.getRange(1, 1, 1, matSheet.getLastColumn()).getValues()[0];
    var col = {};
    headers.forEach(function (h, i) { col[h] = i + 1; });   // 1-based
    if (!col.LastCounted) {
      return { ok: false, error: 'This sheet has no LastCounted column yet. '
             + 'Run Aquamentor → Add missing columns (safe upgrade) first.' };
    }

    var logSheet = ss.getSheetByName(TAB.countlog);
    if (!logSheet) {
      logSheet = ss.insertSheet(TAB.countlog);
      logSheet.getRange(1, 1, 1, COUNTLOG_HEADERS.length).setValues([COUNTLOG_HEADERS])
        .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#ffffff');
      logSheet.setFrozenRows(1);
    }

    var rows = matSheet.getDataRange().getValues();
    var now = new Date();
    var applied = [], unknown = [];

    ids.forEach(function (id) {
      var ri;
      for (var i = 1; i < rows.length; i++) { if (rows[i][0] === id) { ri = i; break; } }
      if (ri === undefined) { unknown.push(id); return; }

      var name = rows[ri][1], unit = rows[ri][2];
      var estimated = Number(rows[ri][3]) || 0;
      var countedQty = round2(Number(counts[id]));
      var variance = round2(estimated - countedQty);
      var pct = estimated === 0 ? '' : round2((variance / estimated) * 100);

      appendByHeader(logSheet, {
        Timestamp: now, MaterialID: id, MaterialName: name, Unit: unit,
        EstimatedAtCount: estimated, CountedQty: countedQty,
        Variance: variance, VariancePct: pct, CountedBy: employee, Notes: notes
      });

      // Re-baseline: the count becomes the new truth the estimate runs from.
      matSheet.getRange(ri + 1, 4).setValue(countedQty);
      matSheet.getRange(ri + 1, col.LastCounted).setValue(countedQty);
      matSheet.getRange(ri + 1, col.LastCountedAt).setValue(now);
      matSheet.getRange(ri + 1, col.LastVariance).setValue(variance);

      applied.push({ id: id, name: name, unit: unit, estimated: estimated,
                     counted: countedQty, variance: variance, variancePct: pct });
    });

    // Biggest relative drift first — that ordering is the BOM-correction worklist.
    applied.sort(function (a, b) {
      return Math.abs(Number(b.variancePct) || 0) - Math.abs(Number(a.variancePct) || 0);
    });

    return { ok: true, counted: applied, unknown: unknown,
             message: 'Reconciled ' + applied.length + ' material'
                    + (applied.length === 1 ? '' : 's') + '.' };
  } finally {
    lock.releaseLock();
  }
}

/* What to buy, and why.
 *
 * The Overview already flags a material below its reorder point, but "below
 * reorder" is a nag, not a decision — it says nothing about whether that
 * material is about to stop the line or sit on the shelf for a month. The
 * question a purchase order actually answers is "how much of this does the
 * work I have already committed to consume, and do I have that much?"
 *
 * COMMITTED demand is computed from work already in the pipeline. A tube
 * sitting at Patched will consume Patched, Paint 1, Paint 2, Printed, Straps
 * and Boxed on its way out, so it owes every material those stages eat. That
 * needs no forecast and no assumption: the units are physically on the floor
 * and they are going somewhere.
 *
 *   committed(material) = SUM over products, over stages i>=1 of
 *                           waiting[i] x (materials consumed by stages i..end)
 *
 * Stage 0 is deliberately excluded. On a variant line its queue is the SHARED
 * blank pool — a 50" blank can still become either an Exotube or a Standard,
 * and charging its downstream materials to both would double-count every one
 * of them. Those blanks are reported separately as an uncommitted pool, so the
 * number is visible without being silently double-booked. On a Blank or Shape
 * line stage 0's input is raw foam, which is not tracked as WIP at all.
 *
 * perUnit is the whole recipe for one finished unit, handed to the app so a
 * "what if we build 200 more" plan recomputes as it is typed rather than
 * costing a round trip per keystroke.
 */
function computePurchasing() {
  var lineMap  = productLineMap();
  var overview = computeOverview();
  var stock    = getStock().materials;

  // bom[productId][stage][materialId] = qty per unit
  var bom = {};
  readObjects(TAB.bom).forEach(function (r) {
    var pid = String(r.ProductID || '').trim();
    var st  = String(r.Stage || '').trim();
    var mid = String(r.MaterialID || '').trim();
    if (!pid || !st || !mid) return;
    bom[pid] = bom[pid] || {};
    bom[pid][st] = bom[pid][st] || {};
    bom[pid][st][mid] = (bom[pid][st][mid] || 0) + (Number(r.QtyPerUnit) || 0);
  });

  var committed = {};     // materialId -> qty owed to work in progress
  var sources   = {};     // materialId -> [{productId, name, units, need}]
  var perUnit   = {};     // productId  -> {materialId: qty for one finished unit}
  var pools     = [];     // blanks not yet committed to a variant

  overview.forEach(function (pr) {
    var pid = pr.productId;
    var stages = stagesForLine(lineMap[pid] || 'Blank');
    var recipe = bom[pid] || {};

    /* remaining[i] = everything stages i..end consume, per unit. Built by
     * walking BACKWARDS so each stage is the one after it plus its own. */
    var remaining = [];
    var acc = {};
    for (var i = stages.length - 1; i >= 0; i--) {
      var here = recipe[stages[i]] || {};
      var next = {};
      Object.keys(acc).forEach(function (m) { next[m] = acc[m]; });
      Object.keys(here).forEach(function (m) { next[m] = (next[m] || 0) + here[m]; });
      acc = next;
      remaining[i] = acc;
    }
    perUnit[pid] = remaining[0] || {};

    pr.stages.forEach(function (row, idx) {
      if (idx === 0) {
        // The shared pool, reported but never charged to a variant.
        if (pr.feedsFrom && row.waiting > 0) {
          pools.push({ feeder: pr.feedsFrom, forProduct: pid,
                       name: pr.name, units: row.waiting });
        }
        return;
      }
      var units = Number(row.waiting) || 0;
      if (units <= 0) return;
      var need = remaining[idx] || {};
      Object.keys(need).forEach(function (mid) {
        var qty = round2(units * need[mid]);
        if (!qty) return;
        committed[mid] = round2((committed[mid] || 0) + qty);
        (sources[mid] = sources[mid] || []).push({
          productId: pid, name: pr.name, stage: row.stage, units: units, need: qty
        });
      });
    });
  });

  /* Burn: how fast each material leaves the shelf if every line runs at its
   * observed pace. Line rate is the bottleneck's rate (computeCapacity), per
   * unit is the whole recipe. No rate on a line means that line burns nothing
   * here — it is not zero consumption, it is unknown, and the app says which. */
  var burn = {}, burnUnknownFor = {};
  computeCapacity().products.forEach(function (pr) {
    var per = perUnit[pr.id] || {};
    Object.keys(per).forEach(function (mid) {
      if (pr.lineRate === null) { (burnUnknownFor[mid] = burnUnknownFor[mid] || []).push(pr.name); return; }
      burn[mid] = round2((burn[mid] || 0) + pr.lineRate * per[mid]);
    });
  });
  var today = new Date();

  var materials = stock.map(function (m) {
    var owed = committed[m.id] || 0;
    var src = (sources[m.id] || []).sort(function (a, b) { return b.need - a.need; });
    var daily = burn[m.id] || 0;
    var daysOfStock = (m.counted && daily > 0 && m.onHand > 0) ? round2(m.onHand / daily) : null;
    // Order-by: the day the shelf runs dry, less the supplier's lead time.
    // Working days, since the burn is in observed working days.
    var orderBy = null, orderByDays = null;
    if (daysOfStock !== null && m.leadDays !== null) {
      orderByDays = Math.floor(daysOfStock - m.leadDays);
      orderBy = fmtDate(addWorkDaysServer(today, Math.max(0, orderByDays)));
    }
    return {
      id: m.id, name: m.name, unit: m.unit, category: m.category, supplier: m.supplier || '',
      leadDays: m.leadDays, dailyBurn: daily, daysOfStock: daysOfStock,
      burnUnknownFor: burnUnknownFor[m.id] || [],
      orderBy: orderBy, orderByDays: orderByDays,
      onHand: m.onHand, counted: m.counted, reorderPoint: m.reorderPoint,
      lastCountedAt: m.lastCountedAt,
      committed: owed,
      // Negative means the work in progress needs more than the shelf holds.
      after: round2(m.onHand - owed),
      sources: src.slice(0, 4)
    };
  });

  // Dedupe the pool list: one entry per feeder, not one per variant drawing
  // from it — the same blanks are visible from both.
  var seen = {}, uniquePools = [];
  pools.forEach(function (p) {
    if (seen[p.feeder]) return;
    seen[p.feeder] = true;
    uniquePools.push({ feeder: p.feeder, units: p.units });
  });

  return { ok: true, materials: materials, perUnit: perUnit, pools: uniquePools,
           products: overview.map(function (pr) {
             return { id: pr.productId, name: pr.name, family: pr.family };
           }),
           familyOrder: FAMILY_ORDER };
}

/* Deliveries: what came in, when, from whom — the other half of the ledger.
 *
 * StageLog is where stock goes out; ReceivingLog is where it comes in, and
 * until now it was write-only from the app. A material's last delivery is the
 * single most useful thing to know when its count looks wrong: "estimate says
 * 40, shelf says 240" stops being a mystery the moment you see 200 arrived on
 * Tuesday and nobody counted since.
 *
 *   ?action=receiving[&materialId=M014][&limit=50]
 */
function getReceiving(p) {
  var want = Number((p && p.limit) || 50);
  var limit = Math.max(1, Math.min(500, isFinite(want) && want > 0 ? want : 50));
  var only = String((p && p.materialId) || '').trim();

  var rows = readObjects(TAB.receiving).map(function (r, i) {
    return {
      at: fmtDate(r.Timestamp), t: r.Timestamp instanceof Date ? r.Timestamp.getTime() : i,
      by: String(r.Employee || ''), id: String(r.MaterialID || '').trim(),
      name: String(r.MaterialName || ''), qty: Number(r.QtyAdded) || 0,
      notes: String(r.Notes || '')
    };
  }).filter(function (r) { return r.id && (!only || r.id === only); });

  // Newest first. Timestamp is set by the app, so it is a real Date for every
  // row the app wrote; a hand-typed row falls back to sheet order.
  rows.sort(function (a, b) { return b.t - a.t; });

  return { ok: true, deliveries: rows.slice(0, limit).map(function (r) {
    return { at: r.at, by: r.by, id: r.id, name: r.name, qty: r.qty, notes: r.notes };
  }), total: rows.length };
}

/* Per material: when it last arrived and how much. Folded into the inventory
 * rows so a wrong-looking estimate can be read against the last delivery. */
function lastReceivedMap() {
  var out = {};
  readObjects(TAB.receiving).forEach(function (r) {
    var id = String(r.MaterialID || '').trim();
    if (!id) return;
    var t = r.Timestamp instanceof Date ? r.Timestamp.getTime() : 0;
    if (!out[id] || t >= out[id].t) {
      out[id] = { t: t, at: fmtDate(r.Timestamp), qty: Number(r.QtyAdded) || 0 };
    }
  });
  return out;
}

/* Who did what, over a window.
 *
 * Units per hour is the number that matters and it exists only where hours
 * were logged — so it is computed from the subset of entries that carried
 * hours, never from total units over partial hours, which would flatter
 * whoever logs hours least. A person's rate on a stage sits next to the
 * line's, so "Joe straps at 22/hr, the line does 20" is one glance.
 *
 *   ?action=crew[&days=30]
 */
function computeCrew(p) {
  var want = Number((p && p.days) || 30);
  var days = Math.max(1, Math.min(365, isFinite(want) && want > 0 ? want : 30));
  var today = new Date();
  var since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));

  var people = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    var who = String(r.Employee || '').trim();
    if (!who || !r.Stage) return;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fmtDate(r.WorkDate));
    if (!m) return;
    var when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (when < since) return;

    var qty = Number(r.Qty) || 0, hrs = Number(r.Hours) || 0;
    var P = people[who] || (people[who] = { name: who, entries: 0, units: 0, hours: 0,
                                             unitsWithHours: 0, days: {}, stages: {} });
    P.entries++; P.units += qty; P.days[fmtDate(r.WorkDate)] = true;
    if (hrs > 0) { P.hours += hrs; P.unitsWithHours += qty; }

    var key = r.ProductID + '||' + r.Stage;
    var S = P.stages[key] || (P.stages[key] = { productId: r.ProductID, product: r.ProductName,
                                                stage: r.Stage, units: 0, hours: 0, unitsWithHours: 0 });
    S.units += qty;
    if (hrs > 0) { S.hours += hrs; S.unitsWithHours += qty; }
  });

  var crew = Object.keys(people).map(function (k) {
    var P = people[k];
    var stages = Object.keys(P.stages).map(function (sk) {
      var S = P.stages[sk];
      return { productId: S.productId, product: S.product, stage: S.stage, units: S.units,
               hours: round2(S.hours),
               unitsPerHour: S.hours > 0 ? round2(S.unitsWithHours / S.hours) : null };
    }).sort(function (a, b) { return b.units - a.units; });
    return {
      name: P.name, entries: P.entries, units: P.units, hours: round2(P.hours),
      daysWorked: Object.keys(P.days).length,
      unitsPerHour: P.hours > 0 ? round2(P.unitsWithHours / P.hours) : null,
      // How much of this person's output the rate actually covers.
      hoursCoverage: P.units > 0 ? round2(P.unitsWithHours / P.units * 100) : 0,
      stages: stages.slice(0, 6)
    };
  }).sort(function (a, b) { return b.units - a.units; });

  return { ok: true, days: days, since: fmtDate(since), crew: crew };
}

/* A whole tab as rows, for the app to turn into a CSV.
 *
 * The sheet can export itself, but a phone on the floor cannot get at the
 * sheet, and "send me the log" should not need a laptop. Dates go out as ISO
 * strings so the file sorts and imports cleanly anywhere.
 *
 *   ?action=export&table=stagelog|countlog|receiving|materials|wipbase|products|bom
 */
var EXPORTABLE = { stagelog: 'stagelog', countlog: 'countlog', receiving: 'receiving',
                   materials: 'materials', wipbase: 'wipbase', products: 'products', bom: 'bom',
                   finished: 'finished', shiplog: 'shiplog' };

/* Everything the Floor tab and the Floor Report need, as plain rows. The
 * math lives in report-core.js, shared by the app and the report, so the
 * backend only hands over the tables. Timestamps go out as ISO so the phone
 * never has to guess a locale. */
function getFloorData() {
  var iso = function (v) { return v instanceof Date ? v.toISOString() : String(v || ''); };
  var products = readObjects(TAB.products).filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return { ProductID: r.ProductID, ProductName: r.ProductName, Line: r.Line || 'Blank', Active: 'YES',
                                 FeedsFrom: r.FeedsFrom || '', Family: String(r.Family || '').trim() || 'Other' }; });
  var stages = readObjects(TAB.stages).map(function (r) {
    return { Line: r.Line, Order: r.Order, Stage: r.Stage, FloorRate_perHr: r.FloorRate_perHr, IdealRate_perHr: r.IdealRate_perHr }; });
  var planning = readObjects(TAB.planning).map(function (r) { return { ProductID: r.ProductID, Stage: r.Stage, DailyTarget: r.DailyTarget }; });
  var stagelog = readObjects(TAB.stagelog).map(function (r) {
    return { Timestamp: iso(r.Timestamp), WorkDate: fmtDate(r.WorkDate), Employee: r.Employee, ProductID: r.ProductID,
             Stage: r.Stage, Qty: r.Qty, Notes: r.Notes || '', Hours: (r.Hours === '' || r.Hours === null || r.Hours === undefined) ? '' : r.Hours }; });
  var wipbase = readObjects(TAB.wipbase).map(function (r) {
    return { Timestamp: iso(r.Timestamp), ProductID: r.ProductID, ProductName: r.ProductName, Stage: r.Stage,
             WaitingBefore: r.WaitingBefore, CountedBy: r.CountedBy || '' }; });
  return { ok: true, generatedAt: iso(new Date()),
           tables: { products: products, stages: stages, planning: planning, stagelog: stagelog, wipbase: wipbase } };
}

/* One person's own log, last 30 days, in floorData's shape so the same
 * report-core math renders it. No one else's rows, no piles, no opening
 * counts: a crew phone never receives the floor. */
function getMyPace(p) {
  var name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'Pick your name first.' };
  var known = readObjects(TAB.employees).filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return String(r.Name || '').trim(); });
  var match = known.filter(function (n) { return n.toLowerCase() === name.toLowerCase(); })[0];
  if (!match) return { ok: false, error: name + ' is not on the Employees tab.' };
  var all = getFloorData().tables;
  var since = new Date(); since.setDate(since.getDate() - 30);
  var sinceIso = fmtDate(since);
  var mine = all.stagelog.filter(function (r) {
    return String(r.Employee || '').trim().toLowerCase() === match.toLowerCase() && String(r.WorkDate) >= sinceIso;
  });
  return { ok: true, name: match, since: sinceIso, generatedAt: all.generatedAt,
           tables: { products: all.products, stages: all.stages, planning: all.planning, stagelog: mine, wipbase: [] } };
}

function exportTable(p) {
  var key = String((p && p.table) || '').trim().toLowerCase();
  var tabKey = EXPORTABLE[key];
  if (!tabKey) return { ok: false, error: 'Unknown table: ' + key
                        + '. One of: ' + Object.keys(EXPORTABLE).join(', ') };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB[tabKey]);
  if (!sh) return { ok: false, error: 'Tab ' + TAB[tabKey] + ' is missing.' };
  var values = sh.getDataRange().getValues();
  if (!values.length) return { ok: true, table: key, headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue;
    rows.push(values[i].map(function (v) {
      if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
      return v === null || v === undefined ? '' : v;
    }));
  }
  return { ok: true, table: key, tab: TAB[tabKey], headers: headers, rows: rows };
}

/* Reverse part or all of a logged stage entry for a day.
 *
 * A double-tap and a genuine second batch look identical in the data, and
 * until now the fix for the former was "delete the row in StageLog" — which
 * fixes the count and leaves the materials deducted, quietly, forever. This
 * does it properly: a NEGATIVE row goes into StageLog, so the sum comes right
 * and the history keeps both the mistake and its correction, and the stage's
 * recipe runs in reverse so the materials go back on the shelf. A last-stage
 * reversal on a sub-assembly takes its output back out of stock too.
 *
 * Attributed to the ORIGINAL employee, on the ORIGINAL work date, so the
 * person's totals and the day's totals correct themselves rather than a
 * phantom negative day appearing under whoever pressed undo — who is named
 * in the note instead. Hours are not touched: nobody knows which hours were
 * the mistake, and a wrong rate from a slightly wrong denominator is a
 * smaller lie than a rate from an invented one.
 *
 *   ?action=reverse&employee=Joe&productId=XRT50EXO&workDate=2026-09-13
 *          &stage=Boxed&qty=40&reason=double%20tap&by=Dan
 */
function reverseEntry(p) {
  var employee  = String(p.employee || '').trim();
  var by        = String(p.by || employee).trim();
  var productId = String(p.productId || '').trim();
  var workDate  = String(p.workDate || '').trim();
  var stage     = String(p.stage || '').trim();
  var reason    = String(p.reason || '').trim();
  var qty       = Number(p.qty);
  if (!employee || !productId || !workDate || !stage) return { ok: false, error: 'Missing employee, product, date or stage.' };
  if (!(qty > 0)) return { ok: false, error: 'Quantity to reverse must be greater than 0.' };
  if (!reason)    return { ok: false, error: 'Say why — the reason goes in the log.' };

  var valid = stagesForLine(productLineMap()[productId] || 'Blank');
  if (valid.indexOf(stage) === -1) return { ok: false, error: 'Unknown stage ' + stage + ' for ' + productId };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var product = readObjects(TAB.products).filter(function (r) { return r.ProductID === productId; })[0];
    if (!product) return { ok: false, error: 'Unknown product: ' + productId };

    // Can only take back what is actually on the books for that day.
    var onBooks = 0;
    readObjects(TAB.stagelog).forEach(function (r) {
      if (r.ProductID === productId && r.Stage === stage && fmtDate(r.WorkDate) === workDate) {
        onBooks += Number(r.Qty) || 0;
      }
    });
    if (qty > onBooks + 1e-9) {
      return { ok: false, error: 'Only ' + round2(onBooks) + ' logged for ' + stage + ' on ' + workDate + ' — cannot reverse ' + qty + '.' };
    }

    var matSheet = ss.getSheetByName(TAB.materials);
    var matRows  = matSheet.getDataRange().getValues();
    var rowOf = {};
    for (var i = 1; i < matRows.length; i++) rowOf[matRows[i][0]] = i;
    var bom = readObjects(TAB.bom).filter(function (r) { return r.ProductID === productId && r.Stage === stage; });

    appendByHeader(ss.getSheetByName(TAB.stagelog), {
      Timestamp: new Date(), WorkDate: workDate, Employee: employee,
      ProductID: productId, ProductName: product.ProductName,
      Stage: stage, Qty: -qty, Hours: '',
      Notes: 'REVERSED ' + qty + ' by ' + by + ': ' + reason
    });

    var restored = [], removed = null, warnings = [];
    bom.forEach(function (r) {
      var ri = rowOf[r.MaterialID];
      if (ri === undefined) { warnings.push('No RawMaterials row for ' + r.MaterialID + ' — nothing restored for it.'); return; }
      var back = round2((Number(r.QtyPerUnit) || 0) * qty);
      var after = round2((Number(matRows[ri][3]) || 0) + back);
      matRows[ri][3] = after;
      matSheet.getRange(ri + 1, 4).setValue(after);
      restored.push({ id: r.MaterialID, name: matRows[ri][1], unit: matRows[ri][2], restored: back, onHand: after });
    });

    if (stage === valid[valid.length - 1] && product.OutputMaterial) {
      var outRi = rowOf[String(product.OutputMaterial).trim()];
      if (outRi !== undefined) {
        var left = round2((Number(matRows[outRi][3]) || 0) - qty);
        matSheet.getRange(outRi + 1, 4).setValue(left);
        removed = { id: matRows[outRi][0], name: matRows[outRi][1], unit: matRows[outRi][2], removed: qty, onHand: left };
      }
    }
    var unstocked = null;
    if (stage === valid[valid.length - 1] && !product.OutputMaterial && isSellable(productId)) {
      var fgLeft = adjustFinished(ss, productId, -qty);
      if (fgLeft !== null) unstocked = { id: productId, name: product.ProductName, removed: qty, onHand: fgLeft };
    }

    return { ok: true, message: 'Reversed ' + qty + ' ' + stage + ' for ' + product.ProductName + ' on ' + workDate,
             nowOnBooks: round2(onBooks - qty), restored: restored, removed: removed, unstocked: unstocked, warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

/* Write one product's opening piles. A zero is meaningful here — "nothing is
 * queued at Paint 2" is a real measurement, not a blank — so every valid
 * stage is written, not just the ones with a number in them. Shared by the
 * single-product form and the whole-floor walk. */
function writeWipRows(sh, product, valid, piles, employee, notes, now) {
  var written = [];
  valid.forEach(function (stage) {
    var raw = piles[stage];
    var qty = (raw === '' || raw === null || raw === undefined) ? 0 : Number(raw);
    if (isNaN(qty) || qty < 0) qty = 0;
    appendByHeader(sh, {
      Timestamp: now, ProductID: product.ProductID, ProductName: product.ProductName,
      Stage: stage, WaitingBefore: qty, CountedBy: employee, Notes: notes
    });
    written.push({ stage: stage, qty: qty });
  });
  return written;
}

/* The whole floor in one pass.
 *
 * The single-product form works, twenty-one times over. Worse than tedious:
 * each submit stamps its own timestamp, and the timestamp is what decides
 * which StageLog rows the baseline supersedes. Twenty-one baselines taken over
 * forty minutes are twenty-one slightly different "befores", and anything
 * logged during the walk lands on one side of the line for some products and
 * the other side for the rest. One walk, one lock, one `now`.
 *
 *   ?action=wipWalk&employee=Dan&walk={"XRT50EXO":{"Patched":88,...},...}&notes=
 *
 * Products absent from `walk` are untouched — a line nobody walked keeps
 * whatever baseline it had, or none.
 */
function submitWipWalk(p) {
  var employee = String(p.employee || '').trim();
  var notes    = String(p.notes || '').trim();
  if (!employee) return { ok: false, error: 'Please pick who you are.' };
  var walk;
  try { walk = JSON.parse(p.walk || '{}'); }
  catch (e) { return { ok: false, error: 'Walk was not valid JSON.' }; }
  var ids = Object.keys(walk);
  if (!ids.length) return { ok: false, error: 'Nothing in the walk.' };

  var byId = {};
  readObjects(TAB.products).forEach(function (r) { byId[r.ProductID] = r; });
  var unknown = ids.filter(function (id) { return !byId[id]; });
  if (unknown.length) return { ok: false, error: 'Unknown product(s): ' + unknown.join(', ') };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TAB.wipbase);
    if (!sh) sh = writeTab(ss, TAB.wipbase, WIPBASE_HEADERS, []);

    var now = new Date(), recorded = [];
    ids.forEach(function (pid) {
      var product = byId[pid];
      var valid = stagesForLine(product.Line || 'Blank').concat([WIP_FINISHED]);
      var written = writeWipRows(sh, product, valid, walk[pid] || {}, employee, notes, now);
      recorded.push({ productId: pid, name: product.ProductName, piles: written });
    });

    var fresh = wipBaselineMap();
    recorded.forEach(function (r) { r.completed = (fresh[r.productId] || { completed: {} }).completed; });
    return { ok: true, at: fmtDate(now), products: recorded,
             message: 'Opening WIP recorded for ' + recorded.length + ' product'
                    + (recorded.length === 1 ? '' : 's') + ' at one moment. Earlier counts are superseded.' };
  } finally {
    lock.releaseLock();
  }
}

/* Set one stage's daily target from the app.
 *
 * Planning is one row per (product, stage). Targets drift with the season and
 * the order book, and "open the sheet, find the row, edit the cell" is enough
 * friction that they do not get updated — so the Overview keeps suggesting
 * yesterday's plan. An existing row is updated in place; a missing one is
 * appended, since a product added after Planning was seeded has none.
 *
 *   ?action=setTarget&productId=XRT50EXO&stage=Boxed&target=40
 */
function setTarget(p) {
  var productId = String(p.productId || '').trim();
  var stage     = String(p.stage || '').trim();
  var target    = Number(p.target);
  if (!productId || !stage) return { ok: false, error: 'Missing product or stage.' };
  if (!isFinite(target) || target < 0) return { ok: false, error: 'Target must be a number, 0 or more.' };
  target = Math.round(target);

  var product = readObjects(TAB.products).filter(function (r) { return r.ProductID === productId; })[0];
  if (!product) return { ok: false, error: 'Unknown product: ' + productId };
  if (stagesForLine(product.Line || 'Blank').indexOf(stage) === -1) {
    return { ok: false, error: 'Unknown stage ' + stage + ' for ' + productId };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TAB.planning);
    if (!sh) return { ok: false, error: 'Planning tab is missing.' };
    var values = sh.getDataRange().getValues();
    var headers = values[0];
    var cPid = headers.indexOf('ProductID'), cStage = headers.indexOf('Stage'), cT = headers.indexOf('DailyTarget');
    if (cPid === -1 || cStage === -1 || cT === -1) return { ok: false, error: 'Planning tab has unexpected headers.' };

    var was = null;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][cPid]).trim() === productId && String(values[i][cStage]).trim() === stage) {
        was = Number(values[i][cT]) || 0;
        sh.getRange(i + 1, cT + 1).setValue(target);
        return { ok: true, productId: productId, stage: stage, target: target, was: was, appended: false };
      }
    }
    appendByHeader(sh, { ProductID: productId, ProductName: product.ProductName, Stage: stage, DailyTarget: target });
    return { ok: true, productId: productId, stage: stage, target: target, was: null, appended: true };
  } finally {
    lock.releaseLock();
  }
}

/* Monday-morning digest, sent by the sheet itself.
 *
 * The Summary tab answers "how are we doing" for whoever opens the app. The
 * digest answers it for whoever does not — it lands in the inbox at 7am on
 * Monday from a time-driven trigger owned by this script, no phone involved.
 * The HTML is built by a pure function so it can be tested without sending
 * anything; the send is a thin wrapper around MailApp.
 *
 * Menu: Aquamentor -> Email me the digest now / Turn on Monday digest / off.
 * Recipients live in Script Properties (DIGEST_TO, comma-separated); with
 * none set it goes to whoever installed the trigger.
 */
function buildDigestHtml(sum, buy, inv, appUrl) {
  var p = sum.production, pipe = sum.pipeline, st = sum.inventory, t = sum.trust;
  var esc = function (x) { return String(x === null || x === undefined ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var n = function (x) { return round2(x).toLocaleString(); };
  var h = [];
  h.push('<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#1c2634">');
  h.push('<h2 style="margin:0 0 4px;color:#0c1f3f">Aquamentor — week to ' + esc(sum.generatedAt) + '</h2>');
  h.push('<p style="margin:0 0 16px;color:#5d6a7d">Last ' + p.windowDays + ' days, since ' + esc(p.since) + '.</p>');

  h.push('<table cellpadding="8" style="border-collapse:collapse;width:100%;margin-bottom:16px">');
  h.push('<tr><td style="border:1px solid #d9d6ce"><b style="font-size:22px;color:#0c1f3f">' + n(p.started) + '</b><br><span style="color:#5d6a7d">entered the shop</span></td>'
       + '<td style="border:1px solid #d9d6ce"><b style="font-size:22px;color:#0c1f3f">' + n(p.finished) + '</b><br><span style="color:#5d6a7d">finished goods</span></td>'
       + '<td style="border:1px solid #d9d6ce"><b style="font-size:22px;color:#0c1f3f">' + n(p.activeDays) + '</b><br><span style="color:#5d6a7d">days worked · ' + n(p.events) + ' entries</span></td></tr>');
  h.push('</table>');

  if (pipe.biggest) {
    h.push('<p><b>On the floor:</b> ' + n(pipe.wipTotal) + ' units in progress. Biggest pile: '
      + n(pipe.biggest.units) + ' ' + esc(pipe.biggest.name) + ' waiting at <b>' + esc(pipe.biggest.stage) + '</b>.</p>');
  }

  var short = (buy.materials || []).filter(function (m) { return m.counted && m.after < 0; })
    .sort(function (a, b) { return a.after - b.after; }).slice(0, 8);
  h.push('<h3 style="margin:18px 0 6px;color:#0c1f3f">To order</h3>');
  if (!short.length) h.push('<p style="color:#5d6a7d">Nothing counted is short of what the pipeline needs.</p>');
  else {
    h.push('<table cellpadding="6" style="border-collapse:collapse;width:100%">');
    short.forEach(function (m) {
      h.push('<tr><td style="border-bottom:1px solid #eae7e0">' + esc(m.name)
        + (m.supplier ? ' <span style="color:#5d6a7d">· ' + esc(m.supplier) + '</span>' : '') + '</td>'
        + '<td style="border-bottom:1px solid #eae7e0;text-align:right;color:#a92e2a"><b>short ' + n(-m.after) + ' ' + esc(m.unit) + '</b></td></tr>');
    });
    h.push('</table>');
  }

  h.push('<h3 style="margin:18px 0 6px;color:#0c1f3f">Count next</h3>');
  var byId = {}; (inv.materials || []).forEach(function (m) { byId[m.id] = m; });
  var next = (inv.countNext || []).map(function (id) { return byId[id]; }).filter(Boolean);
  h.push(next.length
    ? '<p>' + next.map(function (m) { return esc(m.name) + (m.lastCountedAt ? '' : ' <span style="color:#a92e2a">(never)</span>'); }).join(' · ') + '</p>'
    : '<p style="color:#5d6a7d">Everything is freshly counted.</p>');

  h.push('<h3 style="margin:18px 0 6px;color:#0c1f3f">How much of this to trust</h3>');
  h.push('<p style="color:#5d6a7d;margin:0">' + n(t.materialsCounted) + ' of ' + n(t.materialsTotal) + ' materials counted · '
    + n(t.productsWithBaseline) + ' of ' + n(t.productsTracked) + ' products with a WIP baseline · '
    + n(t.rowsWithHours) + ' of ' + n(t.stageLogRows) + ' entries carry hours.</p>');
  if (appUrl) h.push('<p style="margin-top:18px"><a href="' + esc(appUrl) + '" style="color:#0c1f3f">Open the app</a></p>');
  h.push('</div>');
  return h.join('');
}

var APP_PUBLIC_URL = 'https://prod-through-inv-3.dan-daf.workers.dev';

function digestRecipients() {
  var to = '';
  try { to = String(PropertiesService.getScriptProperties().getProperty('DIGEST_TO') || '').trim(); } catch (e) {}
  if (to) return to;
  try { return Session.getEffectiveUser().getEmail(); } catch (e2) { return ''; }
}

function sendWeeklyDigest() {
  var to = digestRecipients();
  if (!to) throw new Error('No recipient: set DIGEST_TO from the Aquamentor menu.');
  var sum = getSummary(), buy = computePurchasing(), inv = getInventory({ history: 1 });
  var html = buildDigestHtml(sum, buy, inv, APP_PUBLIC_URL);
  var subject = 'Aquamentor week to ' + sum.generatedAt + ' — ' + round2(sum.production.finished)
    + ' finished, ' + (sum.buying.short || 0) + ' to order';
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html,
    body: 'This digest is HTML; open it in a mail client that shows HTML.' });
  return { to: to, subject: subject };
}

function emailDigestNow() {
  var r = sendWeeklyDigest();
  SpreadsheetApp.getActive().toast('Sent to ' + r.to, 'Aquamentor', 6);
}
function setDigestRecipients() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Digest recipients', 'Comma-separated email addresses. Blank = whoever turned the digest on.\nCurrently: ' + digestRecipients(), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var to = String(r.getResponseText() || '').trim();
  var props = PropertiesService.getScriptProperties();
  if (to) props.setProperty('DIGEST_TO', to); else props.deleteProperty('DIGEST_TO');
  SpreadsheetApp.getActive().toast('Digest goes to ' + digestRecipients(), 'Aquamentor', 6);
}
function digestTriggerOn() {
  digestTriggerOff();   // never two
  ScriptApp.newTrigger('sendWeeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  SpreadsheetApp.getActive().toast('Monday 7am digest is on, to ' + digestRecipients(), 'Aquamentor', 6);
}
function digestTriggerOff() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendWeeklyDigest') ScriptApp.deleteTrigger(t);
  });
}
function digestTriggerOffMenu() {
  digestTriggerOff();
  SpreadsheetApp.getActive().toast('Monday digest is off', 'Aquamentor', 6);
}

/* Latest opening-WIP baseline per product, already converted from countable
 * piles into the cumulative completions the chain math needs.
 *
 * Returns  productId -> { at: Date, completed: {stage: n}, piles: {...},
 *                         finished: n, countedBy, notes } */
function wipBaselineMap() {
  var rows = readObjects(TAB.wipbase);
  if (!rows.length) return {};

  // Keep only the newest timestamp per product; a re-count supersedes entirely.
  var newest = {};
  rows.forEach(function (r) {
    if (!r.ProductID || !r.Timestamp) return;
    var t = new Date(r.Timestamp).getTime();
    if (isNaN(t)) return;
    if (!newest[r.ProductID] || t > newest[r.ProductID]) newest[r.ProductID] = t;
  });

  var grouped = {};
  rows.forEach(function (r) {
    if (!r.ProductID || !r.Timestamp) return;
    var t = new Date(r.Timestamp).getTime();
    if (t !== newest[r.ProductID]) return;
    var g = grouped[r.ProductID] || (grouped[r.ProductID] = {
      at: new Date(t), piles: {}, finished: 0,
      countedBy: r.CountedBy || '', notes: r.Notes || ''
    });
    var qty = Number(r.WaitingBefore) || 0;
    if (r.Stage === WIP_FINISHED) g.finished = qty;
    else g.piles[r.Stage] = qty;
  });

  var lineMap = productLineMap();
  Object.keys(grouped).forEach(function (pid) {
    var g = grouped[pid];
    var stages = stagesForLine(lineMap[pid] || 'Blank');
    // Walk backwards: everything past a stage is either finished or queued at
    // some later station.
    var completed = {}, running = g.finished;
    for (var i = stages.length - 1; i >= 0; i--) {
      completed[stages[i]] = running;
      running += (g.piles[stages[i]] || 0);
    }
    g.completed = completed;
  });

  return grouped;
}

/* Record an opening-WIP count for one product. Supersedes any earlier one.
 *
 *   ?action=wipBaseline&employee=Dan&productId=XRT50EXO
 *     &piles={"Patched":40,"Paint 1":12,"(finished)":8}
 */
function submitWipBaseline(p) {
  var employee  = String(p.employee || '').trim();
  var productId = String(p.productId || '').trim();
  var notes     = String(p.notes || '').trim();
  if (!employee)  return { ok: false, error: 'Please pick who you are.' };
  if (!productId) return { ok: false, error: 'Please pick a product.' };

  var piles;
  try { piles = JSON.parse(p.piles || '{}'); }
  catch (e) { return { ok: false, error: 'Piles were not valid JSON.' }; }

  var product = readObjects(TAB.products).filter(function (r) {
    return r.ProductID === productId;
  })[0];
  if (!product) return { ok: false, error: 'Unknown product: ' + productId };

  var stages = stagesForLine(product.Line || 'Blank');
  var valid = stages.concat([WIP_FINISHED]);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TAB.wipbase);
    if (!sh) sh = writeTab(ss, TAB.wipbase, WIPBASE_HEADERS, []);

    var now = new Date();
    var written = writeWipRows(sh, product, valid, piles, employee, notes, now);

    var fresh = wipBaselineMap()[productId] || { completed: {} };
    return { ok: true, productId: productId, name: product.ProductName,
             piles: written, completed: fresh.completed,
             message: 'Opening WIP recorded for ' + product.ProductName
                    + '. Counts logged before now are superseded.' };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================================
 *  RUNWAY, THROUGHPUT, METRICS  —  "how much, how fast, by when"
 * ========================================================================== */

/* How many more units of each product the material on hand can support.
 *
 * A material can be consumed at several stages of one product (paint at both
 * Paint 1 and Paint 2), so the per-unit requirement is the SUM across stages,
 * not any single BOM row.
 *
 * Materials with a blank OnHand are reported as `uncounted` rather than
 * treated as zero. Treating "never counted" as "none left" would report a
 * runway of 0 for almost every product here, which is both wrong and useless —
 * the honest answer is a number plus a list of what would sharpen it. */
function computeRunway() {
  var stock = {};
  readObjects(TAB.materials).forEach(function (m) {
    var has = !(m.OnHand === '' || m.OnHand === null || m.OnHand === undefined);
    stock[m.MaterialID] = { name: m.MaterialName, unit: m.Unit,
                            onHand: has ? Number(m.OnHand) || 0 : null };
  });

  var perUnit = {};                        // productId -> materialId -> qty summed over stages
  readObjects(TAB.bom).forEach(function (r) {
    if (!r.ProductID || !r.MaterialID) return;
    perUnit[r.ProductID] = perUnit[r.ProductID] || {};
    perUnit[r.ProductID][r.MaterialID] =
      (perUnit[r.ProductID][r.MaterialID] || 0) + (Number(r.QtyPerUnit) || 0);
  });

  var out = {};
  readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .forEach(function (pr) {
      var needs = perUnit[pr.ProductID] || {};
      var buildable = null, constraint = null, uncounted = [], detail = [];

      Object.keys(needs).forEach(function (mid) {
        var need = needs[mid], mat = stock[mid];
        if (!mat || !(need > 0)) return;
        if (mat.onHand === null) { uncounted.push({ id: mid, name: mat.name }); return; }
        /* Floored at zero. A negative balance divided by a positive recipe
         * yields "-138 buildable", which is not a smaller number of tubes —
         * it is not a number of tubes at all. The honest reading is zero, plus
         * the fact that the shelf is already in the hole, which `owed` carries
         * so the app can say so instead of printing arithmetic at someone. */
        var canMake = Math.max(0, Math.floor(mat.onHand / need));
        var short = mat.onHand < 0 ? round2(-mat.onHand) : 0;
        detail.push({ id: mid, name: mat.name, unit: mat.unit,
                      onHand: mat.onHand, perUnit: round2(need),
                      canMake: canMake, owed: short });
        if (buildable === null || canMake < buildable) {
          buildable = canMake;
          constraint = { id: mid, name: mat.name, unit: mat.unit,
                         onHand: mat.onHand, perUnit: round2(need), owed: short };
        }
      });

      detail.sort(function (a, b) { return a.canMake - b.canMake; });
      // Materials already in the hole. These are not a shortage to plan around;
      // they are a count that never happened, and the app should say which.
      var negative = detail.filter(function (d) { return d.owed > 0; })
        .map(function (d) { return { id: d.id, name: d.name, unit: d.unit, owed: d.owed }; });
      out[pr.ProductID] = {
        buildable: buildable, constraint: constraint, negative: negative,
        uncounted: uncounted, materials: detail.slice(0, 5)
      };
    });
  return out;
}

/* Capacity: how fast each line actually runs, and what that means for the
 * work queued in front of it.
 *
 * Every line has one stage that sets its pace — the bottleneck — and nothing
 * upstream of it can make the line faster. Everything here is derived from
 * the throughput actually observed in StageLog, so it is only as good as the
 * logging: a stage nobody has logged has no rate, and a line with an unrated
 * stage has a bottleneck that is only the slowest of the stages we know
 * about. That distinction is carried in `confidence` and shown, because a
 * rate from one good afternoon is not a rate.
 *
 * daysToClear is Little's Law at one station: the queue in front of a stage
 * divided by that stage's observed pace. aheadOfBottleneck is what an order
 * has to wait behind, since everything queued up to and including the
 * bottleneck must pass through it first. Both are in OBSERVED DAYS — days on
 * which that stage did work — which is the only kind of day the data knows.
 */
function computeCapacity() {
  var m = getMetrics();

  var products = m.products.map(function (pr) {
    var rated = pr.stages.filter(function (s) { return s.unitsPerDay !== null && s.unitsPerDay > 0; });

    var bottleneck = null, bottleneckIdx = -1;
    pr.stages.forEach(function (s, i) {
      if (s.unitsPerDay === null || !(s.unitsPerDay > 0)) return;
      if (!bottleneck || s.unitsPerDay < bottleneck.unitsPerDay) { bottleneck = s; bottleneckIdx = i; }
    });

    var wipInLine = 0, ahead = 0;
    pr.stages.forEach(function (s, i) {
      if (i === 0) return;                       // the shared pool is not this line's
      var w = Number(s.waiting) || 0;
      if (w <= 0) return;
      wipInLine += w;
      if (bottleneckIdx >= 0 && i <= bottleneckIdx) ahead += w;
    });

    var minDays = rated.length
      ? Math.min.apply(null, rated.map(function (s) { return s.daysObserved || 0; })) : 0;
    var confidence = !rated.length ? 'none'
      : rated.length < pr.stages.length ? 'partial'
      : minDays < 5 ? 'thin' : 'ok';

    return {
      id: pr.id, name: pr.name, family: pr.family, feedsFrom: pr.feedsFrom,
      baselineAt: pr.baselineAt, finished: pr.finished,
      lineRate: bottleneck ? bottleneck.unitsPerDay : null,
      bottleneck: bottleneck ? { stage: bottleneck.stage, unitsPerDay: bottleneck.unitsPerDay,
                                 unitsPerHour: bottleneck.unitsPerHour,
                                 daysObserved: bottleneck.daysObserved } : null,
      wipInLine: wipInLine,
      aheadOfBottleneck: ahead,
      ratedStages: rated.length, totalStages: pr.stages.length,
      confidence: confidence,
      buildable: pr.runway ? pr.runway.buildable : null,
      constraint: pr.runway ? pr.runway.constraint : null,
      negative: pr.runway ? (pr.runway.negative || []) : [],
      uncounted: pr.runway ? (pr.runway.uncounted || []) : [],
      stages: pr.stages.map(function (s, i) {
        var w = i === 0 ? null : (Number(s.waiting) || 0);
        var days = null;
        if (w === 0) days = 0;
        else if (w > 0 && s.unitsPerDay > 0) days = round2(w / s.unitsPerDay);
        return {
          stage: s.stage, completed: s.completed, waiting: w,
          unitsPerHour: s.unitsPerHour, unitsPerDay: s.unitsPerDay,
          daysObserved: s.daysObserved, hoursLogged: s.hoursLogged,
          daysToClear: days,
          isBottleneck: i === bottleneckIdx
        };
      })
    };
  });

  return { ok: true, products: products, coverage: m.coverage, familyOrder: FAMILY_ORDER };
}

/* Measured throughput per (product, stage), straight from StageLog.
 *
 * unitsPerHour is the number worth planning with, but it only exists for
 * entries that carried hours. unitsPerDay is always available and is reported
 * alongside so a rate is still visible before the habit of logging hours takes
 * hold — with daysObserved so nobody mistakes one good day for a rate. */
function computeThroughput() {
  var agg = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    if (!r.ProductID || !r.Stage) return;
    var key = r.ProductID + '||' + r.Stage;
    var a = agg[key] || (agg[key] = { productId: r.ProductID, stage: r.Stage,
                                      qty: 0, hours: 0, qtyWithHours: 0, days: {} });
    var qty = Number(r.Qty) || 0, hrs = Number(r.Hours) || 0;
    a.qty += qty;
    if (hrs > 0) { a.hours += hrs; a.qtyWithHours += qty; }
    if (r.WorkDate) a.days[fmtDate(r.WorkDate)] = true;
  });

  return Object.keys(agg).map(function (k) {
    var a = agg[k], days = Object.keys(a.days).length;
    return {
      productId: a.productId, stage: a.stage,
      totalQty: a.qty, daysObserved: days, hoursLogged: round2(a.hours),
      unitsPerDay:  days ? round2(a.qty / days) : null,
      unitsPerHour: a.hours > 0 ? round2(a.qtyWithHours / a.hours) : null
    };
  });
}

/* One read-only call for the dashboard.
 *
 * Deliberately a stable, self-describing contract rather than whatever the
 * phone screens happen to need — the dashboard is a separate project on its
 * own release cycle, and coupling it to the UI's shape would mean changing
 * both sides together every time a screen moves. Read-only and unauthenticated,
 * same as every other action here. */
function getMetrics() {
  var runway = computeRunway();
  var overview = computeOverview();
  var rates = computeThroughput();

  var rateBy = {};
  rates.forEach(function (r) { rateBy[r.productId + '||' + r.stage] = r; });

  var products = overview.map(function (pr) {
    return {
      id: pr.productId, name: pr.name, feedsFrom: pr.feedsFrom, family: pr.family,
      finished: pr.finished, baselineAt: pr.baselineAt,
      runway: runway[pr.productId] || null,
      stages: pr.stages.map(function (s) {
        var r = rateBy[pr.productId + '||' + s.stage] || null;
        return {
          stage: s.stage, completed: s.completed, waiting: s.waiting,
          target: s.target, suggest: s.suggest, starved: s.starved,
          unitsPerHour: r ? r.unitsPerHour : null,
          unitsPerDay:  r ? r.unitsPerDay  : null,
          daysObserved: r ? r.daysObserved : 0,
          hoursLogged:  r ? r.hoursLogged  : 0
        };
      })
    };
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    backendVersion: BACKEND_VERSION,
    sheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    products: products,
    materials: getStock().materials,
    throughput: rates,
    // Named so a consumer can tell an empty pipeline from a broken one.
    coverage: {
      stageLogRows: readObjects(TAB.stagelog).length,
      rowsWithHours: readObjects(TAB.stagelog).filter(function (r) {
        return Number(r.Hours) > 0;
      }).length
    }
  };
}

/* ============================================================================
 *  3. OVERVIEW / STATE MACHINE
 *  For each product: completed-per-stage (all time), WIP waiting before each
 *  stage, and a suggested next-day goal per stage. Also raw-material status.
 * ========================================================================== */
function computeOverview() {
  var lineMap = productLineMap();
  var feedMap = productFeedMap();

  // targets[productId][stage] — set per stage, because Cut and Paint do not
  // run at the same rate.
  var targets = {};
  readObjects(TAB.planning).forEach(function (r) {
    if (!r.ProductID) return;
    targets[r.ProductID] = targets[r.ProductID] || {};
    targets[r.ProductID][r.Stage] = Number(r.DailyTarget) || 0;
  });

  // completed[productId][stage] = opening baseline + everything logged since.
  //
  // Rows timestamped BEFORE a product's baseline are skipped: the units they
  // describe are already standing on the floor and were counted in the piles,
  // so adding them again would double-count the same physical tubes.
  var baseline = wipBaselineMap();
  var completed = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    var pid = r.ProductID, st = r.Stage;
    if (!pid || !st) return;
    var base = baseline[pid];
    if (base && r.Timestamp) {
      var t = new Date(r.Timestamp).getTime();
      if (!isNaN(t) && t <= base.at.getTime()) return;
    }
    completed[pid] = completed[pid] || {};
    completed[pid][st] = (completed[pid][st] || 0) + (Number(r.Qty) || 0);
  });
  function done(pid, stage) {
    var opening = (baseline[pid] && baseline[pid].completed[stage]) || 0;
    return opening + ((completed[pid] || {})[stage] || 0);
  }
  function target(pid, stage) { return (targets[pid] || {})[stage] || 0; }

  var products = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; });

  // feeder -> every product drawing from it. Variants of the same size compete
  // for one pool of blanks, so each one's availability depends on what its
  // siblings have already pulled out.
  var drawnFrom = {};
  products.forEach(function (r) {
    var f = feedMap[r.ProductID];
    if (f) { drawnFrom[f] = drawnFrom[f] || []; drawnFrom[f].push(r.ProductID); }
  });

  /* Blanks still uncommitted to a variant: everything the feeder finished at
   * its last stage, less what each variant has already taken at its first. */
  function poolFrom(feeder) {
    var feederStages = stagesForLine(lineMap[feeder] || 'Blank');
    var pool = done(feeder, feederStages[feederStages.length - 1]);
    (drawnFrom[feeder] || []).forEach(function (sib) {
      pool -= done(sib, stagesForLine(lineMap[sib] || 'Blank')[0]);
    });
    return Math.max(0, pool);
  }

  return products.map(function (pr) {
    var pid = pr.ProductID;
    var stages = stagesForLine(lineMap[pid] || pr.Line || 'Blank');
    var feeder = feedMap[pid];

    var rows = stages.map(function (st, idx) {
      var doneHere = done(pid, st);
      var want = target(pid, st);
      var waiting;

      if (idx > 0) {
        waiting = Math.max(0, done(pid, stages[idx - 1]) - doneHere);  // WIP from the stage before
      } else if (feeder) {
        waiting = poolFrom(feeder);          // first stage of a variant: the shared blank pool
      } else {
        waiting = null;                      // true head of a pipeline — nothing upstream of it
      }

      // Aim at this stage's own target, capped by what is actually available.
      var suggest = waiting === null ? want : Math.min(want, waiting);
      var starved = waiting !== null && waiting < want;
      return { stage: st, completed: doneHere, waiting: waiting,
               target: want, suggest: suggest, starved: starved };
    });

    var base = baseline[pid];
    return { productId: pid, name: pr.ProductName, feedsFrom: feeder || null,
             family: String(pr.Family || '').trim() || 'Other',
             finished: done(pid, stages[stages.length - 1]), stages: rows,
             baselineAt: base ? fmtDate(base.at) : null };
  });
}

function getOverview() {
  return { ok: true, products: computeOverview(), materials: getStock().materials,
           runway: computeRunway(), stages: stageNames() };
}

/* Writes the overview to a sheet tab too (for the desktop/web view in Sheets). */
function rebuildOverview() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = freshSheet(ss, TAB.overview);
  sh.getRange('A1').setValue('AQUAMENTOR — PRODUCTION OVERVIEW').setFontSize(14).setFontWeight('bold');
  var data = computeOverview();
  var row = 3;
  data.forEach(function (pr) {
    sh.getRange(row, 1).setValue(pr.name + '   (finished ' + pr.finished + ')'
        + (pr.feedsFrom ? '   — from ' + pr.feedsFrom : ''))
      .setFontWeight('bold').setFontColor('#0c1f3f');
    row++;
    sh.getRange(row, 1, 1, 6).setValues([['Stage', 'Completed', 'WIP waiting', 'Target', 'Suggested next day', 'Note']])
      .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#fff');
    row++;
    pr.stages.forEach(function (s) {
      sh.getRange(row, 1, 1, 6).setValues([[
        s.stage, s.completed, s.waiting === null ? '' : s.waiting, s.target, s.suggest,
        s.starved ? 'upstream short' : '']]);
      row++;
    });
    row++;
  });
  for (var c = 1; c <= 6; c++) sh.autoResizeColumn(c);
  SpreadsheetApp.getActive().toast('Overview rebuilt.', 'Aquamentor', 3);
}

/* ============================================================================
 *  Menu
 * ========================================================================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Aquamentor')
    .addItem('Set up / repair missing tabs', 'setup')
    .addItem('Rebuild overview / next-day goals', 'rebuildOverview')
    .addItem('What am I running? (diagnostics)', 'whatAmIRunning')
    .addItem('Set manager PIN…', 'setManagerPin')
    .addItem('Set a person\'s PIN…', 'setPersonPin')
    .addSeparator()
    .addItem('Email me the digest now', 'emailDigestNow')
    .addItem('Turn on Monday 7am digest', 'digestTriggerOn')
    .addItem('Turn off Monday digest', 'digestTriggerOffMenu')
    .addItem('Set digest recipients…', 'setDigestRecipients')
    .addSeparator()
    .addItem('Import sales from SalesImport tab', 'importSalesFromTab')
    .addItem('Set Shopify access…', 'setShopifyAccess')
    .addItem('Sync Shopify shipments now', 'syncShopifyMenu')
    .addItem('Turn on hourly Shopify sync', 'shopifySyncOn')
    .addItem('Turn off Shopify sync', 'shopifySyncOffMenu')
    .addSeparator()
    .addItem('Update from GitHub now', 'updateFromGitHubMenu')
    .addItem('Turn on auto-update from GitHub (every 30 min)', 'autoUpdateOn')
    .addItem('Turn off auto-update', 'autoUpdateOffMenu')
    .addItem('Set deployment ID…', 'setDeploymentId')
    .addSeparator()
    .addItem('Add missing columns (safe upgrade)', 'upgradeSchema')
    .addItem('Migrate to Blank → Exo/Standard', 'migrateToVariantLines')
    .addItem('⚠ Erase and rebuild ALL tabs', 'resetAllTabs')
    .addToUi();
}


/* ============================================================================
 *  Finished goods — storage, shipping, and where it went
 *  ---------------------------------------------------------------------------
 *  A tube that reaches Boxed used to vanish: it left the floor and nothing
 *  held it. FinishedGoods holds it. The last stage of a SELLABLE product adds
 *  to OnHand; a shipment (the crew's Ship tab, or an order imported from
 *  Shopify / Amazon / QuickBooks) takes it out and says which channel took it;
 *  a storage count re-baselines OnHand and files the variance in CountLog.
 *  produced − shipped − counted is the reconciliation.
 *
 *  Sellable = an active product that is not another product's feeder (blanks)
 *  and has no OutputMaterial (straps become a material, not stock).
 * ========================================================================== */
var FINISHED_HEADERS = ['ProductID', 'ProductName', 'OnHand', 'LastCounted', 'LastCountedAt', 'LastVariance',
                        'ShopifySKU', 'AmazonSKU', 'QBOItem', 'Notes'];
var SHIPLOG_HEADERS  = ['Timestamp', 'ShipDate', 'ProductID', 'ProductName', 'Qty', 'Channel', 'Ref', 'By', 'Notes', 'Key'];
var CHANNELS = ['Shopify', 'Amazon', 'QuickBooks', 'Wholesale', 'Sample', 'Other'];

function sellableProducts() {
  var all = readObjects(TAB.products).filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; });
  var feeders = {};
  all.forEach(function (r) { if (r.FeedsFrom) feeders[String(r.FeedsFrom).trim()] = true; });
  return all.filter(function (r) { return !feeders[r.ProductID] && !String(r.OutputMaterial || '').trim(); });
}
function isSellable(productId) {
  return sellableProducts().some(function (r) { return r.ProductID === productId; });
}

/* The FinishedGoods sheet with a row for every sellable product. Creates the
 * tab and any missing rows; never touches a value that is already there. */
function finishedSheet(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB.finished);
  if (!sh) sh = writeTab(ss, TAB.finished, FINISHED_HEADERS, []);
  var have = {};
  readObjects(TAB.finished).forEach(function (r) { have[r.ProductID] = true; });
  sellableProducts().forEach(function (p) {
    if (have[p.ProductID]) return;
    appendByHeader(sh, { ProductID: p.ProductID, ProductName: p.ProductName, OnHand: '', ShopifySKU: '', AmazonSKU: '', QBOItem: '' });
  });
  return sh;
}
function shipSheet(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(TAB.shiplog) || writeTab(ss, TAB.shiplog, SHIPLOG_HEADERS, []);
}
/* Add (or subtract) finished stock for a product. Blank OnHand counts as 0 —
 * "never counted" stays visible through LastCountedAt. Returns the new value,
 * or null when the product is not stocked (not sellable). */
function adjustFinished(ss, productId, delta) {
  // Never creates the tab: a day entry must not be the thing that builds
  // schema. The upgrade (and the first manager view) does that.
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB.finished);
  if (!sh) return null;
  var rows = sh.getDataRange().getValues(), headers = rows[0];
  var cId = headers.indexOf('ProductID'), cOn = headers.indexOf('OnHand');
  if (cId === -1 || cOn === -1) return null;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][cId] !== productId) continue;
    var after = round2((Number(rows[i][cOn]) || 0) + delta);
    sh.getRange(i + 1, cOn + 1).setValue(after);
    return after;
  }
  // A product added after the tab was built: give it a row now.
  var product = readObjects(TAB.products).filter(function (r) { return r.ProductID === productId; })[0];
  if (!product) return null;
  appendByHeader(sh, { ProductID: productId, ProductName: product.ProductName, OnHand: round2(delta), ShopifySKU: '', AmazonSKU: '', QBOItem: '' });
  return round2(delta);
}

/* ---- Ship: the crew's tab. One product, one quantity, one channel. -------- */
function shipOut(p) {
  var employee = String(p.employee || '').trim(), productId = String(p.productId || '').trim();
  var channel = String(p.channel || '').trim(), ref = String(p.ref || '').trim(), notes = String(p.notes || '').trim();
  var shipDate = String(p.shipDate || '').trim() || fmtDate(new Date());
  var qty = Number(p.qty);
  if (!employee)  return { ok: false, error: 'Please pick who you are.' };
  if (!productId) return { ok: false, error: 'Please pick a product.' };
  if (!(qty > 0)) return { ok: false, error: 'Quantity must be greater than 0.' };
  if (CHANNELS.indexOf(channel) === -1) return { ok: false, error: 'Pick where it went: ' + CHANNELS.join(', ') + '.' };
  if (!isSellable(productId)) return { ok: false, error: productId + ' is not a finished product.' };

  var clientId = String(p.clientId || '').trim(), cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e0) { cache = null; }
  if (cache && clientId) {
    var seen = null; try { seen = cache.get('ship:' + clientId); } catch (e1) { seen = null; }
    if (seen) { var prior = JSON.parse(seen); prior.replayed = true; return prior; }
  }
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var product = readObjects(TAB.products).filter(function (r) { return r.ProductID === productId; })[0];
    var now = new Date();
    var key = 'manual|' + (clientId || Utilities.getUuid());
    appendByHeader(shipSheet(ss), { Timestamp: now, ShipDate: shipDate, ProductID: productId, ProductName: product.ProductName,
      Qty: qty, Channel: channel, Ref: ref, By: employee, Notes: notes, Key: key });
    var onHand = adjustFinished(ss, productId, -qty);
    var result = { ok: true, message: 'Shipped ' + qty + ' ' + product.ProductName + ' via ' + channel + (ref ? ' (' + ref + ')' : ''),
                   productId: productId, name: product.ProductName, qty: qty, channel: channel, onHand: onHand,
                   warnings: onHand !== null && onHand < 0 ? ['Storage now shows ' + onHand + ' — more shipped than was ever logged as finished. Count storage on the Inventory tab.'] : [] };
    if (cache && clientId) { try { cache.put('ship:' + clientId, JSON.stringify(result), 21600); } catch (e2) {} }
    return result;
  } finally { lock.releaseLock(); }
}

/* ---- Count storage (manager). Same shape as a materials count. ------------ */
function countFinished(p) {
  var employee = String(p.employee || '').trim(), notes = String(p.notes || '').trim();
  if (!employee) return { ok: false, error: 'Please pick who you are.' };
  var counts; try { counts = JSON.parse(p.counts || '{}'); } catch (e) { return { ok: false, error: 'Counts were not valid JSON.' }; }
  var ids = Object.keys(counts).filter(function (id) { var v = counts[id]; return v !== '' && v !== null && v !== undefined && !isNaN(Number(v)); });
  if (!ids.length) return { ok: false, error: 'Enter at least one counted quantity.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = finishedSheet(ss), rows = sh.getDataRange().getValues(), headers = rows[0];
    var col = {}; headers.forEach(function (h, i) { col[h] = i; });
    var logSheet = ss.getSheetByName(TAB.countlog) || writeTab(ss, TAB.countlog, COUNTLOG_HEADERS, []);
    var now = new Date(), applied = [], unknown = [];
    ids.forEach(function (id) {
      var ri; for (var i = 1; i < rows.length; i++) { if (rows[i][col.ProductID] === id) { ri = i; break; } }
      if (ri === undefined) { unknown.push(id); return; }
      var estimated = Number(rows[ri][col.OnHand]) || 0, counted = round2(Number(counts[id]));
      var variance = round2(estimated - counted), pct = estimated === 0 ? '' : round2(variance / estimated * 100);
      appendByHeader(logSheet, { Timestamp: now, MaterialID: id, MaterialName: rows[ri][col.ProductName], Unit: 'finished',
        EstimatedAtCount: estimated, CountedQty: counted, Variance: variance, VariancePct: pct, CountedBy: employee, Notes: notes });
      sh.getRange(ri + 1, col.OnHand + 1).setValue(counted);
      sh.getRange(ri + 1, col.LastCounted + 1).setValue(counted);
      sh.getRange(ri + 1, col.LastCountedAt + 1).setValue(now);
      sh.getRange(ri + 1, col.LastVariance + 1).setValue(variance);
      applied.push({ id: id, name: rows[ri][col.ProductName], estimated: estimated, counted: counted, variance: variance, variancePct: pct });
    });
    return { ok: true, counted: applied, unknown: unknown, message: 'Counted ' + applied.length + ' finished product' + (applied.length === 1 ? '' : 's') + '.' };
  } finally { lock.releaseLock(); }
}

/* ---- Imported sales: Shopify / Amazon / QuickBooks lines -> ShipLog ------- */
/* rows: [{channel, ref, sku, name, qty, date}]. A line is matched to a product
 * by the channel's SKU column on FinishedGoods, then by ProductID, then by
 * ProductName. Key = channel|ref|productId makes a re-import a no-op. Lines
 * that match nothing come back as `unmatched` so the SKU can be mapped;
 * nothing is guessed. */
function importSales(rows, by) {
  by = by || 'import';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  finishedSheet(ss);
  var fg = readObjects(TAB.finished), products = {};
  var skuCol = { Shopify: 'ShopifySKU', Amazon: 'AmazonSKU', QuickBooks: 'QBOItem' };
  fg.forEach(function (r) { products[r.ProductID] = r; });
  function match(channel, sku, name) {
    var s = String(sku || '').trim().toLowerCase(), n = String(name || '').trim().toLowerCase(), c = skuCol[channel];
    var hit = null;
    if (s && c) fg.forEach(function (r) { if (!hit && String(r[c] || '').split(/[,;]/).some(function (x) { return x.trim().toLowerCase() === s; })) hit = r; });
    if (!hit && s) fg.forEach(function (r) { if (!hit && String(r.ProductID).toLowerCase() === s) hit = r; });
    if (!hit && n) fg.forEach(function (r) { if (!hit && String(r.ProductName).toLowerCase() === n) hit = r; });
    if (!hit && n && c) fg.forEach(function (r) { if (!hit && String(r[c] || '').split(/[,;]/).some(function (x) { return x.trim().toLowerCase() === n; })) hit = r; });
    return hit;
  }
  var existing = {};
  readObjects(TAB.shiplog).forEach(function (r) { if (r.Key) existing[String(r.Key)] = true; });
  var sh = shipSheet(ss), now = new Date(), added = [], skipped = 0, unmatched = {}, delta = {};
  rows.forEach(function (r) {
    var qty = Number(r.qty); if (!(qty > 0)) return;
    var channel = CHANNELS.indexOf(r.channel) !== -1 ? r.channel : 'Other';
    var hit = match(channel, r.sku, r.name);
    if (!hit) { var uk = channel + '|' + (r.sku || r.name); unmatched[uk] = unmatched[uk] || { channel: channel, sku: r.sku || '', name: r.name || '', qty: 0, orders: 0 }; unmatched[uk].qty += qty; unmatched[uk].orders += 1; return; }
    var key = channel + '|' + String(r.ref || '').trim() + '|' + hit.ProductID;
    if (existing[key]) { skipped += 1; return; }
    existing[key] = true;
    appendByHeader(sh, { Timestamp: now, ShipDate: fmtDate(r.date) || fmtDate(now), ProductID: hit.ProductID, ProductName: hit.ProductName,
      Qty: qty, Channel: channel, Ref: r.ref || '', By: by, Notes: r.name || '', Key: key });
    delta[hit.ProductID] = (delta[hit.ProductID] || 0) + qty;
    added.push({ productId: hit.ProductID, name: hit.ProductName, qty: qty, channel: channel, ref: r.ref || '' });
  });
  Object.keys(delta).forEach(function (pid) { adjustFinished(ss, pid, -delta[pid]); });
  return { added: added, skipped: skipped, unmatched: Object.keys(unmatched).map(function (k) { return unmatched[k]; }) };
}
function salesImport(p) {
  var rows; try { rows = JSON.parse(p.rows || '[]'); } catch (e) { return { ok: false, error: 'rows was not valid JSON.' }; }
  if (!rows.length) return { ok: false, error: 'Nothing to import.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { var r = importSales(rows, String(p.by || p.mgrName || 'import')); r.ok = true; r.message = 'Imported ' + r.added.length + ', skipped ' + r.skipped + ' already on file, ' + r.unmatched.length + ' unmatched.'; return r; }
  finally { lock.releaseLock(); }
}

/* CSV with quotes, commas and newlines inside quotes. Tabs too (Amazon). */
function parseDelimited(text) {
  text = String(text || '').replace(/^﻿/, '');
  var delim = (text.split('\n')[0] || '').indexOf('\t') !== -1 ? '\t' : ',';
  var rows = [], row = [], cell = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
}
/* Recognise an export by its headers and turn it into import rows. Only
 * SHIPPED lines count — an order placed is not stock gone. */
function salesRowsFromTable(table) {
  if (!table.length) return { format: null, rows: [] };
  var h = table[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var ix = function () { for (var i = 0; i < arguments.length; i++) { var k = h.indexOf(arguments[i]); if (k !== -1) return k; } return -1; };
  var out = [], format = null;
  if (ix('lineitem sku') !== -1 && ix('name') !== -1) {                       // Shopify orders export
    format = 'Shopify';
    var cName = ix('name'), cSku = ix('lineitem sku'), cQty = ix('lineitem quantity'), cLn = ix('lineitem name'),
        cFul = ix('lineitem fulfillment status'), cOrdFul = ix('fulfillment status'), cAt = ix('fulfilled at'), cCr = ix('created at');
    table.slice(1).forEach(function (r) {
      var lineStatus = String(cFul !== -1 ? r[cFul] : (cOrdFul !== -1 ? r[cOrdFul] : '')).toLowerCase();
      if (lineStatus && lineStatus !== 'fulfilled') return;
      out.push({ channel: 'Shopify', ref: r[cName], sku: cSku !== -1 ? r[cSku] : '', name: cLn !== -1 ? r[cLn] : '', qty: Number(cQty !== -1 ? r[cQty] : 0), date: String((cAt !== -1 && r[cAt]) || (cCr !== -1 && r[cCr]) || '').slice(0, 10) });
    });
  } else if (ix('amazon-order-id') !== -1) {                                   // Amazon All Orders report
    format = 'Amazon';
    var aId = ix('amazon-order-id'), aSku = ix('sku'), aQty = ix('quantity', 'quantity-shipped'), aSt = ix('order-status', 'item-status'),
        aDt = ix('last-updated-date', 'purchase-date'), aNm = ix('product-name');
    table.slice(1).forEach(function (r) {
      var st = String(aSt !== -1 ? r[aSt] : '').toLowerCase();
      if (st && st !== 'shipped') return;
      out.push({ channel: 'Amazon', ref: r[aId], sku: aSku !== -1 ? r[aSku] : '', name: aNm !== -1 ? r[aNm] : '', qty: Number(aQty !== -1 ? r[aQty] : 0), date: String(aDt !== -1 ? r[aDt] : '').slice(0, 10) });
    });
  } else if (ix('product/service') !== -1 && ix('qty') !== -1) {              // QBO Sales by Product/Service Detail
    format = 'QuickBooks';
    var qDt = ix('date'), qTy = ix('transaction type'), qNum = ix('num'), qPs = ix('product/service'), qQty = ix('qty');
    table.slice(1).forEach(function (r) {
      var ty = String(qTy !== -1 ? r[qTy] : '').toLowerCase();
      if (ty && !/invoice|sales receipt/.test(ty)) return;
      var ps = String(r[qPs] || '').trim(); if (!ps) return;
      out.push({ channel: 'QuickBooks', ref: (qNum !== -1 ? r[qNum] : '') || (r[qDt] + ' ' + ps), sku: ps.split(':').pop().trim(), name: ps, qty: Number(r[qQty]), date: String(r[qDt] || '').slice(0, 10) });
    });
  }
  return { format: format, rows: out };
}
/* Menu: paste an export into a tab called SalesImport and run this. */
function importSalesFromTab() {
  var ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('SalesImport');
  if (!sh) { ss.insertSheet('SalesImport'); ui.alert('SalesImport', 'A SalesImport tab was created. Paste a Shopify orders export, an Amazon All Orders report, or a QuickBooks Sales by Product/Service Detail report into it (header row first), then run this again.', ui.ButtonSet.OK); return; }
  var table = sh.getDataRange().getValues().map(function (r) { return r.map(function (c) { return c instanceof Date ? fmtDate(c) : c; }); });
  var parsed = salesRowsFromTable(table);
  if (!parsed.format) { ui.alert('Not recognised', 'The header row does not match a Shopify, Amazon or QuickBooks export.', ui.ButtonSet.OK); return; }
  var r = importSales(parsed.rows, 'import:' + parsed.format);
  var msg = parsed.format + ': ' + r.added.length + ' shipment line' + (r.added.length === 1 ? '' : 's') + ' recorded, ' + r.skipped + ' already on file.';
  if (r.unmatched.length) msg += '\n\nNot matched to a product (map these SKUs on the FinishedGoods tab, then run again):\n' + r.unmatched.map(function (u) { return '• ' + (u.sku || '(no sku)') + '  ' + u.name + '  ×' + u.qty; }).join('\n');
  ui.alert('Imported', msg, ui.ButtonSet.OK);
}

/* ---- Shopify, straight from the store, on a timer -------------------------- */
/* Needs a custom app in Shopify admin with read_orders, its Admin API access
 * token in Script Properties (menu: Set Shopify access…). Fulfilled line
 * items only. Keyed by order name + SKU so hourly runs never double-count. */
function shopifyCreds() {
  var props = PropertiesService.getScriptProperties();
  return { shop: String(props.getProperty('SHOPIFY_SHOP') || '').trim(), token: String(props.getProperty('SHOPIFY_TOKEN') || '').trim() };
}
function setShopifyAccess() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Shopify store', 'Store subdomain, the part before .myshopify.com:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var r2 = ui.prompt('Admin API access token', 'From Shopify admin → Settings → Apps → Develop apps → your app → API credentials. Needs read_orders.', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SHOPIFY_SHOP', String(r1.getResponseText()).trim().replace(/\.myshopify\.com.*$/, ''));
  props.setProperty('SHOPIFY_TOKEN', String(r2.getResponseText()).trim());
  SpreadsheetApp.getActive().toast('Shopify access saved. Run "Sync Shopify shipments now" to test it.', 'Aquamentor', 8);
}
function shopifyShippedRows(sinceIso) {
  var c = shopifyCreds();
  if (!c.shop || !c.token) throw new Error('Shopify access is not set. Aquamentor → Set Shopify access…');
  var url = 'https://' + c.shop + '.myshopify.com/admin/api/2025-07/orders.json?status=any&limit=250&updated_at_min=' + encodeURIComponent(sinceIso)
          + '&fields=id,name,created_at,fulfillment_status,fulfillments';
  var rows = [], pages = 0;
  while (url && pages < 20) {
    var res = UrlFetchApp.fetch(url, { headers: { 'X-Shopify-Access-Token': c.token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Shopify answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    (JSON.parse(res.getContentText()).orders || []).forEach(function (o) {
      (o.fulfillments || []).forEach(function (f) {
        if (String(f.status).toLowerCase() !== 'success') return;
        (f.line_items || []).forEach(function (li) {
          rows.push({ channel: 'Shopify', ref: o.name, sku: li.sku || '', name: li.title || li.name || '', qty: Number(li.quantity) || 0, date: String(f.created_at || o.created_at || '').slice(0, 10) });
        });
      });
    });
    var link = String(res.getHeaders()['Link'] || res.getHeaders()['link'] || '');
    var m = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = m ? m[1] : null; pages += 1;
  }
  return rows;
}
function syncShopify() {
  var props = PropertiesService.getScriptProperties();
  var since = String(props.getProperty('SHOPIFY_SINCE') || '').trim();
  if (!since) { var d = new Date(); d.setDate(d.getDate() - 30); since = d.toISOString(); }
  var rows = shopifyShippedRows(since);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { var r = importSales(rows, 'sync:Shopify'); } finally { lock.releaseLock(); }
  // Overlap by a day so a fulfillment that landed mid-run is never missed;
  // the Key makes the overlap harmless.
  var next = new Date(); next.setDate(next.getDate() - 1); props.setProperty('SHOPIFY_SINCE', next.toISOString());
  props.setProperty('SHOPIFY_LAST', new Date().toISOString() + ' +' + r.added.length + ' skipped ' + r.skipped + ' unmatched ' + r.unmatched.length);
  return r;
}
function syncShopifyMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = syncShopify();
    ui.alert('Shopify', r.added.length + ' shipment line' + (r.added.length === 1 ? '' : 's') + ' recorded, ' + r.skipped + ' already on file.'
      + (r.unmatched.length ? '\n\nNot matched (map on FinishedGoods → ShopifySKU):\n' + r.unmatched.map(function (u) { return '• ' + (u.sku || '(no sku)') + '  ' + u.name + '  ×' + u.qty; }).join('\n') : ''), ui.ButtonSet.OK);
  } catch (e) { ui.alert('Shopify sync failed', String(e && e.message ? e.message : e), ui.ButtonSet.OK); }
}
function syncShopifyTrigger() { try { syncShopify(); } catch (e) { /* surfaced by whatAmIRunning via SHOPIFY_LAST */ try { PropertiesService.getScriptProperties().setProperty('SHOPIFY_LAST', new Date().toISOString() + ' FAILED ' + e.message); } catch (e2) {} } }
function shopifySyncOn() {
  shopifySyncOff();
  ScriptApp.newTrigger('syncShopifyTrigger').timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast('Shopify shipments sync every hour.', 'Aquamentor', 6);
}
function shopifySyncOff() { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncShopifyTrigger') ScriptApp.deleteTrigger(t); }); }
function shopifySyncOffMenu() { shopifySyncOff(); SpreadsheetApp.getActive().toast('Shopify sync is off', 'Aquamentor', 6); }

/* ---- What a manager sees: stock, movement, reconciliation ----------------- */
function getFinished(p) {
  var days = Number(p && p.days) || 30;
  var since = new Date(); since.setDate(since.getDate() - days); var sinceIso = fmtDate(since);
  finishedSheet();
  var fg = readObjects(TAB.finished), lineMap = productLineMap();
  var lastOf = {}; Object.keys(lineMap).forEach(function (pid) { var st = stagesForLine(lineMap[pid]); lastOf[pid] = st[st.length - 1]; });
  var produced = {}, producedAll = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    if (r.Stage !== lastOf[r.ProductID]) return;
    var q = Number(r.Qty) || 0; producedAll[r.ProductID] = (producedAll[r.ProductID] || 0) + q;
    if (fmtDate(r.WorkDate) >= sinceIso) produced[r.ProductID] = (produced[r.ProductID] || 0) + q;
  });
  var shipped = {}, byChannel = {}, recent = [];
  readObjects(TAB.shiplog).forEach(function (r) {
    var q = Number(r.Qty) || 0, d = fmtDate(r.ShipDate);
    recent.push({ at: d, productId: r.ProductID, name: r.ProductName, qty: q, channel: r.Channel, ref: r.Ref || '', by: r.By || '' });
    if (d < sinceIso) return;
    shipped[r.ProductID] = shipped[r.ProductID] || {}; shipped[r.ProductID][r.Channel] = (shipped[r.ProductID][r.Channel] || 0) + q;
    byChannel[r.Channel] = (byChannel[r.Channel] || 0) + q;
  });
  recent.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  var products = fg.map(function (r) {
    var sh = shipped[r.ProductID] || {}, shippedTotal = Object.keys(sh).reduce(function (s, k) { return s + sh[k]; }, 0);
    return { id: r.ProductID, name: r.ProductName, onHand: Number(r.OnHand) || 0, counted: !blankish(r.LastCountedAt),
             lastCountedAt: blankish(r.LastCountedAt) ? null : fmtDate(r.LastCountedAt), lastVariance: blankish(r.LastVariance) ? null : Number(r.LastVariance),
             produced: produced[r.ProductID] || 0, shipped: shippedTotal, shippedBy: sh,
             skus: { Shopify: r.ShopifySKU || '', Amazon: r.AmazonSKU || '', QuickBooks: r.QBOItem || '' } };
  }).sort(function (a, b) { return (b.onHand + b.produced + b.shipped) - (a.onHand + a.produced + a.shipped); });
  var props = null; try { props = PropertiesService.getScriptProperties(); } catch (e) { props = null; }
  return { ok: true, days: days, since: sinceIso, channels: CHANNELS, products: products, byChannel: byChannel, recent: recent.slice(0, 40),
           totals: { onHand: products.reduce(function (s, x) { return s + x.onHand; }, 0), produced: products.reduce(function (s, x) { return s + x.produced; }, 0),
                     shipped: products.reduce(function (s, x) { return s + x.shipped; }, 0), neverCounted: products.filter(function (x) { return !x.counted; }).length },
           shopify: { configured: !!(shopifyCreds().shop && shopifyCreds().token), last: props ? (props.getProperty('SHOPIFY_LAST') || null) : null } };
}

/* ============================================================================
 *  Self-update from GitHub
 *  (2.22.1 exists only to prove this round trip: pushed to main, never pasted.)
 *  ---------------------------------------------------------------------------
 *  The paste-and-redeploy round is the step that gets skipped. This replaces
 *  it: the script fetches its own source from GitHub, and if the BUILD_STAMP
 *  differs from the one running, writes it into this project through the
 *  Apps Script API, cuts a new version, points the existing web-app
 *  deployment at it, and checks the web app answers with the new stamp. If
 *  it does not, the deployment is rolled back to the previous version.
 *
 *  Why this works where clasp did not: the calls run as the sheet's owner,
 *  from inside Apps Script. The owner's Apps Script API toggle is on (that
 *  is the per-user gate that stopped the service account), and the grant a
 *  trigger runs under does not carry the reauth clock that killed the
 *  personal clasp login.
 *
 *  Needs, once: oauthScopes in appsscript.json that include script.projects,
 *  script.deployments and script.external_request (see the repo's
 *  apps-script/appsscript.json), then authorize when first run.
 *
 *  The manifest is never touched: the project's own appsscript.json is read
 *  back and written back unchanged, so web-app access settings survive.
 * ========================================================================== */
var GITHUB_RAW_CODE = 'https://raw.githubusercontent.com/dancynamon/Production-Throughput-and-Inventory/main/apps-script/Code.gs';
var SCRIPT_API = 'https://script.googleapis.com/v1/projects/';

function scriptApi(method, path, payload) {
  var res = UrlFetchApp.fetch(SCRIPT_API + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: payload === undefined ? undefined : JSON.stringify(payload)
  });
  var code = res.getResponseCode(), body = res.getContentText();
  if (code >= 300) {
    // The 403 that matters names the Cloud project the script runs under and
    // the page that switches the API on for it. Put that first.
    var enable = /https:\/\/console\.developers\.google\.com\/apis\/api\/script\.googleapis\.com\/overview\?project=\d+/.exec(body);
    var hint = enable ? ' — the Apps Script API is off for the Cloud project behind this script. Open ' + enable[0] + ' and click Enable, wait a minute, run this again. If that page refuses you, move the script to your own project: Project Settings → Google Cloud Platform (GCP) Project → Change project.'
      : code === 403 ? ' — check the Apps Script API toggle at script.google.com/home/usersettings and the oauthScopes in appsscript.json' : '';
    throw new Error('Apps Script API ' + method.toUpperCase() + ' ' + path.replace(/^[^\/]+\//, '…/') + ' → ' + code + hint + ' | ' + body.slice(0, 200));
  }
  return body ? JSON.parse(body) : {};
}
function sourceStamp(src)   { var m = /var BUILD_STAMP = '([^']+)'/.exec(src || ''); return m ? m[1] : null; }
function sourceVersion(src) { var m = /var BACKEND_VERSION = '([^']+)'/.exec(src || ''); return m ? m[1] : null; }

function fetchGitHubCode() {
  // Cache-bust: raw.githubusercontent.com can serve a copy a few minutes old.
  var res = UrlFetchApp.fetch(GITHUB_RAW_CODE + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('GitHub answered ' + res.getResponseCode() + ' for Code.gs');
  var src = res.getContentText();
  if (!/function doGet\(/.test(src) || !sourceStamp(src) || !sourceVersion(src)) throw new Error('The file on GitHub does not look like Code.gs — not deploying it.');
  return src;
}

/* The web-app deployment to advance. Remembered once found; set by hand from
 * the menu if the project has more than one. */
function webAppDeploymentId() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty('DEPLOYMENT_ID') || '').trim();
  if (id) return id;
  var list = scriptApi('get', ScriptApp.getScriptId() + '/deployments');
  var cands = (list.deployments || []).filter(function (d) {
    return d.deploymentConfig && d.deploymentConfig.versionNumber
      && (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP'; });
  });
  if (cands.length === 1) { props.setProperty('DEPLOYMENT_ID', cands[0].deploymentId); return cands[0].deploymentId; }
  throw new Error(cands.length
    ? 'This project has ' + cands.length + ' web-app deployments. Aquamentor → Set deployment ID… with the one from config.js.'
    : 'No versioned web-app deployment found. Deploy once by hand (Deploy → New deployment → Web app) first.');
}
function setDeploymentId() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Set deployment ID', 'The ID in the web-app URL: script.google.com/macros/s/<THIS>/exec\n(also in config.js on GitHub)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var id = String(r.getResponseText() || '').trim();
  if (!/^[\w-]{20,}$/.test(id)) { ui.alert('Not set', 'That does not look like a deployment ID.', ui.ButtonSet.OK); return; }
  PropertiesService.getScriptProperties().setProperty('DEPLOYMENT_ID', id);
  SpreadsheetApp.getActive().toast('Deployment ID saved', 'Aquamentor', 6);
}

/* The whole round. Returns what happened; throws when something went wrong
 * (after rolling the deployment back where that applies). */
function updateFromGitHub() {
  var src = fetchGitHubCode();
  var stamp = sourceStamp(src), version = sourceVersion(src);
  if (stamp === BUILD_STAMP) return { changed: false, stamp: stamp, version: version };

  var scriptId = ScriptApp.getScriptId();
  var content = scriptApi('get', scriptId + '/content');
  var codeFiles = (content.files || []).filter(function (f) { return f.type === 'SERVER_JS'; });
  if (codeFiles.length !== 1) throw new Error('Expected exactly one script file in the project, found ' + codeFiles.length + ' (' + codeFiles.map(function (f) { return f.name; }).join(', ') + '). Merge them into one before auto-updating.');
  var files = content.files.map(function (f) {
    return f.type === 'SERVER_JS' ? { name: f.name, type: f.type, source: src } : { name: f.name, type: f.type, source: f.source };
  });
  scriptApi('put', scriptId + '/content', { files: files });

  var depId = webAppDeploymentId();
  var dep = scriptApi('get', scriptId + '/deployments/' + depId);
  var prev = dep.deploymentConfig.versionNumber, desc = dep.deploymentConfig.description || 'Aquamentor Production';
  var ver = scriptApi('post', scriptId + '/versions', { description: 'Auto-update ' + version + ' (' + stamp + ')' });
  var config = function (n) { return { deploymentConfig: { scriptId: scriptId, versionNumber: n, manifestFileName: 'appsscript', description: desc } }; };
  scriptApi('put', scriptId + '/deployments/' + depId, config(ver.versionNumber));

  // Canary: the live web app must answer with the new stamp, anonymously,
  // the way a phone reaches it. Otherwise put the old version back.
  var why = '';
  try {
    var r = UrlFetchApp.fetch('https://script.google.com/macros/s/' + depId + '/exec?action=config', { muteHttpExceptions: true, followRedirects: true });
    var body = r.getContentText();
    if (r.getResponseCode() !== 200) why = 'HTTP ' + r.getResponseCode();
    else if (body.indexOf(stamp) === -1) why = 'it answered without the new build stamp: ' + body.slice(0, 160);
  } catch (e) { why = String(e && e.message ? e.message : e); }
  if (why) {
    scriptApi('put', scriptId + '/deployments/' + depId, config(prev));
    throw new Error('Version ' + ver.versionNumber + ' (' + version + ') went live but ' + why + '. Rolled the deployment back to version ' + prev + '. The editor holds the new code; check it and deploy by hand.');
  }
  try { PropertiesService.getScriptProperties().setProperty('LAST_AUTO_UPDATE', new Date().toISOString() + ' → ' + version + ' (' + stamp + ') as version ' + ver.versionNumber); } catch (e2) {}
  return { changed: true, stamp: stamp, version: version, versionNumber: ver.versionNumber, previous: prev };
}

function updateFromGitHubMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = updateFromGitHub();
    ui.alert(r.changed ? 'Updated' : 'Already current',
      r.changed ? 'Backend ' + r.version + ' (' + r.stamp + ') is live as deployment version ' + r.versionNumber + '. Phones pick it up on their next request.'
                : 'GitHub has ' + r.version + ' (' + r.stamp + '), which is what is running.', ui.ButtonSet.OK);
  } catch (e) { ui.alert('Update failed', String(e && e.message ? e.message : e), ui.ButtonSet.OK); }
}

/* Trigger handler. Mails on a change, and on a NEW failure — the same
 * failure every 30 minutes would be one email, not forty-eight. */
function autoUpdateFromGitHub() {
  var props = PropertiesService.getScriptProperties(), to = digestRecipients();
  try {
    var r = updateFromGitHub();
    if (r.changed) {
      props.deleteProperty('AUTO_UPDATE_ERROR');
      if (to) MailApp.sendEmail({ to: to, subject: 'Aquamentor backend updated to ' + r.version,
        body: 'Deployed automatically from GitHub.\n\nBuild: ' + r.stamp + '\nDeployment version: ' + r.versionNumber + ' (was ' + r.previous + ')\n\nApp: ' + APP_PUBLIC_URL });
    }
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (props.getProperty('AUTO_UPDATE_ERROR') !== msg) {
      props.setProperty('AUTO_UPDATE_ERROR', msg);
      if (to) MailApp.sendEmail({ to: to, subject: 'Aquamentor auto-update failed', body: msg + '\n\nIt will keep trying every 30 minutes and mail again only if the error changes. To stop: Aquamentor → Turn off auto-update.' });
    }
  }
}
function autoUpdateOn() {
  autoUpdateOff();
  ScriptApp.newTrigger('autoUpdateFromGitHub').timeBased().everyMinutes(30).create();
  SpreadsheetApp.getActive().toast('Auto-update is on: GitHub main is checked every 30 minutes.', 'Aquamentor', 8);
}
function autoUpdateOff() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'autoUpdateFromGitHub') ScriptApp.deleteTrigger(t); });
}
function autoUpdateOffMenu() { autoUpdateOff(); SpreadsheetApp.getActive().toast('Auto-update is off', 'Aquamentor', 6); }

/* ============================================================================
 *  Helpers
 * ========================================================================== */
function readObjects(tabName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0], out = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    out.push(obj);
  }
  return out;
}

/* Append a row by HEADER NAME rather than position.
 *
 * appendRow() is positional, so the moment a sheet's columns and the code's
 * expectation diverge — which is exactly what happens when a column is added
 * to a sheet that already has data — every value lands one place off and the
 * row is silently wrong. Matching on the header makes an extra or reordered
 * column harmless, and a missing one just writes blank. */
function appendByHeader(sh, obj) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '';
  }));
}

function writeTab(ss, tabName, headers, rows) {
  var sh = freshSheet(ss, tabName);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#ffffff');
  if (rows && rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
  for (var c = 1; c <= headers.length; c++) sh.autoResizeColumn(c);
  return sh;
}

function freshSheet(ss, tabName) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) sh = ss.insertSheet(tabName); else sh.clear();
  return sh;
}

function setColumnFormula(ss, tabName, col, template) {
  var sh = ss.getSheetByName(tabName), last = sh.getLastRow();
  for (var r = 2; r <= last; r++) sh.getRange(r, col).setFormula(template.replace(/\{r\}/g, r));
}

function respond(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* Normalize a WorkDate cell (string or Date) to 'YYYY-MM-DD'. */
function fmtDate(v) {
  if (v instanceof Date) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v || '').trim();
}
