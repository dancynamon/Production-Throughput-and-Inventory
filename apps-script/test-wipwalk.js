/* Exercise submitWipWalk() — the whole floor in one pass.
 *
 * Pinned: every product in the walk gets every stage written under ONE
 * timestamp (that timestamp is what decides which logged rows are
 * superseded, so twenty-one different ones would be twenty-one different
 * "befores"); products absent from the walk are untouched; zero is written
 * as zero; an unknown product refuses the whole walk rather than half of it.
 *
 * Run:  node apps-script/test-wipwalk.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const wip = { appended: [], appendRow(r) { this.appended.push(r.slice()); },
  getLastColumn: () => 7, getRange: () => ({ getValues: () => [['Timestamp','ProductID','ProductName','Stage','WaitingBefore','CountedBy','Notes']] }) };
const PRODUCTS = [
  { ProductID: 'LGC30', ProductName: 'Chair 30"', Line: 'Chair', Active: 'YES' },
  { ProductID: 'LGC40', ProductName: 'Chair 40"', Line: 'Chair', Active: 'YES' },
  { ProductID: 'STRAP6', ProductName: 'Strap', Line: 'Strap', Active: 'YES' }
];
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => (n === 'WipBaseline' ? wip : null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const H = ['Timestamp','ProductID','ProductName','Stage','WaitingBefore','CountedBy','Notes'];
sandbox.readObjects = (tab) => ({ Products: PRODUCTS,
  WipBaseline: wip.appended.map((r) => Object.fromEntries(H.map((h, i) => [h, r[i]]))) }[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

check('an unknown product refuses the whole walk',
  sandbox.submitWipWalk({ employee: 'Dan', walk: JSON.stringify({ LGC30: {}, NOPE: {} }) }).ok, false);
check('and nothing was written by the refusal', wip.appended.length, 0);
check('an empty walk is refused', sandbox.submitWipWalk({ employee: 'Dan', walk: '{}' }).ok, false);

// Walk two of the three products. Chair line is Cut -> Assemble -> Box.
const r = sandbox.submitWipWalk({ employee: 'Dan', notes: 'Monday walk',
  walk: JSON.stringify({ LGC30: { Assemble: 3, Box: 1, '(finished)': 2 }, LGC40: { Box: '' } }) });
check('call succeeds', r.ok, true);
check('two products recorded, the third untouched', r.products.map((p) => p.productId), ['LGC30', 'LGC40']);
// Chair: Cut, Assemble, Box, (finished) = 4 rows each.
check('every stage is written for every walked product, zeros included', wip.appended.length, 8);
const stamps = new Set(wip.appended.map((row) => row[0].getTime()));
check('ONE timestamp across the whole walk', stamps.size, 1);
const lgc40 = wip.appended.filter((row) => row[1] === 'LGC40').map((row) => [row[3], row[4]]);
check('a blank pile is written as zero, not skipped',
  lgc40, [['Cut', 0], ['Assemble', 0], ['Box', 0], ['(finished)', 0]]);
check('who and why ride on every row', [wip.appended[0][5], wip.appended[0][6]], ['Dan', 'Monday walk']);
// Backward walk: finished 2 -> Box done 2; +1 at Box -> Assemble done 3; +3 at Assemble -> Cut done 6.
check('cumulative completions come back per product',
  r.products[0].completed, { Box: 2, Assemble: 3, Cut: 6 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
