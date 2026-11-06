/* Suggested POs and the reorder alert (3.09.0).
 *
 * Pinned: 100% = the usual order, else the last delivery, else twice the reorder
 * point; top-up = full + floor owed - good, rounded up; materials at or above
 * full and never-counted ones are left off; an expiring material is cut to what
 * gets used before a new lot is halfway; grouped by supplier with what is due
 * now first. The alert mails only what is NEWLY due, remembers what it sent,
 * mails nothing when nothing is new, and alerts again on a material that came
 * back. The digest carries the per-supplier block.
 *
 * Run:  node apps-script/test-suggested.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const props = {};
let sent = null, tabs = {};
const sandbox = { console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, parseFloat,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
  MailApp: { sendEmail: (m) => { sent = m; } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'dan@example.com' }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getUrl: () => 'https://sheet.example' }), getActive: () => ({ toast() {} }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock: () => true }) }, Logger: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.writeTab = (ss, name, headers, rows) => { tabs[name] = { headers, rows }; };
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`}`);
}

/* ---- fullLevel ------------------------------------------------------- */
check('full = the usual order first', sandbox.fullLevel({ reorderQty: 40, lastOrderQty: 30, reorderPoint: 5 }).qty, 40);
check('else the last delivery', sandbox.fullLevel({ reorderQty: null, lastOrderQty: 30, reorderPoint: 5 }).qty, 30);
check('else twice the reorder point', sandbox.fullLevel({ reorderQty: null, lastOrderQty: null, reorderPoint: 5 }).qty, 10);
check('nothing to go on: no full level', sandbox.fullLevel({ reorderQty: null, lastOrderQty: null, reorderPoint: 0 }), null);

/* ---- computeSuggestedPOs --------------------------------------------- */
const STOCK = [
  { id: 'M002', name: 'Nylon Mesh', unit: 'Boxes', reorderQty: 40, goodStock: 13.84, onHand: 13.84, qboItem: 'MESH' },
  { id: 'M014', name: 'Red webbing', unit: 'Yards', reorderQty: 4000, goodStock: 3700, onHand: 3700 },
  { id: 'M015', name: 'Black webbing', unit: 'Yards', reorderQty: 8000, goodStock: 9000, onHand: 9000 },
  { id: 'M011', name: 'Eversorb', unit: 'Pail', reorderQty: 1, goodStock: 0.33, onHand: 0.33 },
  { id: 'M045', name: 'Cliqflow', unit: 'Pail', reorderQty: 4, goodStock: 0.5, onHand: 0.5, shelfLifeDays: 70 },
  { id: 'M099', name: 'Never counted', unit: 'ea', reorderQty: 10, goodStock: 0, onHand: 0 },
  { id: 'M098', name: 'No basis', unit: 'ea', goodStock: 0, onHand: 0, reorderPoint: 0 }
];
sandbox.getStock = () => ({ materials: STOCK });
const P = (id, extra) => Object.assign({ id, name: STOCK.find((s) => s.id === id).name, unit: STOCK.find((s) => s.id === id).unit,
  counted: true, committed: 0, dailyBurn: 0, supplier: '' }, extra || {});
const purch = { materials: [
  P('M002', { supplier: 'Fiber Dynamics' }), P('M014', { supplier: 'Granat', committed: 100 }), P('M015', { supplier: 'Granat' }),
  P('M011', { supplier: 'DKSH' }), P('M045', { supplier: 'Ravago', dailyBurn: 0.1 }), P('M099', { counted: false }), P('M098', { supplier: 'X' })
] };
const reorder = { items: [{ id: 'M002' }, { id: 'M098' }] };
const r = sandbox.computeSuggestedPOs(purch, reorder);
const line = (id) => r.lines.find((l) => l.id === id);
check('mesh tops up to the usual 40: 40 - 13.84 = 26.16, rounded up', [line('M002').topUp, line('M002').due, line('M002').qboItem], [27, true, 'MESH']);
check('not due yet still gets a line: red webbing 4000 + 100 owed - 3700', [line('M014').topUp, line('M014').due], [400, false]);
check('at or above full: no line', !!line('M015'), false);
check('a fraction of a pail rounds up to a whole one', line('M011').topUp, 1);
check('expiring: cut to what is used before halfway (0.1/day x 25 working days = 2)',
  [line('M045').topUp, /cut from 4/.test(line('M045').note)], [2, true]);
check('never counted: left off', !!line('M099'), false);
check('due with no basis for a full level is reported', r.noBasis, ['No basis']);
check('grouped by supplier, alphabetical', r.suppliers.map((s) => s.supplier), ['DKSH', 'Fiber Dynamics', 'Granat', 'Ravago']);
check('a supplier block counts what is due now', r.suppliers.find((s) => s.supplier === 'Fiber Dynamics').due, 1);
check('the note says where full came from', line('M014').note, 'full = usual order of 4000, floor owed 100');

sandbox.writeSuggestedTab(purch, reorder);
check('SuggestedPOs tab rows match the headers',
  [tabs.SuggestedPOs.headers.length, tabs.SuggestedPOs.rows[0].length, tabs.SuggestedPOs.rows.find((x) => x[2] === 'M002')[8]], [11, 11, 27]);
sandbox.writeSuggestedTab({ materials: [] }, { items: [] });
check('nothing to top up: one row says so', tabs.SuggestedPOs.rows[0][3], 'Everything counted is at or above full');

/* ---- reorder alert --------------------------------------------------- */
check('newlyDue: only ids not already alerted', sandbox.newlyDue([{ id: 'A' }, { id: 'B' }], '["A"]').map((i) => i.id), ['B']);
check('newlyDue: bad stored JSON alerts everything', sandbox.newlyDue([{ id: 'A' }], '{oops').length, 1);

let due = [{ id: 'M002', name: 'Nylon Mesh', supplier: 'Fiber Dynamics', unit: 'Boxes', suggestedQty: 26, reason: 'at or under reorder point' }];
sandbox.writeReorderTab = () => ({ items: due });
sent = null;
let res = sandbox.reorderAlertCheck();
check('first run mails what is due, to the digest recipient', [res.sent, sent && sent.to, /Nylon Mesh/.test(sent && sent.subject)], [true, 'dan@example.com', true]);
check('the alert says what to order and links the sheet', /order 26 Boxes[\s\S]*https:\/\/sheet\.example/.test(sent.htmlBody), true);
sent = null;
res = sandbox.reorderAlertCheck();
check('next day, nothing new: no email', [res.sent, sent], [false, null]);
due = due.concat([{ id: 'M045', name: 'Cliqflow', unit: 'Pail', suggestedQty: null, reason: 'order by 2026-11-12' }]);
res = sandbox.reorderAlertCheck();
check('a new one: mails just that one', [res.fresh, /Cliqflow/.test(sent.subject), /Nylon/.test(sent.subject)], [1, true, false]);
check('no quantity asks how many', /how many\?/.test(sent.htmlBody), true);
due = [due[1]];
sandbox.reorderAlertCheck();
due = due.concat([{ id: 'M002', name: 'Nylon Mesh', unit: 'Boxes', suggestedQty: 26, reason: 'x' }]);
sent = null;
res = sandbox.reorderAlertCheck();
check('dropped off and came back: alerts again', [res.sent, /Nylon Mesh/.test(sent && sent.subject)], [true, true]);
props.DIGEST_TO = 'dan@example.com, john@example.com';
due = due.concat([{ id: 'M011', name: 'Eversorb', unit: 'Pail', suggestedQty: 1, reason: 'x' }]);
sandbox.reorderAlertCheck();
check('DIGEST_TO decides who gets it', sent.to, 'dan@example.com, john@example.com');
due = [1, 2, 3, 4, 5].map((i) => ({ id: 'N' + i, name: 'Item ' + i, unit: 'ea', suggestedQty: 1, reason: 'x' }));
sandbox.reorderAlertCheck();
check('long lists name three in the subject', sent.subject, 'Reorder: Item 1, Item 2, Item 3 and 2 more');

/* ---- digest block ---------------------------------------------------- */
const sum = { generatedAt: '2026-11-09', production: { windowDays: 7, since: '2026-11-02', started: 1, finished: 1, activeDays: 1, events: 1 },
  pipeline: {}, inventory: {}, buying: {}, trust: { materialsCounted: 1, materialsTotal: 1, productsWithBaseline: 0, productsTracked: 1, rowsWithHours: 0, stageLogRows: 1 } };
const html = sandbox.buildDigestHtml(sum, { materials: [] }, { countNext: [], materials: [] }, '', null, { items: [] }, r);
check('digest lists each supplier with what tops it up', /Suggested POs[\s\S]*Fiber Dynamics[\s\S]*1 due now[\s\S]*Nylon Mesh <b[^>]*>27 Boxes/.test(html), true);
check('digest without suggested POs leaves the block out', /Suggested POs/.test(sandbox.buildDigestHtml(sum, { materials: [] }, { countNext: [], materials: [] }, '', null, { items: [] })), false);

/* ---- schedule -------------------------------------------------------- */
let triggers = [];
sandbox.ScriptApp = { getProjectTriggers: () => triggers, deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
  newTrigger: (h) => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ inTimezone: () => ({ create: () => triggers.push({ getHandlerFunction: () => h }) }) }) }) }) }) };
sandbox.ensureReorderAlertSchedule();
check('first request after a deploy installs the 7am alert', triggers.map((t) => t.getHandlerFunction()), ['reorderAlertCheck']);
sandbox.ensureReorderAlertSchedule();
check('twice installs it once', triggers.length, 1);
sandbox.toggleReorderAlert();
check('the menu toggle turns it off and remembers', [triggers.length, props.REORDER_ALERTS], [0, 'off']);
sandbox.ensureReorderAlertSchedule();
check('switched off stays off after the next deploy', triggers.length, 0);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
