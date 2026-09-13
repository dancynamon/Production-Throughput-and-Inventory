/* Exercise getReceiving() and lastReceivedMap().
 *
 * Pinned: newest first regardless of sheet order; the material filter; the
 * limit; and that the per-material "last received" picks the latest delivery
 * of THAT material, not the latest row in the log.
 *
 * Run:  node apps-script/test-receiving.js
 */
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const sandbox = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
                    getActive: () => ({ toast() {} }), getUi: () => ({}) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

// Deliberately NOT in date order, to prove the sort is by timestamp.
const LOG = [
  { Timestamp: new Date(2026, 8, 2, 9),  Employee: 'Dan',  MaterialID: 'M014', MaterialName: 'Red Webbing', QtyAdded: 200, Notes: 'PO 118' },
  { Timestamp: new Date(2026, 8, 10, 14), Employee: 'John', MaterialID: 'M034', MaterialName: 'EVA Foam',    QtyAdded: 20,  Notes: '' },
  { Timestamp: new Date(2026, 8, 6, 11), Employee: 'Joe',  MaterialID: 'M014', MaterialName: 'Red Webbing', QtyAdded: 50,  Notes: 'short roll' },
  { Timestamp: '',                        Employee: 'Dan',  MaterialID: '',     MaterialName: '',            QtyAdded: 5,   Notes: 'blank id — must be ignored' }
];
sandbox.readObjects = (tab) => (tab === 'ReceivingLog' ? LOG : []);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const all = sandbox.getReceiving({});
check('newest first, whatever order the sheet holds them in',
  all.deliveries.map((d) => d.at), ['2026-09-10', '2026-09-06', '2026-09-02']);
check('a row with no material id is dropped, not shown blank', all.total, 3);
check('each delivery carries who, what, how much',
  all.deliveries[0], { at: '2026-09-10', by: 'John', id: 'M034', name: 'EVA Foam', qty: 20, notes: '' });

const one = sandbox.getReceiving({ materialId: 'M014' });
check('filtering by material keeps only that material, still newest first',
  one.deliveries.map((d) => [d.id, d.qty]), [['M014', 50], ['M014', 200]]);
check('total reflects the filter', one.total, 2);

check('limit caps the list but not the total',
  (() => { const r = sandbox.getReceiving({ limit: 1 }); return [r.deliveries.length, r.total]; })(), [1, 3]);
check('a junk limit falls back rather than returning nothing',
  sandbox.getReceiving({ limit: 'lots' }).deliveries.length, 3);

const last = sandbox.lastReceivedMap();
check('last received is the latest delivery of THAT material, not the latest row',
  last.M014.at + ' ' + last.M014.qty, '2026-09-06 50');
check('a material never received is simply absent', last.M999, undefined);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
