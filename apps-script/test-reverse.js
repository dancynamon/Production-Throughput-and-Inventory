/* Exercise reverseEntry() — taking back a mistaken day entry properly.
 *
 * Pinned:
 *   • a NEGATIVE row is appended, never a deletion — history keeps both the
 *     mistake and its correction, and every consumer that sums Qty comes right
 *   • the stage's recipe runs in reverse: materials go back on the shelf
 *   • a last-stage reversal on a sub-assembly takes its output back out
 *   • attributed to the ORIGINAL employee and date, with who-reversed in the
 *     note, so nobody's totals show a phantom negative day
 *   • you cannot reverse more than is on the books for that day
 *   • a reason is required — it goes in the log
 *
 * Run:  node apps-script/test-reverse.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');

function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return {
    appended: [],
    getLastColumn: () => grid[0].length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; },
      setValue: (v) => { grid[r - 1][c - 1] = v; },
      setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => { grid[r - 1 + i][c - 1 + j] = v; })); return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) }; }
    }; },
    appendRow(row) { this.appended.push(row); grid.push(row.slice()); },
    setFrozenRows() {}, autoResizeColumn() {}, grid
  };
}

const MAT_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint', 'Status', 'Category', 'Notes'];
const mats = fakeSheet(MAT_HEADERS, [
  ['M014', 'Red Webbing', 'yd',   10,  1, '', 'Webbing', ''],
  ['M044', 'Strap',       'each', 100, 1, '', 'Sub',     '']
]);
const LOG_HEADERS = ['Timestamp', 'WorkDate', 'Employee', 'ProductID', 'ProductName', 'Stage', 'Qty', 'Hours', 'Notes'];
const log = fakeSheet(LOG_HEADERS, [
  [new Date(), '2026-09-13', 'Joe', 'STRAP6', 'Strap', 'Made', 100, 5, '']
]);
const PRODUCTS = [{ ProductID: 'STRAP6', ProductName: 'Strap', Line: 'Strap', Active: 'YES', OutputMaterial: 'M044' }];
const BOM = [{ ProductID: 'STRAP6', Stage: 'Made', MaterialID: 'M014', QtyPerUnit: 1.78 }];

const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => ({ RawMaterials: mats, StageLog: log }[n] || null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, headers) => sheet.grid.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
sandbox.readObjects = (tab) => ({ Products: PRODUCTS, BOM: BOM,
  StageLog: objs(log, LOG_HEADERS), RawMaterials: objs(mats, MAT_HEADERS) }[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const base = { employee: 'Joe', productId: 'STRAP6', workDate: '2026-09-13', stage: 'Made', by: 'Dan' };

/* --- Guards -------------------------------------------------------------- */
check('a reason is required', sandbox.reverseEntry({ ...base, qty: 40 }).ok, false);
check('cannot reverse more than the day holds (100 logged)',
  /Only 100 logged/.test(sandbox.reverseEntry({ ...base, qty: 101, reason: 'x' }).error), true);
check('unknown stage is refused', sandbox.reverseEntry({ ...base, stage: 'Boxed', qty: 1, reason: 'x' }).ok, false);
check('nothing was written by the refused calls', log.appended.length, 0);

/* --- The reversal -------------------------------------------------------- */
const r = sandbox.reverseEntry({ ...base, qty: 40, reason: 'double tap' });
check('call succeeds', r.ok, true);
check('a NEGATIVE row is appended — nothing deleted', log.appended.length, 1);
const row = Object.fromEntries(LOG_HEADERS.map((h, i) => [h, log.appended[0][i]]));
check('attributed to the original employee and date, not the reverser',
  [row.Employee, row.WorkDate, row.Qty], ['Joe', '2026-09-13', -40]);
check('who reversed it, and why, is in the note', row.Notes, 'REVERSED 40 by Dan: double tap');
check('hours are left blank on the correction', row.Hours, '');
check('the day now sums to what actually happened', r.nowOnBooks, 60);

/* --- Materials ------------------------------------------------------------ */
check('the recipe ran in reverse: 40 × 1.78 yd back on the shelf (10 → 81.2)',
  [r.restored[0].restored, r.restored[0].onHand, mats.grid[1][3]], [71.2, 81.2, 81.2]);
check('last-stage output was taken back out (100 → 60 straps)',
  [r.removed.removed, mats.grid[2][3]], [40, 60]);

/* --- Then a second reversal is bounded by what is left ------------------- */
check('after reversing 40, only 60 can still be reversed',
  /Only 60 logged/.test(sandbox.reverseEntry({ ...base, qty: 61, reason: 'x' }).error), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
