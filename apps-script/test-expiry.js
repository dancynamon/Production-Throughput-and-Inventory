/* Expiration tracking (3.06.0): lots, the usable and good numbers, the reorder
 * trigger, and the receive form's rules.
 *
 * Pinned: oldest stock is used first; good through the expiration date itself;
 * halfway is the reorder line; undated deliveries hold their share; a fresh lot
 * stops the old one asking for another order; dating shelf stock leaves on hand
 * alone; a material with no dates behaves exactly as before.
 *
 * Run:  node apps-script/test-expiry.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const sandbox = { console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, Logger: { log() {} },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`}`);
}
const nums = (e) => [e.usable, e.good, e.expired, e.pastHalf];

/* ---- computeExpiry ---------------------------------------------------- */
const lot = (received, expires, qty) => ({ received, expires, qty });
const T = '2026-11-05';

check('no deliveries: everything is good', nums(sandbox.computeExpiry(40, [], T)), [40, 40, 0, 0]);
check('undated deliveries: everything is good, no lots',
  (() => { const e = sandbox.computeExpiry(40, [lot('2026-10-01', '', 50)], T); return [nums(e), e.lots.length]; })(), [[40, 40, 0, 0], 0]);

check('before halfway: good', nums(sandbox.computeExpiry(10, [lot('2026-11-01', '2027-11-01', 10)], T)), [10, 10, 0, 0]);
check('halfway is the first day past the line (2-year lot received 2024-12-01)',
  nums(sandbox.computeExpiry(10, [lot('2024-12-01', '2026-12-01', 10)], '2025-12-01')), [10, 0, 0, 10]);
check('the day before halfway is still good',
  nums(sandbox.computeExpiry(10, [lot('2024-12-01', '2026-12-01', 10)], '2025-11-30')), [10, 10, 0, 0]);
check('good through the expiration date itself',
  nums(sandbox.computeExpiry(10, [lot('2024-12-01', '2026-11-05', 10)], T)), [10, 0, 0, 10]);
check('the day after: expired, and not usable',
  nums(sandbox.computeExpiry(10, [lot('2024-12-01', '2026-11-04', 10)], T)), [0, 0, 10, 0]);

{
  // 8 on hand across a 5 fresh lot and a 10 old lot: oldest was used first, so 3 of the old remain.
  const e = sandbox.computeExpiry(8, [lot('2025-01-01', '2026-01-01', 10), lot('2026-11-01', '2027-11-01', 5)], T);
  check('oldest used first: the fresh lot is full, the old lot holds the rest', nums(e), [5, 5, 3, 0]);
  check('lots listed soonest expiring first, with what each still holds',
    e.lots.map((l) => [l.expires, l.qty, l.state]), [['2026-01-01', 3, 'expired'], ['2027-11-01', 5, 'good']]);
  check('next expires skips what already has', e.nextExpires, '2027-11-01');
}
check('a shelf counted low empties the old lot first',
  nums(sandbox.computeExpiry(4, [lot('2025-01-01', '2026-01-01', 10), lot('2026-11-01', '2027-11-01', 5)], T)), [4, 4, 0, 0]);
check('a newer undated delivery holds its share ahead of an old dated lot',
  nums(sandbox.computeExpiry(12, [lot('2025-01-01', '2026-01-01', 10), lot('2026-10-01', '', 8)], T)), [8, 8, 4, 0]);
check('same received date: the dated row entered later claims the stock from its undated twin',
  nums(sandbox.computeExpiry(10, [lot('2025-01-01', '', 10), lot('2025-01-01', '2026-01-01', 10)], T)), [0, 0, 10, 0]);
check('more on hand than any delivery explains: the extra is undated and good',
  nums(sandbox.computeExpiry(15, [lot('2025-01-01', '2026-01-01', 10)], T)), [5, 5, 10, 0]);
check('nothing on hand: nothing expired', nums(sandbox.computeExpiry(0, [lot('2025-01-01', '2026-01-01', 10)], T)), [0, 0, 0, 0]);
check('negative on hand holds no lots', sandbox.computeExpiry(-6, [lot('2025-01-01', '2026-01-01', 10)], T).lots.length, 0);

/* ---- computeReorder --------------------------------------------------- */
const base = { committed: 0, after: 10, dailyBurn: 0, orderBy: null, orderByDays: null, leadDays: null, counted: true, supplier: '', unit: 'lb' };
sandbox.getStock = () => ({ materials: [] });
const r = sandbox.computeReorder({ materials: [
  Object.assign({}, base, { id: 'A', name: 'Past half, nothing fresh', onHand: 10, reorderPoint: 2, usable: 10, goodStock: 0, expiredQty: 0, pastHalfQty: 10, nextExpires: '2026-12-01' }),
  Object.assign({}, base, { id: 'B', name: 'Past half, fresh lot in', onHand: 15, reorderPoint: 2, usable: 15, goodStock: 5, expiredQty: 0, pastHalfQty: 10, nextExpires: '2026-12-01' }),
  Object.assign({}, base, { id: 'C', name: 'Expired, no reorder point', onHand: 3, reorderPoint: 0, usable: 0, goodStock: 0, expiredQty: 3, pastHalfQty: 0, nextExpires: '' }),
  Object.assign({}, base, { id: 'D', name: 'No dates', onHand: 10, reorderPoint: 2 })
] });
const by = (id) => r.items.find((i) => i.id === id);
check('past halfway with nothing fresh is due, and says why',
  [!!by('A'), /10 past halfway to expiring \(expires 2026-12-01\)/.test(by('A').reason), by('A').goodStock], [true, true, 0]);
check('a fresh lot above the reorder point stops the old one asking', !!by('B'), false);
check('expired stock with no reorder point is still due', [!!by('C'), /3 expired/.test(by('C').reason)], [true, true]);
check('a material with no dates is judged as before', !!by('D'), false);
check('suggested quantity runs on good stock, not the shelf (back to 2x reorder point)', by('A').suggestedQty, 4);
check('Reorder tab headers match the row', sandbox.REORDER_HEADERS.slice(-3, -1), ['GoodStock', 'NextExpires']);

/* ---- receiveStock ----------------------------------------------------- */
function harness(onHand) {
  const mats = [['MaterialID', 'MaterialName', 'Unit', 'OnHand'], ['M011', 'Cliqflow', 'lb', onHand]];
  const log = [];
  const matSheet = { getDataRange: () => ({ getValues: () => mats }), getRange: (row, col) => ({ setValue: (v) => { mats[row - 1][col - 1] = v; } }) };
  const logHeaders = ['Timestamp', 'Employee', 'MaterialID', 'MaterialName', 'QtyAdded', 'Notes', 'ReceivedOn', 'ExpiresOn', 'OnShelf'];
  const logSheet = { getLastColumn: () => logHeaders.length, getRange: () => ({ getValues: () => [logHeaders] }), appendRow: (row) => log.push(row) };
  sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === 'RawMaterials' ? matSheet : logSheet) }) };
  sandbox.refreshReorderSafe = () => {};
  return { mats, log, at: (i) => (name) => log[i][logHeaders.indexOf(name)] };
}
const today = sandbox.fmtDate(new Date());
const send = (extra) => sandbox.receiveStock(Object.assign({ employee: 'John C', materialId: 'M011', qty: '5' }, extra));

{
  const h = harness(10);
  const res = send({ receivedOn: '2026-01-01', expiresOn: '2028-01-01' });
  check('a dated delivery adds to stock and logs both dates',
    [res.ok, h.mats[1][3], h.at(0)('ReceivedOn'), h.at(0)('ExpiresOn'), h.at(0)('OnShelf')], [true, 15, '2026-01-01', '2028-01-01', '']);
}
{
  const h = harness(10);
  const res = send({ receivedOn: '2025-01-01', expiresOn: '2027-01-01', onShelf: '1' });
  check('dating shelf stock leaves on hand alone and marks the row',
    [res.ok, h.mats[1][3], h.at(0)('OnShelf'), res.warnings.length], [true, 10, 'YES', 0]);
}
{
  const h = harness(2);
  const res = send({ receivedOn: '2025-01-01', expiresOn: '2027-01-01', onShelf: '1' });
  check('dating more than the shelf holds warns to count it', [res.ok, /only that much/.test(res.warnings[0])], [true, true]);
}
{
  const h = harness(10);
  const res = send({});
  check('no dates: received today, nothing else changes', [res.ok, h.mats[1][3], h.at(0)('ReceivedOn'), h.at(0)('ExpiresOn')], [true, 15, today, '']);
}
{
  const h = harness(10);
  const refused = [
    send({ receivedOn: 'soon' }), send({ receivedOn: '2999-01-01' }), send({ expiresOn: 'soon' }),
    send({ receivedOn: '2026-01-01', expiresOn: '2026-01-01' }), send({ onShelf: '1' })
  ];
  check('bad dates and undated shelf stock are refused, and write nothing',
    [refused.every((x) => x.ok === false), h.mats[1][3], h.log.length], [true, 10, 0]);
}

/* ---- getStock: the whole path from the two tabs ---------------------- */
{
  const realGetStock = vm.runInContext(`(${fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8').match(/function getStock\(\) \{[\s\S]*?\n\}\n/)[0]})`, sandbox);
  const LOG = [
    { Timestamp: new Date(2026, 10, 1), MaterialID: 'M011', QtyAdded: 10, ReceivedOn: new Date(2024, 11, 1), ExpiresOn: new Date(2026, 11, 1), OnShelf: 'YES' },
    { Timestamp: new Date(2026, 9, 1), MaterialID: 'M012', QtyAdded: 50, ReceivedOn: '', ExpiresOn: '', OnShelf: '' }
  ];
  sandbox.readObjects = (tab) => (tab === 'ReceivingLog' ? LOG : [
    { MaterialID: 'M011', MaterialName: 'Cliqflow', Unit: 'lb', OnHand: 6, ReorderPoint: 2 },
    { MaterialID: 'M012', MaterialName: 'Webbing', Unit: 'yd', OnHand: 30, ReorderPoint: 40 },
    { MaterialID: 'M013', MaterialName: 'Never counted', Unit: 'ea', OnHand: '', ReorderPoint: 0 }
  ]);
  sandbox.materialRetired = () => false;
  const m = {}; realGetStock().materials.forEach((x) => { m[x.id] = x; });
  check('sheet dates as Date cells work: all 6 past halfway, low on good stock',
    [m.M011.pastHalfQty, m.M011.goodStock, m.M011.low, m.M011.lots[0].expires], [6, 0, true, '2026-12-01']);
  check('an undated material reads as before', [m.M012.usable, m.M012.goodStock, m.M012.low, m.M012.lots.length], [30, 30, true, 0]);
  check('a never-counted material is not called low', m.M013.low, false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
