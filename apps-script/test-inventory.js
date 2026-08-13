/* Exercise getInventory() — the read side of the Inventory panel.
 *
 * Three things here are easy to get wrong and invisible when they are:
 *   • HISTORY ORDER. CountLog is append-only, so the newest row is last. A
 *     panel that shows the OLDEST count as "last counted" is worse than one
 *     that shows none — it looks authoritative and is wrong.
 *   • DRIFT RUNS. A run of same-signed variances is the signal that a recipe is
 *     wrong rather than a count being sloppy. A run must break on a sign change
 *     AND on an exact match; treating a match as neutral would let two misses
 *     either side of an agreement read as continuous drift.
 *   • NEVER-COUNTED vs ZERO. Eight materials currently sit negative because no
 *     opening baseline was ever taken. They must be reported as uncounted, not
 *     folded into the same bucket as materials that were counted and came back
 *     empty.
 *
 * Run:  node apps-script/test-inventory.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const MAT_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint',
                     'Status', 'Category', 'Notes', 'LastCounted', 'LastCountedAt',
                     'LastVariance'];

// LastCountedAt is a Date in the sheet, exactly as setValue(new Date()) leaves it.
const D = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

const MATERIALS = [
  // Counted three times, short every time — the drift signature.
  ['M014', '1" Red PP Webbing', 'Yards', 88, 1000, 'OK', 'Webbing', '', 88, D('2026-08-10'), 12],
  // Counted twice, opposite directions — noise, not drift.
  ['M034', 'EVA Foam (2# black)', 'sheet', 55, 10, 'OK', 'Foam', '', 55, D('2026-08-10'), -5],
  // Never counted, and negative from a missing opening baseline.
  ['M038', 'Boxes 50"', 'each', -492, 50, 'OK', 'Packaging', '', '', '', ''],
  // Never counted, below its reorder point.
  ['M043', 'Tri-glide 2"', 'each', 3, 25, 'OK', 'Hardware', '', '', '', ''],
  // No stock figure at all — a blank OnHand cell, which is not the same as 0.
  ['M099', 'Grommets', 'each', '', 5, 'OK', 'Hardware', '', '', '', '']
];

const COUNTLOG_HEADERS = ['Timestamp', 'MaterialID', 'MaterialName', 'Unit',
                          'EstimatedAtCount', 'CountedQty', 'Variance', 'VariancePct',
                          'CountedBy', 'Notes'];
// Deliberately in chronological order, oldest first — that is how an append-only
// log actually arrives, and reversing it is the endpoint's job, not the fixture's.
const COUNTLOG = [
  [D('2026-06-01'), 'M014', '1" Red PP Webbing', 'Yards', 120, 110, 10, 8.33, 'Dan', 'first'],
  [D('2026-07-14'), 'M014', '1" Red PP Webbing', 'Yards', 100, 94, 6, 6, 'John', ''],
  [D('2026-08-10'), 'M014', '1" Red PP Webbing', 'Yards', 100, 88, 12, 12, 'Dan', 'Q3'],
  [D('2026-07-14'), 'M034', 'EVA Foam (2# black)', 'sheet', 40, 38, 2, 5, 'John', ''],
  [D('2026-08-10'), 'M034', 'EVA Foam (2# black)', 'sheet', 50, 55, -5, -10, 'Dan', 'Q3']
];

const TABS = { RawMaterials: MATERIALS, CountLog: COUNTLOG };

const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getName: () => 'Sheet', getId: () => 'ID', getSheetByName: () => null
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

// readObjects() is the one seam getInventory() reads the sheet through.
sandbox.readObjects = (tab) => {
  const headers = tab === 'CountLog' ? COUNTLOG_HEADERS : MAT_HEADERS;
  return (TABS[tab] || []).map((row) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const res = sandbox.getInventory({});
check('call succeeds', res.ok, true);

const by = Object.fromEntries(res.materials.map((m) => [m.id, m]));

/* --- History ------------------------------------------------------------- */
check('history is newest first, not sheet order',
  by.M014.history.map((h) => h.at), ['2026-08-10', '2026-07-14', '2026-06-01']);
check('history defaults to three entries', by.M014.history.length, 3);
check('every count is still tallied even when the history is trimmed',
  by.M014.countsRecorded, 3);
check('history carries both sides of the comparison, not just the correction',
  { est: by.M014.history[0].estimated, counted: by.M014.history[0].counted },
  { est: 100, counted: 88 });
check('a material with no counts gets an empty history, not undefined',
  by.M038.history, []);
check('history depth is caller-settable',
  sandbox.getInventory({ history: 1 }).materials
    .filter((m) => m.id === 'M014')[0].history.length, 1);
check('a junk history depth falls back rather than returning nothing',
  sandbox.getInventory({ history: 'lots' }).materials
    .filter((m) => m.id === 'M014')[0].history.length, 3);

/* --- Drift --------------------------------------------------------------- */
check('three counts short in a row is a drift run', by.M014.driftRun, 3);
check('a drift run of 2+ is flagged', by.M014.drifting, true);
check('opposite-signed variances break the run', by.M034.driftRun, 1);
check('one miss is not drift', by.M034.drifting, false);
check('an uncounted material cannot be drifting', by.M038.drifting, false);

// An exact match is evidence AGAINST drift, so it must break a run rather than
// being skipped over.
TABS.CountLog = [
  [D('2026-06-01'), 'M014', 'w', 'Yards', 100, 90, 10, 10, 'Dan', ''],
  [D('2026-07-01'), 'M014', 'w', 'Yards', 100, 100, 0, 0, 'Dan', ''],
  [D('2026-08-01'), 'M014', 'w', 'Yards', 100, 95, 5, 5, 'Dan', '']
];
check('an exact match breaks the run',
  sandbox.getInventory({}).materials.filter((m) => m.id === 'M014')[0].driftRun, 1);
TABS.CountLog = COUNTLOG;

/* --- Never counted vs zero ----------------------------------------------- */
check('never-counted materials are counted as such', res.summary.neverCounted, 3);
check('negative stock is surfaced separately from uncounted', res.summary.negative, 1);
check('a negative material is not silently treated as counted',
  { lastCountedAt: by.M038.lastCountedAt, history: by.M038.countsRecorded },
  { lastCountedAt: null, history: 0 });
/* "Below reorder" follows the OnHand FIGURE, not whether anyone has physically
 * counted it — same rule the Overview reorder list uses, deliberately, so the
 * two screens can't disagree about what needs buying. M014 (88 of a 1000
 * reorder point), M038 (negative) and M043 (3 of 25) qualify; M099 has no
 * figure at all and so cannot be below anything. */
check('below-reorder follows the stock figure, counted or not', res.summary.low, 3);
check('a blank OnHand is not read as zero and therefore not low',
  { low: by.M099.low, counted: by.M099.counted }, { low: false, counted: false });
check('drift total matches the per-material flags', res.summary.drifting, 1);
check('every material is returned, not just the interesting ones',
  res.summary.materials, 5);

/* --- Last stocktake ------------------------------------------------------- */
check('the sheet-wide last stocktake is the newest row, not the last material',
  { at: res.summary.lastCountAt, by: res.summary.lastCountBy },
  { at: '2026-08-10', by: 'Dan' });

/* --- Day arithmetic ------------------------------------------------------- */
// daysSince() parses the parts by hand; Date('2026-08-10') would be read as UTC
// and can land a day out depending on where the script's clock thinks it is.
check('same day is zero days, not one',
  sandbox.daysSince('2026-08-10', new Date(2026, 7, 10, 23, 59)), 0);
check('days are whole days across a month boundary',
  sandbox.daysSince('2026-07-31', new Date(2026, 7, 10)), 10);
check('a blank date yields null rather than a bogus age',
  sandbox.daysSince('', new Date(2026, 7, 10)), null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
