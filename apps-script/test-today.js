/* Exercise getToday()'s daily headline.
 *
 * The bug this pins: the old figure summed quantities across stages, so one
 * chair Cut, Assembled and Boxed in a single day reported "3 total". It counts
 * the same physical unit once per station it passed. The tube lines hid it —
 * different tubes sit at different stages, so the sum looked plausible while
 * being just as wrong — and a chair going end to end in one day exposed it.
 *
 * Run:  node apps-script/test-today.js
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
    { ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Line: 'Chair', Active: 'YES' },
    { ProductID: 'BLANK50', ProductName: '50" Blank', Line: 'Blank', Active: 'YES' }
  ],
  StageLog: [
    // John's actual day: ONE chair, cut then assembled then boxed.
    { WorkDate: '2026-08-13', ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Stage: 'Cut',      Qty: 1 },
    { WorkDate: '2026-08-13', ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Stage: 'Assemble', Qty: 1 },
    { WorkDate: '2026-08-13', ProductID: 'LGC30', ProductName: 'Lifeguard Chair 30"', Stage: 'Box',      Qty: 1 },
    // A cutting-only day: work started, nothing came off the end.
    { WorkDate: '2026-08-13', ProductID: 'BLANK50', ProductName: '50" Blank', Stage: 'Cut', Qty: 48 }
  ]
};
sandbox.readObjects = (tab) => FIX[tab] || [];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}

const day = sandbox.getToday({ workDate: '2026-08-13' });
const chair = day.products.find(p => p.productId === 'LGC30');
const blank = day.products.find(p => p.productId === 'BLANK50');

check('one chair through three stations is ONE chair, not three',
  { started: chair.started, finished: chair.finished }, { started: 1, finished: 1 });

check('the summed "total" is gone entirely, not just relabelled',
  chair.total, undefined);

check('per-stage detail is still reported for the chips',
  chair.rows, [{ stage: 'Cut', qty: 1 }, { stage: 'Assemble', qty: 1 }, { stage: 'Box', qty: 1 }]);

check('a cutting-only day shows work started and nothing finished',
  { started: blank.started, finished: blank.finished }, { started: 48, finished: 0 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
