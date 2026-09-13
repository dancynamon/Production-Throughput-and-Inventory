/* Exercise computeCrew() — per-person output over a window.
 *
 * The one thing that would quietly mislead: a units-per-hour that divides ALL
 * of someone's units by only SOME of their hours. It has to use the units
 * from entries that carried hours, and say how much of the output that
 * covers. Also pinned: the window excludes old rows, and per-stage rates.
 *
 * Run:  node apps-script/test-crew.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
                    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

const d = (back) => { const t = new Date(); const x = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
  const p = (n) => (n < 10 ? '0' : '') + n; return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };

const LOG = [
  // Joe: 100 straps in 5h (20/hr) and 60 straps with no hours. Rate must be
  // 20/hr, from the 100, and coverage must say 62.5%.
  { Employee: 'Joe', ProductID: 'STRAP6', ProductName: 'Strap', Stage: 'Made', Qty: 100, Hours: 5,  WorkDate: d(1) },
  { Employee: 'Joe', ProductID: 'STRAP6', ProductName: 'Strap', Stage: 'Made', Qty: 60,  Hours: '', WorkDate: d(2) },
  // Alex: no hours anywhere -> no rate, honestly.
  { Employee: 'Alex', ProductID: 'KB1220', ProductName: 'Kickboard', Stage: 'CNC', Qty: 300, Hours: '', WorkDate: d(1) },
  // Outside a 30-day window.
  { Employee: 'Alex', ProductID: 'KB1220', ProductName: 'Kickboard', Stage: 'CNC', Qty: 999, Hours: 1, WorkDate: d(45) }
];
sandbox.readObjects = (tab) => (tab === 'StageLog' ? LOG : []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const r = sandbox.computeCrew({ days: 30 });
const by = Object.fromEntries(r.crew.map((c) => [c.name, c]));

check('rate uses only the units that had hours (100 ÷ 5), not all units', by.Joe.unitsPerHour, 20);
check('and says how much of the output that rate covers (100 of 160)', by.Joe.hoursCoverage, 62.5);
check('units, entries and days are totals over the window',
  [by.Joe.units, by.Joe.entries, by.Joe.daysWorked], [160, 2, 2]);
check('no hours at all means no rate, not a made-up one', by.Alex.unitsPerHour, null);
check('rows outside the window are excluded (the 999 from 45 days ago)', by.Alex.units, 300);
check('per-stage breakdown carries its own rate',
  by.Joe.stages[0], { productId: 'STRAP6', product: 'Strap', stage: 'Made', units: 160, hours: 5, unitsPerHour: 20 });
check('crew is ordered by output', r.crew.map((c) => c.name), ['Alex', 'Joe']);
check('the window is reported so the numbers can be read in context', r.days, 30);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
