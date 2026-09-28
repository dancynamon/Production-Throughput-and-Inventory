/* Reconcile: three counts scored against what the app believed at the moment
 * of each count. Pinned: a walk freezes the app's estimate beside the count;
 * the floor score only uses walks that carry an estimate and never the
 * (finished) pile; short/extra are relative to the app's number; within 10%
 * or one unit is close; the worst offenders come first; storage says what
 * moved since its count; and the to-do list says which count is due.
 *
 * Run:  node apps-script/test-reconcile.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');

function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return {
    getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) {
      return {
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) out.push((grid[r - 1 + i] || []).slice(c - 1, c - 1 + (nc || 1))); return out; },
        setValue: (v) => { grid[r - 1][c - 1] = v; },
        setValues: (vals) => { vals.forEach((row, i) => { grid[r - 1 + i] = row.slice(); }); return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) }; }
      };
    },
    appendRow(row) { grid.push(row.slice()); }, setFrozenRows() {}, autoResizeColumn() {}, grid
  };
}
const objs = (sheet) => { const [h, ...rows] = sheet.grid; return rows.map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };
// D is defined after the sandbox exists: sheet dates must be instances of the
// sandbox's own Date, or `instanceof Date` inside Code.gs is false.
let D;

const PRODUCTS = [
  { ProductID: 'BLANK50', ProductName: '50" Blank', Line: 'Blank', Active: 'YES', FeedsFrom: '', OutputMaterial: '' },
  { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exotube', Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50', OutputMaterial: '' },
  { ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Line: 'Chair', Active: 'YES', FeedsFrom: '', OutputMaterial: '' }
];
const STAGES = [
  { Line: 'Blank', Order: 1, Stage: 'Cut' }, { Line: 'Blank', Order: 2, Stage: 'Glued' },
  { Line: 'TubeExo', Order: 1, Stage: 'Meshed' }, { Line: 'TubeExo', Order: 2, Stage: 'Boxed' },
  { Line: 'Chair', Order: 1, Stage: 'Cut' }, { Line: 'Chair', Order: 2, Stage: 'Assemble' }, { Line: 'Chair', Order: 3, Stage: 'Box' }
];
const sheets = {};
const WIP_H = ['Timestamp', 'ProductID', 'ProductName', 'Stage', 'WaitingBefore', 'CountedBy', 'Notes', 'EstimatedAtCount'];
const CL_H = ['Timestamp', 'MaterialID', 'MaterialName', 'Unit', 'EstimatedAtCount', 'CountedQty', 'Variance', 'VariancePct', 'CountedBy', 'Notes'];
function reset() {
  sheets.RawMaterials = fakeSheet(['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint', 'LastCounted', 'LastCountedAt', 'LastVariance'], [
    ['M014', 'Red Webbing', 'Yards', 88, 50, 88, D('2026-09-21'), 12],     // counted: app said 100, shelf 88
    ['M020', 'Foam Sheet', 'Sheets', 40, 10, 40, D('2026-09-14'), -2],     // app said 38, shelf 40: close
    ['M033', 'Boxes', 'Boxes', -5, 50, '', '', ''],                        // never counted, negative
    ['M044', 'Strap', 'each', '', 5, '', '', '']                            // never counted
  ]);
  sheets.CountLog = fakeSheet(CL_H, [
    [D('2026-09-07'), 'M014', 'Red Webbing', 'Yards', 120, 110, 10, 8.33, 'John', ''],
    [D('2026-09-14'), 'M020', 'Foam Sheet', 'Sheets', 38, 40, -2, -5.26, 'John', ''],
    [D('2026-09-21'), 'M014', 'Red Webbing', 'Yards', 100, 88, 12, 12, 'John', ''],
    [D('2026-09-20'), 'XRT50EXO', 'XRT-50 Exotube', 'finished', 28, 25, 3, 10.71, 'John', '']
  ]);
  sheets.WipBaseline = fakeSheet(WIP_H, [
    [D('2026-09-01'), 'LGC30', 'Lifeguard Chair 30"', 'Assemble', 4, 'Dan', '', ''],        // old walk, no estimate kept
    [D('2026-09-22'), 'LGC30', 'Lifeguard Chair 30"', 'Assemble', 6, 'John', '', 5],
    [D('2026-09-22'), 'LGC30', 'Lifeguard Chair 30"', 'Box', 2, 'John', '', 9],
    [D('2026-09-22'), 'LGC30', 'Lifeguard Chair 30"', '(finished)', 3, 'John', '', 30],   // ignored: storage scores itself
    [D('2026-09-15'), 'XRT50EXO', 'XRT-50 Exotube', 'Boxed', 42, 'John', '', 30]
  ]);
  sheets.FinishedGoods = fakeSheet(['ProductID', 'ProductName', 'OnHand', 'LastCounted', 'LastCountedAt', 'LastVariance', 'ShopifySKU', 'AmazonSKU', 'QBOItem', 'Notes'], [
    ['XRT50EXO', 'XRT-50 Exotube', 53, 25, D('2026-09-20'), 3, '', '', '', ''],
    ['LGC30', 'Lifeguard Chair 30"', 0, '', '', '', '', '', '', '']
  ]);
  sheets.StageLog = fakeSheet(['Timestamp', 'WorkDate', 'Employee', 'ProductID', 'ProductName', 'Stage', 'Qty', 'Notes', 'Hours'], [
    [D('2026-09-19'), D('2026-09-19'), 'Maria', 'XRT50EXO', 'XRT-50 Exotube', 'Boxed', 15, '', ''],   // before the count
    [D('2026-09-23'), D('2026-09-23'), 'Maria', 'XRT50EXO', 'XRT-50 Exotube', 'Boxed', 40, '', ''],   // after
    [D('2026-09-23'), D('2026-09-23'), 'Maria', 'XRT50EXO', 'XRT-50 Exotube', 'Meshed', 40, '', '']
  ]);
  sheets.ShipLog = fakeSheet(['Timestamp', 'ShipDate', 'ProductID', 'ProductName', 'Qty', 'Channel', 'Ref', 'By', 'Notes', 'Key'], [
    [D('2026-09-24'), D('2026-09-24'), 'XRT50EXO', 'XRT-50 Exotube', 12, 'Shopify', '#1', 'Maria', '', 'k1'],
    [D('2026-09-18'), D('2026-09-18'), 'XRT50EXO', 'XRT-50 Exotube', 5, 'Amazon', '#0', 'Maria', '', 'k0']
  ]);
}
let store = {};
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = fakeSheet([], []); return sheets[n]; } }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) },
  Utilities: { getUuid: () => 'u', DigestAlgorithm: {}, Charset: {}, computeDigest: () => [] },
  ScriptApp: { getProjectTriggers: () => [] }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, Error
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.writeTab = (ss, name, headers, rows) => { sheets[name] = fakeSheet(headers, rows || []); return sheets[name]; };
sandbox.readObjects = (tab) => {
  if (tab === 'Products') return PRODUCTS; if (tab === 'Stages') return STAGES;
  if (tab === 'BOM' || tab === 'Employees' || tab === 'Planning' || tab === 'ReceivingLog') return [];
  return sheets[tab] ? objs(sheets[tab]) : [];
};
// Pin "today" so days-since is stable.
const RealDate = Date;
sandbox.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-09-28T12:00:00'])); } static now() { return new RealDate('2026-09-28T12:00:00').getTime(); } };
D = (s) => new sandbox.Date(s + 'T12:00:00');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

/* --- Words and closeness --------------------------------------------------- */
check('short means the count found less than the app said', sandbox.reconcileWords(100, 88), '12 short');
check('extra means more', sandbox.reconcileWords(30, 42), '12 extra');
check('matched', sandbox.reconcileWords(5, 5), 'matched');
check('within 10% is close; one unit always is', [sandbox.reconcileClose(100, 91), sandbox.reconcileClose(100, 88), sandbox.reconcileClose(3, 4), sandbox.reconcileClose(0, 1), sandbox.reconcileClose(0, 2)], [true, false, true, true, false]);

/* --- A walk freezes the app's estimate beside the count -------------------- */
reset();
sheets.WipBaseline = fakeSheet(WIP_H, []);
const walk = sandbox.submitWipWalk({ employee: 'John', walk: JSON.stringify({ XRT50EXO: { Boxed: 7, '(finished)': 1 } }) });
check('the walk is recorded', walk.ok, true);
const wrote = objs(sheets.WipBaseline);
check('every row carries EstimatedAtCount (a number, never blank, on a live product)', wrote.filter((r) => r.Stage === 'Boxed' || r.Stage === '(finished)').map((r) => [r.Stage, r.WaitingBefore, typeof r.EstimatedAtCount]), [['Boxed', 7, 'number'], ['(finished)', 1, 'number']]);
check('no row is left without the app\'s guess', wrote.filter((r) => r.EstimatedAtCount === '').length, 0);

/* --- The scoreboard --------------------------------------------------------- */
reset();
const r = sandbox.getReconcile();
check('ok', r.ok, true);
check('floor: latest walk wins, per product, only rows with an estimate, never (finished)',
  r.floor.products.map((p) => [p.id, p.at, p.stages.map((s) => [s.stage, s.estimated, s.counted, s.words, s.close])]),
  [['LGC30', '2026-09-22', [['Assemble', 5, 6, '1 extra', true], ['Box', 9, 2, '7 short', false]]],
   ['XRT50EXO', '2026-09-15', [['Boxed', 30, 42, '12 extra', false]]]]);
check('floor headline: walked when, by whom, how many close', [r.floor.walkedAt, r.floor.walkedBy, r.floor.daysSince, r.floor.compared, r.floor.close], ['2026-09-22', 'John', 6, 3, 1]);
check('floor worst first, by size of the miss', r.floor.worst.map((w) => [w.product, w.stage, w.words]), [['XRT-50 Exotube', 'Boxed', '12 extra'], ['Lifeguard Chair 30"', 'Box', '7 short']]);
check('products never walked are named', r.floor.neverWalked, ['50" Blank']);

check('shelf: each counted material scored on its latest count', r.shelf.counted.map((m) => [m.id, m.at, m.estimated, m.counted, m.words, m.close]),
  [['M014', '2026-09-21', 100, 88, '12 short', false], ['M020', '2026-09-14', 38, 40, '2 extra', true]]);
check('shelf headline', [r.shelf.lastAt, r.shelf.daysSince, r.shelf.compared, r.shelf.close, r.shelf.neverCounted, r.shelf.negative], ['2026-09-21', 7, 2, 1, 2, 1]);
check('shelf worst by percent', r.shelf.worst.map((m) => m.name), ['Red Webbing']);
check('count next carries names, never-counted first', r.shelf.countNext.map((m) => m.name).slice(0, 2), ['Boxes', 'Strap']);

check('storage: last count scored, and what moved since it',
  r.storage.products.map((p) => [p.id, p.at, p.estimated, p.counted, p.words, p.madeSince, p.shippedSince, p.onHand]),
  [['XRT50EXO', '2026-09-20', 28, 25, '3 short', 40, 12, 53], ['LGC30', null, null, null, null, 0, 0, 0]]);
check('storage headline', [r.storage.lastAt, r.storage.daysSince, r.storage.compared, r.storage.close, r.storage.neverCounted], ['2026-09-20', 8, 1, 0, 1]);

check('to-do: floor recent, shelf due at a week, storage due', r.todo.map((t) => [t.area, t.due]), [['floor', false], ['shelf', true], ['storage', true]]);
check('the shelf to-do names what to count', /^Count these \d: Boxes, Strap/.test(r.todo[1].text), true);

/* --- Empty sheet: nothing crashes, everything is due ------------------------ */
reset();
sheets.WipBaseline = fakeSheet(WIP_H, []); sheets.CountLog = fakeSheet(CL_H, []);
sheets.FinishedGoods.grid.splice(1); sheets.RawMaterials.grid.forEach((row, i) => { if (i) { row[5] = ''; row[6] = ''; row[7] = ''; } });
const e = sandbox.getReconcile();
check('a blank slate: every count is due', e.todo.map((t) => [t.area, t.due]), [['floor', true], ['shelf', true], ['storage', true]]);
check('and nothing is scored', [e.floor.compared, e.shelf.compared, e.storage.compared], [0, 0, 0]);

console.log(failures ? `${failures} FAILURE(S)` : 'All checks passed.');
process.exit(failures ? 1 : 0);
