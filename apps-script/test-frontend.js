/* Both pages in a real (headless) browser, phone-sized, against a MOCK
 * backend: every request to script.google.com is answered here, so nothing
 * ever reaches the live /exec. 3.05.0.
 *
 * The mock keeps the server's promise (same clientId = logged once), so what
 * is checked is the page: that it sends the same id on every retry, keeps
 * entries it has not been told are safe, and asks for the PIN on top of the
 * screen when a login runs out.
 *
 * Floor mode (390 x 844):
 *   • double-tapped Submit logs once
 *   • a reply lost after the sheet logged it, then no signal: retried with
 *     the same clientId, logged once
 *   • a lock timeout keeps the entry; it goes on the next try
 *   • an HTML error page instead of a reply keeps the entry
 *   • a real refusal is said out loud and leaves the queue
 *   • crew login running out: PIN pad on top, typed number kept, queued entry
 *     sent with the NEW token, nothing lost
 *   • the clock: a resent punch keeps its clientId
 *   • past midnight the strip blanks and the next entry is today's
 *   • no horizontal scroll at 390 px, no JSONP tags left behind, 200 queued
 *     entries render
 * Full app:
 *   • manager unlock running out mid-action: login card, then the SAME
 *     request is sent with the new token, the screen and form stay
 *   • a shipment tapped again after no signal keeps its clientId: once
 *   • a work date left open overnight rolls to today
 *
 * Needs Playwright. Uses a global install (npm i -g playwright) or
 * PLAYWRIGHT=/path/to/node_modules/playwright-core; skips (exit 0) without.
 * Run:  node apps-script/test-frontend.js
 */
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT, 'playwright', 'playwright-core'];
  try { tries.push(path.join(require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright')); } catch (e) { /* no npm */ }
  for (const t of tries.filter(Boolean)) { try { return require(t); } catch (e) { /* next */ } }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log('SKIP  Playwright not installed (npm i -g playwright, or PLAYWRIGHT=<path>).'); process.exit(0); }
function chromePath() {
  try { if (fs.existsSync(pw.chromium.executablePath())) return undefined; } catch (e) { /* look in the cache */ }
  const cache = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      const exe = path.join(cache, d, sub, 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const ROOT = path.join(__dirname, '..');
const FAKE_API = 'https://script.google.com/macros/s/FAKE/exec';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  if (f === '/floor') f = '/floor.html';
  if (f === '/config.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(`window.AEGIS_CONFIG={API_URL:"${FAKE_API}"};`); }
  const p = path.join(ROOT, f);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'text/plain');
  res.end(fs.readFileSync(p));
});

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(50); } return false; }

const SIG = 'b'.repeat(64);
const token = (msFromNow) => (Date.now() + msFromNow) + '.' + SIG;
const LINES = { TubeExo: ['Cut', 'Glued', 'Meshed', 'Patched', 'Paint 1', 'Paint 2', 'Printed', 'Straps Attached', 'Boxed'],
                Blank: ['Cut', 'Glued'], Strap: ['Made'], TubeStd: ['Cut', 'Glued', 'Patched', 'Paint 1', 'Paint 2', 'Printed', 'Straps Attached', 'Boxed'] };
const CONFIG = { ok: true, backendVersion: '3.05.0', employees: ['Ann', 'Bo'], lines: LINES, sellable: ['XRT50EXO'],
  products: [{ id: 'XRT50EXO', name: 'XRT-50 Exotube', line: 'TubeExo', family: 'Tubes' }, { id: 'XRT40EXO', name: 'XRT-40 Exotube', line: 'TubeExo', family: 'Tubes' },
             { id: 'XRT50STD', name: 'XRT-50 Std', line: 'TubeStd', family: 'Tubes' }, { id: 'XRT40STD', name: 'XRT-40 Std', line: 'TubeStd', family: 'Tubes' },
             { id: 'BLANK50', name: 'Blank 50', line: 'Blank', family: 'Blanks' }, { id: 'BLANK40', name: 'Blank 40', line: 'Blank', family: 'Blanks' },
             { id: 'STRAP6', name: 'Strap', line: 'Strap', family: 'Straps' }], materials: [] };
const zero = () => ({ Meshed: 0, Patched: 0, Boxed: 0 });

/* The mock sheet. `plan[action]` may return { abortAfter: true } (logged,
 * reply lost), { abort: true }, { html: true }, or a reply object. */
function mockSheet() {
  const M = { calls: [], logged: {}, plan: {}, today: null };
  M.handle = (q) => {
    const a = q.action; M.calls.push(q);
    const planned = M.plan[a] && M.plan[a](q);
    if (planned && (planned.abort || planned.html)) return planned;
    const record = () => {
      if (!q.clientId) return { ok: true };
      if (M.logged[q.clientId]) return Object.assign({}, M.logged[q.clientId].reply, { replayed: true });
      const reply = { ok: true, message: a + ' ok', duplicates: [], logged: [] };
      M.logged[q.clientId] = { q, reply }; return reply;
    };
    if (planned && planned.abortAfter) { record(); return { abort: true }; }
    if (planned) return planned;
    if (a === 'config') return CONFIG;
    if (a === 'login') return { ok: true, name: q.name, crewToken: token(14 * 86400000) };
    if (a === 'auth') return { ok: true, name: 'Dan', personal: true, token: token(12 * 3600000) };
    if (a === 'floorPace') return { ok: true, today: q.workDate, target: { dailyBoxed: 64, weeklyBoxed: 320, parPerHour: 8 }, par: { today: 10, week: 50 },
      crew: { today: zero(), week: zero(), hoursToday: 2, boxedPerHourToday: 0 }, me: { name: q.employee, today: zero(), week: zero(), hoursToday: 1, clockedIn: true, since: Date.now() - 3600000 } };
    if (a === 'clock') return Object.assign(record(), { clockedIn: q.dir === 'in', since: Date.now(), hoursToday: 1, shiftHours: 1, atShop: true });
    if (['submitDay', 'reverse', 'ship'].includes(a)) return record();
    if (a === 'today') return { ok: true, products: {} };
    return { ok: false, error: 'Unknown action: ' + a };
  };
  M.count = (a) => Object.values(M.logged).filter((x) => x.q.action === a).length;
  M.of = (a) => M.calls.filter((c) => c.action === a);
  return M;
}
async function wire(page, M) {
  await page.route('https://script.google.com/**', async (route) => {
    const u = new URL(route.request().url()); const q = Object.fromEntries(u.searchParams);
    const r = M.handle(q);
    if (r && r.abort) return route.abort('internetdisconnected');
    if (r && r.html) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html><body>Service invoked too many times</body></html>' });
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${q.callback}(${JSON.stringify(r)});` });
  });
}
async function newPage(browser, M, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    geolocation: { latitude: 40, longitude: -74 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  if (opts.time) await page.clock.install({ time: opts.time });
  await wire(page, M);
  if (opts.storage) await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { Object.keys(s).forEach((k) => localStorage.setItem(k, s[k])); sessionStorage.setItem('seeded', '1'); } }, opts.storage);
  page.errors = errors;
  return page;
}
const queueLen = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('aq_floor_queue') || '[]').length);
async function floorLogin(page, base, name = 'Ann') {
  await page.goto(base + '/floor');
  await page.waitForSelector('#flNames button');
  await page.click(`#flNames button:has-text("${name}")`);
  for (const d of '1111') await page.click(`#flPad button[data-k="${d}"]`);
  await page.waitForSelector('#flApp:not([hidden])');
}
const floorStorage = (tok) => ({ aq_floor_epoch: '3.01.2', aq_floor_login: 'Ann', aq_floor_tokens: JSON.stringify({ Ann: tok }) });

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch({ executablePath: chromePath() });
  try {
    /* ---- Floor: double tap -------------------------------------------------- */
    let M = mockSheet(), page = await newPage(browser, M);
    await floorLogin(page, base);
    await page.click('#fl12');
    await page.evaluate(() => { const b = document.getElementById('flSubmit'); b.click(); b.click(); });
    await until(async () => M.count('submitDay') === 1 && (await queueLen(page)) === 0);
    await wait(300);
    check('floor: double-tapped Submit logs ONE entry', [M.count('submitDay'), M.of('submitDay').length], [1, 1]);
    check('floor: and the crew token went with it', M.of('submitDay')[0].crewToken.endsWith(SIG), true);
    check('floor: no horizontal scroll at 390 px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    /* ---- Floor: reply lost after logging, then no signal ------------------------- */
    let lost = 0;
    M.plan.submitDay = () => (lost++ === 0 ? { abortAfter: true } : lost <= 3 ? { abort: true } : null);
    await page.click('#fl12'); await page.click('#flSubmit');
    await until(async () => (await queueLen(page)) === 0, 20000);
    const ids = M.of('submitDay').slice(1).map((c) => c.clientId);
    check('floor: lost reply + no signal: resent until answered', ids.length >= 3, true);
    check('floor: every resend carries the SAME clientId', new Set(ids).size, 1);
    check('floor: logged ONCE', M.count('submitDay'), 2);
    M.plan.submitDay = null;

    /* ---- Floor: lock timeout keeps the entry ---------------------------------------- */
    let busy = 0;
    M.plan.submitDay = () => (busy++ === 0 ? { ok: false, retry: true, error: 'Lock timeout: another process was holding the lock for too long.' } : null);
    await page.click('#fl12'); await page.click('#flSubmit');
    await until(async () => busy >= 1);
    await wait(200);
    check('floor: a lock timeout KEEPS the entry (used to be dropped as refused)', await queueLen(page), 1);
    check('floor: no "Not saved" said for a busy sheet', await page.evaluate(() => /Not saved/.test(document.getElementById('flToastT').textContent)), false);
    await until(async () => (await queueLen(page)) === 0, 10000);
    check('floor: and it goes on the next try', M.count('submitDay'), 3);
    M.plan.submitDay = null;

    /* ---- Floor: an HTML error page keeps the entry ------------------------------------- */
    let pages = 0;
    M.plan.submitDay = () => (pages++ === 0 ? { html: true } : null);
    await page.click('#fl12'); await page.click('#flSubmit');
    await until(async () => pages >= 1); await wait(300);
    check('floor: an error page instead of a reply keeps the entry', await queueLen(page), 1);
    await until(async () => (await queueLen(page)) === 0, 10000);
    check('floor: sent after', M.count('submitDay'), 4);
    M.plan.submitDay = null;

    /* ---- Floor: a real refusal ------------------------------------------------------------ */
    M.plan.submitDay = () => ({ ok: false, error: 'Unknown product: XRT50EXO' });
    await page.click('#fl12'); await page.click('#flSubmit');
    await until(async () => (await queueLen(page)) === 0);
    await until(async () => page.evaluate(() => /Not saved/.test(document.getElementById('flToastT').textContent)));
    check('floor: a refusal is said out loud', await page.evaluate(() => document.getElementById('flToastT').textContent), 'Not saved: 12 Boxed 50". Unknown product: XRT50EXO');
    M.plan.submitDay = null;

    /* ---- Floor: 200 queued, nothing left behind --------------------------------------------- */
    M.plan.submitDay = () => ({ abort: true });
    await page.evaluate(() => { const q = []; for (let i = 0; i < 200; i++) q.push({ action: 'submitDay', workDate: '2026-10-31', employee: 'Ann', productId: 'XRT50EXO', counts: '{"Boxed":1}', clientId: 'bulk-' + i, _label: '1 Boxed' }); localStorage.setItem('aq_floor_queue', JSON.stringify(q)); });
    await page.reload(); await page.waitForSelector('#flApp:not([hidden])'); await wait(3500);
    check('floor: 200 entries on the phone, all kept with no signal', await queueLen(page), 200);
    check('floor: the banner says so', await page.evaluate(() => document.getElementById('flQueue').textContent), '200 saved on this phone. Sends itself when there is signal.');
    check('floor: no JSONP <script> tags left in the page', await page.evaluate(() => document.querySelectorAll('script[src*="script.google"]').length), 0);
    M.plan.submitDay = null;
    await until(async () => (await queueLen(page)) === 0, 30000);
    check('floor: all 200 go when signal is back', M.count('submitDay'), 204);
    // "Unexpected token '<'" is the simulated HTML error page above, loaded as a script: expected.
    check('floor: no page errors', page.errors.filter((e) => !/Unexpected token '<'/.test(e)), []);
    await page.context().close();

    /* ---- Floor: crew login ran out, reactive ------------------------------------------------- */
    M = mockSheet(); page = await newPage(browser, M, { storage: floorStorage(token(14 * 86400000)) });
    let expired = true;
    M.plan.submitDay = (q) => (expired && !q.crewToken.startsWith(String(M.freshPrefix || 'x')) ? { ok: false, locked: true, needLogin: true, error: 'Log in again: reload this page and enter your PIN.' } : null);
    M.plan.login = (q) => { const t = token(14 * 86400000); M.freshPrefix = t.slice(0, 13); return { ok: true, name: q.name, crewToken: t }; };
    await page.goto(base + '/floor'); await page.waitForSelector('#flApp:not([hidden])');
    await page.click('#fl12'); await page.click('#flSubmit');
    await page.waitForSelector('#flPin:not([hidden])');
    check('floor: login ran out -> PIN pad on top of the screen', [await page.evaluate(() => document.getElementById('flPinTitle').textContent), await page.isVisible('#flApp')], ['Ann: your login ran out. Enter your PIN', true]);
    check('floor: the entry is still on the phone', await queueLen(page), 1);
    await page.fill('#flQty', '7');
    for (const d of '1111') await page.click(`#flPad button[data-k="${d}"]`);
    await until(async () => (await queueLen(page)) === 0);
    check('floor: after the PIN it is sent with the NEW token, once', [M.count('submitDay'), M.of('submitDay').slice(-1)[0].crewToken.slice(0, 13) === M.freshPrefix], [1, true]);
    check('floor: the number typed meanwhile is still there', await page.inputValue('#flQty'), '7');
    check('floor: same person, same screen (no name list)', [await page.isVisible('#flPick'), await page.textContent('#flWho')], [false, 'Ann']);
    await page.context().close();

    /* ---- Floor: crew login ran out, caught before typing --------------------------------------- */
    M = mockSheet(); page = await newPage(browser, M, { storage: floorStorage(token(-1000)) });
    await page.goto(base + '/floor'); await page.waitForSelector('#flApp:not([hidden])');
    await page.waitForSelector('#flPin:not([hidden])');
    check('floor: an expired token asks for the PIN on open, before anything is typed', await page.textContent('#flPinTitle'), 'Ann: your login ran out. Enter your PIN');
    await page.context().close();

    /* ---- Floor: clock punch resent keeps its id ------------------------------------------------- */
    M = mockSheet(); page = await newPage(browser, M, { storage: floorStorage(token(86400000)) });
    let punches = 0;
    M.plan.clock = () => (punches++ < 2 ? { abort: true } : null);
    await page.goto(base + '/floor'); await page.waitForSelector('#flClock:not([disabled])');
    await page.click('#flClock');
    for (const d of '1111') await page.click(`#flPad button[data-k="${d}"]`);
    await until(async () => punches >= 2); await page.waitForSelector('#flPinMsg.bad');
    for (const d of '1111') await page.click(`#flPad button[data-k="${d}"]`);
    await page.waitForSelector('#flPin[hidden]', { state: 'attached' });
    const cids = M.of('clock').map((c) => c.clientId);
    check('floor: a punch typed again after no signal keeps ONE clientId', [cids.length, new Set(cids).size], [3, 1]);
    await page.context().close();

    /* ---- Floor: midnight ------------------------------------------------------------------------ */
    M = mockSheet();
    page = await newPage(browser, M, { time: new Date(2026, 9, 31, 23, 59, 0), storage: floorStorage(token(14 * 86400000)) });
    await page.goto(base + '/floor'); await page.waitForSelector('#flApp:not([hidden])');
    await until(async () => (await page.textContent('#dayS')).startsWith('par now'));
    M.plan.floorPace = () => ({ abort: true });      // and no signal just after midnight
    await page.clock.fastForward('02:00');
    await until(async () => (await page.textContent('#dayS')) === 'New day. Loading...');
    check('floor: past midnight, no signal: yesterday\'s numbers are blanked', [await page.textContent('#dayS'), await page.textContent('#dayV')], ['New day. Loading...', '-']);
    M.plan.floorPace = null;
    await page.click('#fl12'); await page.click('#flSubmit');
    await until(async () => M.count('submitDay') === 1);
    check('floor: the next entry is logged on the new day', M.of('submitDay')[0].workDate, '2026-11-01');
    await page.context().close();

    /* ---- Full app: unlock ran out mid-action ------------------------------------------------------ */
    M = mockSheet();
    const mgr = { aq_login_epoch: '3.01.2', aq_role: 'mgr', aq_mgr_name: 'Dan', aq_mgr_token: token(3600000) };
    page = await newPage(browser, M, { storage: mgr });
    await page.goto(base + '/?full=1');
    await page.waitForSelector('#lockedCard[hidden]', { state: 'attached' });
    await until(async () => M.of('config').length > 0); await wait(300);
    // The ship form is off the bar since 3.01.1; open it directly to drive a typed write.
    await page.evaluate(() => { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('screen--active')); document.getElementById('screen-ship').classList.add('screen--active'); });
    await page.selectOption('#shipEmployee', 'Ann'); await page.selectOption('#shipProduct', 'XRT50EXO');
    await page.fill('#shipQty', '4'); await page.selectOption('#shipChannel', 'Shopify'); await page.fill('#shipRef', '#6107');
    let stale = true;
    M.plan.ship = (q) => (stale ? (stale = false, { ok: false, locked: true, error: 'Manager PIN needed. Tap the lock and unlock again.' }) : null);
    await page.click('#shipBtn');
    await page.waitForSelector('#lockedCard:not([hidden])');
    check('full app: the unlock ran out -> login card, nothing recorded yet', M.count('ship'), 0);
    await page.fill('#loginPin', '2468'); await page.click('#loginBtn');
    await until(async () => M.count('ship') === 1);
    await page.waitForSelector('#shipResult:not([hidden])');
    const ships = M.of('ship');
    check('full app: after the PIN the SAME shipment is sent again, with the new token', [ships.length, ships[0].clientId === ships[1].clientId, ships[1].token !== ships[0].token], [2, true, true]);
    check('full app: back on the same screen with the answer', [await page.evaluate(() => document.querySelector('.screen--active').id), (await page.textContent('#shipResult')).includes('ship ok')], ['screen-ship', true]);

    /* ---- Full app: expiration dates (3.06.0) --------------------------------------------------------- */
    M.plan.receiving = () => ({ ok: true, total: 1, deliveries: [{ at: '2024-12-01', by: 'John C', id: 'M011', name: 'Cliqflow', qty: 6, notes: '', expires: '2026-12-01', onShelf: true }] });
    M.plan.receive = () => ({ ok: true, message: 'Dated 6 lb of Cliqflow, expires 2026-12-01', warnings: ['Count it'], material: { id: 'M011', name: 'Cliqflow', unit: 'lb', onHand: 6 } });
    check('full app: Receive is on the bar', await page.isVisible('.tab[data-screen="receive"]'), true);
    await page.click('.tab[data-screen="receive"]');
    await until(async () => (await page.textContent('#rcvList')).includes('Cliqflow'));
    check('receive: received date starts on today', await page.inputValue('#recvOn'), await page.evaluate(() => NetCore.localIso()));
    check('receive: a dated lot on the shelf reads as that, with no plus sign',
      [(await page.textContent('#rcvList')).includes('expires 2026-12-01'), (await page.textContent('.rcv-row__qty')).trim()], [true, 'on shelf 6']);
    await page.evaluate(() => { const s = document.getElementById('recvMaterial'); s.add(new Option('Cliqflow', 'M011')); s.value = 'M011'; });
    await page.selectOption('#recvEmployee', 'Ann'); await page.fill('#recvQty', '6'); await page.fill('#recvOn', '2024-12-01');
    await page.check('#recvOnShelf');
    await page.click('#recvBtn'); await wait(100);
    check('receive: on the shelf with no expiration is stopped before it is sent', M.count('receive'), 0);
    await page.fill('#recvExpires', '2026-12-01');
    check('receive: the form fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.click('#recvBtn');
    await page.waitForSelector('#recvResult:not([hidden])');
    const sent = M.of('receive')[0];
    check('receive: both dates and the shelf flag are sent', [sent.receivedOn, sent.expiresOn, sent.onShelf, sent.qty], ['2024-12-01', '2026-12-01', '1', '6']);
    check('receive: the warning shows and the form resets to today',
      [(await page.textContent('#recvResult')).includes('Count it'), await page.isChecked('#recvOnShelf'), await page.inputValue('#recvExpires'), await page.inputValue('#recvOn')],
      [true, false, '', await page.evaluate(() => NetCore.localIso())]);
    M.plan.inventory = () => ({ ok: true, countNext: [], summary: { materials: 2, neverCounted: 0, negative: 0, stocktake: 0, low: 1, expiring: 1, drifting: 0, stale30: 0, lastCountAt: null },
      materials: [
        { id: 'M011', name: 'Cliqflow', unit: 'lb', onHand: 10, counted: true, reorderPoint: 2, low: true, goodStock: 1, usable: 8, expiredQty: 2, pastHalfQty: 7, nextExpires: '2026-12-01', lots: [{ expires: '2026-12-01' }], history: [], countsRecorded: 0, lastCountedAt: '2026-11-01', daysSinceCount: 4, lastVariance: null },
        { id: 'M012', name: 'Webbing', unit: 'yd', onHand: 30, counted: true, reorderPoint: 2, low: false, goodStock: 30, usable: 30, expiredQty: 0, pastHalfQty: 0, nextExpires: '', lots: [], history: [], countsRecorded: 0, lastCountedAt: '2026-11-01', daysSinceCount: 4, lastVariance: null }
      ] });
    await page.click('.tab[data-screen="inventory"]');
    await page.waitForSelector('[data-row="M011"]');
    const dated = await page.textContent('[data-row="M011"]');
    check('inventory: a dated material shows good stock, expired and past halfway',
      [dated.includes('1 good'), dated.includes('next expires 2026-12-01'), dated.includes('2 expired'), dated.includes('7 past halfway')], [true, true, true, true]);
    check('inventory: an undated material shows none of it', (await page.textContent('[data-row="M012"]')).includes('good'), false);
    await page.click('#invFilters [data-filter="expiring"]');
    check('inventory: the Expiring filter keeps only dated trouble', [await page.isVisible('[data-row="M011"]'), await page.locator('[data-row="M012"]').count()], [true, 0]);
    await page.click('#invFilters [data-filter="all"]');
    await page.evaluate(() => { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('screen--active')); document.getElementById('screen-ship').classList.add('screen--active'); });
    // A delivery reloads config, which refills the pickers, so the next block picks again.
    await page.selectOption('#shipEmployee', 'Ann'); await page.selectOption('#shipProduct', 'XRT50EXO'); await page.selectOption('#shipChannel', 'Shopify');

    /* ---- Full app: ship tapped again after no signal ------------------------------------------------- */
    M.plan.ship = () => ({ abort: true });
    await page.fill('#shipQty', '3');
    await page.click('#shipBtn');
    await until(async () => (await page.textContent('#shipResult')).includes('will not be recorded twice'));
    M.plan.ship = null;
    await page.click('#shipBtn');
    await until(async () => M.count('ship') === 2);
    const last = M.of('ship').slice(-3).map((c) => c.clientId);
    check('full app: a shipment tapped again after no signal keeps its clientId, recorded once', [new Set(last).size, M.count('ship')], [1, 2]);
    check('full app: no page errors', page.errors, []);
    check('full app: no horizontal scroll at 390 px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.context().close();

    /* ---- Full app: unlock ran out while the phone was away --------------------------------------------- */
    M = mockSheet();
    page = await newPage(browser, M, { storage: Object.assign({}, mgr, { aq_mgr_token: token(1500) }) });
    await page.goto(base + '/?full=1'); await page.waitForSelector('#lockedCard[hidden]', { state: 'attached' });
    await wait(1700);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    check('full app: coming back after the 12 h ran out asks for the PIN first', await page.isVisible('#lockedCard'), true);
    await page.context().close();

    /* ---- Full app: review and build POs (3.10.0) ------------------------------------------------------- */
    M = mockSheet();
    const poList = { ok: true, connected: true, built: {}, noBasis: [], suppliers: [
      { supplier: 'Fiber Dynamics', due: 1, lines: [{ id: 'M002', name: 'Nylon Mesh', unit: 'Boxes', goodStock: 13, full: 40, topUp: 27, due: true }, { id: 'M014', name: 'Red <webbing>', unit: 'Yards', goodStock: 3700, full: 4000, topUp: 300, due: false }] },
      { supplier: '(no supplier)', due: 0, lines: [{ id: 'M098', name: 'Loose', unit: 'ea', goodStock: 0, full: 1, topUp: 1, due: false }] }] };
    M.plan.reorder = () => ({ ok: true, items: [{ id: 'M002', name: 'Nylon Mesh', unit: 'Boxes', onHand: 13, suggestedQty: 27, supplier: 'Fiber Dynamics', reason: 'low' }] });
    M.plan.poReview = () => poList;
    let dupAsked = false;
    M.plan.buildPO = (q) => (q.allowDup === '1' || !dupAsked ? (dupAsked = true, q.allowDup === '1'
      ? { ok: true, docNumber: '8704', vendor: 'FIBER DYNAMICS', lines: 1, total: 121.5, url: 'https://qbo.intuit.com/app/purchaseorder?txnId=900', noCost: ['Nylon Mesh'] }
      : { ok: false, already: [{ name: 'Nylon Mesh', doc: '8703' }], error: 'x' }) : { ok: false, error: 'x' });
    page = await newPage(browser, M, { storage: Object.assign({}, mgr, { aq_mgr_token: token(3600000) }) });
    await page.goto(base + '/?full=1'); await page.waitForSelector('#reorderReview');
    await page.click('#reorderReview'); await page.waitForSelector('[data-po-build="0"]');
    check('POs: the list shows each supplier with editable quantities', [await page.inputValue('[data-po-id="M002"]'), await page.inputValue('[data-po-id="M014"]')], ['27', '300']);
    check('POs: a name is shown as text, not markup', (await page.textContent('#poReview')).includes('Red <webbing>'), true);
    check('POs: no supplier, no button', await page.locator('[data-po-build="1"]').count(), 0);
    await page.fill('[data-po-id="M014"]', '0');
    let dialog = '';
    page.once('dialog', (d) => { dialog = d.message(); d.accept(); });
    await page.click('[data-po-build="0"]');
    await until(async () => (await page.textContent('#poNote0')).includes('8704'));
    const poSent = M.of('buildPO');
    check('POs: a line set to 0 is left off', JSON.parse(poSent[0].lines), [{ id: 'M002', qty: 27 }]);
    check('POs: already on an open PO asks, then goes on with the same id', [/PO 8703/.test(dialog), poSent.length, poSent[1].allowDup, poSent[0].clientId === poSent[1].clientId], [true, 2, '1', true]);
    const poWords = await page.textContent('#poNote0');
    check('POs: says built, not sent, and links it', [poWords.includes('Not sent'), await page.getAttribute('#poNote0 a', 'href')], [true, 'https://qbo.intuit.com/app/purchaseorder?txnId=900']);
    check('POs: says what went in at $0', poWords.includes('entered at $0: Nylon Mesh'), true);
    check('POs: no page errors, no sideways scroll at 390 px', [page.errors, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)], [[], true]);
    await page.screenshot({ path: process.env.PO_SHOT || '/dev/null', type: 'png' }).catch(() => {});
    await page.click('[data-po-close]');
    check('POs: Close hides the list', await page.isVisible('#poReview'), false);
    await page.context().close();

    /* ---- Full app: overnight work date --------------------------------------------------------------- */
    M = mockSheet();
    page = await newPage(browser, M, { time: new Date(2026, 9, 31, 23, 59, 30), storage: Object.assign({}, mgr, { aq_mgr_token: token(30 * 86400000) }) });
    await page.goto(base + '/?full=1'); await page.waitForSelector('#lockedCard[hidden]', { state: 'attached' });
    check('full app: work date is today', await page.inputValue('#workDate'), '2026-10-31');
    await page.clock.fastForward('01:05');
    await until(async () => (await page.inputValue('#workDate')) === '2026-11-01');
    check('full app: left open past midnight, it rolls to the new day', await page.inputValue('#workDate'), '2026-11-01');
    await page.context().close();
  } finally {
    await browser.close(); server.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
