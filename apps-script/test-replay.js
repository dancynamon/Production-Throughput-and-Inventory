/* submitDay() must be safe to retry.
 *
 * JSONP gives no reply on a timeout, so a phone cannot tell "never arrived"
 * from "arrived, answer lost". It retries with the same clientId, and the
 * second call has to return the first answer WITHOUT logging the day again or
 * deducting the materials twice. Pinned here with a fake CacheService; also
 * pinned that a call with no clientId behaves exactly as before, and that a
 * missing CacheService degrades to "no dedupe" rather than an error.
 *
 * Run:  node apps-script/test-replay.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return { appended: [], getLastColumn: () => grid[0].length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; },
      setValue: (v) => { grid[r - 1][c - 1] = v; } }; },
    appendRow(row) { this.appended.push(row.slice()); grid.push(row.slice()); }, grid };
}
const MAT_H = ['MaterialID','MaterialName','Unit','OnHand','ReorderPoint','Status','Category','Notes'];
const LOG_H = ['Timestamp','WorkDate','Employee','ProductID','ProductName','Stage','Qty','Hours','Notes'];
const mats = fakeSheet(MAT_H, [['M014', 'Red Webbing', 'yd', 100, 1, '', 'Webbing', '']]);
const log  = fakeSheet(LOG_H, []);
const cacheStore = {};
const sandbox = {
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => ({ RawMaterials: mats, StageLog: log }[n] || null) }), getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, H) => sheet.grid.slice(1).map((row) => Object.fromEntries(H.map((h, i) => [h, row[i]])));
sandbox.readObjects = (tab) => ({
  Products: [{ ProductID: 'STRAP6', ProductName: 'Strap', Line: 'Strap', Active: 'YES' }],
  BOM: [{ ProductID: 'STRAP6', Stage: 'Made', MaterialID: 'M014', QtyPerUnit: 2 }],
  StageLog: objs(log, LOG_H), RawMaterials: objs(mats, MAT_H) }[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const req = { workDate: '2026-09-13', employee: 'Joe', productId: 'STRAP6', counts: '{"Made":10}', clientId: 'phone-abc-1' };

const first = sandbox.submitDay(req);
check('first submit logs and deducts', [first.ok, log.appended.length, mats.grid[1][3]], [true, 1, 80]);
check('first answer is not marked as a replay', first.replayed, undefined);

const second = sandbox.submitDay(req);
check('the retry returns the same answer', second.message, first.message);
check('and is marked as a replay', second.replayed, true);
check('the retry logged NOTHING more', log.appended.length, 1);
check('and deducted NOTHING more', mats.grid[1][3], 80);

const third = sandbox.submitDay({ ...req, clientId: 'phone-abc-2' });
check('a different clientId is a different submission', [third.replayed, log.appended.length, mats.grid[1][3]], [undefined, 2, 60]);

const fourth = sandbox.submitDay({ ...req, clientId: '' });
check('no clientId means no dedupe, exactly the old behaviour', [fourth.ok, log.appended.length], [true, 3]);

delete sandbox.CacheService;
const fifth = sandbox.submitDay({ ...req, clientId: 'phone-abc-1' });
check('no CacheService at all degrades to no dedupe, not an error', [fifth.ok, log.appended.length], [true, 4]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
