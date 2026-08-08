/* Exercise computeRunway() and computeThroughput().
 *
 * Two things here are easy to get wrong in ways that look plausible:
 *
 *   - A material consumed at SEVERAL stages of one product (paint at Paint 1
 *     and Paint 2) must be summed across those stages. Take any single BOM row
 *     and the runway comes out roughly double, which reads as believable.
 *   - A material that has never been counted must NOT be read as zero. Most of
 *     this sheet is uncounted; treating blank as empty reports a runway of 0
 *     for nearly every product, which is both wrong and useless.
 *
 * Run:  node apps-script/test-metrics.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }),
    getActive: () => ({ toast() {} }), getUi: () => ({})
  },
  Logger: { log() {} }, console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

const FIX = {
  Products: [
    { ProductID: 'XRT50EXO', ProductName: 'Exotube', Line: 'TubeExo', Active: 'YES', FeedsFrom: 'BLANK50' },
    { ProductID: 'BLANK50',  ProductName: '50" Blank', Line: 'Blank', Active: 'YES', FeedsFrom: '' }
  ],
  RawMaterials: [
    { MaterialID: 'M036', MaterialName: 'WB Urethane Paint', Unit: 'gal',   OnHand: 10 },
    { MaterialID: 'M014', MaterialName: '1" Red PP Webbing', Unit: 'Yards', OnHand: 96 },
    { MaterialID: 'M034', MaterialName: 'EVA Foam',          Unit: 'sheet', OnHand: '' }   // never counted
  ],
  BOM: [
    // Paint is consumed TWICE — 0.0769 at each of two stages, so 0.1538/unit.
    { ProductID: 'XRT50EXO', Stage: 'Paint 1', MaterialID: 'M036', QtyPerUnit: 0.0769 },
    { ProductID: 'XRT50EXO', Stage: 'Paint 2', MaterialID: 'M036', QtyPerUnit: 0.0769 },
    { ProductID: 'XRT50EXO', Stage: 'Straps Attached', MaterialID: 'M014', QtyPerUnit: 1.78 },
    { ProductID: 'BLANK50',  Stage: 'Cut',     MaterialID: 'M034', QtyPerUnit: 0.1333 }
  ],
  Planning: [],
  StageLog: [
    { ProductID: 'BLANK50', Stage: 'Cut', Qty: 60, Hours: 2, WorkDate: '2026-08-04' },
    { ProductID: 'BLANK50', Stage: 'Cut', Qty: 90, Hours: 3, WorkDate: '2026-08-05' },
    // A day logged with no hours: counts toward totals and units/day, but must
    // not drag the hourly rate toward zero.
    { ProductID: 'BLANK50', Stage: 'Cut', Qty: 50, Hours: '', WorkDate: '2026-08-06' }
  ]
};
sandbox.readObjects = (tab) => FIX[tab] || [];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const rw = sandbox.computeRunway();

// Paint: 10 gal / 0.1538 per unit = 65. Webbing: 96 / 1.78 = 53. Webbing binds.
check('per-unit need is SUMMED across stages, so paint gives 65 not 130',
  rw.XRT50EXO.materials.find(m => m.id === 'M036').canMake, 65);

check('buildable is the minimum across materials',
  rw.XRT50EXO.buildable, 53);

check('the binding constraint is named, not just the number',
  { name: rw.XRT50EXO.constraint.name, perUnit: rw.XRT50EXO.constraint.perUnit },
  { name: '1" Red PP Webbing', perUnit: 1.78 });

check('scarcest material sorts first',
  rw.XRT50EXO.materials.map(m => m.id), ['M014', 'M036']);

// BLANK50's only material has never been counted.
check('uncounted material does NOT read as zero buildable',
  rw.BLANK50.buildable, null);
check('uncounted material is reported so it can be counted',
  rw.BLANK50.uncounted.map(u => u.id), ['M034']);

const tp = sandbox.computeThroughput();
const cut = tp.find(t => t.productId === 'BLANK50' && t.stage === 'Cut');

check('total quantity includes the hours-less day', cut.totalQty, 200);
check('three distinct work dates observed', cut.daysObserved, 3);
check('units/day spreads over every day logged (200/3)', cut.unitsPerDay, 66.67);
check('units/hour uses ONLY the entries that carried hours (150/5)', cut.unitsPerHour, 30);
check('hours are not invented for entries that lacked them', cut.hoursLogged, 5);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
