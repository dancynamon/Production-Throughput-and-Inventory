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
 * 3.04.1: today, myPace and reverse read StageLog through readObjectsWhere
 * (one column, then only the span of matching rows), not the whole tab:
 *   • on a log with hand-inserted, back-dated, future-dated, blank, Date and
 *     odd-string WorkDates, every answer equals the full-sheet read's,
 *     including rows a day either side of a window's edge
 *   • myPace no longer builds the whole floor; reverse reads Products and BOM
 *     before the lock and only that day's span under it
 *   • a before/after cell count is printed for an append-ordered log
 *
 * Run:  node apps-script/test-speed.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path');

const reads = {}, cells = {}, lockedCells = {}, lock = { held: false };
function countCells(name, n) {
  cells[name] = (cells[name] || 0) + n;
  if (lock.held) lockedCells[name] = (lockedCells[name] || 0) + n;
}
function fakeSheet(name, headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  const writes = [];
  return { name, writes, grid, getName: () => name,
    getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => { reads[name] = (reads[name] || 0) + 1; countCells(name, grid.length * grid[0].length); return grid.map((r) => r.slice()); } }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); countCells(name, (nr || 1) * (nc || 1)); return o; },
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
  LockService: { getScriptLock: () => ({ waitLock() { lock.held = true; }, releaseLock() { lock.held = false; } }) }, Logger: { log() {} },
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

// ---- windowed StageLog reads (3.04.1) ------------------------------------------
// The answer the 3.04.0 code gave: the whole tab, then the same filter.
const fullRead = (tab, col, test) => sandbox.readObjects(tab).filter((r) => test(r[col]));
const windowed = sandbox.readObjectsWhere;
function both(fn) {
  sandbox.readObjectsWhere = fullRead; const before = fn();
  sandbox.readObjectsWhere = windowed; const after = fn();
  return [before, after];
}
const D = (s) => new FakeDate(s + 'T12:00:00Z');        // the sandbox's Date, so fmtDate sees a Date
const row = (wd, who, qty, notes) => [D('2026-09-01'), wd, who, 'STRAP6', 'Strap', 'Made', qty, '', notes || ''];
clock.t = Date.parse('2026-09-29T15:00:00Z');        // myPace since = 2026-08-30
const tricky = [];
for (let i = 0; i < 400; i++) tricky.push(row(i % 2 ? '2026-07-15' : D('2026-07-16'), i % 3 ? 'Joe' : 'Alex', 1));
tricky.splice(5, 0, row('2026-09-29', 'joe', 4, 'hand-inserted near the top'));
tricky.splice(9, 0, row('2026-08-30', 'Joe', 6, 'first day in the window, also high up'));
tricky.push(row('2026-08-29', 'Joe', 7, 'one day before the window'));
tricky.push(row(D('2026-08-30'), 'JOE', 8, 'first day in the window, as a Date'));
tricky.push(['', '', '', '', '', '', '', '', '']);
tricky.push(row('9/15/2026', 'Joe', 9, 'typed by hand, not ISO'));
tricky.push(row('2026-09-28', 'Alex', 10));
tricky.push(row(D('2026-09-29'), 'Joe', 11, 'today'));
tricky.push(row('2026-09-29', 'Alex', 12));
tricky.push(row('2026-07-15', 'Joe', -1, 'REVERSED 1 by Dan: back-dated, at the bottom'));
tricky.push(row('2026-10-02', 'Joe', 13, 'future-dated'));
sheets.StageLog = fakeSheet('StageLog', LOG_H, tricky);

const dates = ['2026-07-14', '2026-07-15', '2026-07-16', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-15', '9/15/2026',
               '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-02', '2026-10-03', ''];
let same = 0;
dates.forEach((d) => {
  const eq = (v) => sandbox.fmtDate(v) === d, ge = (v) => sandbox.fmtDate(v) >= d;
  if (JSON.stringify(windowed('StageLog', 'WorkDate', eq)) === JSON.stringify(fullRead('StageLog', 'WorkDate', eq))) same++;
  if (JSON.stringify(windowed('StageLog', 'WorkDate', ge)) === JSON.stringify(fullRead('StageLog', 'WorkDate', ge))) same++;
});
check('readObjectsWhere returns the full read\'s rows, in order, for = and >= on every date either side of each edge', same, dates.length * 2);
const noCol = [windowed('StageLog', 'NoSuchCol', (v) => v === undefined), fullRead('StageLog', 'NoSuchCol', (v) => v === undefined)];
check('a column the tab does not have falls back to the full read', [noCol[0].length, JSON.stringify(noCol[0]) === JSON.stringify(noCol[1])], [tricky.length - 1, true]);
check('a missing tab is empty', windowed('NoSuchTab', 'WorkDate', () => true), []);

['2026-09-29', '2026-08-29', '2026-08-30', '2026-07-15', '2026-10-02', '9/15/2026', '2026-01-01'].forEach((d) => {
  const [a, b] = both(() => sandbox.getToday({ workDate: d }));
  check('today ' + d + ' matches the full read', [JSON.stringify(b) === JSON.stringify(a), b.products.length], [true, a.products.length]);
});
const t29 = sandbox.getToday({ workDate: '2026-09-29' });
check('today 2026-09-29 counts the hand-inserted row too', t29.products[0].rows[0].qty, 4 + 11 + 12);

// 3.04.0's getMyPace body. Its generatedAt read getFloorData().tables.generatedAt,
// which does not exist, so it never went out; 3.04.1 sends the real one (the app
// stores it as FLOOR.at and reads it nowhere). Everything else must match.
const oldMyPace = (name) => {
  const all = sandbox.getFloorData().tables;
  const since = new FakeDate(); since.setDate(since.getDate() - 30);
  const sinceIso = sandbox.fmtDate(since);
  const mine = all.stagelog.filter((r) => String(r.Employee || '').trim().toLowerCase() === name.toLowerCase() && String(r.WorkDate) >= sinceIso);
  return { ok: true, name, since: sinceIso, generatedAt: all.generatedAt,
           tables: { products: all.products, stages: all.stages, planning: all.planning, stagelog: mine, wipbase: [] } };
};
['Joe', 'joe', 'Alex'].forEach((n) => {
  const now = sandbox.getMyPace({ name: n });
  const was = oldMyPace(now.name);
  const sameBut = JSON.stringify(Object.assign({}, now, { generatedAt: undefined })) === JSON.stringify(was);
  check('myPace ' + n + ' equals the 3.04.0 answer (plus a real generatedAt)', [sameBut, now.tables.stagelog.length, now.generatedAt], [true, was.tables.stagelog.length, '2026-09-29T15:00:00.000Z']);
});
const mp = sandbox.getMyPace({ name: 'Joe' });
check('myPace keeps 08-30 (string and Date), drops 08-29, keeps the hand-typed and future rows',
  mp.tables.stagelog.map((r) => r.Qty), [4, 6, 8, 9, 11, 13]);

const tooMuch = (d) => sandbox.reverseEntryOnce({ employee: 'Joe', productId: 'STRAP6', workDate: d, stage: 'Made', qty: 1e6, reason: 'probe' }).error;
['2026-09-29', '2026-08-29', '2026-07-15', '2026-07-16', '2026-10-02', '2026-01-01'].forEach((d) => {
  const [a, b] = both(() => tooMuch(d));
  check('reverse ' + d + ' sees the same on-the-books total', b, a);
});

// Read size on an append-ordered log: 20,000 rows, the last 40 of them today.
const ordered = [];
for (let i = 0; i < 20000; i++) {
  const day = new FakeDate(Date.parse('2026-05-01T12:00:00Z') + Math.floor(i / 40) * 864e5 * 0.3);
  ordered.push(row(i >= 19960 ? '2026-09-29' : sandbox.fmtDate(day), i % 2 ? 'Joe' : 'Alex', 1));
}
sheets.StageLog = fakeSheet('StageLog', LOG_H, ordered);
const measure = (fn) => { Object.keys(cells).forEach((k) => delete cells[k]); Object.keys(lockedCells).forEach((k) => delete lockedCells[k]); fn(); return [cells.StageLog || 0, lockedCells.StageLog || 0]; };
const size = {};
[['today', () => sandbox.getToday({ workDate: '2026-09-29' })],
 ['myPace', () => sandbox.getMyPace({ name: 'Joe' })],
 ['reverse', () => tooMuch('2026-09-29')]].forEach(([k, fn]) => {
  sandbox.readObjectsWhere = fullRead; const before = measure(fn);
  sandbox.readObjectsWhere = windowed; const after = measure(fn);
  size[k] = { before, after };
});
const mpOld = measure(() => oldMyPace('Joe'))[0];
console.log('      StageLog cells read, 20,000 rows x 9 columns (before -> after; under lock for reverse):');
console.log('        today    ' + size.today.before[0] + ' -> ' + size.today.after[0]);
console.log('        myPace   ' + mpOld + ' -> ' + size.myPace.after[0] + '   (span = rows since ' + mp.since + ')');
console.log('        reverse  ' + size.reverse.before[1] + ' -> ' + size.reverse.after[1] + ' under the lock');
check('today reads one column plus today\'s span, not the tab', size.today.after[0] < size.today.before[0] / 5, true);
check('myPace reads less than the whole floor did', size.myPace.after[0] < mpOld, true);
check('reverse holds the lock over one column plus a day, not the tab', size.reverse.after[1] < size.reverse.before[1] / 5, true);
reset();
sandbox.getToday({ workDate: '2026-09-29' }); sandbox.getMyPace({ name: 'Joe' }); tooMuch('2026-09-29');
check('none of the three calls getDataRange on StageLog', reads.StageLog || 0, 0);
Object.keys(lockedCells).forEach((k) => delete lockedCells[k]);
tooMuch('2026-09-29');
check('reverse reads Products and BOM before the lock', [lockedCells.Products || 0, lockedCells.BOM || 0], [0, 0]);

console.log(failures ? failures + ' FAILURE(S)' : 'All checks passed.');
process.exit(failures ? 1 : 0);
