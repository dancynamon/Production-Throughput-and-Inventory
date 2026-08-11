/* Exercise wipBaselineMap() and its effect on computeOverview().
 *
 * Two properties carry the whole feature:
 *
 *   - The BACKWARD WALK. Nobody can count "units that have ever passed
 *     Patched", but anyone can count the pile standing at each station.
 *     Cumulative completions are derived from those piles by walking the line
 *     from finished goods backwards. Get the direction wrong and the numbers
 *     look plausible while being exactly inverted.
 *
 *   - The DOUBLE-COUNT GUARD. Units logged before the baseline are already
 *     standing in the piles that were counted. Adding them again counts the
 *     same physical tube twice.
 *
 * Run:  node apps-script/test-wip.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  Logger: { log() {} }, console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

const BASE_AT = new Date('2026-08-05T09:00:00Z');
const BEFORE  = new Date('2026-08-04T10:00:00Z');   // already embodied in the piles
const AFTER   = new Date('2026-08-06T10:00:00Z');   // genuinely new work

// TubeStd line: Patched → Paint 1 → Paint 2 → Printed → Straps Attached → Boxed
const FIX = {
  Products: [
    { ProductID: 'XRT50STD', ProductName: 'Standard', Line: 'TubeStd', Active: 'YES', FeedsFrom: '' }
  ],
  Planning: [{ ProductID: 'XRT50STD', Stage: 'Paint 1', DailyTarget: 30 }],
  WipBaseline: [
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: 'Paint 1',         WaitingBefore: 40 },
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: 'Paint 2',         WaitingBefore: 25 },
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: 'Printed',         WaitingBefore: 10 },
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: 'Straps Attached', WaitingBefore: 5 },
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: 'Boxed',           WaitingBefore: 0 },
    { Timestamp: BASE_AT, ProductID: 'XRT50STD', Stage: '(finished)',      WaitingBefore: 8 }
  ],
  StageLog: [
    { Timestamp: BEFORE, WorkDate: '2026-08-04', ProductID: 'XRT50STD', Stage: 'Paint 1', Qty: 999 },
    { Timestamp: AFTER,  WorkDate: '2026-08-06', ProductID: 'XRT50STD', Stage: 'Paint 1', Qty: 12 }
  ],
  RawMaterials: [], BOM: []
};
sandbox.readObjects = (tab) => FIX[tab] || [];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const base = sandbox.wipBaselineMap().XRT50STD;

/* Backward walk from 8 finished:
 *   Boxed           = 8
 *   Straps Attached = 8 + 0  = 8
 *   Printed         = 8 + 5  = 13
 *   Paint 2         = 13 + 10 = 23
 *   Paint 1         = 23 + 25 = 48
 *   Patched         = 48 + 40 = 88            */
// Compared key-by-key: the map is built back-to-front, so its insertion order
// is reversed and comparing whole objects would fail on ordering alone.
const sortEntries = (o) => Object.keys(o).sort().map(k => [k, o[k]]);
check('cumulative completions derived by walking backwards from finished goods',
  sortEntries(base.completed),
  sortEntries({ 'Patched': 88, 'Paint 1': 48, 'Paint 2': 23,
                'Printed': 13, 'Straps Attached': 8, 'Boxed': 8 }));

check('the last stage equals finished goods on hand', base.completed.Boxed, 8);

const ov = sandbox.computeOverview();
const st = (n) => ov[0].stages.find(s => s.stage === n);

// The 999 logged BEFORE the baseline must be ignored; only the 12 after counts.
check('pre-baseline log rows are not double-counted',
  st('Paint 1').completed, 48 + 12);

// waiting at Paint 1 = completed(Patched) - completed(Paint 1) = 88 - 60 = 28.
// Physically: the pile of 40 shrank by the 12 that got painted.
check('WIP reflects the counted pile, drawn down by work logged since',
  st('Paint 1').waiting, 28);

check('a stage with an empty queue reports 0, not a phantom backlog',
  st('Boxed').waiting, 0);

check('finished count comes off the baseline, not from zero', ov[0].finished, 8);
check('the baseline date is surfaced so the UI can show its age',
  typeof ov[0].baselineAt, 'string');

// Without any baseline the old behaviour must be unchanged.
FIX.WipBaseline = [];
const bare = sandbox.computeOverview();
check('with no baseline, only logged work counts (999 + 12)',
  bare[0].stages.find(s => s.stage === 'Paint 1').completed, 1011);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
