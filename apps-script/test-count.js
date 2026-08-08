/* Exercise submitCount()'s reconciliation against a fake spreadsheet.
 *
 * Two things here are easy to get backwards and expensive to get wrong:
 * the SIGN of the variance (which direction means "we used more than the
 * recipe said"), and PARTIAL counts (a blank box must leave a material
 * completely alone, not zero it). Both are pinned below.
 *
 * Run:  node apps-script/test-count.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* --- Minimal fake of the Sheets API surface submitCount() actually uses --- */
function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map(r => r.slice())];
  return {
    appended: [],
    getLastColumn: () => grid[0].length,
    getDataRange: () => ({ getValues: () => grid.map(r => r.slice()) }),
    getRange(r, c, nr, nc) {
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            out.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1)));
          }
          return out;
        },
        setValue: (v) => { grid[r - 1][c - 1] = v; },
        setValues: (vals) => {
          vals.forEach((row, i) => row.forEach((v, j) => {
            while (grid[r - 1 + i].length <= c - 1 + j) grid[r - 1 + i].push('');
            grid[r - 1 + i][c - 1 + j] = v;
          }));
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    },
    appendRow(row) { this.appended.push(row); },
    setFrozenRows: () => {},
    autoResizeColumn: () => {},
    grid
  };
}

const MAT_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint',
                     'Status', 'Category', 'Notes', 'LastCounted', 'LastCountedAt', 'LastVariance'];
const matSheet = fakeSheet(MAT_HEADERS, [
  ['M014', '1" Red PP Webbing', 'Yards', 100, 1000, 'OK', 'Webbing', '', '', '', ''],
  ['M034', 'EVA Foam (2# black)', 'sheet', 50, 10, 'OK', 'Foam', '', '', '', ''],
  ['M037', 'UV White Ink (print)', 'unit', 8, 1, 'OK', 'Ink', '', '', '', '']
]);
// Real headers matter: submitCount() now writes through appendByHeader(), so a
// header-less fixture would append nothing and mask a genuine regression.
const countLog = fakeSheet(['Timestamp', 'MaterialID', 'MaterialName', 'Unit',
                            'EstimatedAtCount', 'CountedQty', 'Variance',
                            'VariancePct', 'CountedBy', 'Notes'], []);

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getName: () => 'Sheet', getId: () => 'ID',
      getSheetByName: (n) => (n === 'RawMaterials' ? matSheet : n === 'CountLog' ? countLog : null),
      insertSheet: () => countLog
    }),
    getActive: () => ({ toast() {} }),
    getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN
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

// Shelf holds less than the recipe predicted on M014 (100 est -> 88 real),
// MORE than predicted on M034 (50 est -> 55 real). M037 is not counted at all.
const res = sandbox.submitCount({
  employee: 'Dan',
  counts: JSON.stringify({ M014: 88, M034: 55 }),
  notes: 'Q3 stocktake'
});

check('call succeeds', res.ok, true);
check('only the counted materials are reported', res.counted.length, 2);

const byId = Object.fromEntries(res.counted.map(c => [c.id, c]));

check('over-consumption is POSITIVE variance (100 est - 88 real)',
  { variance: byId.M014.variance, pct: byId.M014.variancePct }, { variance: 12, pct: 12 });

check('recipe over-deducting is NEGATIVE variance (50 est - 55 real)',
  { variance: byId.M034.variance, pct: byId.M034.variancePct }, { variance: -5, pct: -10 });

check('biggest relative drift is reported first',
  res.counted.map(c => c.id), ['M014', 'M034']);

// Row order in the fake grid: 1 = headers, 2 = M014, 3 = M034, 4 = M037.
check('OnHand re-baselined to the counted number (M014)', matSheet.grid[1][3], 88);
check('LastCounted / LastVariance stamped (M014)',
  { counted: matSheet.grid[1][8], variance: matSheet.grid[1][10] }, { counted: 88, variance: 12 });

check('UNCOUNTED material is left completely alone (M037 OnHand)', matSheet.grid[3][3], 8);
check('UNCOUNTED material gets no LastCounted stamp', matSheet.grid[3][8], '');

check('one CountLog row per counted material', countLog.appended.length, 2);
check('CountLog captures estimate AND count, not just the correction',
  countLog.appended[0].slice(1, 7), ['M014', '1" Red PP Webbing', 'Yards', 100, 88, 12]);

// Rows are written by header name, so an added or reordered column can't
// silently shift every value one place along.
check('CountLog row is ordered by header, not by argument position',
  countLog.appended[0].length, 10);
check('CountedBy lands in the CountedBy column', countLog.appended[0][8], 'Dan');
check('Notes land in the Notes column', countLog.appended[0][9], 'Q3 stocktake');

// Guards
check('blank submission is rejected rather than zeroing everything',
  sandbox.submitCount({ employee: 'Dan', counts: '{}' }).ok, false);
check('missing employee is rejected',
  sandbox.submitCount({ employee: '', counts: '{"M014":1}' }).ok, false);
check('unknown material is reported, not silently dropped',
  sandbox.submitCount({ employee: 'Dan', counts: '{"NOPE":5}' }).unknown, ['NOPE']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
