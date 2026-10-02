/* Reorder list (3.01.9): which materials are due, why, and how many to buy.
 * Pinned: never-counted shelves are not judged; at/under ReorderPoint, floor
 * work outrunning the shelf, and an order-by date within 5 working days each
 * make a material due; ReorderQty wins, else 4 weeks of use + what the floor
 * is owed or back to twice the reorder point; grouped by supplier.
 *
 * Run:  node apps-script/test-reorder.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const sandbox = { console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, Logger: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`}`);
}
const base = { committed: 0, after: 10, dailyBurn: 0, orderBy: null, orderByDays: null, leadDays: null, counted: true, supplier: '' };
const purch = { materials: [
  Object.assign({}, base, { id: 'M002', name: 'Nylon Mesh', unit: 'Boxes', onHand: 2, reorderPoint: 2, supplier: 'Mesh Co' }),       // at RP, ReorderQty 4
  Object.assign({}, base, { id: 'M004', name: 'CA glue', unit: 'lbs', onHand: 14, reorderPoint: 10, after: -6, committed: 20, dailyBurn: 1, supplier: 'Glue Inc' }), // floor needs more
  Object.assign({}, base, { id: 'M005', name: 'Accelerant', unit: 'Gallons', onHand: 5, reorderPoint: 2, orderBy: '2026-10-05', orderByDays: 2, dailyBurn: 0.5, supplier: 'Glue Inc' }), // order-by soon
  Object.assign({}, base, { id: 'M009', name: 'Chromatint', unit: 'Drums', onHand: 3, reorderPoint: 1, supplier: 'Ink Co' }),          // fine
  Object.assign({}, base, { id: 'M020', name: 'Never counted', unit: 'ea', onHand: 0, reorderPoint: 5, counted: false }),            // not judged
  Object.assign({}, base, { id: 'M021', name: 'No supplier yet', unit: 'ea', onHand: 1, reorderPoint: 3 })                           // due, RP fallback
] };
sandbox.getStock = () => ({ materials: [{ id: 'M002', reorderQty: 4, qboItem: 'Nylon Mesh Box' }, { id: 'M004', reorderQty: null, qboItem: '' }] });
const r = sandbox.computeReorder(purch);
check('due list, grouped by supplier, blank supplier last', r.items.map((i) => i.id), ['M005', 'M004', 'M002', 'M021']);
check('a never-counted shelf is counted as unknown, not ordered', [r.neverCounted, r.items.some((i) => i.id === 'M020')], [1, false]);
const by = (id) => r.items.find((i) => i.id === id);
check('ReorderQty wins, QBOItem carried', [by('M002').suggestedQty, by('M002').qboItem, /at or under reorder point/.test(by('M002').reason)], [4, 'Nylon Mesh Box', true]);
check('floor owed: 20 days of use + committed - on hand = 26', [by('M004').suggestedQty, /floor work needs 6/.test(by('M004').reason)], [26, true]);
check('order-by within 5 working days makes it due', [/order by 2026-10-05/.test(by('M005').reason), by('M005').suggestedQty], [true, 5]);
check('no use, no ReorderQty: back to twice the reorder point', by('M021').suggestedQty, 5);
check('a comfortable shelf is not listed', r.items.some((i) => i.id === 'M009'), false);

/* 3.01.10: purchasing defaults fill BLANK cells only. */
{
  const H = ['MaterialID', 'MaterialName', 'Supplier', 'ReorderQty', 'QBOItem'];
  const grid = [H, ['M014', '1" Red', '', '', ''], ['M015', '1" Black', 'My Mill', '', ''], ['M999', 'Other', '', '', '']];
  const sh = { getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }), getRange: (r, c) => ({ setValue: (v) => { grid[r - 1][c - 1] = v; } }) };
  sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: () => sh }) };
  const n = sandbox.backfillPurchasingDefaults();
  check('fills blanks: Granat + 4000 on M014, only qty on M015 (typed supplier kept), unknown id untouched',
    [grid[1][2], grid[1][3], grid[2][2], grid[2][3], grid[3][2], n], ['Granat Industries Inc', 4000, 'My Mill', 8000, '', 3]);
  check('second run changes nothing', sandbox.backfillPurchasingDefaults(), 0);
  check('every default is for a real material and has a supplier', Object.keys(sandbox.PURCHASING_DEFAULTS).every((k) => /^M0\d\d$/.test(k) && sandbox.PURCHASING_DEFAULTS[k].supplier), true);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
