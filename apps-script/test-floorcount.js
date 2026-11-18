/* Count on Floor (3.11.0): the crew's to-do list and count writes.
 *
 * What is pinned here:
 *  - countList is BLIND: no on-hand number ever reaches the crew's phone
 *  - its order: never counted, then below zero, then stale; today's counts drop off
 *  - floorCount refuses blanks and negatives, writes through submitCount, and its
 *    reply carries no estimate or variance either
 *  - a resent count or walk logs once, from the cache AND with the cache gone
 *  - both writes sit behind the crew login
 *
 * Run:  node apps-script/test-floorcount.js
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
        setValue: (v) => { grid[r - 1][c - 1] = v; }
      };
    },
    appendRow(row) { grid.push(row.slice()); },
    rows: () => grid.slice(1).map(r => Object.fromEntries(grid[0].map((h, i) => [h, r[i]]))),
    grid
  };
}

const MAT_HEADERS = ['MaterialID', 'MaterialName', 'Unit', 'OnHand', 'ReorderPoint',
                     'Status', 'Category', 'Notes', 'LastCounted', 'LastCountedAt', 'LastVariance'];
const matSheet = fakeSheet(MAT_HEADERS, [
  ['M014', 'Red webbing', 'Yards', 100, 10, '', 'Webbing', '', '', '', ''],
  ['M034', 'EVA foam', 'sheet', -4, 10, '', 'Foam', '', '', '', '']
]);
const countLog = fakeSheet(['Timestamp', 'MaterialID', 'MaterialName', 'Unit', 'EstimatedAtCount', 'CountedQty',
                            'Variance', 'VariancePct', 'CountedBy', 'Notes', 'ClientId'], []);
const wipSheet = fakeSheet(['Timestamp', 'ProductID', 'ProductName', 'Stage', 'WaitingBefore', 'CountedBy',
                            'Notes', 'EstimatedAtCount', 'ClientId'], []);

let cacheOn = true;
const store = {};
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getName: () => 'Sheet', getId: () => 'ID',
      getSheetByName: (n) => (n === 'RawMaterials' ? matSheet : n === 'CountLog' ? countLog : n === 'WipBaseline' ? wipSheet : null),
      insertSheet: () => countLog
    }),
    getActive: () => ({ toast() {} })
  },
  CacheService: { getScriptCache: () => {
    if (!cacheOn) throw new Error('no cache');
    return { get: k => store[k] || null, put: (k, v) => { store[k] = v; }, remove: k => { delete store[k]; } };
  } },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.refreshReorderSafe = () => {};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

/* ---- both writes need the crew login --------------------------------------- */
check('floorCount and wipWalk are crew writes', ['floorCount', 'wipWalk'].map(a => sandbox.CREW_WRITE_ACTIONS.indexOf(a) !== -1), [true, true]);
check('countList and floorCount answer without a manager token', ['countList', 'floorCount'].map(a => sandbox.OPEN_ACTIONS.indexOf(a) !== -1), [true, true]);
check('countList is a read, not a crew write', sandbox.CREW_WRITE_ACTIONS.indexOf('countList'), -1);

/* ---- floorCount ---------------------------------------------------------------- */
check('a negative count is refused', sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M014: -2 }), clientId: 'fc-1' }).ok, false);
check('a blank count is refused', sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M014: '' }), clientId: 'fc-1' }).ok, false);
check('nothing counted is refused', sandbox.floorCount({ employee: 'Ana', counts: '{}', clientId: 'fc-1' }).ok, false);
check('refusals wrote nothing', countLog.rows().length, 0);

const r1 = sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M014: 88 }), clientId: 'fc-1' });
check('a count saves', { ok: r1.ok, saved: r1.saved }, { ok: true, saved: 1 });
check('the reply is blind: no estimate, no variance', ['counted', 'estimated', 'variance'].some(k => JSON.stringify(r1).indexOf('"' + k) !== -1), false);
const row = countLog.rows()[0];
check('CountLog row: who, note, clientId, the app\'s number beside the count',
  [row.CountedBy, row.Notes, row.ClientId, row.EstimatedAtCount, row.CountedQty], ['Ana', 'floor count', 'fc-1', 100, 88]);
check('OnHand re-baselined to the count', matSheet.grid[1][3], 88);

const r2 = sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M014: 88 }), clientId: 'fc-1' });
check('the same count resent: replayed from the cache, logged once', [r2.ok, r2.replayed, countLog.rows().length], [true, true, 1]);
cacheOn = false;
const r3 = sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M014: 88 }), clientId: 'fc-1' });
check('resent with the cache gone: CountLog.ClientId still catches it', [r3.ok, r3.replayed, countLog.rows().length], [true, true, 1]);
const r4 = sandbox.floorCount({ employee: 'Ana', counts: JSON.stringify({ M034: 6 }), clientId: 'fc-2' });
check('a different count goes through', [r4.ok, r4.replayed, countLog.rows().length], [true, false, 2]);
cacheOn = true;

/* ---- wipWalk replay ------------------------------------------------------------ */
const PRODUCTS = [
  { ProductID: 'XRT50EXO', ProductName: 'XRT-50 Exo', Line: 'TubeExo', Family: 'Rescue tubes', Active: 'YES' },
  { ProductID: 'XRT40EXO', ProductName: 'XRT-40 Exo', Line: 'TubeExo', Family: 'Rescue tubes', Active: 'YES' },
  { ProductID: 'CHAIR50', ProductName: 'Chair 50', Line: 'Chair', Family: 'Chairs', Active: 'NO' }
];
sandbox.readObjects = (tab) => (tab === 'Products' ? PRODUCTS : []);
sandbox.currentWaitingMap = () => ({});
sandbox.wipBaselineMap = () => ({});
sandbox.dropConfigCache = () => {};
const walk = JSON.stringify({ XRT50EXO: { Patched: 4 } });
const w1 = sandbox.submitWipWalk({ employee: 'Ana', walk: walk, notes: 'floor count', clientId: 'fw-1' });
const perWalk = wipSheet.rows().length;
check('a floor walk saves, every pile written, clientId on each row',
  [w1.ok, perWalk > 1, wipSheet.rows().every(r => r.ClientId === 'fw-1')], [true, true, true]);
cacheOn = false;
const w2 = sandbox.submitWipWalk({ employee: 'Ana', walk: walk, notes: 'floor count', clientId: 'fw-1' });
check('the same walk resent with the cache gone logs once', [w2.ok, w2.replayed, wipSheet.rows().length], [true, true, perWalk]);
cacheOn = true;

/* ---- countList ---------------------------------------------------------------- */
const fmt = d => sandbox.fmtDate(d);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
sandbox.getInventory = () => ({ ok: true, materials: [
  { id: 'A', name: 'Stale glue', unit: 'gal', onHand: 5, lastCountedAt: daysAgo(40), daysSinceCount: 40, stocktake: false },
  { id: 'B', name: 'Fresh ink', unit: 'unit', onHand: 5, lastCountedAt: daysAgo(3), daysSinceCount: 3, stocktake: false },
  { id: 'C', name: 'Never webbing', unit: 'yd', onHand: 0, lastCountedAt: null, daysSinceCount: null, stocktake: true },
  { id: 'D', name: 'Below-zero foam', unit: 'sheet', onHand: -7, lastCountedAt: daysAgo(10), daysSinceCount: 10, stocktake: true },
  { id: 'E', name: 'Counted today', unit: 'roll', onHand: -1, lastCountedAt: daysAgo(0), daysSinceCount: 0, stocktake: true }
] });
const twentyAgo = new Date(); twentyAgo.setDate(twentyAgo.getDate() - 20);
const twoAgo = new Date(); twoAgo.setDate(twoAgo.getDate() - 2);
sandbox.wipBaselineMap = () => ({ XRT40EXO: { at: twentyAgo } });
let list = sandbox.getCountList();
check('shelf: never counted, then below zero, then stale; fresh and today\'s left off',
  list.shelf.map(m => m.id + ':' + m.why), ['C:never counted', 'D:below zero', 'A:last counted 40 days ago']);
check('shelf is blind: no on-hand number on the phone', list.shelf.some(m => 'onHand' in m || 'estimated' in m), false);
check('floor: never counted first, then the 20-day-old count; inactive left off',
  list.floor.map(p => p.id + ':' + p.why), ['XRT50EXO:never counted', 'XRT40EXO:last counted 20 days ago']);
const tubeStages = sandbox.stagesForLine('TubeExo');
check('floor piles: every station after the first, then finished',
  list.floor[0].piles.map(p => p.key), tubeStages.slice(1).concat(['(finished)']));
sandbox.wipBaselineMap = () => ({ XRT40EXO: { at: twoAgo }, XRT50EXO: { at: twoAgo } });
list = sandbox.getCountList();
check('floor: counted inside 14 days drops off', list.floor.length, 0);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
