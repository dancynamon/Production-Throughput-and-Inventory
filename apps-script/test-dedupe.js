/* The replay guard on the four writes a phone retries (3.05.0): submitDay,
 * reverse, ship, clock.
 *
 * test-replay.js pins the easy case: the retry arrives after the first answer
 * is in the cache. Pinned here are the two that used to double-log:
 *   • the RACE. A phone gives up waiting (20 s) while its first request is
 *     still queued on the script lock, and resends. Both looked in the cache
 *     before the lock, both missed, both logged. The fake lock below runs the
 *     twin while the second request waits on it, which is exactly that order
 *   • the EVICTED cache. CacheService keeps six hours at best; a phone left
 *     in a locker overnight retries after that. The log row's ClientId (or
 *     the ShipLog Key) is the durable answer
 * Plus: doGet marks "not now" errors (lock timeout, quota) retry: true, so a
 * phone keeps the entry instead of reading a busy floor as a refusal.
 *
 * Run:  node apps-script/test-dedupe.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path');

function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return { getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; },
      setValue: (v) => { grid[r - 1][c - 1] = v; } }; },
    appendRow(row) { grid.push(row.slice()); }, grid };
}
const MAT_H = ['MaterialID','MaterialName','Unit','OnHand','ReorderPoint','Status','Category','Notes'];
const LOG_H = ['Timestamp','WorkDate','Employee','ProductID','ProductName','Stage','Qty','Hours','Notes','ClientId'];
const SHIP_H = ['Timestamp','ShipDate','ProductID','ProductName','Qty','Channel','Ref','By','Notes','Key'];
const TIME_H = ['Timestamp','WorkDate','Employee','In','Out','Hours','Source','ClientId','InLat','InLng','InAccuracy','InDistanceM','OutLat','OutLng','OutAccuracy','OutDistanceM','NoGeofence'];
const EMP_H = ['Name','Active','PinHash'];
const mats = fakeSheet(MAT_H, [['M014', 'Red Webbing', 'yd', 100, 1, '', 'Webbing', '']]);
const log  = fakeSheet(LOG_H, []);
const ship = fakeSheet(SHIP_H, []);
const time = fakeSheet(TIME_H, []);
const emps = fakeSheet(EMP_H, [['Joe','YES','']]);

let cacheStore = {};
const props = { CLOCK_CUTOFF_HOUR: 'off' };
/* The lock: while a request waits on it, `twin` (if set) runs first, the
 * way a request that got there earlier finishes while the second one waits. */
let twin = null;
const lock = { waitLock() { const t = twin; twin = null; if (t) t(); }, tryLock() { return true; }, releaseLock() {} };
const sandbox = {
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  ContentService: { MimeType: { JAVASCRIPT: 'js', JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => ({ RawMaterials: mats, StageLog: log, ShipLog: ship, TimeLog: time, Employees: emps }[n] || null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => lock }, Logger: { log() {} },
  Utilities: { computeDigest: (alg, t) => Array.from(require('crypto').createHash('sha256').update(t, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)), getUuid: () => 'uuid-' + Math.random(), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, H) => sheet.grid.slice(1).map((row) => Object.fromEntries(H.map((h, i) => [h, row[i]])));
sandbox.ensureSchemaCurrent = () => {};
sandbox.readObjects = (tab) => ({
  Products: [{ ProductID: 'STRAP6', ProductName: 'Strap', Line: 'Strap', Active: 'YES' },
             { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exotube', Line: 'TubeExo', Active: 'YES' }],
  BOM: [{ ProductID: 'STRAP6', Stage: 'Made', MaterialID: 'M014', QtyPerUnit: 2 }],
  StageLog: objs(log, LOG_H), RawMaterials: objs(mats, MAT_H), ShipLog: objs(ship, SHIP_H), Employees: objs(emps, EMP_H) }[tab] || []);
sandbox.isSellable = () => true;
let storage = 50;
sandbox.adjustFinished = (ss, pid, d) => (storage += d);
sandbox.setClockPinFor('Joe', '1111');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const today = sandbox.fmtDate(new Date());
const rows = (sheet) => sheet.grid.length - 1;

/* ---- submitDay ------------------------------------------------------------ */
const day = { workDate: today, employee: 'Joe', productId: 'STRAP6', counts: '{"Made":10}', clientId: 'fl-race-1' };
let first = null;
twin = () => { first = sandbox.submitDay(day); };
const second = sandbox.submitDay(day);
check('race: the twin that held the lock first logged once', [first.ok, first.replayed], [true, undefined]);
check('race: the resend waiting on the lock gets its answer, marked replayed', [second.ok, second.replayed, second.message], [true, true, first.message]);
check('race: ONE StageLog row, webbing deducted ONCE', [rows(log), mats.grid[1][3]], [1, 80]);
check('the row carries the phone\'s ClientId', log.grid[1][LOG_H.indexOf('ClientId')], 'fl-race-1');

cacheStore = {};                                       // six hours later, or evicted
const late = sandbox.submitDay(day);
check('evicted cache: the ClientId on the row still says "already logged"', [late.ok, late.replayed, rows(log), mats.grid[1][3]], [true, true, 1, 80]);
check('and the answer says what is on the books', [late.logged[0].stage, late.logged[0].qty], ['Made', 10]);

const other = sandbox.submitDay(Object.assign({}, day, { clientId: 'fl-race-2' }));
check('a different clientId is a new entry', [other.replayed, rows(log), mats.grid[1][3]], [undefined, 2, 60]);
const bare = sandbox.submitDay(Object.assign({}, day, { clientId: '' }));
check('no clientId: no dedupe, the old behaviour', [bare.ok, rows(log)], [true, 3]);

/* ---- reverse ------------------------------------------------------------------ */
const rv = { employee: 'Joe', by: 'Joe', productId: 'STRAP6', workDate: today, stage: 'Made', qty: 5, reason: 'floor undo', clientId: 'rv-fl-race-1' };
let rFirst = null;
twin = () => { rFirst = sandbox.reverseEntry(rv); };
const rSecond = sandbox.reverseEntry(rv);
check('race: reverse lands once', [rFirst.ok, rSecond.ok, rSecond.replayed, rows(log)], [true, true, true, 4]);
check('race: webbing restored once (5 x 2)', mats.grid[1][3], 50);
cacheStore = {};
const rLate = sandbox.reverseEntry(rv);
check('evicted cache: the reversal row\'s ClientId stops a second reversal', [rLate.ok, rLate.replayed, rows(log), mats.grid[1][3]], [true, true, 4, 50]);
check('the reversal row carries its ClientId', log.grid[4][LOG_H.indexOf('ClientId')], 'rv-fl-race-1');

/* ---- ship ------------------------------------------------------------------------ */
const before = storage;
const sh = { employee: 'Maria', productId: 'XRT50EXO', qty: 4, channel: 'Shopify', ref: '#6107', clientId: 'ship-1', shipDate: today };
let sFirst = null;
twin = () => { sFirst = sandbox.shipOut(sh); };
const sSecond = sandbox.shipOut(sh);
check('race: one ShipLog row, storage down once', [sFirst.ok, sSecond.replayed, rows(ship), before - storage], [true, true, 1, 4]);
cacheStore = {};
const sLate = sandbox.shipOut(sh);
check('evicted cache: the ShipLog Key stops a second shipment', [sLate.ok, sLate.replayed, rows(ship), before - storage], [true, true, 1, 4]);

/* ---- clock ------------------------------------------------------------------------ */
sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'ck-1' });
const cout = { pin: '1111', employee: 'Joe', dir: 'out', clientId: 'ck-2' };
let cFirst = null;
twin = () => { cFirst = sandbox.clockShift(cout); };
const cSecond = sandbox.clockShift(cout);
check('race: a resent clock-out gets the first answer, not "You are not clocked in"', [cFirst.ok, cSecond.ok, cSecond.replayed, cSecond.dir], [true, true, true, 'out']);

/* ---- doGet: "not now" vs "no" ------------------------------------------------------ */
const saved = sandbox.submitDay;
const call = () => JSON.parse(sandbox.doGet({ parameter: { action: 'submitDay', employee: 'Joe', productId: 'STRAP6' } }).t);
props.CREW_TOKEN_ENFORCE_AT = String(Date.now() + 3600000);     // inside the tokenless grace window
sandbox.submitDay = () => { throw new Error('Lock timeout: another process was holding the lock for too long.'); };
let r = call();
check('a lock timeout is marked retry: true', [r.ok, r.retry], [false, true]);
sandbox.submitDay = () => { throw new Error('Service invoked too many times for one day: urlfetch.'); };
check('a quota burst is marked retry: true', call().retry, true);
sandbox.submitDay = () => { throw new Error('Cannot read properties of undefined'); };
check('a real bug is not', call().retry, false);
sandbox.submitDay = saved;
check('a plain refusal (bad input) carries no retry flag', sandbox.submitDay({ workDate: today, employee: 'Joe', productId: 'STRAP6', counts: '{}' }).retry, undefined);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
