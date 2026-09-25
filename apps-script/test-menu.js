/* The sheet menu: a short top level, everything else one click down, every
 * handler a real function, and the schedule toggles flip the right trigger.
 *
 * Run:  node apps-script/test-menu.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
let triggers = [], toasts = [];
function menuBuilder(title) {
  const m = { title, items: [], addItem(label, fn) { m.items.push({ label, fn }); return m; },
    addSeparator() { m.items.push({ sep: true }); return m; },
    addSubMenu(sub) { m.items.push({ sub }); return m; }, addToUi() { built.push(m); return m; } };
  return m;
}
const built = [];
const sandbox = {
  SpreadsheetApp: { getUi: () => ({ createMenu: menuBuilder }), getActive: () => ({ toast: (t) => toasts.push(t) }),
    getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
  ScriptApp: { WeekDay: { MONDAY: 1 },
    getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })),
    deleteTrigger: (t) => { triggers = triggers.filter((h) => h !== t.getHandlerFunction()); },
    newTrigger: (h) => { const c = () => triggers.push(h); const tb = { everyMinutes: () => ({ create: c }), everyHours: () => ({ create: c }), onWeekDay: () => ({ atHour: () => ({ create: c }) }) }; return { timeBased: () => tb }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
  Utilities: {}, ContentService: {}, LockService: {}, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.digestRecipients = () => 'dan';
let fails = 0;
function check(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fails++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name); }

sandbox.onOpen();
const top = built[built.length - 1];
const topItems = top.items.filter((i) => !i.sep);
check('top level is short', topItems.length <= 9, true);
check('top level: five actions and three submenus', [topItems.filter((i) => i.fn).length, topItems.filter((i) => i.sub).length], [5, 3]);
const all = []; (function walk(m) { m.items.forEach((i) => { if (i.fn) all.push(i); if (i.sub) walk(i.sub); }); })(top);
check('every menu item names a function that exists', all.filter((i) => typeof sandbox[i.fn] !== 'function').map((i) => i.label), []);
const labels = all.map((i) => i.label);
['setManagerPin', 'setPersonPin', 'setGuideReaders', 'importSalesFromTab', 'syncShopifyMenu', 'updateFromGitHubMenu', 'upgradeSchema', 'resetAllTabs', 'setDeploymentId', 'whatAmIRunning'].forEach((fn) => check('still reachable: ' + fn, all.some((i) => i.fn === fn), true));
check('no duplicate labels', labels.length, new Set(labels).size);
check('the six on/off items became three toggles', all.filter((i) => /^Turn (on|off)/.test(i.label)).length, 0);

triggers = [];
sandbox.toggleDigest();      check('digest toggle: off → on', triggers, ['sendWeeklyDigest']);
sandbox.toggleDigest();      check('digest toggle: on → off', triggers, []);
sandbox.toggleShopifySync(); check('shopify toggle: off → on', triggers, ['syncShopifyTrigger']);
sandbox.toggleAutoUpdate();  check('auto-update toggle: off → on, sync untouched', triggers, ['syncShopifyTrigger', 'autoUpdateFromGitHub']);
sandbox.toggleAutoUpdate();  check('auto-update toggle: on → off, sync untouched', triggers, ['syncShopifyTrigger']);
check('every flip says which way it went', toasts.length, 5);
check('toasts say on or off', toasts.every((t) => /\bon\b|\boff\b|every hour|every 30/i.test(t)), true);

console.log(fails ? fails + ' FAILED' : 'All checks passed.');
process.exit(fails ? 1 : 0);
