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
    if (action === 'config') data = { ok:true, stages:STAGES, employees:['Maria','James'],
      products:[{id:'XRT50',name:'XRT-50 Rescue Tube'},{id:'XRT40',name:'XRT-40 Rescue Tube'}],
      materials:[{id:'M014',name:'1" Red PP Webbing',unit:'Yards'}] };
    else if (action === 'submitDay') data = { ok:true, message:'Logged 202 tube-stages for XRT-50 Rescue Tube on 2026-07-01',
      logged:[{stage:'Cut',qty:112},{stage:'Boxed',qty:40}],
      consumed:[{name:'1" Red PP Webbing',used:89,onHand:7,unit:'Yards'}], warnings:['1" Red PP Webbing is low (7 Yards)'] };
    else if (action === 'overview') data = { ok:true, stages:STAGES, materials:[{id:'M014',name:'1" Red PP Webbing',unit:'Yards',onHand:7,counted:true,reorderPoint:1000,low:true}],
      products:[{productId:'XRT50',name:'XRT-50 Rescue Tube',dailyTarget:60,finished:40,
        stages:STAGES.map((s,i)=>({stage:s,completed:i===0?112:(i===1?90:40),waiting:i===0?null:20,suggest:i===0?60:20,starved:i>0}))}] };
    else if (action === 'receive') data = { ok:true, message:'Received 200 Yards of 1" Red PP Webbing', material:{name:'1" Red PP Webbing',unit:'Yards',onHand:207} };
    else data = { ok:false, error:'bad action' };
    route.fulfill({ contentType:'application/javascript', body:`${cb}(${JSON.stringify(data)});` });
  });

  await page.goto(`http://localhost:${port}/index.html`, { waitUntil:'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#stageInputs [data-stage]').length > 0, { timeout:5000 });
  console.log('stage inputs:', (await page.$$('#stageInputs [data-stage]')).length);

  await page.selectOption('#employee','Maria'); await page.selectOption('#product','XRT50');
  await page.fill('#stageInputs [data-stage="Cut"]','112');
  await page.fill('#stageInputs [data-stage="Boxed"]','40');
  await page.click('#dayBtn');
  await page.waitForSelector('#dayResult .result__ok', { timeout:5000 });
  console.log('DAY:', (await page.textContent('#dayResult')).replace(/\s+/g,' ').trim().slice(0,120));

  await page.click('.tab[data-screen="overview"]');
  await page.waitForSelector('.ov-card', { timeout:5000 });
  console.log('overview cards:', (await page.$$('.ov-card')).length, '| starved:', (await page.$$('.ov-starved')).length);

  await browser.close(); server.close();
  if (errors.length) { console.error('PAGE ERRORS:', errors); process.exit(1); }
  console.log('\nSMOKE TEST PASSED');
})().catch(e => { console.error(e); process.exit(1); });
