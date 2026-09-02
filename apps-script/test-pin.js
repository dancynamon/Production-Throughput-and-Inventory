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
const sandbox = {
  // doGet() wraps its result through ContentService; a stub that hands the
  // JSON back is all auth needs.
  ContentService: {
    MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
    createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t })
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = v; }
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

check('the source no longer carries a PIN constant',
  /var MANAGER_PIN\s*=/.test(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8')), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
