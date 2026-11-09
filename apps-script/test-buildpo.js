/* Build POs in QuickBooks (3.10.0).
 *
 * Pinned: manager-only; not connected says how; vendor names match through legal
 * suffixes but never by picking between two; an unmatched item or vendor builds
 * nothing; an item already on an open PO asks first; the PO is unsent, numbered
 * next after the highest, ship-to Garwood; a retry builds once; a token refresh
 * keeps the rotated token; Intuit's callback needs the state the menu made.
 *
 * Run:  node apps-script/test-buildpo.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
let props = {}, cacheStore = {}, posts = [], tokenCalls = [], openPOs = [], items = {}, vendors = [], recent = [];
const lock = { waitLock() {}, tryLock: () => true, releaseLock() {} };
const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
let unauthorizedOnce = false;
const fetch = (url, o) => {
  if (/oauth2\/v1\/tokens/.test(url)) {
    tokenCalls.push(o.payload);
    if (props.BAD_REFRESH) return reply(400, { error: 'invalid_grant' });
    return reply(200, { access_token: 'A' + tokenCalls.length, refresh_token: 'R' + tokenCalls.length, expires_in: 3600 });
  }
  if (unauthorizedOnce) { unauthorizedOnce = false; return reply(401, {}); }
  if (o.method === 'post') {
    const body = JSON.parse(o.payload); posts.push({ url, body });
    return reply(200, { PurchaseOrder: { Id: '900', DocNumber: body.DocNumber, TotalAmt: 123.5 } });
  }
  const q = decodeURIComponent(url.split('query=')[1].split('&')[0]);
  if (/from Vendor/.test(q)) return reply(200, { QueryResponse: { Vendor: vendors } });
  if (/from Item/.test(q)) { const n = /= '(.*?)' and Active/.exec(q)[1]; return reply(200, { QueryResponse: items[n] ? { Item: [items[n]] } : {} }); }
  if (/POStatus/.test(q)) return reply(200, { QueryResponse: { PurchaseOrder: openPOs } });
  if (/orderby/.test(q)) return reply(200, { QueryResponse: { PurchaseOrder: recent } });
  return reply(200, { QueryResponse: {} });
};
const sandbox = { console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, parseFloat, encodeURIComponent, decodeURIComponent,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
  LockService: { getDocumentLock: () => lock, getScriptLock: () => lock },
  UrlFetchApp: { fetch }, Utilities: { base64Encode: (s) => s, formatDate: () => '2026-11-09', getUuid: () => 'uuid' },
  HtmlService: { createHtmlOutput: (h) => ({ html: h }) }, Logger: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.webAppDeploymentId = () => 'DEP';
sandbox.getStock = () => ({ materials: [{ id: 'M002', name: 'Nylon Mesh', qboItem: '' }, { id: 'M008', name: 'Siltech', qboItem: 'PNT-MFG:SIL-C4405' }] });
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`}`);
}
function connected() {
  props = { QBO_CLIENT_ID: 'id', QBO_CLIENT_SECRET: 's', QBO_REALM: '123', QBO_REFRESH: 'R0', QBO_ACCESS: 'A0', QBO_ACCESS_EXP: String(Date.now() + 3600000), QBO_REFRESHED: String(Date.now()) };
  cacheStore = {}; posts = []; tokenCalls = []; openPOs = [];
  vendors = [{ Id: '7', DisplayName: 'FIBER DYNAMICS, INC.' }];
  items = { 'Nylon Mesh': { Id: '11', Name: 'Nylon Mesh', PurchaseCost: 4.5 }, 'PNT-MFG:SIL-C4405': { Id: '12', Name: 'SIL-C4405', PurchaseCost: 10 } };
  recent = [{ DocNumber: '8703' }, { DocNumber: 'ABC' }, { DocNumber: '8665' }];
}
const build = (extra) => sandbox.buildQboPO(Object.assign({ supplier: 'Fiber Dynamics', lines: JSON.stringify([{ id: 'M002', qty: 27 }, { id: 'M008', qty: 1 }]), clientId: 'c1', mgrName: 'Dan' }, extra || {}));

/* ---- gating ---------------------------------------------------------- */
check('buildPO and poReview are manager-only', ['buildPO', 'poReview'].some((a) => vm.runInContext('OPEN_ACTIONS', sandbox).indexOf(a) !== -1), false);
props = {};
check('not connected: says how, builds nothing', [build().ok, build().needConnect, /Connect QuickBooks/.test(build().error)], [false, true, true]);

/* ---- vendor names ---------------------------------------------------- */
const V = (n, id) => ({ Id: id || n, DisplayName: n });
const mv = (n, list) => { const r = sandbox.matchVendor(n, list); return r ? r.DisplayName : null; };
check('legal suffix differs', mv('American & Efird, LLC', [V('AMERICAN & EFIRD, INC.'), V('AMERICAN EXPRESS'), V('AMERICAN WATER')]), 'AMERICAN & EFIRD, INC.');
check('shorter name in QuickBooks', mv('Chromatech Colors', [V('CHROMATECH'), V('CHRYSLER CAPITAL')]), 'CHROMATECH');
check('parenthesised note ignored', mv('DKSH USA, LLC (Terra Firma)', [V('DKSH USA')]), 'DKSH USA');
check('exact beats a looser match', mv('Granat', [V('Granat'), V('GRANAT INDUSTRIES INC')]), 'Granat');
check('two equally good: refuses to pick', mv('Ravago', [V('RAVAGO CHEMICALS'), V('RAVAGO AMERICAS')]), null);
check('shares only a first word: no match', mv('Professional Plastics', [V('PROFESSIONAL SWIM INC')]), null);
check('legal words alone never match', mv('Inc', [V('ACME INC')]), null);

check('next number is one past the highest numeric', sandbox.nextPoNumber(['8665', 'ABC', '8703']), '8704');
check('no numeric PO: no guess', sandbox.nextPoNumber(['ABC']), null);

/* ---- building --------------------------------------------------------- */
connected();
let r = build();
const po = posts[0] && posts[0].body;
check('builds one PO', [r.ok, r.docNumber, r.vendor, posts.length, r.url], [true, '8704', 'FIBER DYNAMICS, INC.', 1, 'https://qbo.intuit.com/app/purchaseorder?txnId=900']);
check('lines carry item, quantity and last cost', po.Line.map((l) => [l.ItemBasedExpenseLineDetail.ItemRef.value, l.ItemBasedExpenseLineDetail.Qty, l.ItemBasedExpenseLineDetail.UnitPrice, l.Amount]), [['11', 27, 4.5, 121.5], ['12', 1, 10, 10]]);
check('ships to Garwood, notes who built it', [po.ShipAddr.Line2, /by Dan, 2026-11-09: M002 x 27/.test(po.PrivateNote)], ['628 South Ave.', true]);
check('nothing asks QuickBooks to email it', [/send/.test(posts[0].url), 'POEmail' in po, 'EmailStatus' in po], [false, false, false]);
check('remembered beside the button', JSON.parse(props.QBO_BUILT)['Fiber Dynamics'].doc, '8704');
r = build();
check('a retry answers from the first build', [r.replayed, r.docNumber, posts.length], [true, '8704', 1]);

connected(); delete items['Nylon Mesh'];
r = build();
check('an item not in QuickBooks: names it, builds nothing', [r.ok, r.unmatched, posts.length], [false, ['Nylon Mesh'], 0]);
connected(); vendors = [];
r = build();
check('a vendor not in QuickBooks: says so, builds nothing', [r.ok, /exactly one QuickBooks vendor/.test(r.error), posts.length], [false, true, 0]);
connected();
r = build({ lines: JSON.stringify([{ id: 'M002', qty: 0 }]) });
check('all zero: nothing to build', [r.ok, posts.length], [false, 0]);
r = build({ lines: JSON.stringify([{ id: 'M999', qty: 1 }]) });
check('an unknown material is refused', [r.ok, posts.length], [false, 0]);
r = build({ supplier: '(no supplier)' });
check('no supplier is refused', [r.ok, posts.length], [false, 0]);

connected(); openPOs = [{ Id: '50', DocNumber: '8703', Line: [{ ItemBasedExpenseLineDetail: { ItemRef: { value: '11' } } }] }];
r = build();
check('already on an open PO: asks first', [r.ok, r.already[0].name, r.already[0].doc, posts.length], [false, 'Nylon Mesh', '8703', 0]);
r = build({ allowDup: '1' });
check('the refusal was not remembered: going ahead builds', [r.ok, posts.length], [true, 1]);
connected(); openPOs = [{ Id: '50', DocNumber: '8703', Line: [{ ItemBasedExpenseLineDetail: { ItemRef: { value: '99' } } }] }];
check('another item on the open PO does not matter', build().ok, true);

/* ---- tokens ----------------------------------------------------------- */
connected(); props.QBO_ACCESS_EXP = '0';
build();
check('an expired access token is refreshed, the rotated refresh token kept', [tokenCalls.length, tokenCalls[0].refresh_token, props.QBO_REFRESH], [1, 'R0', 'R1']);
connected(); unauthorizedOnce = true;
check('a 401 refreshes and goes again', [build().ok, tokenCalls.length], [true, 1]);
connected(); props.QBO_ACCESS_EXP = '0'; props.BAD_REFRESH = '1';
r = build();
check('a dead connection says reconnect', [r.ok, r.needConnect, posts.length], [false, true, 0]);
connected(); sandbox.qboKeepAlive();
check('keep-alive leaves a recent token alone', tokenCalls.length, 0);
props.QBO_REFRESHED = String(Date.now() - 31 * 86400000); sandbox.qboKeepAlive();
check('keep-alive renews at 30 days', tokenCalls.length, 1);

/* ---- callback --------------------------------------------------------- */
check('only a redirect with state is the callback', [sandbox.isQboCallback({ code: 'x', realmId: '1', state: 's' }), sandbox.isQboCallback({ action: 'config' }), sandbox.isQboCallback({ code: 'x' })], [true, false, false]);
props = { QBO_CLIENT_ID: 'id', QBO_CLIENT_SECRET: 's', QBO_STATE: 'good|' + Date.now() }; tokenCalls = [];
let page = sandbox.qboCallback({ code: 'c', realmId: '555', state: 'bad' });
check('a wrong state connects nothing', [/expired/.test(page.html), tokenCalls.length, props.QBO_REALM], [true, 0, undefined]);
page = sandbox.qboCallback({ code: 'c', realmId: '555', state: 'good' });
check('the right state connects', [/is connected/.test(page.html), props.QBO_REALM, props.QBO_REFRESH, tokenCalls[0].redirect_uri, 'QBO_STATE' in props], [true, '555', 'R1', 'https://script.google.com/macros/s/DEP/exec', false]);
page = sandbox.qboCallback({ code: 'c', realmId: '666', state: 'good' });
check('the link works once', [/expired/.test(page.html), props.QBO_REALM], [true, '555']);
props.QBO_STATE = 'old|' + (Date.now() - 31 * 60000);
check('a stale link is refused', /expired/.test(sandbox.qboCallback({ code: 'c', realmId: '1', state: 'old' }).html), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
