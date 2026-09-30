/* The time clock that keeps people honest (3.01.0).
 *
 * Pinned here: personal 4-digit PIN (salted hash, never returned, five wrong
 * tries lock a name for 15 minutes), the shop geofence (accept, reject,
 * accuracy, no location, shop not set yet), forgot-to-punch requests that
 * only change TimeLog when a manager approves and keep the originals, manager
 * edits that need a reason, the flags, timeExport and the manager actions
 * being token-gated, and the 6pm summary email.
 *
 * Run:  node apps-script/test-timeclock.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path'); const crypto = require('crypto');

const clock = { t: Date.parse('2026-09-29T14:00:00Z') };
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
const REQ_H = ['RequestId','Timestamp','Employee','Dir','RequestedTime','WorkDate','Reason','Status','DecidedBy','DecidedAt','DecisionNote'];
const EMP_H = ['Name','Active','PinHash'];
const log = fakeSheet(LOG_H, []), time = fakeSheet(TIME_H, []), reqs = fakeSheet(REQ_H, []);
const emps = fakeSheet(EMP_H, [['Joe','YES',''],['Alex','YES',''],['Maria','YES','']]);
const cacheStore = {}, props = {}, mails = [], triggers = [];
const sandbox = {
  CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
  ContentService: { MimeType: { JAVASCRIPT: 'js', JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
  Utilities: { computeDigest: (alg, t) => Array.from(crypto.createHash('sha256').update(t, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: (() => { let n = 0; return () => 'aaaa-bbbb-cccc-' + (++n) + 'dddd'; })(), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
    formatDate: (d) => d.toISOString().slice(11, 16) },
  MailApp: { sendEmail: (m) => mails.push(m) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'dan@aquamentor.com' }) },
  ScriptApp: { getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.h, id: t })),
    deleteTrigger: (t) => { const i = triggers.indexOf(t.id); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: (h) => { const t = { h }; const b = { timeBased: () => b, everyDays: (n) => { t.days = n; return b; }, atHour: (x) => { t.hour = x; return b; },
      nearMinute: () => b, inTimezone: (z) => { t.tz = z; return b; }, create: () => { triggers.push(t); } }; return b; } },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID',
    getSheetByName: (n) => ({ StageLog: log, TimeLog: time, TimeRequests: reqs, Employees: emps }[n] || null) }), getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date: FakeDate, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const objs = (sheet, H) => sheet.grid.slice(1).map((row) => Object.fromEntries(H.map((h, i) => [h, row[i]])));
sandbox.ensureSchemaCurrent = () => {};
sandbox.readObjects = (tab) => ({ StageLog: objs(log, LOG_H), Employees: objs(emps, EMP_H), TimeLog: objs(time, TIME_H), TimeRequests: objs(reqs, REQ_H) }[tab] || []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const H = 3600000, body = (o) => JSON.parse(o.t), rows = () => objs(time, TIME_H);
const SHOP = { lat: 40.6600, lng: -74.3100 }, M_PER_DEG = 111195;
const near = (m) => ({ lat: SHOP.lat + m / M_PER_DEG, lng: SHOP.lng });
let cid = 0;
const punch = (o) => sandbox.clockShift(Object.assign({ employee: 'Joe', pin: '1111', clientId: 'c' + (++cid) }, o));

// ---- PIN ----------------------------------------------------------------------
check('no PIN on file: refused with the manager message', punch({ dir: 'in' }).error, 'Ask a manager to set your PIN.');
check('PIN must be exactly 4 digits', [sandbox.managerSetClockPin({ employee: 'Joe', pin: '12' }).ok, sandbox.managerSetClockPin({ employee: 'Joe', pin: '12345' }).ok, sandbox.managerSetClockPin({ employee: 'Joe', pin: 'abcd' }).ok], [false, false, false]);
check('manager sets Joe\'s PIN', sandbox.managerSetClockPin({ employee: 'Joe', pin: '1111' }).ok, true);
const stored = emps.grid[1][2];
check('only "salt:sha256" is stored, never the PIN', [/^[0-9a-f]{12}:[0-9a-f]{64}$/.test(stored), stored.indexOf('1111') === -1], [true, true]);
sandbox.managerSetClockPin({ employee: 'Maria', pin: '1111' });
check('same PIN, different person: different hash (salted)', emps.grid[1][2] !== emps.grid[3][2], true);
const cfgJson = JSON.stringify(sandbox.getConfig());
check('config never carries the hash', cfgJson.indexOf(stored) === -1 && cfgJson.indexOf('PinHash') === -1, true);
check('the Employees tab cannot be exported', sandbox.exportTable({ table: 'employees' }).ok, false);
const tvJson = JSON.stringify(sandbox.getTimeView({}));
check('timeView shows who has a PIN, not the hash', [tvJson.indexOf(stored) === -1, tvJson.indexOf('PinHash') === -1, JSON.parse(tvJson).employees.filter((e) => e.hasPin).map((e) => e.name)], [true, true, ['Joe', 'Maria']]);
check('unset name still refused for Alex (no PIN)', punch({ employee: 'Alex', dir: 'in' }).error, 'Ask a manager to set your PIN.');

let r = punch({ dir: 'in', pin: '9999' });
check('wrong PIN refused, tries counted', [r.ok, r.error], [false, 'Wrong PIN. 4 tries left.']);
check('a right PIN clears the count', punch({ dir: 'in', pin: '1111' }).ok, true);
punch({ dir: 'out' });                              // shop not set: allowed, flagged; closes the shift
for (let i = 0; i < 4; i++) punch({ dir: 'in', pin: '0000' });
r = punch({ dir: 'in', pin: '0000' });
check('fifth wrong PIN locks the name', [r.ok, r.locked, /15 minutes/.test(r.error)], [false, true, true]);
r = punch({ dir: 'in', pin: '1111' });
check('locked means locked, even for the right PIN', [r.ok, r.locked], [false, true]);
check('and an in-request is locked too', sandbox.submitTimeRequest({ employee: 'Joe', pin: '1111', dir: 'out', at: clock.t - H, reason: 'x' }).locked, true);
check('Maria is not affected', punch({ employee: 'Maria', dir: 'in' }).ok, true);
punch({ employee: 'Maria', dir: 'out' });
sandbox.managerSetClockPin({ employee: 'Joe', pin: '1111' });
check('a manager PIN reset lifts the lock', punch({ dir: 'in' }).ok, true);
punch({ dir: 'out' });

// ---- geofence -----------------------------------------------------------------
time.grid.length = 1;
r = punch({ dir: 'in' });
check('shop not set: punch allowed, flagged NoGeofence', [r.ok, r.atShop, rows()[0].NoGeofence], [true, false, 'TRUE']);
punch({ dir: 'out' });
time.grid.length = 1;
check('setShopLocation rejects nonsense', [sandbox.managerSetShopLocation({ lat: 'x', lng: 1 }).ok, sandbox.managerSetShopLocation({ lat: 0, lng: 0 }).ok, sandbox.managerSetShopLocation({ lat: 95, lng: 1 }).ok], [false, false, false]);
check('setShopLocation writes SHOP_LAT / SHOP_LNG', [sandbox.managerSetShopLocation(SHOP).ok, props.SHOP_LAT, props.SHOP_LNG], [true, '40.66', '-74.31']);
r = punch({ dir: 'in' });
check('shop set, no location: refused with the clear message', [r.ok, r.error, r.needLocation], [false, 'Turn on location. Punches only work at the shop.', true]);
r = punch({ dir: 'in', lat: near(20).lat, lng: near(20).lng, accuracy: 400 });
check('accuracy over 300 m: refused', [r.ok, r.needLocation], [false, true]);
r = punch({ dir: 'in', lat: near(800).lat, lng: near(800).lng, accuracy: 20 });
check('800 m away: refused, says how far', [r.ok, /about 800 m/.test(r.error)], [false, true]);
r = punch({ dir: 'in', lat: near(300).lat, lng: near(300).lng, accuracy: 50 });
check('300 m away, accuracy 50 (250 > 150): refused', r.ok, false);
r = punch({ dir: 'in', lat: near(200).lat, lng: near(200).lng, accuracy: 100 });
check('200 m away, accuracy 100 (100 <= 150): accepted', [r.ok, r.atShop, r.distanceM], [true, true, 200]);
const row0 = rows()[0];
check('lat, lng, accuracy and distance stored on the row', [row0.InLat > 40.66, row0.InLng, row0.InAccuracy, row0.InDistanceM, row0.NoGeofence], [true, -74.31, 100, 200, '']);
r = punch({ dir: 'out' });
check('clock OUT needs the fence too', [r.ok, r.needLocation], [false, true]);
r = punch({ dir: 'out', pin: '2222', lat: near(10).lat, lng: near(10).lng, accuracy: 10 });
check('clock OUT needs the PIN too', [r.ok, r.needPin], [false, true]);
clock.t += 3 * H;
r = punch({ dir: 'out', lat: near(10).lat, lng: near(10).lng, accuracy: 10 });
check('clock out at the shop works and stores the out fix', [r.ok, r.shiftHours, rows()[0].OutDistanceM, rows()[0].OutAccuracy], [true, 3, 10, 10]);
props.SHOP_RADIUS_M = '500';
check('SHOP_RADIUS_M widens the fence', punch({ dir: 'in', lat: near(300).lat, lng: near(300).lng, accuracy: 50 }).ok, true);
delete props.SHOP_RADIUS_M;
punch({ dir: 'out', lat: near(10).lat, lng: near(10).lng, accuracy: 10 });

// ---- forgot to punch -> request -> approve -----------------------------------------
time.grid.length = 1;
const at = () => ({ lat: near(5).lat, lng: near(5).lng, accuracy: 10 });
const inMs = clock.t;
punch(Object.assign({ dir: 'in' }, at()));
clock.t += 8 * H;
const rq = (o) => sandbox.submitTimeRequest(Object.assign({ employee: 'Joe', pin: '1111', dir: 'out', at: clock.t - H, reason: 'Left at 3, forgot' }, o));
check('request needs a reason', rq({ reason: '' }).ok, false);
check('request refuses the future', rq({ at: clock.t + 3 * H }).ok, false);
check('request needs the PIN', rq({ pin: '0000' }).ok, false);
sandbox.managerSetClockPin({ employee: 'Joe', pin: '1111' });      // the wrong-PIN try above counted one
const rqOk = rq({});
check('request lands as Pending and changes NOTHING in TimeLog', [rqOk.ok, objs(reqs, REQ_H)[0].Status, rows()[0].Out], [true, 'Pending', '']);
check('manager actions need a token: timeDecide', body(sandbox.doGet({ parameter: { action: 'timeDecide', id: rqOk.requestId, decision: 'approve' } })).locked, true);
const tok = sandbox.managerToken('Dan');
const mgr = (o) => body(sandbox.doGet({ parameter: Object.assign({ mgrName: 'Dan', token: tok }, o) }));
check('timeView lists it', mgr({ action: 'timeView' }).pending.map((x) => [x.employee, x.dir, x.reason]), [['Joe', 'out', 'Left at 3, forgot']]);
const ap = mgr({ action: 'timeDecide', id: rqOk.requestId, decision: 'approve', note: 'ok' });
const done = rows()[0];
check('approval closes the shift with Hours', [ap.ok, done.Hours, done.Source], [true, 7, 'request']);
check('originals kept: OriginalIn is the real In, OriginalOut says it was open', [new Date(done.OriginalIn).getTime(), done.OriginalOut], [inMs, '(open)']);
check('audit columns filled', [done.EditedBy, /forgot/.test(done.EditReason), /Dan/.test(done.EditLog)], ['Dan', true, true]);
check('request row records who decided', [objs(reqs, REQ_H)[0].Status, objs(reqs, REQ_H)[0].DecidedBy], ['Approved', 'Dan']);
check('cannot approve twice', mgr({ action: 'timeDecide', id: rqOk.requestId, decision: 'approve' }).ok, false);
const rq2 = rq({ dir: 'in', at: clock.t - 2 * H, reason: 'forgot to clock in' });
mgr({ action: 'timeDecide', id: rq2.requestId, decision: 'approve' });
const added = rows()[1];
check('an approved "in" request appends a row with the audit trail', [added.Source, added.OriginalIn, added.EditedBy, added.NoGeofence], ['request', '(none)', 'Dan', 'TRUE']);
const rq3 = rq({ dir: 'out', at: clock.t - H, reason: 'again' });
const dn = mgr({ action: 'timeDecide', id: rq3.requestId, decision: 'deny', note: 'no' });
check('deny leaves TimeLog alone', [dn.ok, rows().length, objs(reqs, REQ_H)[2].Status], [true, 2, 'Denied']);

// ---- manager edits --------------------------------------------------------------------
check('edit without a reason is refused', mgr({ action: 'timeEdit', row: 2, inMs: clock.t - 9 * H }).ok, false);
const first = new Date(rows()[0].OriginalIn).getTime();
let ed = mgr({ action: 'timeEdit', row: 2, inMs: inMs + H, outMs: inMs + 6 * H, reason: 'fixing start' });
check('edit with a reason works, Hours recomputed', [ed.ok, rows()[0].Hours, rows()[0].Source], [true, 5, 'manual']);
ed = mgr({ action: 'timeEdit', row: 2, inMs: inMs + 2 * H, outMs: inMs + 6 * H, reason: 'second fix' });
check('a second edit never overwrites the ORIGINAL times', [new Date(rows()[0].OriginalIn).getTime(), rows()[0].OriginalOut], [inMs, '(open)']);
check('every edit is in EditLog', rows()[0].EditLog.split('\n').length, 3);
check('out before in refused', mgr({ action: 'timeEdit', row: 2, inMs: inMs + 5 * H, outMs: inMs + H, reason: 'x' }).ok, false);

// ---- flags -------------------------------------------------------------------------------
time.grid.length = 1; log.grid.length = 1; reqs.grid.length = 1;
clock.t = Date.parse('2026-09-29T20:00:00Z');
const T = (h) => clock.t - h * H;
const shift = (who, inH, outH, src, extra) => time.grid.push(TIME_H.map((c) => ({ Timestamp: new Date(T(inH)), WorkDate: '2026-09-29', Employee: who, In: new Date(T(inH)),
  Out: outH === null ? '' : new Date(T(outH)), Hours: outH === null ? '' : inH - outH, Source: src || 'floor' }[c] !== undefined ? ({ Timestamp: new Date(T(inH)), WorkDate: '2026-09-29', Employee: who, In: new Date(T(inH)), Out: outH === null ? '' : new Date(T(outH)), Hours: outH === null ? '' : inH - outH, Source: src || 'floor' })[c] : ((extra || {})[c] || ''))));
const stage = (who, agoH) => log.grid.push([new Date(T(agoH)), '2026-09-29', who, 'XRT50EXO', 'n', 'Boxed', 12, '', 'floor ' + agoH]);
shift('Joe', 3, null);                      // 3 h in, nothing logged
shift('Alex', 3, null); stage('Alex', 1);   // 3 h in, logged
shift('Maria', 1.5, null);                  // 1.5 h, nothing yet: too early to flag
let fl = mgr({ action: 'timeView' }).flags;
check('2+ h with no production is flagged', fl.filter((f) => f.type === 'noProduction').map((f) => f.employee), ['Joe']);
shift('Joe', 11, null);                     // second open row, 11 h
fl = mgr({ action: 'timeView' }).flags;
check('open past 10 h is flagged', fl.filter((f) => f.type === 'openLong').map((f) => f.employee), ['Joe']);
shift('Maria', 20, 6, 'auto');
shift('Alex', 30, 22, 'floor', { EditedBy: 'Dan', EditReason: 'fixed', NoGeofence: 'TRUE' });
fl = mgr({ action: 'timeView' }).flags;
check('auto-closed shift is flagged for review', fl.filter((f) => f.type === 'autoClosed').map((f) => f.employee), ['Maria']);
check('no-geofence and edited are flagged', [fl.some((f) => f.type === 'noGeofence' && f.employee === 'Alex'), fl.some((f) => f.type === 'edited' && f.employee === 'Alex')], [true, true]);
mgr({ action: 'timeEdit', row: 6, reason: 'reviewed the auto close' });   // Maria's auto-closed row
fl = mgr({ action: 'timeView' }).flags;
check('a manager edit clears the auto-close review flag', fl.filter((f) => f.type === 'autoClosed').length, 0);

// ---- timeExport ------------------------------------------------------------------------------
time.grid.length = 1;
const wd = (d, who, h) => time.grid.push(TIME_H.map((c) => ({ WorkDate: d, Employee: who, In: new Date(Date.parse(d + 'T12:00:00Z')), Out: new Date(Date.parse(d + 'T12:00:00Z') + h * H), Hours: h, Source: 'floor' })[c] || ''));
wd('2026-09-28', 'Joe', 8); wd('2026-09-29', 'Joe', 4); wd('2026-09-29', 'Joe', 3.5); wd('2026-09-29', 'Alex', 6); wd('2026-09-20', 'Joe', 9);
check('timeExport is manager-only', body(sandbox.doGet({ parameter: { action: 'timeExport', from: '2026-09-28', to: '2026-10-04' } })).locked, true);
const ex = mgr({ action: 'timeExport', from: '2026-09-28', to: '2026-10-04' });
check('timeExport: hours per person per day, range respected', [ex.ok, ex.people.Joe.days, ex.people.Joe.total, ex.people.Alex.days, ex.days], [true, { '2026-09-28': 8, '2026-09-29': 7.5 }, 15.5, { '2026-09-29': 6 }, ['2026-09-28', '2026-09-29']]);
check('timeExport validates dates', mgr({ action: 'timeExport', from: 'x', to: 'y' }).ok, false);
check('every manager time action is locked without a token',
  ['timeView', 'timeEdit', 'timeExport', 'timeDecide', 'setClockPin', 'setShopLocation'].map((a) => body(sandbox.doGet({ parameter: { action: a } })).locked === true), [true, true, true, true, true, true]);
check('clock, floorPace and timeRequest stay open actions', ['clock', 'floorPace', 'timeRequest', 'submitDay'].map((a) => vm.runInContext('OPEN_ACTIONS', sandbox).indexOf(a) !== -1), [true, true, true, true]);

// ---- summary email -----------------------------------------------------------------------------
time.grid.length = 1; log.grid.length = 1; reqs.grid.length = 1;
clock.t = Date.parse('2026-09-29T22:00:00Z');
shift('Joe', 7, 1); stage('Joe', 3); stage('Joe', 2);
shift('Alex', 4, null);
reqs.grid.push(['R1', new Date(clock.t), 'Maria', 'in', new Date(T(6)), '2026-09-29', 'phone died', 'Pending', '', '', '']);
const sum = sandbox.collectTimeSummary('2026-09-29', clock.t);
const html = sandbox.buildTimeSummaryHtml(sum);
check('summary lists who worked with hours and boxed', [/Joe/.test(html), /Alex/.test(html), sum.people.find((p) => p.name === 'Joe').boxed], [true, true, 24]);
check('summary shows boxed per clocked hour per person and crew', [sum.people.find((p) => p.name === 'Joe').boxedPerHour, sum.crew.boxedPerHour], [4, 2.4]);
check('summary shows open shifts, flags and pending requests', [/still in/.test(html), /Alex<\/b> 2026-09-29: Clocked in 4 h, nothing logged/.test(html), /Maria<\/b> forgot to clock in/.test(html)], [true, true, true]);
check('summary has no dollars', /\$/.test(html), false);
sandbox.sendDailyTimeSummary();
check('email goes to the script owner plus SUMMARY_TO', mails.length, 1);
props.SUMMARY_TO = 'john@example.com, alex@example.com';
sandbox.sendDailyTimeSummary();
check('SUMMARY_TO adds recipients', mails[1].to, 'dan@aquamentor.com,john@example.com,alex@example.com');
check('subject and HTML body', [mails[1].subject, /<table/.test(mails[1].htmlBody)], ['Aquamentor time and pace, 2026-09-29', true]);
sandbox.installDailyTimeSummary(); sandbox.installDailyTimeSummary();
check('installDailyTimeSummary is idempotent: one trigger, 6pm New York', triggers.map((t) => [t.h, t.hour, t.tz, t.days]), [['sendDailyTimeSummary', 18, 'America/New_York', 1]]);
check('it is in the sheet menu', /installDailyTimeSummary/.test(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8').split('function onOpen')[1].split('addToUi')[0]), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
