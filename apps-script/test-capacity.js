/* Exercise computeCapacity() — the rates an order promise rests on.
 *
 * What is pinned:
 *   • The BOTTLENECK is the slowest RATED stage, and a line's rate is that
 *     stage's rate. A faster stage upstream cannot make the line faster.
 *   • A stage nobody has logged has no rate, so it can't be the bottleneck —
 *     and the line's confidence says so, because the real bottleneck might be
 *     exactly the stage nobody has logged yet.
 *   • daysToClear is queue ÷ that stage's own pace, with 0 for an empty queue
 *     and null when there is a queue but no pace to clear it at.
 *   • aheadOfBottleneck counts queues up to and including the bottleneck,
 *     since that is what a new order waits behind. Queues past it don't.
 *
 * Run:  node apps-script/test-capacity.js
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

const PRODUCTS = [
  { ProductID: 'LGC30', ProductName: 'Chair 30"', Line: 'Chair', Active: 'YES', FeedsFrom: '', Family: 'Lifeguard Chairs' }
];
/* Chair line: Cut -> Assemble -> Box.
 *   Cut:      40 over 2 days  -> 20/day, and 8 hours logged -> 5/hr
 *   Assemble: 12 over 2 days  ->  6/day            <- the bottleneck
 *   Box:      never logged    -> no rate
 * Queues: 40 cut - 12 assembled = 28 waiting at Assemble; 12 - 0 = 12 waiting at Box. */
const STAGELOG = [
  { ProductID: 'LGC30', Stage: 'Cut',      Qty: 25, Hours: 5, WorkDate: '2026-08-18', Timestamp: new Date(2026, 7, 18) },
  { ProductID: 'LGC30', Stage: 'Cut',      Qty: 15, Hours: 3, WorkDate: '2026-08-19', Timestamp: new Date(2026, 7, 19) },
  { ProductID: 'LGC30', Stage: 'Assemble', Qty: 7,  Hours: '', WorkDate: '2026-08-18', Timestamp: new Date(2026, 7, 18) },
  { ProductID: 'LGC30', Stage: 'Assemble', Qty: 5,  Hours: '', WorkDate: '2026-08-19', Timestamp: new Date(2026, 7, 19) }
];
sandbox.readObjects = (tab) => ({
  Products: PRODUCTS, StageLog: STAGELOG, RawMaterials: [], BOM: [], Planning: [], WipBaseline: []
}[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const cap = sandbox.computeCapacity();
check('call succeeds', cap.ok, true);
const c = cap.products[0];
const st = Object.fromEntries(c.stages.map((s) => [s.stage, s]));

/* --- Bottleneck ------------------------------------------------------------ */
check('the slowest rated stage is the bottleneck', c.bottleneck.stage, 'Assemble');
check('the line runs at the bottleneck\'s pace, not the fastest stage\'s', c.lineRate, 6);
check('an unlogged stage has no rate and cannot be the bottleneck', st.Box.unitsPerDay, null);
check('only the bottleneck stage is flagged',
  c.stages.filter((s) => s.isBottleneck).map((s) => s.stage), ['Assemble']);
check('units per hour survives where hours were logged', st.Cut.unitsPerHour, 5);

/* --- Confidence ----------------------------------------------------------- */
// Two of three stages rated: the real bottleneck could be the one nobody logged.
check('a line with an unrated stage is only partially known', c.confidence, 'partial');
check('rated vs total stages are both reported', [c.ratedStages, c.totalStages], [2, 3]);

/* --- Little's Law at one station ------------------------------------------ */
check('days to clear = queue ÷ that stage\'s own pace (28 ÷ 6)', st.Assemble.daysToClear, 4.67);
check('a queue with no pace to clear it is null, not zero', st.Box.daysToClear, null);
check('the head of a line has no queue of its own', st.Cut.waiting, null);

/* --- What an order waits behind ------------------------------------------ */
check('ahead of the bottleneck counts queues up to and including it', c.aheadOfBottleneck, 28);
check('but the whole line\'s WIP includes what is already past it', c.wipInLine, 40);

/* --- Nothing logged at all --------------------------------------------------- */
sandbox.readObjects = (tab) => ({ Products: PRODUCTS, StageLog: [], RawMaterials: [], BOM: [], Planning: [], WipBaseline: [] }[tab] || []);
const empty = sandbox.computeCapacity().products[0];
check('with nothing logged there is no rate and no bottleneck',
  { rate: empty.lineRate, bn: empty.bottleneck, conf: empty.confidence }, { rate: null, bn: null, conf: 'none' });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
