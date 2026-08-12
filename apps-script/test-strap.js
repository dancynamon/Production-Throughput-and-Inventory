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

// Both strap materials survived the array-literal edit.
const mats = s.PRODUCT_ROWS.filter(r=>r[2]==='Strap').map(r=>r[6]);
ck('both strap products declare an OutputMaterial', mats, ['M044','M045']);

// The whole point: total consumption per finished tube is UNCHANGED.
const bom = s.tubeBomRows();
const strapRecipe = bom.filter(r=>r[0]==='STRAP50').map(r=>[r[2],r[3]]);
ck('the strap carries exactly what the tube used to consume at Straps Attached',
   strapRecipe, [['M014',1.78],['M015',2.44],['M019',1.58],['M023',1],['M024',1]]);

const tubeStraps = bom.filter(r=>r[0]==='XRT50EXO'&&r[1]==='Straps Attached');
ck('the tube now consumes one finished strap instead of raw webbing',
   tubeStraps.map(r=>[r[2],r[3]]), [['M044',1]]);

// No raw webbing left on any tube product.
const webOnTube = bom.filter(r=>/^(XRT)/.test(r[0]) && ['M014','M015','M019','M023','M024'].includes(r[2]));
ck('no tube product deducts raw webbing or hardware any more', webOnTube.length, 0);

ck('strap line is a single station named Made', s.stagesForLine('Strap'), ['Made']);
ck('every product row matches the header width',
   [...new Set(s.PRODUCT_ROWS.map(r=>r.length))], [s.PRODUCT_HEADERS.length]);
console.log(fail?`\n${fail} FAILURE(S)`:'\nAll checks passed.');
process.exit(fail?1:0);
