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

// Shaped like computePurchasing(): one short, one uncounted, one covered, one idle.
const PURCHASING = [
  { id:'M033', name:'Rescue Tube Custom Boxes', unit:'Boxes', category:'Packaging',
    onHand:0, counted:true, reorderPoint:20, lastCountedAt:null, committed:30, after:-30,
    sources:[{productId:'XRT50EXO',name:'XRT-50 Exotube',stage:'Boxed',units:151,need:30}] },
  { id:'M044', name:"Shoulder Strap w/ 6' Tow Line", unit:'each', category:'Sub-assembly',
    onHand:0, counted:false, reorderPoint:50, lastCountedAt:null, committed:30, after:-30,
    sources:[{productId:'XRT50EXO',name:'XRT-50 Exotube',stage:'Straps Attached',units:30,need:30}] },
  { id:'M002', name:'Nylon Mesh', unit:'Boxes', category:'Glue & Mesh',
    onHand:11.65, counted:true, reorderPoint:2, lastCountedAt:null, committed:0.5, after:11.15,
    sources:[{productId:'XRT50EXO',name:'XRT-50 Exotube',stage:'Meshed',units:125,need:0.5}] },
  { id:'M029', name:'Brass Buckle', unit:'Each', category:'Webbing & Thread',
    onHand:80, counted:true, reorderPoint:40, lastCountedAt:'2026-08-10', committed:0, after:80, sources:[] }
];
const PER_UNIT = { XRT50EXO:{ M033:0.0833, M044:1, M002:0.004 }, LGC30:{ M043:1 } };

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
    if (action === 'config') data = { ok:true, pinIsDefault:true, lines:{ Tube:STAGES, Shape:['CNC','Clean','Box'] },
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
    else if (action === 'receiving') data = { ok:true, total:2, deliveries:[
      { at:'2026-09-10', by:'John', id:'M034', name:'EVA Foam (2# black)', qty:20, notes:'' },
      { at:'2026-09-02', by:'Dan',  id:'M014', name:'1" Red PP Webbing',   qty:200, notes:'PO 118' } ] };
    else if (action === 'crew') data = { ok:true, days:30, since:'2026-08-15', crew:[
      { name:'Joe', entries:2, units:160, hours:5, daysWorked:2, unitsPerHour:20, hoursCoverage:62.5,
        stages:[{ productId:'STRAP6', product:'Strap', stage:'Made', units:160, hours:5, unitsPerHour:20 }] },
      { name:'Alex', entries:1, units:300, hours:0, daysWorked:1, unitsPerHour:null, hoursCoverage:0,
        stages:[{ productId:'KB1220', product:'Kickboard', stage:'CNC', units:300, hours:0, unitsPerHour:null }] } ] };
    else if (action === 'export') data = { ok:true, table:'stagelog', tab:'StageLog',
      headers:['Timestamp','WorkDate','Employee','ProductName','Qty','Notes'],
      rows:[['2026-09-13T12:00:00.000Z','2026-09-13','Dan','1" Red PP Webbing',3,'note, with comma'],
            ['2026-09-14T12:00:00.000Z','2026-09-14','Joe','Chair 30"',1,'']] };
    else if (action === 'capacity') data = { ok:true, familyOrder:['Lifeguard Chairs'],
      coverage:{ stageLogRows:19, rowsWithHours:1 },
      products:[{ id:'LGC30', name:'Lifeguard Chair 30"', family:'Lifeguard Chairs', feedsFrom:null,
        baselineAt:null, finished:0, lineRate:6,
        bottleneck:{ stage:'Assemble', unitsPerDay:6, unitsPerHour:null, daysObserved:2 },
        wipInLine:40, aheadOfBottleneck:28, ratedStages:2, totalStages:3, confidence:'partial',
        buildable:10, constraint:{ name:'Chair Hardware Kit' }, negative:[], uncounted:[],
        stages:[
          { stage:'Cut', completed:40, waiting:null, unitsPerHour:5, unitsPerDay:20, daysObserved:2, daysToClear:null, isBottleneck:false },
          { stage:'Assemble', completed:12, waiting:28, unitsPerHour:null, unitsPerDay:6, daysObserved:2, daysToClear:4.67, isBottleneck:true },
          { stage:'Box', completed:0, waiting:12, unitsPerHour:null, unitsPerDay:null, daysObserved:0, daysToClear:null, isBottleneck:false }
        ] }] };
    else if (action === 'summary') data = { ok:true, generatedAt:'2026-08-23',
      production:{ windowDays:7, since:'2026-08-17', started:150, finished:2, events:6,
        activeDays:2, hours:5,
        days:[{date:'2026-08-19',started:100,finished:0,events:4},
              {date:'2026-08-23',started:50,finished:2,events:2}],
        products:[{id:'BLANK50',name:'50" Blank',family:'Rescue Tubes',started:150,finished:60}] },
      pipeline:{ wipTotal:437, biggest:{productId:'XRT50EXO',name:'XRT-50 Exotube',stage:'Boxed',units:151},
        starvedStages:8, productsTracked:21, productsWithoutBaseline:['50" Blank','XRT-50 Exotube'] },
      inventory:{ materials:44, neverCounted:12, negative:12, low:14, drifting:0,
        lastCountAt:null, daysSinceLastCount:null },
      buying:{ short:3, biggest:{id:'M038',name:'4# 1.5" Foam',unit:'sq ft',short:492},
        pools:[{feeder:'BLANK50',units:70}] },
      trust:{ stageLogRows:19, rowsWithHours:1, productsTracked:21, productsWithBaseline:0,
        materialsTotal:44, materialsCounted:0 } };
    else if (action === 'purchasing') data = { ok:true, materials:PURCHASING, perUnit:PER_UNIT,
      pools:[{feeder:'BLANK50',units:70}],
      products:[{id:'XRT50EXO',name:'XRT-50 Exotube',family:'Rescue Tubes'},
                {id:'LGC30',name:'Lifeguard Chair 30"',family:'Lifeguard Chairs'}],
      familyOrder:['Rescue Tubes','Lifeguard Chairs'] };
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

  /* ---- Capacity + promise ------------------------------------------------- */
  await page.click('.tab[data-screen="capacity"]');
  await page.waitForSelector('#capBody .ov-card', { timeout:5000 });
  // The stage name is the cell's first text node; the bottleneck pill that
  // follows it is a separate element, so read the node rather than splitting.
  const bn = await page.$$eval('.cap-bn td:first-child', (t) => t.map((x) => x.firstChild.textContent.trim()));
  if (JSON.stringify(bn) !== '["Assemble"]') errors.push('bottleneck row wrong: ' + JSON.stringify(bn));
  await page.selectOption('#promProduct', 'LGC30');
  await page.fill('#promQty', '20');
  const prom = (await page.textContent('#promOut')).replace(/\s+/g,' ');
  // (28 ahead + 20 new) / 6 per day = 8 working days.
  if (!/8 working days/.test(prom)) errors.push('promise arithmetic wrong: ' + prom);
  // 20 asked, 10 buildable: the material warning must fire.
  if (!/Only 10 buildable/.test(prom)) errors.push('material limit not flagged: ' + prom);
  console.log('PROMISE:', prom.slice(0, 120));
  // The PIN nag shows to a manager while the default is in force.
  if (await page.$eval('#pinBanner', (b) => b.hidden)) errors.push('PIN banner hidden while default PIN in force');

  /* ---- Crew (on the capacity tab) ----------------------------------------- */
  await page.waitForSelector('#crewBody .crew-card', { timeout:5000 });
  const crewTxt = (await page.textContent('#crewBody')).replace(/\s+/g,' ');
  if (!/Joe.*20\/hr.*62\.5%/.test(crewTxt)) errors.push('crew rate/coverage missing: ' + crewTxt.slice(0,160));
  if (!/Alex.*no hours logged/.test(crewTxt)) errors.push('no-hours person not marked honestly');

  /* ---- Deliveries (on the receive tab) ------------------------------------ */
  await page.click('.tab[data-screen="receive"]');
  await page.waitForSelector('#rcvList .rcv-row', { timeout:5000 });
  const rcvRows = await page.$$eval('#rcvList .rcv-row .rcv-row__at', (t) => t.map((x) => x.textContent));
  if (JSON.stringify(rcvRows) !== '["2026-09-10","2026-09-02"]') errors.push('deliveries order: ' + JSON.stringify(rcvRows));

  /* ---- Export: an actual file download with correct quoting ----------------- */
  await page.click('.tab[data-screen="summary"]');
  await page.waitForSelector('[data-export="stagelog"]', { timeout:5000 });
  const [dl] = await Promise.all([ page.waitForEvent('download', { timeout:8000 }), page.click('[data-export="stagelog"]') ]);
  const csvPath = await dl.path();
  const csv = fs.readFileSync(csvPath, 'utf8');
  console.log('EXPORT:', dl.suggestedFilename(), csv.length + ' bytes');
  if (!/^aquamentor-stagelog-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename())) errors.push('export filename: ' + dl.suggestedFilename());
  // The inch mark and the comma are the two things that break a naive CSV.
  if (!csv.includes('"1"" Red PP Webbing"')) errors.push('inch-mark field not quoted/doubled');
  if (!csv.includes('"note, with comma"')) errors.push('comma field not quoted');
  if (!csv.startsWith('\ufeffTimestamp,WorkDate')) errors.push('missing BOM or header row');
  if (csv.split('\r\n').length !== 4) errors.push('row count wrong: ' + csv.split('\r\n').length);

  /* ---- Summary ----------------------------------------------------------- */
  await page.click('.tab[data-screen="summary"]');
  await page.waitForSelector('#sumBody .sum-card', { timeout:5000 });
  const cards = await page.$$eval('.sum-card__h', (h) => h.map((x) => x.firstChild.textContent.trim()));
  console.log('summary cards:', JSON.stringify(cards));
  const sumTxt = (await page.textContent('#sumBody')).replace(/\s+/g,' ');
  // The headline pair has to be entered-vs-finished, not a sum of stages.
  // textContent puts no space between adjacent elements, so the number and its
  // label arrive glued together — match on that rather than on rendered layout.
  if (!/150\s*entered the shop/.test(sumTxt)) errors.push('entered figure missing: ' + sumTxt.slice(0,200));
  if (!/2\s*finished goods/.test(sumTxt)) errors.push('finished figure missing');
  // Seven bars, two per day.
  const bars = await page.$$('.spark__col');
  if (bars.length !== 2) errors.push('expected one column per logged day, got ' + bars.length);
  // The trust block must state what is missing, not hide it.
  if (!/0 \/ 44/.test(sumTxt)) errors.push('trust block did not report uncounted materials');
  if (!/0 \/ 21/.test(sumTxt)) errors.push('trust block did not report missing baselines');

  /* ---- Buy panel --------------------------------------------------------- */
  await page.click('.tab[data-screen="buy"]');
  await page.waitForSelector('#buyRows .buy-row', { timeout:5000 });
  const order = await page.$$eval('.buy-sec', (secs) =>
    secs.map((s) => s.querySelector('.buy-sec__h').textContent.trim().split(' ').slice(0,2).join(' ')));
  console.log('buy sections:', JSON.stringify(order));

  // Shortest first — the buy list has to lead with what stops the line.
  const firstShort = await page.textContent('.buy-sec .buy-row .buy-row__name');
  if (!/Custom Boxes/.test(firstShort)) errors.push('buy list did not lead with the shortfall: ' + firstShort);

  // A material nobody ever counted cannot be called short.
  const strapRow = await page.textContent('#buyRows .buy-row:has-text("Shoulder Strap")');
  if (!/never counted/.test(strapRow)) errors.push('uncounted material was given a shortfall: ' + strapRow);

  // Planning 100 more tubes must move the numbers without a round trip.
  const before = await page.textContent('.buy-sec .buy-row .buy-row__v');
  await page.fill('[data-plan="XRT50EXO"]', '100');
  const after = await page.textContent('.buy-sec .buy-row .buy-row__v');
  console.log('boxes shortfall — committed only:', before.replace(/\s+/g,' ').trim(),
              '| plus 100 planned:', after.replace(/\s+/g,' ').trim());
  if (before === after) errors.push('planned build did not change the shortfall');

  // The uncommitted blank pool is stated, not silently folded into a variant.
  const pool = await page.textContent('#buyPools');
  if (!/70/.test(pool) || !/not yet committed/.test(pool)) errors.push('pool not surfaced: ' + pool);

  await browser.close(); server.close();
  if (errors.length) { console.error('PAGE ERRORS:', errors); process.exit(1); }
  console.log('\nSMOKE TEST PASSED');
})().catch(e => { console.error(e); process.exit(1); });
