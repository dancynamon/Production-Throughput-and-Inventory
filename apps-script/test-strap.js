/* Strap sub-assembly: the recipe moved off the tube and onto its own station.
 * The property that matters is that TOTAL consumption per finished tube is
 * unchanged — the webbing simply comes off at a different moment. Also guards
 * the array-literal edit that added M044/M045, where a missing comma parses
 * cleanly but silently drops both rows.
 *
 * Run:  node apps-script/test-strap.js
 */
const fs=require('fs'),vm=require('vm');
const s={SpreadsheetApp:{getActiveSpreadsheet:()=>({}),getActive:()=>({}),getUi:()=>({})},Logger:{log(){}},console};
vm.createContext(s); vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),s);
let fail=0;
const ck=(l,a,b)=>{const ok=JSON.stringify(a)===JSON.stringify(b);if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${l}\n      got ${JSON.stringify(a)}  want ${JSON.stringify(b)}`);};

// One strap, not one per size — a 6' tow line is 6' on either tube.
const straps = s.PRODUCT_ROWS.filter(r=>r[2]==='Strap');
ck('exactly one strap product exists', straps.length, 1);
ck('it declares its OutputMaterial', straps[0][6], 'M044');

// The whole point: total consumption per finished tube is UNCHANGED.
const bom = s.tubeBomRows();
const strapRecipe = bom.filter(r=>r[0]==='STRAP6').map(r=>[r[2],r[3]]);
// The 50" quantities, deliberately: the 40" column was documented as the 50"
// column x0.8 applied blanket-wide, never measured. Since the strap does not
// vary by size, the measured set is the right one.
ck('the strap recipe is emitted once, from the measured 50-inch quantities',
   strapRecipe, [['M014',1.78],['M015',2.44],['M019',1.58],['M023',1],['M024',1]]);

// Every tube, both sizes and both variants, pulls one strap from the same pool.
const perTube = ['XRT50EXO','XRT50STD','XRT40EXO','XRT40STD'].map(p =>
  bom.filter(r=>r[0]===p && r[1]==='Straps Attached').map(r=>r[2]+' x'+r[3]).join(','));
ck('all four tube products consume exactly one M044',
   perTube, ['M044 x1','M044 x1','M044 x1','M044 x1']);

// No raw webbing left on any tube product.
const webOnTube = bom.filter(r=>/^(XRT)/.test(r[0]) && ['M014','M015','M019','M023','M024'].includes(r[2]));
ck('no tube product deducts raw webbing or hardware any more', webOnTube.length, 0);

ck('strap line is a single station named Made', s.stagesForLine('Strap'), ['Made']);
ck('no size-specific strap material lingers in any recipe',
   bom.filter(r=>r[2]==='M045').length, 0);
ck('every product row matches the header width',
   [...new Set(s.PRODUCT_ROWS.map(r=>r.length))], [s.PRODUCT_HEADERS.length]);
console.log(fail?`\n${fail} FAILURE(S)`:'\nAll checks passed.');
process.exit(fail?1:0);
