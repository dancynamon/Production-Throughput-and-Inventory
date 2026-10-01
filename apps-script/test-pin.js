/* The manager PIN must come from Script Properties, never from this file —
 * this file is public. Pinned: the default applies only when nothing is
 * stored; a stored value wins; a blank stored value does not silently unlock
 * the app; and auth compares against whatever is live.
 *
 * Run:  node apps-script/test-pin.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let store = {};
const crypto = require('crypto');
const sandbox = {
  // Utilities.computeDigest returns signed bytes, exactly as Apps Script does.
  Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => crypto.randomUUID(),
    computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)) },
  // doGet() wraps its result through ContentService; a stub that hands the
  // JSON back is all auth needs.
  ContentService: {
    MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
    createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t })
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = v; },
    deleteProperty: (k) => { delete store[k]; },
    getProperties: () => Object.assign({}, store)
  }) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.readObjects = () => [];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

check('no stored PIN: the default applies and is reported as default',
  [sandbox.managerPin(), sandbox.pinIsDefault()], ['2468', true]);

store.MANAGER_PIN = '731905';
check('a stored PIN wins', [sandbox.managerPin(), sandbox.pinIsDefault()], ['731905', false]);

store.MANAGER_PIN = '   ';
check('a blank stored PIN falls back rather than unlocking on empty input',
  sandbox.managerPin(), '2468');

store.MANAGER_PIN = '731905';
const auth = (pin) => JSON.parse(sandbox.doGet({ parameter: { action: 'auth', pin } }).getContent()).ok;
check('auth accepts the live PIN', auth('731905'), true);
check('auth rejects the old default once a PIN is set', auth('2468'), false);
check('auth rejects an empty PIN', auth(''), false);

/* --- Per-person PINs ------------------------------------------------------- */
store['PIN:Dan'] = sandbox.pinHash('990011');
const authAs = (name, pin) => JSON.parse(sandbox.doGet({ parameter: { action: 'auth', name, pin } }).getContent());
const sansToken = (r) => { const c = { ...r }; delete c.token; return c; };
check('a person with a PIN on file unlocks with name + their PIN, full view by default',
  sansToken(authAs('Dan', '990011')), { ok: true, name: 'Dan', personal: true, view: 'full' });
store['VIEW:Dan'] = 'count';
check('a person set to the count-only view is told so at unlock', authAs('Dan', '990011').view, 'count');
store['VIEW:Dan'] = 'nonsense';
check('anything but count means full', authAs('Dan', '990011').view, 'full');
delete store['VIEW:Dan'];
check('the wrong personal PIN is refused, and the shared PIN does NOT rescue it',
  [authAs('Dan', '731905').ok, authAs('Dan', '000000').ok], [false, false]);
check('a person with NO PIN on file falls back to the shared PIN',
  sansToken(authAs('Joe', '731905')), { ok: true, name: 'Joe', personal: false });
check('no name at all is the shared PIN, as before', authAs('', '731905').ok, true);
check('what is stored is a hash, never the PIN', store['PIN:Dan'].indexOf('990011') === -1 && store['PIN:Dan'].length === 64, true);

/* --- The lock lives on the server ------------------------------------------ */
const call = (params) => JSON.parse(sandbox.doGet({ parameter: params }).getContent());
const tok = authAs('', '731905').token;
check('a successful unlock returns a token, and it is not the PIN',
  [typeof tok, tok.length, tok.indexOf('731905')], ['string', 64, -1]);
check('a failed unlock returns no token', authAs('', '0000').token, undefined);
check('a manager action with no token is refused as locked',
  [call({ action: 'stock' }).locked, call({ action: 'export', table: 'stagelog' }).locked], [true, true]);
check('a wrong token is refused', call({ action: 'stock', token: 'x'.repeat(64) }).locked, true);
check('the token from the unlock opens it', call({ action: 'stock', token: tok, mgrName: '' }).locked, undefined);
check('what the floor needs stays open without a token',
  [call({ action: 'config' }).locked, call({ action: 'today', workDate: '2026-09-17' }).locked, call({ action: 'myPace', name: 'x' }).locked], [undefined, undefined, undefined]);
check('the whole floor is a manager view', [call({ action: 'floorData' }).locked, call({ action: 'floorData', token: tok, mgrName: '' }).locked], [true, undefined]);
check('floorData hands over the five tables and nothing else',
  Object.keys(call({ action: 'floorData', token: tok, mgrName: '' }).tables).sort(), ['planning', 'products', 'stagelog', 'stages', 'wipbase']);
/* myPace: only that person's rows leave the server. */
sandbox.readObjects = (tab) => ({
  Employees: [{ Name: 'Dan', Active: 'YES' }, { Name: 'Joe', Active: 'YES' }],
  StageLog: [
    { Timestamp: new Date(), WorkDate: new Date(), Employee: 'Dan', ProductID: 'P', Stage: 'Cut', Qty: 5 },
    { Timestamp: new Date(), WorkDate: new Date(), Employee: 'Joe', ProductID: 'P', Stage: 'Cut', Qty: 7 },
    { Timestamp: new Date(), WorkDate: new Date(), Employee: 'joe', ProductID: 'P', Stage: 'Box', Qty: 2 }
  ]
}[tab] || []);
const mine = call({ action: 'myPace', name: 'joe' });
check('myPace returns only that person\'s rows, matched without regard to case',
  [mine.ok, mine.name, mine.tables.stagelog.map((r) => r.Qty), mine.tables.wipbase], [true, 'Joe', [7, 2], []]);
check('an unknown name gets nothing', call({ action: 'myPace', name: 'Nobody' }).ok, false);
sandbox.readObjects = () => [];
check('the floor count is the crew\'s to record', sandbox.OPEN_ACTIONS.indexOf('wipWalk') !== -1, true);
const danTok = authAs('Dan', '990011').token;
check('a personal token is bound to that name',
  [call({ action: 'stock', token: danTok, mgrName: 'Dan' }).locked, call({ action: 'stock', token: danTok, mgrName: 'Joe' }).locked], [undefined, true]);
store.MANAGER_PIN = '246810';
check('changing the shared PIN locks every phone that unlocked with it',
  call({ action: 'stock', token: tok, mgrName: '' }).locked, true);
check('...but not a phone unlocked with a personal PIN', call({ action: 'stock', token: danTok, mgrName: 'Dan' }).locked, undefined);
store['PIN:Dan'] = sandbox.pinHash('112233');
check('changing a personal PIN locks that person\'s phone', call({ action: 'stock', token: danTok, mgrName: 'Dan' }).locked, true);
check('no PIN ever lands in Script Properties as plain text beyond MANAGER_PIN itself',
  Object.keys(store).filter((k) => k !== 'MANAGER_PIN' && /990011|112233|731905/.test(store[k])), []);

/* --- The manager guide: listed names, personal PIN, token --------------------- */
store = {}; store.MANAGER_PIN = '731905'; store['PIN:Alex'] = sandbox.pinHash('4444'); store['PIN:Joe'] = sandbox.pinHash('5555');
const alexTok = authAs('Alex', '4444').token, joeTok = authAs('Joe', '5555').token, sharedAsDan = authAs('Dan', '731905').token;
check('a listed manager with a personal PIN gets the guide', call({ action: 'guide', token: alexTok, mgrName: 'Alex' }).ok, true);
check('a personal PIN but not on the list: refused', call({ action: 'guide', token: joeTok, mgrName: 'Joe' }).ok, false);
check('on the list but unlocked with the shared PIN: refused (the name is unverified)', call({ action: 'guide', token: sharedAsDan, mgrName: 'Dan' }).ok, false);
check('no token at all: locked', call({ action: 'guide', mgrName: 'Alex' }).locked, true);
store.GUIDE_READERS = 'Joe';
check('the readers list is editable from the sheet', [call({ action: 'guide', token: joeTok, mgrName: 'Joe' }).ok, call({ action: 'guide', token: alexTok, mgrName: 'Alex' }).ok], [true, false]);
check('the guide is baked in, not empty', sandbox.MANAGER_GUIDE_HTML.length > 5000 && /Running the floor/.test(sandbox.MANAGER_GUIDE_HTML), true);
delete store.GUIDE_READERS;

/* --- 3.01.5: PIN only, the server works out whose it is ---------------------- */
store = {}; store.MANAGER_PIN = '731905';
store['PIN:Dan'] = sandbox.pinHash('990011'); store['PIN:John'] = sandbox.pinHash('5151');
check('PIN only: a personal manager PIN logs in as its owner',
  sansToken(authAs('', '990011')), { ok: true, name: 'Dan', personal: true, view: 'full' });
check('PIN only: John too', authAs('', '5151').name, 'John');
check('PIN only: the shared PIN still works, no name', sansToken(authAs('', '731905')), { ok: true, name: '', personal: false });
check('PIN only: an unknown PIN is refused', authAs('', '1212').ok, false);
store['PIN:Joe'] = sandbox.pinHash('5151');
check('PIN only: two owners of one PIN is refused with a reason', [authAs('', '5151').ok, /more than one/.test(authAs('', '5151').error)], [false, true]);
delete store['PIN:Joe'];
// A manager's clock PIN (Employees.PinHash) also opens the full app; a crew member's does not.
const salt = 'abc123';
const emp = { Alex: sandbox.clockPinHash('Alex', '8080', salt), Maria: sandbox.clockPinHash('Maria', '7070', salt) };
sandbox.employeeSheetRow = (n) => { const k = Object.keys(emp).find((x) => x.toLowerCase() === String(n).toLowerCase()); return k ? { name: k, hash: emp[k] } : null; };
check('managers default to Dan, John, Alex', sandbox.managerNames(), ['Dan', 'John', 'Alex']);
const alexIn = authAs('', '8080');
check('a manager\'s clock PIN logs them in', [alexIn.ok, alexIn.name, alexIn.personal], [true, 'Alex', true]);
check('...and that token works', call({ action: 'stock', token: alexIn.token, mgrName: 'Alex' }).locked, undefined);
check('a crew member\'s clock PIN does not open the full app', authAs('', '7070').ok, false);
store.MANAGERS = 'Dan,John,Alex,Maria';
check('adding a name to MANAGERS lets their clock PIN in', authAs('', '7070').name, 'Maria');
delete store.MANAGERS;
emp.Alex = sandbox.clockPinHash('Alex', '9191', salt);
check('changing a manager\'s clock PIN locks their phone', call({ action: 'stock', token: alexIn.token, mgrName: 'Alex' }).locked, true);
sandbox.employeeSheetRow = () => null;

/* --- 3.01.5: retired materials ---------------------------------------------- */
sandbox.readObjects = (tab) => (tab === 'RawMaterials' ? [
  { MaterialID: 'M001', MaterialName: 'Glue Pods', OnHand: 5, Active: '' },
  { MaterialID: 'M002', MaterialName: 'Nylon Mesh', OnHand: 12, Active: '' },
  { MaterialID: 'M009', MaterialName: 'Old ink', OnHand: 1, Active: 'no' }] : []);
check('Glue Pods and Active=NO are off the stock list', sandbox.getStock().materials.map((m) => m.id), ['M002']);
sandbox.readObjects = (tab) => (tab === 'RawMaterials' ? [{ MaterialID: 'M001', MaterialName: 'Glue Pods', OnHand: 5, Active: 'YES' }] : []);
check('typing YES brings Glue Pods back', sandbox.getStock().materials.map((m) => m.id), ['M001']);
sandbox.readObjects = () => [];

check('the source no longer carries a PIN constant',
  /var MANAGER_PIN\s*=/.test(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8')), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
