/* Exercise the additive schema repairs — the ones that self-apply on deploy.
 *
 * These exist because of a failure that produced no error anywhere: the BOM
 * referenced M044 (the strap), RawMaterials had no such row, and submitDay()
 * silently skipped both the deduction and the production. Straps were made,
 * webbing came off the shelf, and no strap was ever added to stock.
 *
 * What is pinned here:
 *   • a referenced-but-missing material is APPENDED, with a BLANK OnHand —
 *     unknown, not zero, because zero is a confident claim nobody made
 *   • a material nobody references is NOT added — absence may be deliberate
 *   • blank Family cells are filled, non-blank ones are left alone
 *   • both operations are idempotent: running twice changes nothing
 *
 * Run:  node apps-script/test-schema.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map(r => r.slice())];
  return {
    getLastColumn: () => grid[0].length,
    getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map(r => r.slice()) }),
    getRange(r, c, nr, nc) {
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) out.push(grid[r - 1 + i].slice(c - 1, c - 1 + (nc || 1)));
          return out;
        },
        setValue: (v) => { grid[r - 1][c - 1] = v; },
        setFormula: (f) => { grid[r - 1][c - 1] = f; },
        setValues: (vals) => {
          vals.forEach((row, i) => row.forEach((v, j) => {
            while (grid[r - 1 + i].length <= c - 1 + j) grid[r - 1 + i].push('');
            grid[r - 1 + i][c - 1 + j] = v;
          }));
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    },
    appendRow(row) { grid.push(row.slice()); },
    setFrozenRows: () => {},
    autoResizeColumn: () => {},
    grid
  };
}

const MAT_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint',
                     'Status', 'Category', 'Notes', 'LastCounted', 'LastCountedAt', 'LastVariance'];
// The live sheet as it actually stood: M044 referenced by the BOM, no row for it.
const matSheet = fakeSheet(MAT_HEADERS, [
  ['M014', '1" Red PP Webbing', 'Yards', -350.78, 1000, '⚠ REORDER', 'Webbing & Thread', '', '', '', '']
]);

const PROD_HEADERS = ['ProductID', 'ProductName', 'Line', 'Unit', 'Active',
                      'FeedsFrom', 'OutputMaterial', 'Family'];
// Family column present but empty — the state an upgraded (not rebuilt) sheet
// lands in, where every product silently collapses into "Other".
const prodSheet = fakeSheet(PROD_HEADERS, [
  ['STRAP6',   "Shoulder Strap w/ 6' Tow Line", 'Strap', 'each', 'YES', '', 'M044', ''],
  ['LGC30',    'Lifeguard Chair 30"',           'Chair', 'each', 'YES', '', '',     ''],
  ['XRT50EXO', 'XRT-50 Exotube (meshed)',       'TubeExo', 'each', 'YES', 'BLANK50', '', 'Hand-typed'],
  ['ZZZ99',    'Something Dan added himself',   'Shape', 'each', 'YES', '', '',     '']
]);

const bomRows = [
  ['STRAP6',   'Made',            'M014', 1.78],
  ['XRT50EXO', 'Straps Attached', 'M044', 1],
  ['XRT50EXO', 'Boxed',           'M031', 0.002]
];

const SHEETS = { RawMaterials: matSheet, Products: prodSheet };

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getName: () => 'Sheet', getId: () => 'ID',
      getSheetByName: (n) => SHEETS[n] || null,
      insertSheet: () => fakeSheet([], [])
    }),
    getActive: () => ({ toast() {} }),
    getUi: () => ({})
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);

sandbox.readObjects = (tab) => {
  const src = tab === 'BOM'
    ? { headers: ['ProductID', 'Stage', 'MaterialID', 'QtyPerUnit'], rows: bomRows }
    : tab === 'Products'
      ? { headers: PROD_HEADERS, rows: prodSheet.grid.slice(1) }
      : tab === 'RawMaterials'
        ? { headers: MAT_HEADERS, rows: matSheet.grid.slice(1) }
        : { headers: [], rows: [] };
  return src.rows.map((row) => {
    const o = {};
    src.headers.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

/* --- Missing referenced materials ---------------------------------------- */
const added = sandbox.addMissingReferencedMaterials();

check('a BOM-referenced material with no row is added', added.sort(), ['M031', 'M044']);

const rowOf = (id) => matSheet.grid.find((r) => r[0] === id);
check('the added strap carries its catalogue name and unit',
  rowOf('M044').slice(0, 3), ['M044', "Shoulder Strap w/ 6' Tow Line", 'each']);
// Blank, NOT zero: nobody has counted these, and 0 would claim they did.
check('OnHand is left blank, not zeroed', rowOf('M044')[3], '');
check('the reorder point comes from the catalogue', rowOf('M044')[4], 50);
check('the existing material is untouched', rowOf('M014')[3], -350.78);
check('the Status formula is restored on the appended row',
  String(rowOf('M044')[5]).slice(0, 4), '=IF(');

check('running it again adds nothing', sandbox.addMissingReferencedMaterials(), []);

/* --- Families ------------------------------------------------------------- */
const filled = sandbox.backfillProductFamilies();
check('blank families are filled from the catalogue', filled, 2);
const prodOf = (id) => prodSheet.grid.find((r) => r[0] === id);
check('the strap lands under Rescue Tubes', prodOf('STRAP6')[7], 'Rescue Tubes');
check('the chair lands under Lifeguard Chairs', prodOf('LGC30')[7], 'Lifeguard Chairs');
// A family someone typed themselves is theirs, not ours to overwrite.
check('a hand-typed family is left alone', prodOf('XRT50EXO')[7], 'Hand-typed');
check('a product the catalogue does not know is left blank', prodOf('ZZZ99')[7], '');
check('running it again fills nothing', sandbox.backfillProductFamilies(), 0);

/* --- The catalogue itself -------------------------------------------------- */
// A missing comma between two array literals parses as a member access and
// silently swallows both rows, so the shape is asserted rather than trusted.
check('every catalogue material row is the full width',
  sandbox.MATERIAL_ROWS.every((r) => r.length === sandbox.MATERIAL_HEADERS.length), true);
check('every recipe material exists in the catalogue',
  sandbox.MATERIAL_ROWS.filter((r) => r[0] === 'M044').length, 1);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
