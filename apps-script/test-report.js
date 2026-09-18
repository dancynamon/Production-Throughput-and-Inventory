/* report-core.js — the math behind the Floor tab and the Floor Report.
 * Pinned: the Drive markdown parses by header signature; a repeated entry is
 * counted once when dropped and its extra is paid down by a reversal already
 * on the books; an opening count on the WIP tab resets the piles and rows
 * before it are not double-counted; pace is per active day.
 *
 * Run:  node apps-script/test-report.js
 */
const path = require('path');
const R = require(path.join(__dirname, '..', 'report-core.js'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

/* --- Parsing the Drive connector's markdown -------------------------------- */
const md = `|  |  |  |
| :-: | :-: | :-: |
| ProductID | ProductName | Line |
| LGC30 | Lifeguard Chair 30" | Chair |

|  |  |  |  |  |
| :-: | :-: | :-: | :-: | :-: |
| Line | Order | Stage | IdealRate\\_perHr | FloorRate\\_perHr |
| Chair | 1 | Cut | 0 | 2 |
| Chair | 2 | Box | 0 | 0 |

|  |  |  |  |  |  |  |  |  |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Timestamp | WorkDate | Employee | ProductID | ProductName | Stage | Qty | Notes | Hours |
| 9/1/2026 8:00:00 | 2026-09-01 | Joe | LGC30 | Lifeguard Chair 30" | Cut | 4 | a \\| b |  |
`;
const parsed = R.parseSheet(md);
check('tables are recognised by header, whatever order they arrive in', Object.keys(parsed).sort(), ['products', 'stagelog', 'stages']);
check('escaped underscores and pipes in cells come back clean',
  [parsed.stages[0].FloorRate_perHr, parsed.stagelog[0].Notes], ['2', 'a | b']);
check('sheet-style timestamps parse', new Date(R.ts('9/1/2026 8:00:00')).getHours(), 8);

/* --- A small floor ---------------------------------------------------------- */
const T = {
  products: [
    { ProductID: 'BLK', ProductName: 'Blank', Line: 'Blank', Active: 'YES', FeedsFrom: '', Family: 'Tubes' },
    { ProductID: 'EXO', ProductName: 'Exo', Line: 'Tube', Active: 'YES', FeedsFrom: 'BLK', Family: 'Tubes' },
    { ProductID: 'CHR', ProductName: 'Chair', Line: 'Chair', Active: 'YES', FeedsFrom: '', Family: 'Chairs' }
  ],
  stages: [
    { Line: 'Blank', Order: 1, Stage: 'Cut', FloorRate_perHr: 10 }, { Line: 'Blank', Order: 2, Stage: 'Glued', FloorRate_perHr: 10 },
    { Line: 'Tube', Order: 1, Stage: 'Meshed' }, { Line: 'Tube', Order: 2, Stage: 'Boxed' },
    { Line: 'Chair', Order: 1, Stage: 'Cut' }, { Line: 'Chair', Order: 2, Stage: 'Box' }
  ],
  planning: [{ ProductID: 'EXO', Stage: 'Boxed', DailyTarget: 20 }],
  stagelog: [
    { Timestamp: '2026-09-01T12:00:00Z', WorkDate: '2026-09-01', Employee: 'Al', ProductID: 'BLK', Stage: 'Cut', Qty: 100 },
    { Timestamp: '2026-09-01T12:01:00Z', WorkDate: '2026-09-01', Employee: 'Al', ProductID: 'BLK', Stage: 'Glued', Qty: 100 },
    { Timestamp: '2026-09-02T12:00:00Z', WorkDate: '2026-09-02', Employee: 'Al', ProductID: 'EXO', Stage: 'Meshed', Qty: 60 },
    { Timestamp: '2026-09-03T12:00:00Z', WorkDate: '2026-09-03', Employee: 'Bo', ProductID: 'EXO', Stage: 'Boxed', Qty: 10, Hours: 2 },
    // Bo's 10 boxed, saved three times.
    { Timestamp: '2026-09-03T12:00:30Z', WorkDate: '2026-09-03', Employee: 'Bo', ProductID: 'EXO', Stage: 'Boxed', Qty: 10, Hours: 2 },
    { Timestamp: '2026-09-03T12:01:00Z', WorkDate: '2026-09-03', Employee: 'Bo', ProductID: 'EXO', Stage: 'Boxed', Qty: 10, Hours: 2 },
    { Timestamp: '2026-09-04T12:00:00Z', WorkDate: '2026-09-04', Employee: 'Bo', ProductID: 'EXO', Stage: 'Boxed', Qty: 10 },
    { Timestamp: '2026-09-04T13:00:00Z', WorkDate: '2026-09-04', Employee: 'Cy', ProductID: 'CHR', Stage: 'Box', Qty: 1 }
  ],
  wipbase: []
};
const asLogged = R.compute(T, { windowDays: 7, today: '2026-09-04', dedupe: false });
const dropped = R.compute(T, { windowDays: 7, today: '2026-09-04', dedupe: true });

check('the repeated entry is found, with its extra', [asLogged.duplicates.length, asLogged.duplicates[0].times, asLogged.duplicates[0].extra, asLogged.duplicates[0].open], [1, 3, 20, 20]);
check('as logged, finished counts every copy (100 glued blanks + 30 + 10 boxed + 1 chair)', asLogged.totals.finished, 141);
check('dropped, each copy after the first is taken out', dropped.totals.finished, 121);
check('dropped copies take their entries with them; people stay', [asLogged.totals.entries, dropped.totals.entries, dropped.people.map((p) => p.name).sort()], [8, 6, ['Al', 'Bo', 'Cy']]);
check('the pile at Boxed follows the drop', [asLogged.pipelines[1].stages[1].waiting, dropped.pipelines[1].stages[1].waiting], [20, 40]);
check('a shared pool sits on the variant\'s first stage', [dropped.pipelines[1].stages[0].shared, dropped.pipelines[1].stages[0].waiting], [true, 40]);
check('pace is per active day — Boxed 20 over 2 days when dropped', dropped.stations.filter((s) => s.stage === 'Boxed')[0].perDay, 10);
check('station target sums the products on the line', dropped.stations.filter((s) => s.stage === 'Boxed')[0].target, 20);
check('hours ride along, and dropped copies do not count theirs', [asLogged.totals.hours, dropped.totals.hours, dropped.people.filter((p) => p.name === 'Bo')[0].hours], [6, 2, 2]);
check('rated capacity is floor rate over 8 h', dropped.stations[0].ratedPerDay, 80);
check('the worst pile is ranked first', dropped.bottlenecks[0].stage, 'Boxed');

/* --- A reversal on the books pays the extra down ----------------------------- */
const T2 = JSON.parse(JSON.stringify(T));
T2.stagelog.push({ Timestamp: '2026-09-05T09:00:00Z', WorkDate: '2026-09-03', Employee: 'Bo', ProductID: 'EXO', Stage: 'Boxed', Qty: -20, Notes: 'REVERSED 20 by Dan: duplicate' });
const fixed = R.compute(T2, { windowDays: 7, today: '2026-09-04', dedupe: true });
check('after the reversal nothing is open on that entry', [fixed.duplicates[0].reversed, fixed.duplicates[0].open, fixed.duplicateExtra], [20, 0, 0]);
check('and dropping no longer subtracts a second time', fixed.totals.finished, 121);

/* --- An opening count resets the piles ------------------------------------- */
const T3 = JSON.parse(JSON.stringify(T));
T3.wipbase = [
  { Timestamp: '2026-09-03T18:00:00Z', ProductID: 'EXO', Stage: 'Meshed', WaitingBefore: 5, CountedBy: 'Dan' },
  { Timestamp: '2026-09-03T18:00:00Z', ProductID: 'EXO', Stage: 'Boxed', WaitingBefore: 7, CountedBy: 'Dan' },
  { Timestamp: '2026-09-03T18:00:00Z', ProductID: 'EXO', Stage: '(finished)', WaitingBefore: 3, CountedBy: 'Dan' }
];
const based = R.compute(T3, { windowDays: 7, today: '2026-09-04', dedupe: true });
// After the walk: 7 waiting at Boxed, then 10 boxed on the 4th -> 0 waiting (3 + 10 finished).
check('rows before the walk are not added on top of the count', [based.pipelines[1].stages[1].waiting, based.pipelines[1].finished], [-3, 13]);
check('the walk is reported', based.baselines, 1);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
