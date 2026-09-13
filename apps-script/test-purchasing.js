/* Exercise computePurchasing() — the "what do I buy" arithmetic.
 *
 * This one turns into purchase orders, so the things that would quietly cost
 * money are pinned hard:
 *
 *   • DOWNSTREAM ACCUMULATION. A tube waiting at Patched owes every material
 *     that Patched AND every stage after it consumes — not just Patched's.
 *     Getting this wrong under-orders by most of the recipe.
 *   • NO DOUBLE-COUNTING THE SHARED POOL. An uncommitted 50" blank can become
 *     an Exotube or a Standard. Charging its downstream materials to both
 *     would roughly double every tube material on the buy list.
 *   • WIP ONLY, NOT COMPLETED WORK. Units that already passed a stage have
 *     already had their materials deducted. Counting them again would order
 *     stock for work that is finished.
 *
 * Run:  node apps-script/test-purchasing.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

/* A deliberately small world: one blank feeding two variants, so the shared
 * pool is exercised, plus a chair line that shares nothing. */
const PRODUCTS = [
  { ProductID: 'BLANK50',  ProductName: '50" Blank',   Line: 'Blank',   Active: 'YES', FeedsFrom: '',        Family: 'Rescue Tubes' },
  { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exo',  Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50', Family: 'Rescue Tubes' },
  { ProductID: 'XRT50STD', ProductName: 'XRT-50 Std',  Line: 'TubeStd', Active: 'YES', FeedsFrom: 'BLANK50', Family: 'Rescue Tubes' },
  { ProductID: 'LGC30',    ProductName: 'Chair 30"',   Line: 'Chair',   Active: 'YES', FeedsFrom: '',        Family: 'Lifeguard Chairs' }
];

// Round numbers so the expected values are checkable by hand.
const BOM = [
  { ProductID: 'XRT50EXO', Stage: 'Meshed',          MaterialID: 'MESH',  QtyPerUnit: 1 },
  { ProductID: 'XRT50EXO', Stage: 'Patched',         MaterialID: 'GLUE',  QtyPerUnit: 2 },
  { ProductID: 'XRT50EXO', Stage: 'Straps Attached', MaterialID: 'STRAP', QtyPerUnit: 1 },
  { ProductID: 'XRT50EXO', Stage: 'Boxed',           MaterialID: 'BOX',   QtyPerUnit: 1 },
  { ProductID: 'XRT50STD', Stage: 'Patched',         MaterialID: 'GLUE',  QtyPerUnit: 2 },
  { ProductID: 'XRT50STD', Stage: 'Straps Attached', MaterialID: 'STRAP', QtyPerUnit: 1 },
  { ProductID: 'XRT50STD', Stage: 'Boxed',           MaterialID: 'BOX',   QtyPerUnit: 1 },
  { ProductID: 'LGC30',    Stage: 'Assemble',        MaterialID: 'KIT',   QtyPerUnit: 1 }
];

const MATERIALS = [
  { MaterialID: 'MESH',  MaterialName: 'Nylon Mesh',  Unit: 'Boxes', OnHand: 10, ReorderPoint: 2,  Category: 'Glue & Mesh' },
  { MaterialID: 'GLUE',  MaterialName: 'CA Glue',     Unit: 'lbs',   OnHand: 5,  ReorderPoint: 10, Category: 'End Patches' },
  { MaterialID: 'STRAP', MaterialName: 'Strap',       Unit: 'each',  OnHand: 4,  ReorderPoint: 50, Category: 'Sub-assembly' },
  { MaterialID: 'BOX',   MaterialName: 'Tube Box',    Unit: 'Boxes', OnHand: 0,  ReorderPoint: 20, Category: 'Packaging' },
  { MaterialID: 'KIT',   MaterialName: 'Chair Kit',   Unit: 'kits',  OnHand: 3,  ReorderPoint: 20, Category: 'Chair Hardware' }
];

/* StageLog chosen so the WIP is easy to state:
 *   BLANK50  Cut 100, Glued 100          -> 100 blanks finished
 *   XRT50EXO Meshed 30                   -> 30 taken from the pool
 *   XRT50STD (nothing)                   ->  0 taken
 *   => uncommitted pool = 100 - 30 = 70
 *   Exo: 30 meshed, 0 patched            -> 30 waiting at Patched
 *   LGC30 Cut 4, Assemble 1              ->  3 waiting at Assemble
 */
const STAGELOG = [
  { ProductID: 'BLANK50',  Stage: 'Cut',     Qty: 100, WorkDate: '2026-08-01', Timestamp: new Date(2026, 7, 1) },
  { ProductID: 'BLANK50',  Stage: 'Glued',   Qty: 100, WorkDate: '2026-08-01', Timestamp: new Date(2026, 7, 1) },
  { ProductID: 'XRT50EXO', Stage: 'Meshed',  Qty: 30,  WorkDate: '2026-08-02', Timestamp: new Date(2026, 7, 2) },
  { ProductID: 'LGC30',    Stage: 'Cut',     Qty: 4,   WorkDate: '2026-08-02', Timestamp: new Date(2026, 7, 2) },
  { ProductID: 'LGC30',    Stage: 'Assemble', Qty: 1,  WorkDate: '2026-08-02', Timestamp: new Date(2026, 7, 2) }
];

sandbox.readObjects = (tab) => ({
  Products: PRODUCTS, BOM: BOM, RawMaterials: MATERIALS,
  StageLog: STAGELOG, Planning: [], WipBaseline: []
}[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const res = sandbox.computePurchasing();
const by = Object.fromEntries(res.materials.map((m) => [m.id, m]));

/* --- Downstream accumulation --------------------------------------------- */
// 30 Exos waiting at Patched still owe Patched + Straps + Boxed.
check('waiting units owe their stage AND every stage after it',
  { glue: by.GLUE.committed, strap: by.STRAP.committed, box: by.BOX.committed },
  { glue: 60, strap: 30, box: 30 });

// Meshed is BEHIND them — those 30 already had their mesh deducted.
check('a stage already passed is not re-ordered for', by.MESH.committed, 0);

/* --- The shared pool ------------------------------------------------------ */
// 70 uncommitted blanks. If they were charged to both variants, GLUE would
// read 60 + 70*2 + 70*2 = 340 instead of 60.
check('uncommitted blanks are not charged to either variant', by.GLUE.committed, 60);
check('the pool is reported rather than hidden',
  res.pools, [{ feeder: 'BLANK50', units: 70 }]);

/* --- Shortfall ------------------------------------------------------------ */
// after = onHand - committed. Negative means work in progress outruns stock.
check('what is left after the pipeline is served',
  { glue: by.GLUE.after, box: by.BOX.after, mesh: by.MESH.after },
  { glue: -55, box: -30, mesh: 10 });

/* --- Supplier passes through so the buy list can group by it ------------- */
check('supplier rides along on each material (blank when unset)', by.GLUE.supplier, '');

/* --- Burn and order-by ----------------------------------------------------- */
// The Exo line has one Meshed day in the fixture (30 in a day -> 30/day), the
// Standard line has no rows at all. So GLUE burns 30 × 2 = 60/day from Exo,
// and the Standard line is named as one it cannot see — unknown, not zero.
// 5 on hand ÷ 60 -> 0.08 days of stock; no lead time -> no order-by date.
check('burn comes from the rated line only, and the blind line is named',
  [by.GLUE.dailyBurn, by.GLUE.daysOfStock, by.GLUE.orderBy, by.GLUE.burnUnknownFor.sort()],
  [60, 0.08, null, ['XRT-50 Std']]);
check('lead days is null when the column is blank', by.GLUE.leadDays, null);
// Now stock GLUE at 120 with a 3-day lead: 120 ÷ 60 = 2 days of stock.
const savedRO = sandbox.readObjects;
sandbox.readObjects = (tab) => (tab === 'RawMaterials'
  ? MATERIALS.map((m) => (m.MaterialID === 'GLUE' ? { ...m, OnHand: 120, LeadDays: 3 } : m))
  : savedRO(tab));
const rated = Object.fromEntries(sandbox.computePurchasing().materials.map((m) => [m.id, m]));
check('burn = line rate × per-unit recipe, summed over rated lines', rated.GLUE.dailyBurn, 60);
check('days of stock = on hand ÷ burn (120 ÷ 60)', rated.GLUE.daysOfStock, 2);
check('order-by days = days of stock − lead days, floored (2 − 3 → −1)', rated.GLUE.orderByDays, -1);
check('an already-late order-by is today, never a past date', rated.GLUE.orderBy, sandbox.fmtDate(new Date()));
sandbox.readObjects = savedRO;

/* --- Attribution ---------------------------------------------------------- */
check('the demand names the product that caused it',
  by.BOX.sources.map((s) => [s.productId, s.need]), [['XRT50EXO', 30]]);

/* --- Lines that share nothing --------------------------------------------- */
// 3 chairs waiting at Assemble, 1 kit each.
check('an unrelated line computes independently', by.KIT.committed, 3);

/* --- Per-unit recipe for the planner -------------------------------------- */
// One finished Exo, from the top of its line: mesh + 2 glue + strap + box.
// Compared as sorted pairs — key order in an object carries no meaning, and
// asserting on it fails for a reason that has nothing to do with the code.
const pairs = (o) => Object.keys(o).sort().map((k) => [k, o[k]]);
check('perUnit is the whole recipe for one finished unit',
  pairs(sandbox.computePurchasing().perUnit.XRT50EXO),
  pairs({ MESH: 1, GLUE: 2, STRAP: 1, BOX: 1 }));
// A Standard never meshes, which is the point of the split.
check('a Standard carries no mesh in its per-unit recipe',
  sandbox.computePurchasing().perUnit.XRT50STD.MESH, undefined);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
