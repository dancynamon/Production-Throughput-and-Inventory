/* Exercise getSummary() — the top-level dashboard.
 *
 * A summary's failure mode is quiet: it shows a plausible number that
 * disagrees with the screen it summarises, and nobody notices until a decision
 * has been made on it. So the things pinned here are the ones where a summary
 * would most easily drift from the truth:
 *
 *   • STARTED vs FINISHED are the first and LAST stage of each product's own
 *     line, never a sum across stages — one chair cut, assembled and boxed is
 *     one chair, not three. Same bug John reported in the daily totals.
 *   • The 7-day window EXCLUDES older rows rather than quietly including them.
 *   • WIP does not double-count the shared blank pool across variants.
 *   • The trust block reports what is missing, since most of these numbers
 *     currently rest on figures nobody has established.
 *
 * Run:  node apps-script/test-summary.js
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

// Dates relative to "today" so the 7-day window is exercised, not hard-coded.
const d = (back) => {
  const t = new Date();
  const x = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};

const PRODUCTS = [
  { ProductID: 'BLANK50',  ProductName: '50" Blank',  Line: 'Blank',   Active: 'YES', FeedsFrom: '',        Family: 'Rescue Tubes' },
  { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exo', Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50', Family: 'Rescue Tubes' },
  { ProductID: 'LGC30',    ProductName: 'Chair 30"',  Line: 'Chair',   Active: 'YES', FeedsFrom: '',        Family: 'Lifeguard Chairs' }
];

/* Chair line is Cut -> Assemble -> Box. One chair through all three in a day
 * must read as 1 started and 1 finished, never 3 of anything. */
const STAGELOG = [
  { ProductID: 'LGC30', Stage: 'Cut',      Qty: 1, Hours: 2, WorkDate: d(1), Timestamp: new Date() },
  { ProductID: 'LGC30', Stage: 'Assemble', Qty: 1, Hours: '', WorkDate: d(1), Timestamp: new Date() },
  { ProductID: 'LGC30', Stage: 'Box',      Qty: 1, Hours: '', WorkDate: d(1), Timestamp: new Date() },
  { ProductID: 'BLANK50', Stage: 'Cut',    Qty: 100, Hours: '', WorkDate: d(2), Timestamp: new Date() },
  { ProductID: 'BLANK50', Stage: 'Glued',  Qty: 60,  Hours: '', WorkDate: d(2), Timestamp: new Date() },
  { ProductID: 'XRT50EXO', Stage: 'Meshed', Qty: 20, Hours: '', WorkDate: d(2), Timestamp: new Date() },
  // Outside the 7-day window — must not appear in production totals, but must
  // still count toward the pipeline and the total row tally.
  { ProductID: 'BLANK50', Stage: 'Cut',    Qty: 999, Hours: '', WorkDate: d(30), Timestamp: new Date() }
];

const MATERIALS = [
  { MaterialID: 'M001', MaterialName: 'Glue',  Unit: 'lbs', OnHand: 5,  ReorderPoint: 1, Category: 'Glue',
    LastCounted: 5, LastCountedAt: new Date(), LastVariance: 0 },
  { MaterialID: 'M002', MaterialName: 'Mesh',  Unit: 'box', OnHand: '', ReorderPoint: 2, Category: 'Glue',
    LastCounted: '', LastCountedAt: '', LastVariance: '' },
  { MaterialID: 'M003', MaterialName: 'Boxes', Unit: 'ea',  OnHand: -40, ReorderPoint: 5, Category: 'Pack',
    LastCounted: '', LastCountedAt: '', LastVariance: '' }
];

const BOM = [{ ProductID: 'XRT50EXO', Stage: 'Boxed', MaterialID: 'M003', QtyPerUnit: 1 }];

sandbox.readObjects = (tab) => ({
  Products: PRODUCTS, StageLog: STAGELOG, RawMaterials: MATERIALS,
  BOM: BOM, Planning: [], WipBaseline: [], CountLog: []
}[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const s = sandbox.getSummary();
check('call succeeds', s.ok, true);

/* --- Started / finished are ends of a line, not a sum ------------------- */
/* 1 chair Cut + 100 blanks Cut = 101 new units. The 20 tubes Meshed are NOT
 * new: Meshed is the first stage of the Exo line, but those tubes are blanks
 * that already entered the building as blanks. Counting them again is the
 * 3-chairs bug one level up. */
check('new units exclude a line fed by another line', s.production.started, 101);
/* Only the chair is a finished good. The 60 Glued blanks are a feeder's last
 * stage — they are tubes waiting to happen, not stock you can ship. */
check('finished goods exclude a feeder\'s output', s.production.finished, 1);
check('one chair through three stations is one chair, not three',
  s.production.products.filter((p) => p.id === 'LGC30')[0],
  { id: 'LGC30', name: 'Chair 30"', family: 'Lifeguard Chairs', started: 1, finished: 1 });

/* --- The 7-day window --------------------------------------------------- */
// The 999 cut a month ago must be excluded from the window...
check('rows older than the window are excluded', s.production.events, 6);
check('only days inside the window are listed', s.production.days.length, 2);
// ...but still counted in the all-time tally that measures how much data exists.
check('the trust tally counts every row ever logged', s.trust.stageLogRows, 7);
check('hours are tallied only where they were logged', s.production.hours, 2);
check('rows carrying hours are counted honestly', s.trust.rowsWithHours, 1);

/* --- Pipeline ------------------------------------------------------------ */
/* WIP is all-time, deliberately, even though production is windowed: a pile
 * that has been sitting for a month is still sitting there. 1099 cut (100 this
 * week + 999 last month) less 60 glued = 1039 waiting at Glued. */
check('the biggest pile is named, and counts work older than the window',
  { stage: s.pipeline.biggest.stage, units: s.pipeline.biggest.units, name: s.pipeline.biggest.name },
  { stage: 'Glued', units: 1039, name: '50" Blank' });
check('every product lacking an opening WIP baseline is named',
  s.pipeline.productsWithoutBaseline.length, 3);

/* --- Inventory + buying -------------------------------------------------- */
check('never-counted materials are surfaced', s.inventory.neverCounted, 2);
check('negative stock is surfaced separately', s.inventory.negative, 1);
check('the worst shortfall is named with its size',
  { name: s.buying.biggest.name, short: s.buying.biggest.short }, { name: 'Boxes', short: 60 });

/* --- Trust --------------------------------------------------------------- */
check('the summary reports how little has been counted',
  { counted: s.trust.materialsCounted, total: s.trust.materialsTotal }, { counted: 1, total: 3 });
check('and how few products have a baseline',
  { withBaseline: s.trust.productsWithBaseline, tracked: s.trust.productsTracked }, { withBaseline: 0, tracked: 3 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
