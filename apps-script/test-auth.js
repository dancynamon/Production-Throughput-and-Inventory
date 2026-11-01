/* Auth hardening (3.04.0). The /exec URL is public, so the server has to hold
 * every line by itself.
 *
 * Pinned here: the manager unlock locks out (per name typed, and across all
 * names at once, which is what stops a PIN-only brute force); manager tokens
 * carry a signed expiry and old never-expiring tokens open nothing; a JSONP
 * callback is a function name or it is refused; submitDay / reverse / ship
 * need a manager token or the person's own crew token from Floor login, with
 * a 48 h grace for tokenless old pages and never for a wrong token; and the
 * floor can undo only today's entries.
 *
 * Run:  node apps-script/test-auth.js
 */
process.env.TZ = 'UTC';
const fs = require('fs'); const vm = require('vm'); const path = require('path'); const crypto = require('crypto');

const clock = { t: Date.parse('2026-10-31T14:00:00Z') };
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock.t); }
  static now() { return clock.t; }
}
const H = 3600000;
const EMP_H = ['Name', 'Active', 'PinHash'];
const emps = { grid: [EMP_H, ['Joe', 'YES', ''], ['Maria', 'YES', ''], ['Dan', 'YES', '']],
  getDataRange() { return { getValues: () => this.grid.map((r) => r.slice()) }; },
  getRange(r, c) { const g = this.grid; return { setValue: (v) => { g[r - 1][c - 1] = v; } }; } };
const cacheStore = {}, props = { MANAGER_PIN: '731905' };
let cacheOn = true;
const sandbox = {
  CacheService: { getScriptCache: () => {
    if (!cacheOn) throw new Error('no cache');
    return { get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } };
  } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
    deleteProperty: (k) => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
  ContentService: { MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
    createTextOutput: (t) => ({ t, mime: null, setMimeType(m) { this.mime = m; return this; } }) },
  Utilities: { computeDigest: (alg, t) => Array.from(crypto.createHash('sha256').update(t, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: (n) => (n === 'Employees' ? emps : null) }),
    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date: FakeDate, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.ensureSchemaCurrent = () => {};
sandbox.readObjects = (tab) => (tab === 'Employees' ? emps.grid.slice(1).map((r) => ({ Name: r[0], Active: r[1], PinHash: r[2] })) : []);
// The writes themselves are pinned in their own tests; here only the gate in front of them.
['submitDay', 'reverseEntry', 'shipOut'].forEach((f) => { sandbox[f] = (p) => ({ ok: true, ran: f, employee: p.employee }); });

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const call = (params) => { const o = JSON.parse(sandbox.doGet({ parameter: params }).t); delete o.serverMs; return o; };
const auth = (pin, name) => call({ action: 'auth', pin, name: name || '' });
const clearCache = () => Object.keys(cacheStore).forEach((k) => delete cacheStore[k]);

/* ---- 1. Manager unlock lockout -------------------------------------------- */
check('the right PIN unlocks', auth('731905').ok, true);
for (let i = 0; i < 4; i++) auth('0000');
let r = auth('0001');
check('fifth wrong PIN in a row locks that login', [r.ok, r.lockedOut, /15 minutes/.test(r.error)], [false, true, true]);
r = auth('731905');
check('locked means locked, even for the right PIN', [r.ok, r.lockedOut, r.token], [false, true, undefined]);
clearCache();
for (let i = 0; i < 4; i++) auth('0000');
check('a right PIN clears the per-name count', auth('731905').ok, true);
check('...so four more wrong ones do not lock', [0, 1, 2, 3].map(() => auth('0000').lockedOut), [null, null, null, null]);
check('...but the global count kept going: two more lock everyone for an hour',
  [auth('0000', 'Eve').lockedOut, /an hour/.test(auth('0000', 'Mallory').error), auth('731905', 'Bob').lockedOut], [undefined, true, true]);
check('the global lock holds for a name never tried', auth('731905', 'Nobody').lockedOut, true);
clearCache();
const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
check('rotating names does not dodge it: 9 wrong across 9 names, none locked yet',
  names.map((n) => auth('1234', n).lockedOut).filter(Boolean).length, 0);
check('the 10th locks everyone', [auth('1234', 'J').lockedOut, auth('731905').ok], [true, false]);
clearCache(); cacheOn = false;
check('no cache: no lockout, the PIN still decides',
  [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => auth('0000').lockedOut).filter(Boolean).length, auth('731905').ok], [0, true]);
cacheOn = true;

/* ---- 2. Manager tokens expire --------------------------------------------- */
const tok = auth('731905').token;
check('a token is "<expiry>.<signature>", 12 h out, and is not the PIN',
  [/^\d+\.[0-9a-f]{64}$/.test(tok), Number(tok.split('.')[0]) - clock.t, tok.indexOf('731905')], [true, 12 * H, -1]);
check('it opens a manager action', call({ action: 'stock', token: tok, mgrName: '' }).locked, undefined);
const legacy = sandbox.pinHash('tok|' + props.TOKEN_SECRET + '||' + sandbox.pinHash('731905'));
check('a pre-3.04.0 token (no expiry) opens nothing', call({ action: 'stock', token: legacy, mgrName: '' }).locked, true);
const [exp, sig] = tok.split('.');
check('pushing the expiry out breaks the signature', call({ action: 'stock', token: (Number(exp) + 30 * 24 * H) + '.' + sig, mgrName: '' }).locked, true);
clock.t += 11 * H;
check('still good at 11 h', call({ action: 'stock', token: tok, mgrName: '' }).locked, undefined);
clock.t += 1 * H;
check('expired at 12 h', call({ action: 'stock', token: tok, mgrName: '' }).locked, true);
clock.t = Date.parse('2026-10-31T14:00:00Z');

/* ---- 3. JSONP callback ---------------------------------------------------- */
const raw = (cb) => sandbox.doGet({ parameter: { action: 'config', callback: cb } });
const realConfig = sandbox.getConfig;
sandbox.getConfig = () => ({ ok: true });
check('a plain function name is wrapped as before', [raw('__fl_cb_12').t.indexOf('__fl_cb_12({'), raw('__fl_cb_12').mime], [0, 'js']);
check('dotted names and $ are function names too', [raw('a.b$c').t.indexOf('a.b$c('), raw('$x').t.indexOf('$x(')], [0, 0]);
['alert(1);x', 'x</script><script>', '1abc', 'a b', 'a=b', 'a(b)', "a'", 'a\nb'].forEach((cb) => {
  const out = raw(cb);
  check('callback ' + JSON.stringify(cb) + ' is refused, not echoed', [out.mime, out.t.indexOf(cb) === -1, JSON.parse(out.t).ok], ['json', true, false]);
});

/* ---- 4. Open writes: crew token, today-only undo ------------------------- */
const today = '2026-10-31';
sandbox.setClockPinFor('Joe', '1111');
sandbox.setClockPinFor('Maria', '2222');
const login = call({ action: 'login', name: 'joe', pin: '1111' });
check('Floor login hands back a crew token for the canonical name',
  [login.ok, login.name, /^\d+\.[0-9a-f]{64}$/.test(login.crewToken), Number(login.crewToken.split('.')[0]) - clock.t], [true, 'Joe', true, 14 * 24 * H]);
check('a wrong PIN gets no token', call({ action: 'login', name: 'Joe', pin: '0000' }).crewToken, undefined);
const ct = login.crewToken;
const day = (o) => call(Object.assign({ action: 'submitDay', employee: 'Joe', workDate: today }, o));

check('grace starts the first time a write is seen, 48 h out', [day({}).ok, Number(props.CREW_TOKEN_ENFORCE_AT) - clock.t], [true, 48 * H]);
check('in the grace, a tokenless old page still logs, ships and undoes today',
  [day({}).ran, call({ action: 'ship', employee: 'Joe' }).ran, call({ action: 'reverse', employee: 'Joe', workDate: today }).ran],
  ['submitDay', 'shipOut', 'reverseEntry']);
check('...but a WRONG token is refused even in the grace', day({ crewToken: ct.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }).needLogin, true);
check('...and someone else\'s token is refused', day({ employee: 'Maria', crewToken: ct }).needLogin, true);
clock.t += 48 * H;
r = day({});
check('after the grace, no token = log in again (and never ran)', [r.ok, r.locked, r.needLogin, r.ran], [false, true, true, undefined]);
check('ship and reverse too', [call({ action: 'ship', employee: 'Joe' }).needLogin, call({ action: 'reverse', employee: 'Joe', workDate: '2026-11-02' }).needLogin], [true, true]);
check('the person\'s own token writes as them, any case of the name', [day({ crewToken: ct, workDate: '2026-11-02' }).ran, day({ employee: 'JOE', crewToken: ct }).ran], ['submitDay', 'submitDay']);
check('the crew token is not a manager token', call({ action: 'stock', token: ct, mgrName: 'Joe' }).locked, true);
sandbox.setClockPinFor('Joe', '3333');
check('a new clock PIN voids the old crew token', day({ crewToken: ct }).needLogin, true);
const ct2 = call({ action: 'login', name: 'Joe', pin: '3333' }).crewToken;
check('logging in again earns a working one', day({ crewToken: ct2 }).ran, 'submitDay');
clock.t += 14 * 24 * H;
check('crew tokens expire after 14 days', day({ crewToken: ct2 }).needLogin, true);
clock.t = Date.parse('2026-10-31T14:00:00Z');

const ct3 = call({ action: 'login', name: 'Joe', pin: '3333' }).crewToken;
const undo = (o) => call(Object.assign({ action: 'reverse', employee: 'Joe', crewToken: ct3 }, o));
check('the floor undoes today\'s entry', undo({ workDate: today }).ran, 'reverseEntry');
r = undo({ workDate: '2026-10-30' });
check('...but not yesterday\'s, or any other day', [r.ok, r.ran, /today/.test(r.error), undo({ workDate: '2026-09-01' }).ok, undo({}).ok], [false, undefined, true, false, false]);
props.CREW_TOKEN_ENFORCE_AT = String(clock.t + H);   // even inside a grace window
check('the today bound holds in the grace too', call({ action: 'reverse', employee: 'Joe', workDate: '2026-10-30' }).ok, false);
props.CREW_TOKEN_ENFORCE_AT = '0';
check('CREW_TOKEN_ENFORCE_AT = 0 enforces at once', day({}).needLogin, true);

const mtok = auth('731905').token;
const asMgr = (o) => call(Object.assign({ token: mtok, mgrName: '' }, o));
check('a manager writes for anyone, and reverses any day',
  [asMgr({ action: 'submitDay', employee: 'Maria' }).ran, asMgr({ action: 'ship', employee: 'Francis' }).ran,
   asMgr({ action: 'reverse', employee: 'Maria', workDate: '2026-09-13' }).ran], ['submitDay', 'shipOut', 'reverseEntry']);
r = call({ action: 'reverse', employee: 'Maria', workDate: '2026-09-13', token: 'x', mgrName: '' });
check('a bad manager token is "locked" (the app asks for the PIN), not a crew refusal', [r.locked, r.needLogin, r.ran], [true, undefined, undefined]);
sandbox.getConfig = realConfig;
check('the actions that stay open still need nothing', call({ action: 'login', name: 'Maria', pin: '2222' }).ok, true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
