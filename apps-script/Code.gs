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
  overview:  'Overview'
};

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
var COUNTLOG_HEADERS = ['Timestamp', 'MaterialID', 'MaterialName', 'Unit',
                        'EstimatedAtCount', 'CountedQty', 'Variance', 'VariancePct',
                        'CountedBy', 'Notes'];

// Appended to RawMaterials by enableCountReconciliation() on an existing sheet.
var COUNT_COLUMNS = ['LastCounted', 'LastCountedAt', 'LastVariance'];

// Manager PIN — the three owners type this to unlock the full site (Overview,
// Receive). Employees never see it; it lives here on the server, not in the
// public app code. CHANGE THIS to your own code.
var MANAGER_PIN = '2468';

// Reported to the app and shown in its footer, so you can tell which backend a
// phone is actually talking to. Bump this when you change this file, and
// remember it only reaches the app after Deploy > Manage deployments >
// Edit > New version.
var BACKEND_VERSION = '2.2.0';

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

var PRODUCT_HEADERS = ['ProductID', 'ProductName', 'Line', 'Unit', 'Active', 'FeedsFrom'];

var PRODUCT_ROWS = (function () {
  var rows = [];
  TUBE_SIZES.forEach(function (s) {
    rows.push([s.blank, s.label + ' Blank (uncommitted)',   'Blank',   'each', 'YES', '']);
    rows.push([s.exo,   'XRT-' + s.label.replace('"', '') + ' Exotube (meshed)',
                                                            'TubeExo', 'each', 'YES', s.blank]);
    rows.push([s.std,   'XRT-' + s.label.replace('"', '') + ' Standard (unmeshed)',
                                                            'TubeStd', 'each', 'YES', s.blank]);
  });
  return rows.concat([
    // Foam-mat shapes (size buckets) — CNC → Clean → Box, foam by area
    ['SHP16',   'Shape 16x16',        'Shape', 'each', 'YES', ''],
    ['SHP24',   'Shape 24x24',        'Shape', 'each', 'YES', ''],
    ['SHP36',   'Shape 36x36',        'Shape', 'each', 'YES', ''],
    ['SHP4824', 'Shape 48x24',        'Shape', 'each', 'YES', ''],
    ['SHP48',   'Shape 48x48',        'Shape', 'each', 'YES', ''],
    ['SHP7236', 'Shape 72x36',        'Shape', 'each', 'YES', ''],
    // Kickboards
    ['KB914',   'Kickboard 9x14',     'Shape', 'each', 'YES', ''],
    ['KB1116',  'Kickboard 11x16.5',  'Shape', 'each', 'YES', ''],
    ['KB1220',  'Kickboard 11.8x20',  'Shape', 'each', 'YES', ''],
    // Lifeguard chairs — Cut → Assemble → Box; lumber + hardware
    ['LGC30',   'Lifeguard Chair 30"','Chair', 'each', 'YES', ''],
    ['LGC40',   'Lifeguard Chair 40"','Chair', 'each', 'YES', ''],
    ['LGC50',   'Lifeguard Chair 50"','Chair', 'each', 'YES', ''],
    ['LGC60',   'Lifeguard Chair 60"','Chair', 'each', 'YES', ''],
    ['LGC72',   'Lifeguard Chair 72"','Chair', 'each', 'YES', '']
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
        [pid, 'Straps Attached', 'M014', s.web1red],
        [pid, 'Straps Attached', 'M015', s.web1blk],
        [pid, 'Straps Attached', 'M019', s.web2blk],
        [pid, 'Straps Attached', 'M023', 1],
        [pid, 'Straps Attached', 'M024', 1],
        [pid, 'Boxed',           'M031', 0.002],
        [pid, 'Boxed',           'M033', 0.0833]
      );
    });
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
  seed(TAB.materials,
    ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint', 'Status', 'Category', 'Notes'],
    [
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
      ['M043', 'Chair Hardware Kit',       'kits',          '',   20,   '', 'Chair Hardware',   '1 kit per chair (bolts/nuts/washers/screws). Itemize later if wanted.']
    ]);
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
  seed(TAB.stagelog,
    ['Timestamp', 'WorkDate', 'Employee', 'ProductID', 'ProductName', 'Stage', 'Qty', 'Notes'],
    []);

  // ---- ReceivingLog --------------------------------------------------------
  seed(TAB.receiving,
    ['Timestamp', 'Employee', 'MaterialID', 'MaterialName', 'QtyAdded', 'Notes'],
    []);

  // ---- CountLog: physical stocktakes, appended by submitCount() ------------
  seed(TAB.countlog, COUNTLOG_HEADERS, []);

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
   TAB.countlog].forEach(function (t) {
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
  say('Lines defined in code', typeof LINES === 'undefined'
    ? '(undefined)' : Object.keys(LINES).join(', '));
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

/* Turn on estimated-vs-actual on a sheet that predates it.
 *
 * Deliberately additive: it APPENDS the three reconciliation columns to
 * RawMaterials and creates CountLog, and touches no existing cell. Your
 * on-hand numbers, reorder points, categories and notes are untouched, so
 * unlike the other migrations this one needs no confirmation and is safe to
 * run twice — the second run reports that there was nothing to do. */
function enableCountReconciliation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var did = [];

  var matSheet = ss.getSheetByName(TAB.materials);
  if (!matSheet) {
    SpreadsheetApp.getActive().toast('No RawMaterials tab — run setup first.', 'Aquamentor', 6);
    return;
  }

  var headers = matSheet.getRange(1, 1, 1, matSheet.getLastColumn()).getValues()[0];
  var missing = COUNT_COLUMNS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    var all = headers.concat(missing);
    matSheet.getRange(1, 1, 1, all.length).setValues([all])
      .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#ffffff');
    did.push('added ' + missing.join(', ') + ' to RawMaterials');
  }

  if (!ss.getSheetByName(TAB.countlog)) {
    writeTab(ss, TAB.countlog, COUNTLOG_HEADERS, []);
    did.push('created CountLog');
  }

  SpreadsheetApp.getActive().toast(
    did.length ? did.join('; ') + '. No existing values were changed.'
               : 'Already enabled — nothing to do.',
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
      + '   XRT50STD / XRT40STD    Patched → … → Boxed\n\n'
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
function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};
  var action = p.action || 'config';
  var result;
  try {
    if      (action === 'config')    result = getConfig();
    else if (action === 'stock')     result = getStock();
    else if (action === 'overview')  result = getOverview();
    else if (action === 'today')     result = getToday(p);
    else if (action === 'submitDay') result = submitDay(p);
    else if (action === 'receive')   result = receiveStock(p);
    else if (action === 'count')     result = submitCount(p);
    else if (action === 'auth')      result = { ok: String(p.pin || '') === MANAGER_PIN };
    else result = { ok: false, error: 'Unknown action: ' + action };
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return respond(result, p.callback);
}

function getConfig() {
  var products = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return { id: r.ProductID, name: r.ProductName, line: r.Line || 'Blank' }; });
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
  return { ok: true, products: products, employees: employees, materials: materials,
           lines: lines, stages: stageNames(),
           backendVersion: BACKEND_VERSION, sheetName: ss.getName(), sheetId: ss.getId() };
}

function getStock() {
  var mats = readObjects(TAB.materials).map(function (m) {
    var counted = !(m.OnHand === '' || m.OnHand === null || m.OnHand === undefined);
    var onHand = Number(m.OnHand) || 0, reorder = Number(m.ReorderPoint) || 0;
    return {
      id: m.MaterialID, name: m.MaterialName, unit: m.Unit, category: m.Category || '',
      onHand: onHand, counted: counted, reorderPoint: reorder, low: counted && onHand <= reorder,
      // Reconciliation. onHand is the ESTIMATE; lastCounted is the last actual.
      lastCounted:   m.LastCounted === '' || m.LastCounted === undefined ? null : Number(m.LastCounted),
      lastCountedAt: m.LastCountedAt ? fmtDate(m.LastCountedAt) : null,
      lastVariance:  m.LastVariance === '' || m.LastVariance === undefined ? null : Number(m.LastVariance)
    };
  });
  return { ok: true, materials: mats };
}

/*
 * Today's totals for the employee landing page: per product, how many were
 * finished at each stage on the given work date (all staff combined).
 */
function getToday(p) {
  var workDate = String(p.workDate || '').trim();
  if (!workDate) return { ok: false, error: 'No work date' };
  var lineMap = productLineMap(), byProduct = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    if (fmtDate(r.WorkDate) !== workDate) return;
    var pid = r.ProductID;
    byProduct[pid] = byProduct[pid] || { name: r.ProductName, stages: {} };
    byProduct[pid].stages[r.Stage] = (byProduct[pid].stages[r.Stage] || 0) + (Number(r.Qty) || 0);
  });
  var products = Object.keys(byProduct).map(function (pid) {
    var stages = stagesForLine(lineMap[pid] || 'Blank');
    return {
      productId: pid, name: byProduct[pid].name,
      rows: stages.map(function (s) { return { stage: s, qty: byProduct[pid].stages[s] || 0 }; }),
      total: stages.reduce(function (a, s) { return a + (byProduct[pid].stages[s] || 0); }, 0)
    };
  });
  return { ok: true, workDate: workDate, products: products };
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
  var counts;
  try { counts = JSON.parse(p.counts || '{}'); } catch (e) { return { ok: false, error: 'Bad counts payload' }; }

  if (!workDate)  return { ok: false, error: 'Please pick the work date.' };
  if (!employee)  return { ok: false, error: 'Please pick who you are.' };
  if (!productId) return { ok: false, error: 'Please pick a product.' };

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
    var logged = [], consumed = {}, warnings = [], now = new Date();

    valid.forEach(function (stage) {
      var qty = Number(counts[stage]) || 0;
      if (qty <= 0) return;
      logSheet.appendRow([now, workDate, employee, productId, product.ProductName, stage, qty, notes]);
      logged.push({ stage: stage, qty: qty });

      bom.filter(function (r) { return r.Stage === stage; }).forEach(function (r) {
        var ri = rowOf[r.MaterialID];
        if (ri === undefined) return;
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

    return {
      ok: true,
      message: 'Logged ' + total + ' stage entries for ' + product.ProductName + ' on ' + workDate,
      logged: logged,
      consumed: Object.keys(consumed).map(function (k) {
        return { name: consumed[k].name, used: consumed[k].used, onHand: consumed[k].onHand, unit: consumed[k].unit };
      }),
      warnings: warnings
    };
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
    ss.getSheetByName(TAB.receiving).appendRow([new Date(), employee, materialId, name, qty, notes]);
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
             + 'Run Aquamentor → Enable count reconciliation first.' };
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

      logSheet.appendRow([now, id, name, unit, estimated, countedQty, variance, pct, employee, notes]);

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

  // completed[productId][stage] = sum of StageLog Qty
  var completed = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    var pid = r.ProductID, st = r.Stage;
    completed[pid] = completed[pid] || {};
    completed[pid][st] = (completed[pid][st] || 0) + (Number(r.Qty) || 0);
  });
  function done(pid, stage) { return (completed[pid] || {})[stage] || 0; }
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

    return { productId: pid, name: pr.ProductName, feedsFrom: feeder || null,
             finished: done(pid, stages[stages.length - 1]), stages: rows };
  });
}

function getOverview() {
  return { ok: true, products: computeOverview(), materials: getStock().materials, stages: stageNames() };
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
    .addSeparator()
    .addItem('Enable count reconciliation', 'enableCountReconciliation')
    .addItem('Migrate to Blank → Exo/Standard', 'migrateToVariantLines')
    .addItem('⚠ Erase and rebuild ALL tabs', 'resetAllTabs')
    .addToUi();
}

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
