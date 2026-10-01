/* Floor mode backend: the clock (TimeLog) and the pace read (floorPace).
 *
 * Pinned here:
 *   • clock in appends one open row; a second clock-in returns the open shift
 *     instead of adding another
 *   • clock out closes it and computes Hours; a second clock-out is refused
 *   • the same clientId twice does nothing the second time (replay-safe)
 *   • a shift left open past 14 h is closed at 14 h, Source 'auto', when the
 *     next clock action arrives
 *   • floorPace counts identical StageLog rows once (production-recon rule),
 *     nets reversals, ignores other stages/products/weeks, and reports
 *     crew hours and boxed per clocked hour
 *   • access is exactly submitDay's: open actions, unknown names refused,
 *     manager actions still locked without a token
 *
 * Run:  node apps-script/test-floor.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path');

const clock = { t: Date.parse('2026-09-29T14:00:00Z') };      // a Tuesday
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock.t); }
  static now() { return clock.t; }
}
function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return { getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) { return {
      getValues: () => { const o = []; for (let i = 0; i < (nr || 1); i++) o.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1))); return o; },
      setValue: (v) => { grid[r - 1][c - 1] = v; } }; },
    appendRow(row) { grid.push(row.slice()); }, grid };
}
const LOG_H = ['Timestamp','WorkDate','Employee','ProductID','ProductName','Stage','Qty','Hours','Notes'];
const TIME_H = ['Timestamp','WorkDate','Employee','In','Out','Hours','Source','ClientId','InLat','InLng','InAccuracy','InDistanceM','OutLat','OutLng','OutAccuracy','OutDistanceM','NoGeofence','OriginalIn','OriginalOut','EditedBy','EditedAt','EditReason','EditLog'];
const EMP_H = ['Name','Active','PinHash'];
const log  = fakeSheet(LOG_H, []);
const time = fakeSheet(TIME_H, []);
const emps = fakeSheet(EMP_H, [['Joe','YES',''],['Alex','YES',''],['Gone','NO','']]);
const cacheStore = {}, props = {};
// The 14 h and approval checks below predate the 6pm auto clock-out (3.01.7); it has its own block at the end.
props.CLOCK_CUTOFF_HOUR = 'off';
const sandbox = {
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  ContentService: { MimeType: { JAVASCRIPT: 'js', JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => ({ StageLog: log, TimeLog: time, Employees: emps }[n] || null) }), getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  Utilities: { computeDigest: (alg, t) => Array.from(require('crypto').createHash('sha256').update(t, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)), getUuid: () => 'abcd-ef01-2345-6789', DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
  console, JSON, Math, Number, String, Object, Array, Date: FakeDate, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, H) => sheet.grid.slice(1).map((row) => Object.fromEntries(H.map((h, i) => [h, row[i]])));
sandbox.ensureSchemaCurrent = () => {};
['Joe', 'Alex'].forEach((n) => sandbox.setClockPinFor(n, '1111'));   // clock needs a personal PIN
sandbox.readObjects = (tab) => ({ StageLog: objs(log, LOG_H), Employees: objs(emps, EMP_H) }[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const H = 3600000;
const rowsOf = () => objs(time, TIME_H);

// ---- clock ------------------------------------------------------------------
const in1 = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c1' });
check('clock in opens one shift', [in1.ok, in1.clockedIn, in1.already, rowsOf().length], [true, true, false, 1]);
check('the open row has no Out and is Source floor', [rowsOf()[0].Out, rowsOf()[0].Source, rowsOf()[0].WorkDate], ['', 'floor', '2026-09-29']);

const in2 = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c2' });
check('second clock-in returns the open shift, adds nothing', [in2.ok, in2.already, in2.clockedIn, rowsOf().length], [true, true, true, 1]);

const in3 = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c1' });
check('same clientId is a replay', [in3.replayed, rowsOf().length], [true, 1]);

clock.t += 2.5 * H;
const out1 = sandbox.clockShift({ pin: '1111', employee: 'joe', dir: 'out', clientId: 'c3' });
check('clock out closes the shift with Hours (name matched case-blind)', [out1.ok, out1.shiftHours, out1.clockedIn, rowsOf()[0].Hours, rowsOf()[0].Source], [true, 2.5, false, 2.5, 'floor']);
check('hoursToday after clock out', out1.hoursToday, 2.5);

const out2 = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'out', clientId: 'c4' });
check('clock out with nothing open is refused', [out2.ok, rowsOf().length], [false, 1]);

// auto-close: left open, next clock-in 15 h later
const inA = sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'in', clientId: 'a1' });
const alexIn = clock.t;
clock.t += 15 * H;
const inA2 = sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'in', clientId: 'a2' });
const alexRows = rowsOf().filter((r) => r.Employee === 'Alex');
check('open >14h: old shift closed at 14h, Source auto', [alexRows[0].Hours, alexRows[0].Source, new Date(alexRows[0].Out).getTime() - new Date(alexRows[0].In).getTime()], [14, 'auto', 14 * H]);
check('and a fresh shift is opened', [inA2.ok, inA2.already, inA2.clockedIn, alexRows.length, alexRows[1].Out], [true, false, true, 2, '']);
check('the auto-close is reported to the phone', inA2.autoClosed && inA2.autoClosed.hours, 14);
const outA = sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'out', clientId: 'a3' });
check('a normal clock-out after that works', [outA.ok, outA.shiftHours], [true, 0]);

// clock-out arriving >14h after an open shift
sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'in', clientId: 'a4' });
clock.t += 20 * H;
const outLate = sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'out', clientId: 'a5' });
check('clock-out after 20h: refused, shift closed at 14h', [outLate.ok, rowsOf().filter((r) => r.Employee === 'Alex').pop().Hours], [false, 14]);

// ---- access: same as submitDay ---------------------------------------------
check('unknown name refused', sandbox.clockShift({ pin: '1111', employee: 'Mallory', dir: 'in' }).ok, false);
check('inactive name refused', sandbox.clockShift({ pin: '1111', employee: 'Gone', dir: 'in' }).ok, false);
check('no name refused', sandbox.clockShift({ dir: 'in' }).ok, false);
check('bad dir refused', sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'sideways' }).ok, false);
check('clock and floorPace are open actions, exactly like submitDay',
  ['submitDay', 'clock', 'floorPace'].map((a) => vm.runInContext('OPEN_ACTIONS', sandbox).indexOf(a) !== -1), [true, true, true]);
const body = (o) => JSON.parse(o.t);
check('a manager action is still locked without a token', body(sandbox.doGet({ parameter: { action: 'summary' } })).locked, true);
check('doGet routes clock without a token', body(sandbox.doGet({ parameter: { action: 'clock', pin: '1111', employee: 'Joe', dir: 'in', clientId: 'r1' } })).ok, true);
check('doGet routes floorPace without a token', body(sandbox.doGet({ parameter: { action: 'floorPace', employee: 'Joe' } })).ok, true);

// ---- floorPace --------------------------------------------------------------
// Fresh books for a clean count. Today = Tue 2026-09-29, week starts Mon 09-28.
clock.t = Date.parse('2026-09-29T14:00:00Z');
log.grid.length = 1; time.grid.length = 1;
const L = (date, who, pid, stage, qty, notes) => log.grid.push([new Date(clock.t), date, who, pid, 'n', stage, qty, '', notes || '']);
L('2026-09-29', 'Joe', 'XRT50EXO', 'Boxed', 24, '');
L('2026-09-29', 'Joe', 'XRT50EXO', 'Boxed', 24, '');            // replay duplicate: counts once
L('2026-09-29', 'Joe', 'XRT50EXO', 'Boxed', 12, 'floor a1b2c3');
L('2026-09-29', 'Joe', 'XRT50EXO', 'Boxed', 12, 'floor d4e5f6'); // same qty, distinct notes: both count
L('2026-09-29', 'Joe', 'XRT50EXO', 'Boxed', -12, 'REVERSED 12 by Joe: floor undo');
L('2026-09-29', 'Alex', 'XRT40EXO', 'Meshed', 30, '');
L('2026-09-29', 'Alex', 'XRT40STD', 'Patched', 20, '');
L('2026-09-29', 'Alex', 'BLANK50', 'Cut', 99, '');              // not a floor stage/product
L('2026-09-29', 'Alex', 'XRT50EXO', 'Paint 1', 50, '');         // not a floor stage
L('2026-09-28', 'Alex', 'XRT50EXO', 'Boxed', 40, '');           // Monday: week only
L('2026-09-21', 'Alex', 'XRT50EXO', 'Boxed', 500, '');          // last week: ignored
time.grid.push([new Date(clock.t), '2026-09-29', 'Joe', new Date(clock.t - 3 * H), new Date(clock.t - 0.5 * H), 2.5, 'floor', '']);
time.grid.push([new Date(clock.t), '2026-09-29', 'Alex', new Date(clock.t - 1 * H), '', '', 'floor', '']);   // open, 1 h

const fp = sandbox.getFloorPace({ employee: 'Joe', workDate: '2026-09-29' });
check('week starts on Monday', fp.weekStart, '2026-09-28');
check('crew Boxed today: dup once, distinct notes both, reversal netted (24+12+12-12)', fp.crew.today.Boxed, 36);
check('crew Meshed / Patched today', [fp.crew.today.Meshed, fp.crew.today.Patched], [30, 20]);
check('crew Boxed this week adds Monday, not last week', fp.crew.week.Boxed, 76);
check('one duplicate dropped', fp.duplicatesDropped, 1);
check('Joe today', fp.people.Joe.today, { Meshed: 0, Patched: 0, Boxed: 36 });
check('me = Joe', [fp.me.name, fp.me.today.Boxed, fp.me.clockedIn, fp.me.hoursToday], ['Joe', 36, false, 2.5]);
check('crew hours today: Joe 2.5 + Alex open 1', fp.crew.hoursToday, 3.5);
check('boxed per clocked hour', fp.crew.boxedPerHourToday, round(36 / 3.5));
check('Alex is clocked in per floorPace', sandbox.getFloorPace({ employee: 'Alex', workDate: '2026-09-29' }).me.clockedIn, true);
check('default target is 320/week, 64/day', [fp.target.weeklyBoxed, fp.target.dailyBoxed, fp.target.source], [320, 64, 'default']);
// Par is driven by clocked hours, not by the wall clock: 320 / 165 boxed per crew hour.
check('par per hour = 320 / 165', fp.target.parPerHour, 1.94);
check('par now = crew clocked hours (open shift counted to now) x par/hr', [fp.par.today, fp.par.week], [round(3.5 * 320 / 165), round(3.5 * 320 / 165)]);
clock.t += 1 * H;                                            // an hour later, Alex still clocked in
check('par grows with clocked hours, not time of day (Joe out, Alex still in: +1 h)', sandbox.getFloorPace({ workDate: '2026-09-29' }).par.today, round(4.5 * 320 / 165));
clock.t -= 1 * H;
props.FLOOR_WEEKLY_CREW_HOURS = '160';
check('FLOOR_WEEKLY_CREW_HOURS overrides the 165', [sandbox.getFloorPace({ workDate: '2026-09-29' }).target.parPerHour, sandbox.getFloorPace({ workDate: '2026-09-29' }).par.today], [2, 7]);
delete props.FLOOR_WEEKLY_CREW_HOURS;
check('no hours clocked means no par (0)', (() => { const t = time.grid.splice(1); const r = sandbox.getFloorPace({ workDate: '2026-09-29' }); t.forEach((x) => time.grid.push(x)); return r.par.today; })(), 0);
const FC = require('../floor-core.js');
check('grade: >=95% green', [FC.grade(19, 20), FC.grade(20, 20), FC.grade(30, 20)], ['g', 'g', 'g']);
check('grade: 75-95% amber', [FC.grade(18.9, 20), FC.grade(15, 20)], ['a', 'a']);
check('grade: <75% red', [FC.grade(14.9, 20), FC.grade(0, 20)], ['r', 'r']);
check('grade: no par yet is green', FC.grade(0, 0), 'g');
const dup = (by) => [{ stage: 'Boxed', priorQty: 36, priorBy: by, addedQty: 24, newTotal: 60 }];
check('dup message when someone else logged it', FC.dupText(dup('Joe'), 'Alex'), 'Joe already logged 36 Boxed today, total now 60');
check('silent when the only prior entries are mine', FC.dupText(dup('Joe'), 'joe'), '');
check('shown when mine and someone else\'s', FC.dupText(dup('Joe, Alex'), 'Joe'), 'Joe, Alex already logged 36 Boxed today, total now 60');
check('silent with no duplicates', FC.dupText([], 'Joe'), '');
props.FLOOR_WEEKLY_TARGET = '400';
const fp2 = sandbox.getFloorPace({ workDate: '2026-09-29' });
check('Script Property FLOOR_WEEKLY_TARGET overrides', [fp2.target.weeklyBoxed, fp2.target.dailyBoxed, fp2.target.source], [400, 80, 'FLOOR_WEEKLY_TARGET']);
check('floorPace works without an employee', fp2.me, undefined);
function round(n) { return Math.round(n * 100) / 100; }

/* 3.01.7: everyone still in at 6pm is clocked out at 6pm (TZ=UTC here, so 18:00Z). */
{
  props.CLOCK_CUTOFF_HOUR = '';               // blank = default 18
  const day = Date.parse('2026-10-05T00:00:00Z'), at = (h) => day + h * H;
  clock.t = at(7);
  sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c6a' });
  clock.t = at(17.5);
  check('6pm: before the cutoff the shift is still open', sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c6b' }).already, true);
  clock.t = at(19);
  const pace = sandbox.getFloorPace({ employee: 'Joe', workDate: '2026-10-05' });
  const joe6 = rowsOf().filter((r) => r.Employee === 'Joe').pop();
  check('6pm: the pace read writes the clock-out at 18:00 with Source auto6pm, 11 h',
    [new Date(joe6.Out).toISOString(), joe6.Source, joe6.Hours, pace.me.clockedIn], ['2026-10-05T18:00:00.000Z', 'auto6pm', 11, false]);
  const lateOut = sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'out', clientId: 'c6c' });
  check('6pm: a clock-out tap after it says you are already out', [lateOut.ok, /not clocked in/.test(lateOut.error)], [false, true]);
  clock.t = at(19.5);
  sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'in', clientId: 'c6d' });
  clock.t = at(21);
  check('6pm: a shift started after 6pm is not cut, it runs on the 14 h rule', sandbox.clockShift({ pin: '1111', employee: 'Joe', dir: 'out', clientId: 'c6e' }).shiftHours, 1.5);
  clock.t = at(30);   // next day 06:00, someone left in since 17:00 the day before
  sandbox.clockShift({ pin: '1111', employee: 'Alex', dir: 'in', clientId: 'c6f' });
  clock.t = at(30) + 0;
  props.CLOCK_CUTOFF_HOUR = '16';
  clock.t = at(41);   // 17:00 next day
  check('CLOCK_CUTOFF_HOUR moves it', sandbox.getFloorPace({ employee: 'Alex', workDate: '2026-10-06' }).me.hoursToday, 10);
  props.CLOCK_CUTOFF_HOUR = 'off';
  check('off: no cutoff', sandbox.cutoffMsFor(at(7)), Infinity);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
