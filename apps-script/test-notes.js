/* Per-stage notes on a day entry.
 * Pinned: a note given for a stage lands on THAT stage's row; a stage with no
 * note of its own gets the shared note; and getToday surfaces the notes.
 * Run:  node apps-script/test-notes.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return { appended: [], getLastColumn: () => grid[0].length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) { return { getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; }, setValue: (v) => { grid[r - 1][c - 1] = v; } }; },
    appendRow(row) { this.appended.push(row.slice()); grid.push(row.slice()); }, grid };
}
const MAT_H = ['MaterialID','MaterialName','Unit','OnHand','ReorderPoint','Status','Category','Notes'];
const LOG_H = ['Timestamp','WorkDate','Employee','ProductID','ProductName','Stage','Qty','Hours','Notes'];
const mats = fakeSheet(MAT_H, []); const log = fakeSheet(LOG_H, []);
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => ({ RawMaterials: mats, StageLog: log }[n] || null) }), getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, H) => sheet.grid.slice(1).map((row) => Object.fromEntries(H.map((h, i) => [h, row[i]])));
sandbox.readObjects = (tab) => ({ Products: [{ ProductID: 'LGC30', ProductName: 'Chair 30"', Line: 'Chair', Active: 'YES' }], BOM: [],
  StageLog: objs(log, LOG_H), RawMaterials: objs(mats, MAT_H) }[tab] || []);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const r = sandbox.submitDay({ workDate: '2026-09-13', employee: 'Joe', productId: 'LGC30',
  counts: JSON.stringify({ Cut: 4, Assemble: 2, Box: 1 }), notes: 'short-staffed',
  stageNotes: JSON.stringify({ Assemble: 'jig out of square, refit' }) });
const byStage = Object.fromEntries(log.appended.map((row) => [row[5], row[8]]));
check('the stage with its own note keeps it', byStage.Assemble, 'jig out of square, refit');
check('stages without one get the shared note', [byStage.Cut, byStage.Box], ['short-staffed', 'short-staffed']);
check('the response echoes the note per logged stage', r.logged.map((l) => [l.stage, l.note]),
  [['Cut', 'short-staffed'], ['Assemble', 'jig out of square, refit'], ['Box', 'short-staffed']]);
const today = sandbox.getToday({ workDate: '2026-09-13' });
check('today surfaces every note with product, stage and who', today.notes,
  [ { product: 'Chair 30"', stage: 'Cut', by: 'Joe', note: 'short-staffed' },
    { product: 'Chair 30"', stage: 'Assemble', by: 'Joe', note: 'jig out of square, refit' },
    { product: 'Chair 30"', stage: 'Box', by: 'Joe', note: 'short-staffed' } ]);
const r2 = sandbox.submitDay({ workDate: '2026-09-13', employee: 'Joe', productId: 'LGC30', counts: '{"Cut":1}', stageNotes: 'not json' });
check('junk stageNotes falls back to the shared note rather than failing', [r2.ok, r2.logged[0].note], [true, null]);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
