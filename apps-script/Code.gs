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
  overview:  'Overview'
};

// The production pipeline, in order, with throughput rates (tubes/hour) taken
// from your Throughput sheet (ideal vs floor).
var STAGES = [
  ['Cut',             30, 30],
  ['Glued',           30, 15],
  ['Meshed',          30, 20],
  ['Patched',         15, 15],
  ['Paint 1',         25, 18],
  ['Paint 2',         25, 18],
  ['Printed',         45, 64],
  ['Straps Attached', 25, 20],
  ['Boxed',           30, 20]
];
function stageNames() { return STAGES.map(function (s) { return s[0]; }); }

/* ============================================================================
 *  1. SETUP
 * ========================================================================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- Products (start with the two main tubes; add rows to expand) --------
  writeTab(ss, TAB.products,
    ['ProductID', 'ProductName', 'Unit', 'Active'],
    [
      ['XRT50', 'XRT-50 Rescue Tube', 'each', 'YES'],
      ['XRT40', 'XRT-40 Rescue Tube', 'each', 'YES']
    ]);

  // ---- Stages (the pipeline + throughput rates) ----------------------------
  writeTab(ss, TAB.stages,
    ['Order', 'Stage', 'IdealRate_perHr', 'FloorRate_perHr'],
    STAGES.map(function (s, i) { return [i + 1, s[0], s[1], s[2]]; }));

  // ---- RawMaterials --------------------------------------------------------
  // M001–M033 from your "Raw Material Inventory" sheet (3/1/2023 counts; blank
  // = not yet counted). M034–M037 come from the COGS build (foam, adhesive,
  // paint, ink) — they aren't on the count sheet yet, so count/receive them.
  writeTab(ss, TAB.materials,
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
      ['M037', 'UV White Ink (print)',     'unit',          '',   1,    '', 'Ink & Coating',    'ESTIMATE 0.007 unit/tube (COGS top-down) — send real ink-per-batch to refine']
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
  writeTab(ss, TAB.bom,
    ['ProductID', 'Stage', 'MaterialID', 'QtyPerUnit'],
    [
      // XRT-50
      ['XRT50', 'Cut',             'M034', 0.1333],
      ['XRT50', 'Glued',           'M035', 0.1522],
      ['XRT50', 'Meshed',          'M002', 0.004],    // boxes (250 tubes/box)
      ['XRT50', 'Patched',         'M003', 0.000103],  // rolls  (2 patches/tube)
      ['XRT50', 'Patched',         'M004', 0.012571],  // CA glue lb  (44lb/3500)
      ['XRT50', 'Patched',         'M005', 0.001429],  // accelerant gal (5gal/3500)
      ['XRT50', 'Paint 1',         'M036', 0.0769],
      ['XRT50', 'Paint 2',         'M036', 0.0769],
      ['XRT50', 'Printed',         'M037', 0.007],      // ink — ESTIMATE
      ['XRT50', 'Straps Attached', 'M014', 1.78],
      ['XRT50', 'Straps Attached', 'M015', 2.44],
      ['XRT50', 'Straps Attached', 'M019', 1.58],
      ['XRT50', 'Straps Attached', 'M023', 1],
      ['XRT50', 'Straps Attached', 'M024', 1],
      ['XRT50', 'Boxed',           'M031', 0.002],
      ['XRT50', 'Boxed',           'M033', 0.0833],
      // XRT-40 — length-based ×0.8 (foam/mesh/paint/webbing); patch & CA are
      // per-end so same as 50"; hardware/box same.  (all confirm)
      ['XRT40', 'Cut',             'M034', 0.1067],
      ['XRT40', 'Glued',           'M035', 0.1218],
      ['XRT40', 'Meshed',          'M002', 0.0032],   // boxes (~310 tubes/box)
      ['XRT40', 'Patched',         'M003', 0.000103],
      ['XRT40', 'Patched',         'M004', 0.012571],
      ['XRT40', 'Patched',         'M005', 0.001429],
      ['XRT40', 'Paint 1',         'M036', 0.0615],
      ['XRT40', 'Paint 2',         'M036', 0.0615],
      ['XRT40', 'Printed',         'M037', 0.007],
      ['XRT40', 'Straps Attached', 'M014', 1.424],
      ['XRT40', 'Straps Attached', 'M015', 1.952],
      ['XRT40', 'Straps Attached', 'M019', 1.264],
      ['XRT40', 'Straps Attached', 'M023', 1],
      ['XRT40', 'Straps Attached', 'M024', 1],
      ['XRT40', 'Boxed',           'M031', 0.002],
      ['XRT40', 'Boxed',           'M033', 0.0833]
    ]);

  // ---- StageLog: filled by the phone app (start with headers) --------------
  writeTab(ss, TAB.stagelog,
    ['Timestamp', 'WorkDate', 'Employee', 'ProductID', 'ProductName', 'Stage', 'Qty', 'Notes'],
    []);

  // ---- ReceivingLog --------------------------------------------------------
  writeTab(ss, TAB.receiving,
    ['Timestamp', 'Employee', 'MaterialID', 'MaterialName', 'QtyAdded', 'Notes'],
    []);

  // ---- Employees -----------------------------------------------------------
  writeTab(ss, TAB.employees, ['Name', 'Active'],
    [['Maria', 'YES'], ['James', 'YES'], ['Priya', 'YES'], ['Sam', 'YES']]);

  // ---- Planning: your daily build target per product (drives next-day goals)-
  writeTab(ss, TAB.planning, ['ProductID', 'ProductName', 'DailyTarget'],
    [['XRT50', 'XRT-50 Rescue Tube', 60], ['XRT40', 'XRT-40 Rescue Tube', 40]]);

  rebuildOverview();
  SpreadsheetApp.getActive().toast('Setup complete — stage-based tracking ready.', 'Aquamentor', 5);
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
    else if (action === 'submitDay') result = submitDay(p);
    else if (action === 'receive')   result = receiveStock(p);
    else result = { ok: false, error: 'Unknown action: ' + action };
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return respond(result, p.callback);
}

function getConfig() {
  var products = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return { id: r.ProductID, name: r.ProductName }; });
  var employees = readObjects(TAB.employees)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; })
    .map(function (r) { return r.Name; });
  var materials = readObjects(TAB.materials)
    .map(function (m) { return { id: m.MaterialID, name: m.MaterialName, unit: m.Unit }; });
  return { ok: true, products: products, employees: employees, materials: materials, stages: stageNames() };
}

function getStock() {
  var mats = readObjects(TAB.materials).map(function (m) {
    var counted = !(m.OnHand === '' || m.OnHand === null || m.OnHand === undefined);
    var onHand = Number(m.OnHand) || 0, reorder = Number(m.ReorderPoint) || 0;
    return {
      id: m.MaterialID, name: m.MaterialName, unit: m.Unit, category: m.Category || '',
      onHand: onHand, counted: counted, reorderPoint: reorder, low: counted && onHand <= reorder
    };
  });
  return { ok: true, materials: mats };
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

  var valid = stageNames();
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
      message: 'Logged ' + total + ' tube-stages for ' + product.ProductName + ' on ' + workDate,
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

/* ============================================================================
 *  3. OVERVIEW / STATE MACHINE
 *  For each product: completed-per-stage (all time), WIP waiting before each
 *  stage, and a suggested next-day goal per stage. Also raw-material status.
 * ========================================================================== */
function computeOverview() {
  var stages = stageNames();
  var targets = {};
  readObjects(TAB.planning).forEach(function (r) { targets[r.ProductID] = Number(r.DailyTarget) || 0; });

  // completed[productId][stage] = sum of StageLog Qty
  var completed = {};
  readObjects(TAB.stagelog).forEach(function (r) {
    var pid = r.ProductID, st = r.Stage;
    completed[pid] = completed[pid] || {};
    completed[pid][st] = (completed[pid][st] || 0) + (Number(r.Qty) || 0);
  });

  var products = readObjects(TAB.products)
    .filter(function (r) { return String(r.Active).toUpperCase() !== 'NO'; });

  var out = products.map(function (pr) {
    var pid = pr.ProductID, done = completed[pid] || {}, target = targets[pid] || 0;
    var rows = stages.map(function (st, idx) {
      var doneHere = done[st] || 0;
      var upstream = idx === 0 ? null : (done[stages[idx - 1]] || 0);
      var waiting  = idx === 0 ? null : Math.max(0, upstream - doneHere);   // WIP between prev and this
      // Suggested next-day: first stage aims at the daily target; later stages
      // clear the WIP waiting for them, capped at the target.
      var suggest  = idx === 0 ? target : Math.min(target, waiting);
      var starved  = idx > 0 && waiting < target;
      return { stage: st, completed: doneHere, waiting: waiting, suggest: suggest, starved: starved };
    });
    return { productId: pid, name: pr.ProductName, dailyTarget: target,
             finished: done[stages[stages.length - 1]] || 0, stages: rows };
  });
  return out;
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
    sh.getRange(row, 1).setValue(pr.name + '   (daily target ' + pr.dailyTarget + ', finished ' + pr.finished + ')')
      .setFontWeight('bold').setFontColor('#0c1f3f');
    row++;
    sh.getRange(row, 1, 1, 5).setValues([['Stage', 'Completed', 'WIP waiting', 'Suggested next day', 'Note']])
      .setFontWeight('bold').setBackground('#0c1f3f').setFontColor('#fff');
    row++;
    pr.stages.forEach(function (s) {
      sh.getRange(row, 1, 1, 5).setValues([[
        s.stage, s.completed, s.waiting === null ? '' : s.waiting, s.suggest,
        s.starved ? 'upstream short' : '']]);
      row++;
    });
    row++;
  });
  for (var c = 1; c <= 5; c++) sh.autoResizeColumn(c);
  SpreadsheetApp.getActive().toast('Overview rebuilt.', 'Aquamentor', 3);
}

/* ============================================================================
 *  Menu
 * ========================================================================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Aquamentor')
    .addItem('Build / reset all tabs (setup)', 'setup')
    .addItem('Rebuild overview / next-day goals', 'rebuildOverview')
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
