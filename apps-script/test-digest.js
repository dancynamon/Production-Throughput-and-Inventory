/* Exercise buildDigestHtml() and sendWeeklyDigest().
 * The HTML builder is pure and asserted on content; the sender is asserted on
 * what it hands MailApp — recipient from DIGEST_TO, fallback to the effective
 * user, subject carrying the two numbers a manager would act on.
 * Run:  node apps-script/test-digest.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
let sent = null, props = {};
const sandbox = {
  MailApp: { sendEmail: (m) => { sent = m; } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }), getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.readObjects = () => [];
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const sum = { generatedAt: '2026-09-13', production: { windowDays: 7, since: '2026-09-07', started: 150, finished: 2, activeDays: 3, events: 9 },
  pipeline: { wipTotal: 437, biggest: { name: 'XRT-50 Exotube', stage: 'Boxed', units: 151 } },
  inventory: {}, buying: { short: 2 }, trust: { materialsCounted: 0, materialsTotal: 44, productsWithBaseline: 0, productsTracked: 21, rowsWithHours: 1, stageLogRows: 19 } };
const buy = { materials: [
  { id: 'M033', name: 'Tube <Boxes>', unit: 'Boxes', supplier: 'Uline', counted: true, after: -30 },
  { id: 'M002', name: 'Mesh', unit: 'box', counted: true, after: 10 },
  { id: 'M044', name: 'Strap', unit: 'each', counted: false, after: -30 } ] };
const inv = { countNext: ['M038', 'M002'], materials: [ { id: 'M038', name: '4# Foam', lastCountedAt: null }, { id: 'M002', name: 'Mesh', lastCountedAt: '2026-08-10' } ] };

const html = sandbox.buildDigestHtml(sum, buy, inv, 'https://app.example');
check('headline numbers are in', /150<\/b>[\s\S]*entered the shop[\s\S]*2<\/b>[\s\S]*finished goods/.test(html), true);
check('the biggest pile is named with its stage', /151 XRT-50 Exotube waiting at <b>Boxed<\/b>/.test(html), true);
check('only counted-and-short materials are listed to order, with supplier', /Tube &lt;Boxes&gt;.*Uline.*short 30 Boxes/.test(html), true);
check('a covered material is not on the order list', /Mesh<\/td>/.test(html), false);
check('an uncounted material is not called short', /Strap/.test(html), false);
check('HTML in names is escaped', html.indexOf('<Boxes>') === -1, true);
check('count-next names the never-counted', /4# Foam <span[^>]*>\(never\)<\/span> · Mesh/.test(html), true);
check('the trust line is present', /0 of 44 materials counted/.test(html), true);
check('the app link is included', /href="https:\/\/app.example"/.test(html), true);

/* 3.08.0: To order is the Reorder tab's list when there is one. */
{
  const ro = { items: [
    { name: 'Nylon Mesh', supplier: 'Fiber Dynamics', unit: 'Boxes', suggestedQty: 40, reason: 'at or under reorder point (13.84 of 20, half the usual order of 40)' },
    { name: 'Mystery', supplier: '', unit: 'ea', suggestedQty: null, reason: 'order by 2026-11-10' } ] };
  const h2 = sandbox.buildDigestHtml(sum, buy, inv, '', null, ro);
  check('reorder items listed with supplier, reason and quantity',
    /Nylon Mesh.*Fiber Dynamics.*half the usual order of 40.*order 40 Boxes/.test(h2), true);
  check('no quantity asks how many', /Mystery[\s\S]*how many\?/.test(h2), true);
  check('the floor-short list is replaced, not added to', /short 30 Boxes/.test(h2), false);
  check('an empty reorder list says so', /Nothing to reorder/.test(sandbox.buildDigestHtml(sum, buy, inv, '', null, { items: [] })), true);
}

/* --- Sending ------------------------------------------------------------- */
sandbox.computeReorder = () => ({ items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
sandbox.getSummary = () => ({ ...sum, buying: { short: 2 } });
sandbox.computePurchasing = () => buy;
sandbox.getInventory = () => inv;
const r1 = sandbox.sendWeeklyDigest();
check('with no DIGEST_TO the digest goes to the effective user', sent.to, 'owner@example.com');
check('subject carries finished and to-order counts', r1.subject, 'Aquamentor week to 2026-09-13 — 2 finished, 3 to order');
check('an HTML body is sent', typeof sent.htmlBody === 'string' && sent.htmlBody.length > 200, true);
props.DIGEST_TO = 'dan@example.com, john@example.com';
sandbox.sendWeeklyDigest();
check('DIGEST_TO wins when set', sent.to, 'dan@example.com, john@example.com');
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
