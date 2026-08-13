/* Headless smoke test of the stage-based phone app. Serves the folder, stubs
 * the Apps Script JSONP endpoint, and drives a day upload + overview.
 * Dev-only. Run: node apps-script/smoketest.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const ROOT = path.join(__dirname, '..');
const FAKE_API = 'https://script.google.com/macros/s/FAKE/exec';
const TYPES = { '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json' };

const server = http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  if (f === '/config.js') { res.setHeader('Content-Type','application/javascript');
    return res.end(`window.AEGIS_CONFIG={API_URL:"${FAKE_API}"};`); }
  const p = path.join(ROOT, f);
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'text/plain');
  res.end(fs.readFileSync(p));
});

const STAGES = ['Cut','Glued','Meshed','Patched','Paint 1','Paint 2','Printed','Straps Attached','Boxed'];

// Shaped exactly like getInventory().materials: one material drifting, one
// never counted and negative from a missing opening baseline, one ordinary.
const INVENTORY = [
  { id:'M014', name:'1" Red PP Webbing', unit:'Yards', category:'Webbing', onHand:100,
    counted:true, reorderPoint:1000, low:true, lastCounted:94, lastCountedAt:'2026-08-10',
    lastVariance:6, lastVariancePct:6, daysSinceCount:3, countsRecorded:2, driftRun:2,
    drifting:true,
    history:[{at:'2026-08-10',estimated:100,counted:94,variance:6,variancePct:6,by:'Dan',notes:''},
             {at:'2026-07-14',estimated:120,counted:110,variance:10,variancePct:8.33,by:'John',notes:''}] },
  { id:'M034', name:'EVA Foam (2# black)', unit:'sheet', category:'Foam', onHand:50,
    counted:true, reorderPoint:10, low:false, lastCounted:50, lastCountedAt:'2026-08-10',
    lastVariance:0, lastVariancePct:0, daysSinceCount:3, countsRecorded:1, driftRun:0,
    drifting:false,
    history:[{at:'2026-08-10',estimated:50,counted:50,variance:0,variancePct:0,by:'Dan',notes:''}] },
  { id:'M038', name:'Boxes 50"', unit:'each', category:'Packaging', onHand:-492,
    counted:true, reorderPoint:50, low:true, lastCounted:null, lastCountedAt:null,
    lastVariance:null, lastVariancePct:null, daysSinceCount:null, countsRecorded:0,
    driftRun:0, drifting:false, history:[] }
];

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 1400 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));

  await page.route(FAKE_API + '**', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action'); const cb = url.searchParams.get('callback');
    let data;
    if (action === 'config') data = { ok:true, lines:{ Tube:STAGES, Shape:['CNC','Clean','Box'] },
      employees:['Maria','James'],
      products:[{id:'XRT50',name:'XRT-50 Rescue Tube',line:'Tube'},{id:'SHP24',name:'Shape 24x24',line:'Shape'}],
      materials:[{id:'M014',name:'1" Red PP Webbing',unit:'Yards'}] };
    else if (action === 'submitDay') data = { ok:true, message:'Logged 202 tube-stages for XRT-50 Rescue Tube on 2026-07-01',
      logged:[{stage:'Cut',qty:112},{stage:'Boxed',qty:40}],
      consumed:[{name:'1" Red PP Webbing',used:89,onHand:7,unit:'Yards'}], warnings:['1" Red PP Webbing is low (7 Yards)'] };
    else if (action === 'overview') data = { ok:true, stages:STAGES, materials:[{id:'M014',name:'1" Red PP Webbing',unit:'Yards',onHand:7,counted:true,reorderPoint:1000,low:true}],
      products:[{productId:'XRT50',name:'XRT-50 Rescue Tube',dailyTarget:60,finished:40,
        stages:STAGES.map((s,i)=>({stage:s,completed:i===0?112:(i===1?90:40),waiting:i===0?null:20,suggest:i===0?60:20,starved:i>0}))}] };
    else if (action === 'receive') data = { ok:true, message:'Received 200 Yards of 1" Red PP Webbing', material:{name:'1" Red PP Webbing',unit:'Yards',onHand:207} };
    else if (action === 'inventory') data = { ok:true, materials:INVENTORY,
      summary:{ materials:3, neverCounted:1, negative:1, low:1, drifting:1,
                lastCountAt:'2026-08-10', lastCountBy:'Dan', daysSinceLastCount:3 } };
    else if (action === 'count') data = { ok:true, message:'Reconciled 1 material.',
      counted:[{id:'M014',name:'1" Red PP Webbing',unit:'Yards',estimated:100,counted:88,variance:12,variancePct:12}],
      unknown:[] };
    else if (action === 'auth') data = { ok: url.searchParams.get('pin') === '2468' };
    else data = { ok:false, error:'bad action' };
    route.fulfill({ contentType:'application/javascript', body:`${cb}(${JSON.stringify(data)});` });
  });

  await page.goto(`http://localhost:${port}/index.html`, { waitUntil:'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#product option').length > 1, { timeout:5000 });
  await page.selectOption('#employee','Maria'); await page.selectOption('#product','XRT50');
  await page.waitForFunction(() => document.querySelectorAll('#stageInputs [data-stage]').length > 0, { timeout:5000 });
  console.log('stage inputs (tube):', (await page.$$('#stageInputs [data-stage]')).length);
  await page.fill('#stageInputs [data-stage="Cut"]','112');
  await page.fill('#stageInputs [data-stage="Boxed"]','40');
  await page.click('#dayBtn');
  await page.waitForSelector('#dayResult .result__ok', { timeout:5000 });
  console.log('DAY:', (await page.textContent('#dayResult')).replace(/\s+/g,' ').trim().slice(0,120));

  // Unlock manager mode to reveal Overview, then check it renders.
  await page.evaluate(() => { window.prompt = () => '2468'; });
  await page.click('#mgrBtn');
  await page.waitForFunction(() => { var t = document.querySelector('.tab[data-screen="overview"]'); return t && getComputedStyle(t).display !== 'none'; }, { timeout:5000 });
  await page.click('.tab[data-screen="overview"]');
  await page.waitForSelector('#screen-overview .ov-card', { timeout:5000 });
  console.log('overview cards:', (await page.$$('#screen-overview .ov-card')).length, '| starved:', (await page.$$('.ov-starved')).length);

  /* ---- Inventory panel --------------------------------------------------- */
  // The live gap is the whole point of this screen, so it is asserted rather
  // than eyeballed: 100 estimated, 88 counted, "12 short" — the word form, in
  // the same direction CountLog files it.
  await page.click('.tab[data-screen="inventory"]');
  await page.waitForSelector('#invRows .inv-row', { timeout:5000 });
  console.log('inventory rows:', (await page.$$('#invRows .inv-row')).length,
              '| stats:', (await page.$$('#invSummary .inv-stat')).length);

  await page.fill('.inv-input[data-mat="M014"]', '88');
  const diff = (await page.textContent('[data-diff="M014"]')).replace(/\s+/g,' ').trim();
  console.log('DIFF:', diff, '| bar:', await page.textContent('#invBarText'));
  if (!/12 short/.test(diff)) { errors.push('live diff did not read "12 short": ' + diff); }
  if (!/12% off/.test(diff)) { errors.push('a 12% gap was not flagged: ' + diff); }

  // "= est" fills the estimate in, so a shelf that agrees is one tap.
  await page.click('[data-same="M034"]');
  const same = await page.inputValue('.inv-input[data-mat="M034"]');
  if (same !== '50') errors.push('"= est" did not fill the estimate: ' + same);

  // A negative material has no estimate worth copying, so it gets no button.
  if ((await page.$$('[data-same="M038"]')).length) errors.push('"= est" offered on a negative estimate');

  // History is per material and collapsed until asked for.
  await page.click('[data-hist="M014"]');
  await page.waitForSelector('[data-histbox="M014"] .inv-hist__t', { state:'visible', timeout:3000 });

  // Filtering must not lose numbers already walked to the shelf to collect.
  await page.click('.inv-chip[data-filter="never"]');
  await page.waitForFunction(() => document.querySelectorAll('#invRows .inv-row').length === 1, { timeout:3000 });
  await page.click('.inv-chip[data-filter="all"]');
  await page.waitForFunction(() => document.querySelectorAll('#invRows .inv-row').length === 3, { timeout:3000 });
  const kept = await page.inputValue('.inv-input[data-mat="M014"]');
  if (kept !== '88') errors.push('a filter round-trip dropped an entered count: ' + kept);

  await page.selectOption('#invEmployee','Maria');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('#invBtn');
  await page.waitForSelector('#invResult .result__ok', { timeout:5000 });
  console.log('COUNT:', (await page.textContent('#invResult')).replace(/\s+/g,' ').trim().slice(0,130));

  await browser.close(); server.close();
  if (errors.length) { console.error('PAGE ERRORS:', errors); process.exit(1); }
  console.log('\nSMOKE TEST PASSED');
})().catch(e => { console.error(e); process.exit(1); });
