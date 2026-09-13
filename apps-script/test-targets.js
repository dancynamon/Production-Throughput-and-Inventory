/* Exercise setTarget() — a daily target changed from the app.
 * Pinned: an existing (product, stage) row is updated in place and the old
 * value reported; a missing row is appended; an unknown stage or a negative
 * target is refused before anything is touched.
 * Run:  node apps-script/test-targets.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const grid = [['ProductID','ProductName','Stage','DailyTarget'], ['LGC30','Chair 30"','Cut',5], ['LGC30','Chair 30"','Assemble',5]];
const sheet = { appended: [], getLastColumn: () => 4,
  getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
  getRange: (r, c, nr, nc) => ({ getValues: () => [grid[r - 1].slice(c - 1, c - 1 + (nc || 1))], setValue: (v) => { grid[r - 1][c - 1] = v; } }),
  appendRow(row) { this.appended.push(row.slice()); grid.push(row.slice()); } };
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => (n === 'Planning' ? sheet : null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.readObjects = (tab) => (tab === 'Products' ? [{ ProductID: 'LGC30', ProductName: 'Chair 30"', Line: 'Chair', Active: 'YES' }] : []);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
check('a negative target is refused', sandbox.setTarget({ productId: 'LGC30', stage: 'Cut', target: -1 }).ok, false);
check('an unknown stage is refused', sandbox.setTarget({ productId: 'LGC30', stage: 'Paint', target: 3 }).ok, false);
check('nothing was touched by the refusals', [grid[1][3], sheet.appended.length], [5, 0]);
const u = sandbox.setTarget({ productId: 'LGC30', stage: 'Cut', target: 12.4 });
check('an existing row is updated in place, rounded, old value reported',
  [u.ok, u.appended, u.was, u.target, grid[1][3]], [true, false, 5, 12, 12]);
const a = sandbox.setTarget({ productId: 'LGC30', stage: 'Box', target: 7 });
check('a missing row is appended with the product name filled in',
  [a.ok, a.appended, a.was, sheet.appended[0]], [true, true, null, ['LGC30', 'Chair 30"', 'Box', 7]]);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
