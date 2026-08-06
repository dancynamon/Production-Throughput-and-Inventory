/* Exercise computeOverview()'s shared-blank-pool math against fixtures.
 *
 * The pool arithmetic is the one piece of genuinely new logic in the split
 * pipeline: two variants drawing from one batch of blanks, where what each can
 * start depends on what its sibling already took. Easy to get subtly wrong and
 * invisible until the numbers are nonsense on the floor, so it is pinned here.
 *
 * Runs Code.gs in a VM with the Apps Script globals stubbed and readObjects()
 * swapped for fixtures — no spreadsheet and no network involved.
 *
 * Run:  node apps-script/test-overview.js
 */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require('path').join(__dirname, 'Code.gs'), 'utf8');
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'Sheet', getId: () => 'ID', getSheetByName: () => null }),
    getActive: () => ({ toast() {} }),
    getUi: () => ({})
  },
  Logger: { log: console.log },
  console
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

// 100 blanks cut, 80 glued. 30 committed to Exo, 20 to Standard.
// Uncommitted pool should therefore be 80 - 30 - 20 = 30.
const FIXTURES = {
  Products: [
    { ProductID: 'BLANK50',  ProductName: '50" Blank', Line: 'Blank',   Active: 'YES', FeedsFrom: '' },
    { ProductID: 'XRT50EXO', ProductName: 'Exotube',   Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50' },
    { ProductID: 'XRT50STD', ProductName: 'Standard',  Line: 'TubeStd', Active: 'YES', FeedsFrom: 'BLANK50' }
  ],
  Planning: [
    { ProductID: 'BLANK50',  Stage: 'Cut',     DailyTarget: 60 },
    { ProductID: 'BLANK50',  Stage: 'Glued',   DailyTarget: 60 },
    { ProductID: 'XRT50EXO', Stage: 'Meshed',  DailyTarget: 30 },
    { ProductID: 'XRT50EXO', Stage: 'Patched', DailyTarget: 30 },
    { ProductID: 'XRT50STD', Stage: 'Patched', DailyTarget: 30 }
  ],
  StageLog: [
    { ProductID: 'BLANK50',  Stage: 'Cut',     Qty: 100 },
    { ProductID: 'BLANK50',  Stage: 'Glued',   Qty: 80 },
    { ProductID: 'XRT50EXO', Stage: 'Meshed',  Qty: 30 },
    { ProductID: 'XRT50STD', Stage: 'Patched', Qty: 20 }
  ]
};
sandbox.readObjects = (tab) => FIXTURES[tab] || [];

const out = sandbox.computeOverview();
const pick = (pid, stage) =>
  out.find(p => p.productId === pid).stages.find(s => s.stage === stage);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const cut = pick('BLANK50', 'Cut');
check('BLANK50/Cut — head of pipeline, nothing upstream',
  { waiting: cut.waiting, target: cut.target, suggest: cut.suggest },
  { waiting: null, target: 60, suggest: 60 });

const glued = pick('BLANK50', 'Glued');
check('BLANK50/Glued — 20 cut blanks still unglued, capped below its 60 target',
  { waiting: glued.waiting, suggest: glued.suggest, starved: glued.starved },
  { waiting: 20, suggest: 20, starved: true });

const meshed = pick('XRT50EXO', 'Meshed');
check('XRT50EXO/Meshed — shared pool 80-30-20 = 30',
  { waiting: meshed.waiting, target: meshed.target, suggest: meshed.suggest },
  { waiting: 30, target: 30, suggest: 30 });

const stdPatched = pick('XRT50STD', 'Patched');
check('XRT50STD/Patched — same pool, siblings compete',
  { waiting: stdPatched.waiting, suggest: stdPatched.suggest },
  { waiting: 30, suggest: 30 });

const exoPatched = pick('XRT50EXO', 'Patched');
check('XRT50EXO/Patched — normal chain, 30 meshed and none patched',
  { waiting: exoPatched.waiting, suggest: exoPatched.suggest },
  { waiting: 30, suggest: 30 });

check('Standard has no Meshed stage',
  out.find(p => p.productId === 'XRT50STD').stages.map(s => s.stage).includes('Meshed'),
  false);

check('Standard never deducts mesh (no BOM row for M002)',
  sandbox.tubeBomRows().some(r => r[0] === 'XRT50STD' && r[2] === 'M002'),
  false);

check('Exotube does deduct mesh',
  sandbox.tubeBomRows().some(r => r[0] === 'XRT50EXO' && r[2] === 'M002'),
  true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
