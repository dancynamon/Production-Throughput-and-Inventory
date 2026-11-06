/* Reorder points (3.07.0): half an order, and smaller orders for things that expire.
 *
 * Pinned: a typed ReorderPoint wins; blank = half of ReorderQty, else half the
 * last real delivery (dating shelf stock is not an order); nothing on record =
 * no point; REORDER_FRACTION changes or switches off the half; the reason and
 * Inventory say where a point came from; an expiring material's computed order
 * is cut to what the floor uses before a new lot is halfway, never below what
 * the floor is owed, and a typed ReorderQty is kept with a note.
 *
 * Run:  node apps-script/test-reorderpoint.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const props = {};
const sandbox = { console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, parseFloat,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) }, Logger: { log() {} } };
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
vm.runInContext(SRC, sandbox);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`}`);
}
const d = (received, qty, extra) => Object.assign({ received, expires: '', qty, onShelf: false }, extra || {});
const rp = (typed, rq, dels) => { const r = sandbox.effectiveReorderPoint(typed, rq, dels, sandbox.reorderFraction()); return [r.point, r.from]; };

/* ---- effectiveReorderPoint ------------------------------------------ */
check('a typed reorder point wins over everything', rp(3, 100, [d('2026-10-01', 40)]), [3, 'set']);
check('blank: half the usual order', rp('', 100, [d('2026-10-01', 40)]), [50, 'usual order']);
check('0 counts as blank', rp(0, 100, []), [50, 'usual order']);
check('no usual order: half the last delivery', rp('', null, [d('2026-09-01', 10), d('2026-10-01', 40)]), [20, 'last delivery']);
check('last delivery is by received date, not row order', rp('', null, [d('2026-10-01', 40), d('2026-09-01', 10)]), [20, 'last delivery']);
check('dating shelf stock is not an order', rp('', null, [d('2026-09-01', 10), d('2026-10-05', 99, { onShelf: true })]), [5, 'last delivery']);
check('nothing on record: no point, as before', rp('', null, []), [0, '']);
check('halves keep two decimals', rp('', 3, []), [1.5, 'usual order']);

props.REORDER_FRACTION = '40%';
check('REORDER_FRACTION 40% gives 40 of 100', rp('', 100, []), [40, 'usual order']);
props.REORDER_FRACTION = '0.25';
check('REORDER_FRACTION 0.25 gives 25 of 100', rp('', 100, []), [25, 'usual order']);
props.REORDER_FRACTION = 'off';
check('REORDER_FRACTION off: blank stays blank', rp('', 100, []), [0, '']);
check('REORDER_FRACTION off: a typed point still works', rp(7, 100, []), [7, 'set']);
props.REORDER_FRACTION = 'nonsense';
check('an unreadable REORDER_FRACTION falls back to half', rp('', 100, []), [50, 'usual order']);
delete props.REORDER_FRACTION;

/* ---- shelf life and use before halfway ------------------------------ */
check('shelf life comes from the newest dated lot',
  sandbox.shelfLifeDays([d('2024-01-01', 5, { expires: '2026-01-01' }), d('2026-01-01', 5, { expires: '2027-01-01' }), d('2026-06-01', 5)]), 365);
check('no dated lot: no shelf life', sandbox.shelfLifeDays([d('2026-06-01', 5)]), null);
check('used before halfway: 2 a working day, 365-day life -> 182 days x 5/7', sandbox.usedBeforeHalfway(365, 2), 260);
check('no daily use: can not tell', sandbox.usedBeforeHalfway(365, 0), null);

/* ---- computeReorder --------------------------------------------------- */
const base = { committed: 0, after: 10, dailyBurn: 0, orderBy: null, orderByDays: null, leadDays: null, counted: true, supplier: '', unit: 'lb',
               expiredQty: 0, pastHalfQty: 0, nextExpires: '' };
const stock = {
  H: { reorderPointFrom: 'usual order', orderSize: 40, reorderQty: 40 },
  L: { reorderPointFrom: 'last delivery', orderSize: 30 },
  P: { reorderPointFrom: 'last delivery', orderSize: 100, shelfLifeDays: 70 },      // 35 days -> 25 working days
  Q: { reorderPointFrom: 'usual order', orderSize: 100, reorderQty: 100, shelfLifeDays: 70 },
  F: { reorderPointFrom: 'last delivery', orderSize: 100, shelfLifeDays: 70 }
};
sandbox.getStock = () => ({ materials: Object.keys(stock).map((id) => Object.assign({ id }, stock[id])) });
const r = sandbox.computeReorder({ materials: [
  Object.assign({}, base, { id: 'H', name: 'Half usual', onHand: 20, reorderPoint: 20, reorderPointFrom: 'usual order' }),
  Object.assign({}, base, { id: 'L', name: 'Half last', onHand: 16, reorderPoint: 15, reorderPointFrom: 'last delivery' }),
  Object.assign({}, base, { id: 'P', name: 'Paint add-on', onHand: 40, reorderPoint: 50, dailyBurn: 1, reorderPointFrom: 'last delivery' }),
  Object.assign({}, base, { id: 'Q', name: 'Paint, usual order', onHand: 40, reorderPoint: 50, dailyBurn: 1, reorderPointFrom: 'usual order' }),
  Object.assign({}, base, { id: 'F', name: 'Floor owes more', onHand: 40, reorderPoint: 50, dailyBurn: 1, after: -30, committed: 70, reorderPointFrom: 'last delivery' })
] });
const by = (id) => r.items.find((i) => i.id === id);
check('half the usual order is due at it, and says so',
  [!!by('H'), /at or under reorder point \(20 of 20, half the usual order of 40\)/.test(by('H').reason)], [true, true]);
check('above half the last delivery is not due', !!by('L'), false);
check('expiring: a computed order is cut to what is used before halfway (60 -> 25)',
  [by('P').suggestedQty, by('P').usedBeforeHalfway, /order cut from 60/.test(by('P').reason)], [25, 25, true]);
check('expiring: a typed usual order is kept, with a note',
  [by('Q').suggestedQty, /a smaller order than 100 would do/.test(by('Q').reason)], [100, true]);
check('the cut never goes below what the floor is owed', by('F').suggestedQty, 30);
check('Reorder tab headers end with UsedBeforeHalfway', sandbox.REORDER_HEADERS.slice(-1), ['UsedBeforeHalfway']);

/* ---- getStock end to end -------------------------------------------- */
{
  const realGetStock = vm.runInContext(`(${SRC.match(/function getStock\(\) \{[\s\S]*?\n\}\n/)[0]})`, sandbox);
  const LOG = [
    { Timestamp: new Date(2026, 8, 1), MaterialID: 'M011', QtyAdded: 40, ReceivedOn: new Date(2026, 8, 1), ExpiresOn: new Date(2027, 8, 1), OnShelf: '' },
    { Timestamp: new Date(2026, 9, 1), MaterialID: 'M012', QtyAdded: 50, ReceivedOn: '', ExpiresOn: '', OnShelf: '' }
  ];
  sandbox.readObjects = (tab) => (tab === 'ReceivingLog' ? LOG : [
    { MaterialID: 'M011', MaterialName: 'Cliqflow', Unit: 'lb', OnHand: 18, ReorderPoint: '' },
    { MaterialID: 'M012', MaterialName: 'Webbing', Unit: 'yd', OnHand: 30, ReorderPoint: '', ReorderQty: 100 },
    { MaterialID: 'M013', MaterialName: 'Typed', Unit: 'ea', OnHand: 5, ReorderPoint: 4, ReorderQty: 100 },
    { MaterialID: 'M014', MaterialName: 'Never ordered', Unit: 'ea', OnHand: 5, ReorderPoint: '' }
  ]);
  sandbox.materialRetired = () => false;
  const m = {}; realGetStock().materials.forEach((x) => { m[x.id] = x; });
  check('Cliqflow: half its 40 delivery, 18 on hand is low',
    [m.M011.reorderPoint, m.M011.reorderPointFrom, m.M011.low, m.M011.shelfLifeDays], [20, 'last delivery', true, 365]);
  check('Webbing: half its usual 100 beats its last delivery', [m.M012.reorderPoint, m.M012.reorderPointFrom, m.M012.low], [50, 'usual order', true]);
  check('typed point kept', [m.M013.reorderPoint, m.M013.reorderPointFrom, m.M013.low], [4, 'set', false]);
  check('never ordered, nothing typed: no point, not low', [m.M014.reorderPoint, m.M014.low], [0, false]);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
