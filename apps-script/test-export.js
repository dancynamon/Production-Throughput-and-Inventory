/* Exercise exportTable() — a tab as rows for the app to turn into CSV.
 *
 * Pinned: dates leave as ISO strings (they sort and import anywhere), blank
 * rows are dropped, every tab in the allow-list resolves, and an unknown name
 * is refused with the list of what is allowed rather than a bare error.
 *
 * Run:  node apps-script/test-export.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const grid = [
  ['Timestamp', 'WorkDate', 'Employee', 'Qty', 'Notes'],
  [new Date(Date.UTC(2026, 8, 13, 12, 0, 0)), '2026-09-13', 'Dan', 3, 'note "with" quotes, and a comma'],
  ['', '', '', '', ''],
  [new Date('invalid'), '2026-09-14', 'Joe', 0, null]
];
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => (n === 'StageLog' ? { getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }) } : null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const r = sandbox.exportTable({ table: 'stagelog' });
check('headers come from the first row', r.headers, ['Timestamp', 'WorkDate', 'Employee', 'Qty', 'Notes']);
check('a blank row is dropped', r.rows.length, 2);
check('a Date leaves as an ISO string', r.rows[0][0], '2026-09-13T12:00:00.000Z');
check('an invalid Date leaves as empty, not "Invalid Date"', r.rows[1][0], '');
check('null leaves as empty', r.rows[1][4], '');
check('text with quotes and commas is passed through untouched (quoting is the CSV writer\'s job)',
  r.rows[0][4], 'note "with" quotes, and a comma');
check('table name is case-insensitive', sandbox.exportTable({ table: 'StageLog' }).ok, true);

const bad = sandbox.exportTable({ table: 'employees' });
check('an unknown table is refused', bad.ok, false);
check('and the refusal names what is allowed', /stagelog, countlog, receiving/.test(bad.error), true);
check('a missing tab is reported, not thrown', sandbox.exportTable({ table: 'countlog' }).ok, false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
