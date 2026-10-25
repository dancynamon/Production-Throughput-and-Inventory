/* Speed (3.02.0): the floor's three requests do less sheet work.
 *
 * Pinned here:
 *   • submitDay reads Products once (was three times), never reads the whole
 *     StageLog (only its bottom DUP_TAIL_ROWS), and still calls out a second
 *     entry for the same stage today
 *   • each material's OnHand is written once per submit, after every read
 *   • config is served from the script cache on the second ask, and a hand
 *     edit to Products drops it while an edit to StageLog does not
 *   • a clock-in reads TimeLog once; floorPace reads it once
 *   • every reply carries serverMs
 *
 * Run:  node apps-script/test-speed.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path');

const reads = {};
function fakeSheet(name, headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  const writes = [];
  return { name, writes, grid, getName: () => name,
    getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => { reads[name] = (reads[name] || 0) + 1; return grid.map((r) => r.slice()); } }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; },
      setValue: (v) => { writes.push([r, c, v]); grid[r - 1][c - 1] = v; } }; },
    appendRow(row) { grid.push(row.slice()); } };
}
const LOG_H = ['Timestamp','WorkDate','Employee','ProductID','ProductName','Stage','Qty','Hours','Notes'];
const MAT_H = ['MaterialID','MaterialName','Unit','OnHand','ReorderPoint','Status','Category','Notes'];
const PROD_H = ['ProductID','ProductName','Line','Unit','Active','Family'];
const BOM_H = ['ProductID','Stage','MaterialID','QtyPerUnit'];
const EMP_H = ['Name','Active','PinHash'];
const TIME_H = ['Timestamp','WorkDate','Employee','In','Out','Hours','Source','ClientId','InLat','InLng','InAccuracy','InDistanceM','OutLat','OutLng','OutAccuracy','OutDistanceM','NoGeofence'];

// 600 old rows, then one of Alex's Made entries today near the bottom.
const old = []; for (let i = 0; i < 600; i++) old.push([new Date('2026-08-01T12:00:00Z'), '2026-08-01', 'Joe', 'STRAP6', 'Strap', 'Made', 1, '', '']);
const sheets = {
  StageLog: fakeSheet('StageLog', LOG_H, old.concat([[new Date(), '2026-09-29', 'Alex', 'STRAP6', 'Strap', 'Made', 5, '', '']])),
  RawMaterials: fakeSheet('RawMaterials', MAT_H, [['M014', 'Red Webbing', 'yd', 100, 1, '', 'Webbing', ''], ['M044', 'Strap', 'ea', 0, 0, '', 'Strap', '']]),
  Products: fakeSheet('Products', PROD_H.concat(['OutputMaterial']), [['STRAP6', 'Strap', 'Strap', 'ea', 'YES', 'Rescue Tubes', 'M044']]),
  BOM: fakeSheet('BOM', BOM_H, [['STRAP6', 'Made', 'M014', 2]]),
  Employees: fakeSheet('Employees', EMP_H, [['Joe', 'YES', ''], ['Alex', 'YES', '']]),
  TimeLog: fakeSheet('TimeLog', TIME_H, [])
};
const cacheStore = {}, props = { CLOCK_CUTOFF_HOUR: 'off' };
const clock = { t: Date.parse('2026-09-29T14:00:00Z') };
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock.t); }
  static now() { return clock.t; }
}
const sandbox = {
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  ContentService: { MimeType: { JAVASCRIPT: 'js', JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => sheets[n] || null }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  Utilities: { computeDigest: (alg, t) => Array.from(require('crypto').createHash('sha256').update(t, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)), getUuid: () => 'abcd', DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
  console, JSON, Math, Number, String, Object, Array, Date: FakeDate, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.ensureSchemaCurrent = () => {};
sandbox.wipBaselineMap = () => ({});

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const reset = () => Object.keys(reads).forEach((k) => delete reads[k]);

// ---- submitDay ----------------------------------------------------------------
reset();
const r = sandbox.submitDay({ workDate: '2026-09-29', employee: 'Joe', productId: 'STRAP6', counts: '{"Made":3}', clientId: 's1' });
check('submit logs', [r.ok, r.logged.length], [true, 1]);
check('Products read once, StageLog never read whole', [reads.Products, reads.StageLog || 0], [1, 0]);
check('a second entry today is still called out from the tail', r.duplicates.map((d) => [d.priorBy, d.priorQty, d.newTotal]), [['Alex', 5, 8]]);
check('the row lands at the bottom with every column in place', sheets.StageLog.grid[sheets.StageLog.grid.length - 1].slice(1, 7), ['2026-09-29', 'Joe', 'STRAP6', 'Strap', 'Made', 3]);
check('webbing deducted and strap produced, one write each', sheets.RawMaterials.writes.map((w) => [w[0], w[2]]).sort(), [[2, 94], [3, 3]]);
check('rows older than the tail are not read back', vm.runInContext('DUP_TAIL_ROWS', sandbox) < sheets.StageLog.grid.length, true);

// ---- reverse replay -------------------------------------------------------------
const rows0 = sheets.StageLog.grid.length;
const undo = { employee: 'Joe', by: 'Joe', productId: 'STRAP6', workDate: '2026-09-29', stage: 'Made', qty: 3, reason: 'floor undo', clientId: 'rv-1' };
const u1 = sandbox.reverseEntry(undo), u2 = sandbox.reverseEntry(undo);
check('a queued undo sent twice reverses once', [u1.ok, !!u1.replayed, u2.ok, u2.replayed, sheets.StageLog.grid.length - rows0], [true, false, true, true, 1]);

// ---- config cache -------------------------------------------------------------
reset();
const c1 = sandbox.getConfig();
const c2 = sandbox.getConfig();
check('first config is built, second comes from cache', [!!c1.cached, c2.cached, c2.employees], [false, true, ['Joe', 'Alex']]);
check('the cached ask read no tab', reads.Employees, 1);
sandbox.onEdit({ range: { getSheet: () => sheets.StageLog } });
check('a StageLog edit keeps the cache', sandbox.getConfig().cached, true);
sheets.Employees.grid.push(['Max', 'YES', '']);
sandbox.onEdit({ range: { getSheet: () => sheets.Employees } });
const c3 = sandbox.getConfig();
check('an Employees edit drops it, the next config sees the new name', [!!c3.cached, c3.employees], [false, ['Joe', 'Alex', 'Max']]);

// ---- clock / floorPace --------------------------------------------------------
sandbox.setClockPinFor('Joe', '1111');
reset();
const ci = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'k1' });
check('clock in works and reports the open shift', [ci.ok, ci.clockedIn, ci.hoursToday], [true, true, 0]);
check('clock in read TimeLog once', reads.TimeLog, 1);
clock.t += 2 * 3600000;
reset();
const co = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'out', clientId: 'k2' });
check('clock out closes it, hours from memory', [co.ok, co.clockedIn, co.shiftHours, co.hoursToday], [true, false, 2, 2]);
check('clock out read TimeLog once', reads.TimeLog, 1);
reset();
const fp = sandbox.getFloorPace({ employee: 'Joe', workDate: '2026-09-29' });
check('floorPace reads TimeLog once and StageLog never whole', [fp.ok, reads.TimeLog, reads.StageLog || 0, fp.me.hoursToday], [true, 1, 0, 2]);

// ---- serverMs -----------------------------------------------------------------
const out = sandbox.doGet({ parameter: { action: 'config', callback: 'cb' } });
check('replies carry serverMs', /"serverMs":\d+/.test(out.t), true);

console.log(failures ? failures + ' FAILURE(S)' : 'All checks passed.');
process.exit(failures ? 1 : 0);
