/* Finished goods: storage, shipping, imports. Pinned: the last stage of a
 * sellable product adds to storage and a reversal takes it back; a blank or
 * strap never lands in storage; a shipment subtracts and replays once; a
 * storage count re-baselines and files the variance; an import matches by
 * channel SKU, then ID, then name, skips what is already on file, and names
 * what it could not match; each export format is recognised and only shipped
 * lines count.
 *
 * Run:  node apps-script/test-finished.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  return {
    getLastColumn: () => grid[0].length, getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(r, c, nr, nc) {
      return {
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) out.push((grid[r - 1 + i] || []).slice(c - 1, c - 1 + (nc || 1))); return out; },
        setValue: (v) => { while (grid.length < r) grid.push([]); while (grid[r - 1].length < c) grid[r - 1].push(''); grid[r - 1][c - 1] = v; },
        setValues: (vals) => { vals.forEach((row, i) => { while (grid.length < r + i) grid.push([]); row.forEach((v, j) => { while (grid[r - 1 + i].length <= c - 1 + j) grid[r - 1 + i].push(''); grid[r - 1 + i][c - 1 + j] = v; }); });
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) }; }
      };
    },
    appendRow(row) { grid.push(row.slice()); },
    setFrozenRows() {}, autoResizeColumn() {}, clear() { grid.length = 1; },
    grid
  };
}
const objs = (sheet) => { const [h, ...rows] = sheet.grid; return rows.map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };

const PRODUCTS = [
  { ProductID: 'BLANK50', ProductName: '50" Blank', Line: 'Blank', Active: 'YES', FeedsFrom: '', OutputMaterial: '' },
  { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exotube', Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50', OutputMaterial: '' },
  { ProductID: 'STRAP6', ProductName: 'Shoulder Strap', Line: 'Strap', Active: 'YES', FeedsFrom: '', OutputMaterial: 'M044' },
  { ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Line: 'Chair', Active: 'YES', FeedsFrom: '', OutputMaterial: '' }
];
const STAGES = [
  { Line: 'Blank', Order: 1, Stage: 'Cut' }, { Line: 'Blank', Order: 2, Stage: 'Glued' },
  { Line: 'TubeExo', Order: 1, Stage: 'Meshed' }, { Line: 'TubeExo', Order: 2, Stage: 'Boxed' },
  { Line: 'Strap', Order: 1, Stage: 'Made' }, { Line: 'Chair', Order: 1, Stage: 'Cut' }, { Line: 'Chair', Order: 2, Stage: 'Box' }
];
const sheets = {};
const FIN_H = ['ProductID', 'ProductName', 'OnHand', 'LastCounted', 'LastCountedAt', 'LastVariance', 'ShopifySKU', 'AmazonSKU', 'QBOItem', 'Notes'];
const SHIP_H = ['Timestamp', 'ShipDate', 'ProductID', 'ProductName', 'Qty', 'Channel', 'Ref', 'By', 'Notes', 'Key'];
function reset() {
  sheets.RawMaterials = fakeSheet(['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint'], [['M044', 'Strap', 'each', 10, 5]]);
  sheets.StageLog = fakeSheet(['Timestamp', 'WorkDate', 'Employee', 'ProductID', 'ProductName', 'Stage', 'Qty', 'Notes', 'Hours'], []);
  sheets.CountLog = fakeSheet(['Timestamp', 'MaterialID', 'MaterialName', 'Unit', 'EstimatedAtCount', 'CountedQty', 'Variance', 'VariancePct', 'CountedBy', 'Notes'], []);
  delete sheets.FinishedGoods; delete sheets.ShipLog;
}
let store = {};
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getName: () => 'S', getId: () => 'ID',
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => { sheets[n] = fakeSheet([], []); return sheets[n]; }
    }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: (k) => store['c:' + k] || null, put: (k, v) => { store['c:' + k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) },
  Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2), DigestAlgorithm: {}, Charset: {}, computeDigest: () => [] },
  ScriptApp: { getProjectTriggers: () => [] },
  Logger: { log() {} }, console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, Error
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
// The fake writeTab must create a real fake sheet with headers.
sandbox.writeTab = (ss, name, headers, rows) => { sheets[name] = fakeSheet(headers, rows || []); return sheets[name]; };
sandbox.readObjects = (tab) => {
  if (tab === 'Products') return PRODUCTS; if (tab === 'Stages') return STAGES; if (tab === 'BOM') return []; if (tab === 'Employees') return [];
  return sheets[tab] ? objs(sheets[tab]) : [];
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

/* --- Which products are stock ------------------------------------------------ */
reset();
check('sellable = not a feeder, no output material', sandbox.sellableProducts().map((p) => p.ProductID), ['XRT50EXO', 'LGC30']);
sandbox.finishedSheet();
check('the FinishedGoods tab is seeded with one row per sellable product, OnHand blank',
  objs(sheets.FinishedGoods).map((r) => [r.ProductID, r.OnHand]), [['XRT50EXO', ''], ['LGC30', '']]);

/* --- The last stage lands in storage ----------------------------------------- */
const day = (pid, counts) => sandbox.submitDay({ workDate: '2026-09-22', employee: 'Joe', productId: pid, counts: JSON.stringify(counts) });
let r = day('XRT50EXO', { Meshed: 30, Boxed: 12 });
check('Boxed adds to storage; Meshed does not', [r.ok, r.stocked, objs(sheets.FinishedGoods)[0].OnHand], [true, [{ id: 'XRT50EXO', name: 'XRT-50 Exotube', added: 12, onHand: 12 }], 12]);
r = day('BLANK50', { Cut: 50, Glued: 50 });
check('a blank\'s last stage is not stock', [r.stocked, objs(sheets.FinishedGoods).length], [[], 2]);
r = day('STRAP6', { Made: 5 });
check('a strap becomes a material, not finished stock', [r.stocked, r.produced.map((x) => [x.id, x.onHand])], [[], [['M044', 15]]]);
r = sandbox.reverseEntry({ employee: 'Joe', productId: 'XRT50EXO', workDate: '2026-09-22', stage: 'Boxed', qty: 2, reason: 'double tap' });
check('reversing Boxed takes it back out of storage', [r.ok, r.unstocked, objs(sheets.FinishedGoods)[0].OnHand], [true, { id: 'XRT50EXO', name: 'XRT-50 Exotube', removed: 2, onHand: 10 }, 10]);

/* --- Shipping ------------------------------------------------------------------ */
r = sandbox.shipOut({ employee: 'Maria', productId: 'XRT50EXO', qty: 4, channel: 'Shopify', ref: '#6107', clientId: 'c1', shipDate: '2026-09-22' });
check('a shipment subtracts from storage and is logged with its channel',
  [r.ok, r.onHand, objs(sheets.ShipLog).map((s) => [s.ProductID, s.Qty, s.Channel, s.Ref, s.By])], [true, 6, [['XRT50EXO', 4, 'Shopify', '#6107', 'Maria']]]);
const again = sandbox.shipOut({ employee: 'Maria', productId: 'XRT50EXO', qty: 4, channel: 'Shopify', ref: '#6107', clientId: 'c1' });
check('the same clientId again is replayed, not shipped twice', [again.replayed, objs(sheets.ShipLog).length, objs(sheets.FinishedGoods)[0].OnHand], [true, 1, 6]);
check('a blank cannot be shipped', sandbox.shipOut({ employee: 'M', productId: 'BLANK50', qty: 1, channel: 'Other' }).ok, false);
check('an unknown channel is refused', sandbox.shipOut({ employee: 'M', productId: 'XRT50EXO', qty: 1, channel: 'eBay' }).ok, false);
r = sandbox.shipOut({ employee: 'M', productId: 'XRT50EXO', qty: 10, channel: 'Wholesale' });
check('shipping more than storage holds warns instead of refusing', [r.onHand, r.warnings.length], [-4, 1]);

/* --- Count ---------------------------------------------------------------------- */
r = sandbox.countFinished({ employee: 'Dan', counts: JSON.stringify({ XRT50EXO: 3, LGC30: '' }) });
check('a storage count re-baselines and files the variance (estimate − counted)',
  [r.counted.map((c) => [c.id, c.estimated, c.counted, c.variance]), objs(sheets.FinishedGoods)[0].OnHand, objs(sheets.CountLog).map((c) => [c.MaterialID, c.Unit, c.Variance])],
  [[['XRT50EXO', -4, 3, -7]], 3, [['XRT50EXO', 'finished', -7]]]);
check('a blank box leaves that product alone', objs(sheets.FinishedGoods)[1].OnHand, '');

/* --- Imports ------------------------------------------------------------------- */
reset(); sandbox.finishedSheet();
sheets.FinishedGoods.getRange(2, 3).setValue(20);           // XRT50EXO on hand 20
sheets.FinishedGoods.getRange(2, 7).setValue('AM-XRT50, xrt50-red');  // ShopifySKU
sheets.FinishedGoods.getRange(3, 9).setValue('Lifeguard Chair:30in');  // QBOItem
r = sandbox.importSales([
  { channel: 'Shopify', ref: '#6107', sku: 'xrt50-red', name: 'Rescue tube red', qty: 2, date: '2026-09-18' },
  { channel: 'Shopify', ref: '#6108', sku: 'NOODLE-60', name: 'Pool Noodle', qty: 1, date: '2026-09-18' },
  { channel: 'QuickBooks', ref: '18897', sku: '30in', name: 'Lifeguard Chair:30in', qty: 1, date: '2026-09-18' },
  { channel: 'Amazon', ref: '111-1', sku: 'XRT50EXO', name: '', qty: 3, date: '2026-09-19' }
], 'test');
check('lines match by channel SKU (list, any case), by product ID, or by name',
  r.added.map((a) => [a.productId, a.qty, a.channel]), [['XRT50EXO', 2, 'Shopify'], ['LGC30', 1, 'QuickBooks'], ['XRT50EXO', 3, 'Amazon']]);
check('what matched nothing is reported, never guessed', r.unmatched.map((u) => [u.sku, u.qty]), [['NOODLE-60', 1]]);
check('storage moved by the matched quantities', objs(sheets.FinishedGoods).map((x) => [x.ProductID, x.OnHand]), [['XRT50EXO', 15], ['LGC30', -1]]);
const rerun = sandbox.importSales([{ channel: 'Shopify', ref: '#6107', sku: 'AM-XRT50', qty: 2, date: '2026-09-18' }], 'test');
check('re-importing the same order line is a no-op', [rerun.added.length, rerun.skipped, objs(sheets.FinishedGoods)[0].OnHand], [0, 1, 15]);

/* --- Export formats -------------------------------------------------------------- */
const shopify = sandbox.salesRowsFromTable(sandbox.parseDelimited(
  'Name,Email,Financial Status,Fulfillment Status,Fulfilled at,Created at,Lineitem quantity,Lineitem name,Lineitem sku,Lineitem fulfillment status\n'
  + '#6107,a@b.c,paid,fulfilled,2026-09-18 10:00,2026-09-17 09:00,2,"Rescue Tube, Red",AM-XRT50,fulfilled\n'
  + '#6108,a@b.c,paid,unfulfilled,,2026-09-18 09:00,1,Pool Noodle,NOODLE-60,pending\n'));
check('Shopify export: fulfilled lines only, quoted commas survive', [shopify.format, shopify.rows.map((x) => [x.ref, x.sku, x.qty, x.date, x.name])], ['Shopify', [['#6107', 'AM-XRT50', 2, '2026-09-18', 'Rescue Tube, Red']]]);
const amazon = sandbox.salesRowsFromTable(sandbox.parseDelimited(
  'amazon-order-id\tpurchase-date\tlast-updated-date\torder-status\tsku\tproduct-name\tquantity\n'
  + '111-1\t2026-09-18T01:00:00+00:00\t2026-09-19T01:00:00+00:00\tShipped\tXRT50EXO\tRescue Tube\t3\n'
  + '111-2\t2026-09-18T01:00:00+00:00\t2026-09-18T01:00:00+00:00\tPending\tXRT50EXO\tRescue Tube\t1\n'));
check('Amazon report: tab-separated, Shipped only', [amazon.format, amazon.rows.map((x) => [x.ref, x.sku, x.qty, x.date])], ['Amazon', [['111-1', 'XRT50EXO', 3, '2026-09-19']]]);
const qbo = sandbox.salesRowsFromTable(sandbox.parseDelimited(
  'Date,Transaction Type,Num,Customer,Product/Service,Memo/Description,Qty,Sales Price,Amount\n'
  + '2026-09-16,Invoice,18897,Carmel,Lifeguard Chair:30in,,1,419.88,419.88\n'
  + '2026-09-16,Estimate,3590,Someone,Lifeguard Chair:30in,,4,419.88,1679.52\n'));
check('QuickBooks detail: invoices and sales receipts only, item name after the colon is the SKU',
  [qbo.format, qbo.rows.map((x) => [x.ref, x.sku, x.name, x.qty])], ['QuickBooks', [['18897', '30in', 'Lifeguard Chair:30in', 1]]]);
check('an unknown header row is not an import', sandbox.salesRowsFromTable([['Foo', 'Bar'], [1, 2]]).format, null);

/* --- Shopify pull -------------------------------------------------------------- */
sandbox.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify({ orders: [
  { name: '#6110', created_at: '2026-09-20T10:00:00Z', fulfillments: [
    { status: 'success', created_at: '2026-09-21T10:00:00Z', line_items: [{ sku: 'AM-XRT50', title: 'Tube', quantity: 5 }] },
    { status: 'cancelled', created_at: '2026-09-21T10:00:00Z', line_items: [{ sku: 'AM-XRT50', title: 'Tube', quantity: 9 }] } ] },
  { name: '#6111', created_at: '2026-09-20T10:00:00Z', fulfillments: [] } ] }) }) };
store.SHOPIFY_SHOP = 'aquamentor'; store.SHOPIFY_TOKEN = 'shpat_x';
check('Shopify pull: successful fulfillments only, keyed by order and SKU',
  sandbox.shopifyShippedRows('2026-09-01T00:00:00Z').map((x) => [x.ref, x.sku, x.qty, x.date]), [['#6110', 'AM-XRT50', 5, '2026-09-21']]);
const sync = sandbox.syncShopify();
check('sync records it against storage and remembers the run', [sync.added.length, objs(sheets.FinishedGoods)[0].OnHand, /\+1 skipped 0/.test(store.SHOPIFY_LAST)], [1, 10, true]);
check('a second sync of the same window adds nothing', [sandbox.syncShopify().skipped, objs(sheets.FinishedGoods)[0].OnHand], [1, 10]);

/* --- The manager view ------------------------------------------------------------ */
const view = sandbox.getFinished({ days: 30 });
check('the view carries storage, movement by channel, and what was never counted',
  [view.totals.onHand, view.byChannel, view.products.map((p) => [p.id, p.onHand, p.shipped, p.counted])],
  [9, { Shopify: 7, QuickBooks: 1, Amazon: 3 }, [['XRT50EXO', 10, 10, false], ['LGC30', -1, 1, false]]]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
