/* net-core.js: the network layer both pages use (3.05.0). Pure Node, a fake
 * document whose <script> tags answer the way Apps Script and a shop-floor
 * Wi-Fi do.
 *
 * Pinned:
 *   • a reply resolves; a late reply after the timeout is swallowed, not a
 *     "callback is not defined" error in the page
 *   • no signal: one quiet retry, then a rejection marked transient
 *   • an HTML error page (loaded, never called back) rejects at once, transient
 *   • transient() tells "not now" (retry: true, lock timeout text, a
 *     rejection) from "no" (a refusal) and from a login that ran out
 *   • drainQueue: oldest first; ok/replayed leave; a refusal leaves and is
 *     reported; "not now" keeps everything; a login that ran out holds that
 *     person's entries (an undo never overtakes its entry) and lets everyone
 *     else's through
 *   • stableIds: the same form sent again keeps its clientId; a change or a
 *     success gets a new one
 *   • tokenExpiry reads "<ms>.<sig>"; old or missing tokens are "can't tell"
 *
 * Run:  node apps-script/test-net.js
 */
const N = require('../net-core.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

/* A document whose scripts behave per `mode(url)`:
 *   'reply'  -> calls the callback with `reply`
 *   'late'   -> calls it after `lateMs`
 *   'html'   -> loads (onload) and never calls back
 *   'down'   -> onerror */
function fakeWorld(mode, reply, lateMs) {
  const win = {}, sent = [], errors = [];
  const doc = {
    createElement: () => ({ parentNode: null }),
    body: { appendChild(s) {
      s.parentNode = this; s.parentNode.removeChild = () => { s.parentNode = null; };
      const url = s.src; sent.push(url);
      const cb = /callback=([^&]+)/.exec(url)[1];
      const m = mode(url);
      const call = () => { try { if (typeof win[cb] !== 'function') throw new Error(cb + ' is not defined'); win[cb](typeof reply === 'function' ? reply(url) : reply); } catch (e) { errors.push(e.message); } };
      if (m === 'reply') setTimeout(() => { call(); s.onload && s.onload(); }, 1);
      else if (m === 'late') setTimeout(() => { call(); s.onload && s.onload(); }, lateMs);
      else if (m === 'html') setTimeout(() => s.onload && s.onload(), 1);
      else setTimeout(() => s.onerror && s.onerror(), 1);
    } }
  };
  return { win, doc, sent, errors };
}

(async () => {
  /* ---- jsonp ---------------------------------------------------------------- */
  let w = fakeWorld(() => 'reply', { ok: true, n: 1 });
  let api = N.jsonp({ url: 'https://x/exec', doc: w.doc, win: w.win });
  check('a reply resolves with the data', await api({ action: 'config' }), { ok: true, n: 1 });
  check('params go on the query string', /action=config/.test(w.sent[0]), true);

  w = fakeWorld(() => 'late', { ok: true }, 40);
  api = N.jsonp({ url: 'https://x/exec', doc: w.doc, win: w.win, messages: { timeout: 'No answer.' } });
  let err = await api({ action: 'submitDay' }, 10).catch((e) => e);
  check('a slow sheet times out, marked transient', [err.message, err.transient, err.kind], ['No answer.', true, 'timeout']);
  await tick(60);
  check('the late reply after that does not throw into the page', w.errors, []);

  w = fakeWorld(() => 'down');
  api = N.jsonp({ url: 'https://x/exec', doc: w.doc, win: w.win, messages: { offline: 'No signal.' } });
  err = await api({ action: 'submitDay', clientId: 'a' }).catch((e) => e);
  check('no signal: tried twice (one quiet retry), then transient', [w.sent.length, err.message, err.transient], [2, 'No signal.', true]);
  check('the retry is the SAME request (same clientId)', w.sent.every((u) => /clientId=a/.test(u)), true);

  w = fakeWorld(() => 'html');
  api = N.jsonp({ url: 'https://x/exec', doc: w.doc, win: w.win });
  const t0 = Date.now();
  err = await api({ action: 'floorPace' }, 15000).catch((e) => e);
  check('an HTML error page rejects at once, not after 15 s', [err.kind, err.transient, Date.now() - t0 < 1000], ['badReply', true, true]);

  let seen = null;
  w = fakeWorld(() => 'reply', { ok: false, locked: true });
  api = N.jsonp({ url: 'https://x/exec', doc: w.doc, win: w.win, onReply: (d, p) => { seen = p.action; return Object.assign({}, d, { tagged: true }); } });
  check('onReply sees every reply first and can stand in for it', [await api({ action: 'timeView' }), seen], [{ ok: false, locked: true, tagged: true }, 'timeView']);

  /* ---- transient ----------------------------------------------------------- */
  check('retry: true is "not now"', N.transient({ ok: false, retry: true, error: 'x' }), true);
  check('an old backend\'s lock timeout text is "not now"', N.transient({ ok: false, error: 'Lock timeout: another process was holding the lock' }), true);
  check('a refusal is "no"', N.transient({ ok: false, error: 'Unknown product: X' }), false);
  check('a login that ran out is neither (it has its own path)', N.transient({ ok: false, locked: true, needLogin: true, error: 'timed out' }), false);
  check('a success is not', N.transient({ ok: true }), false);

  /* ---- drainQueue ---------------------------------------------------------- */
  function queue(items) { let q = items.slice(); return { read: () => q.slice(), write: (n) => { q = n.slice(); }, get: () => q.map((x) => x.clientId) }; }
  const A1 = { employee: 'Ann', clientId: 'a1' }, A2 = { employee: 'Ann', clientId: 'rv-a1' }, B1 = { employee: 'Bo', clientId: 'b1' };

  let Q = queue([A1, B1]), order = [];
  let res = await N.drainQueue({ read: Q.read, write: Q.write, send: (it) => { order.push(it.clientId); return Promise.resolve(it.clientId === 'a1' ? { ok: true } : { ok: false, replayed: true }); } });
  check('ok and replayed both leave the phone, oldest first', [order, Q.get(), res.sent, res.offline], [['a1', 'b1'], [], 2, false]);

  Q = queue([A1, B1]); const refused = [];
  res = await N.drainQueue({ read: Q.read, write: Q.write, onRefused: (it, r) => refused.push(r.error),
    send: (it) => Promise.resolve(it.clientId === 'a1' ? { ok: false, error: 'Unknown product: X' } : { ok: true }) });
  check('a refusal leaves, is reported, and the rest still go', [Q.get(), refused], [[], ['Unknown product: X']]);

  Q = queue([A1, B1]); order = [];
  res = await N.drainQueue({ read: Q.read, write: Q.write, send: (it) => { order.push(it.clientId); return Promise.resolve({ ok: false, retry: true, error: 'Lock timeout' }); } });
  check('a busy sheet keeps EVERYTHING and stops (no hammering)', [order, Q.get(), res.offline], [['a1'], ['a1', 'b1'], true]);

  Q = queue([A1, B1]);
  res = await N.drainQueue({ read: Q.read, write: Q.write, send: () => Promise.reject(Object.assign(new Error('No signal.'), { transient: true })) });
  check('no signal keeps everything', [Q.get(), res.offline], [['a1', 'b1'], true]);

  Q = queue([A1, A2, B1]); order = []; const asked = [];
  res = await N.drainQueue({ read: Q.read, write: Q.write, onNeedLogin: (n) => asked.push(n),
    send: (it) => { order.push(it.clientId); return Promise.resolve(it.employee === 'Ann' ? { ok: false, locked: true, needLogin: true } : { ok: true }); } });
  check('a login that ran out: that person\'s entry AND their undo stay, in order', Q.get(), ['a1', 'rv-a1']);
  check('the undo was never sent ahead of its entry', order, ['a1', 'b1']);
  check('someone else\'s entry still went, and who must log in is reported', [res.waitingFor, asked, res.offline], [['Ann'], ['Ann'], false]);

  Q = queue([A1, B1]); let busy = 0;
  res = await N.drainQueue({ read: Q.read, write: (n) => { Q.write(n); }, send: (it) => {
    if (it.clientId === 'a1') Q.write(Q.read().concat([{ employee: 'Cy', clientId: 'c1' }]));   // saved while sending
    busy++; return Promise.resolve({ ok: true }); } });
  check('an entry saved while the queue drains goes in the same run', [Q.get(), busy], [[], 3]);

  /* ---- stableIds ----------------------------------------------------------- */
  let n = 0; const ids = N.stableIds(() => 'id' + (++n));
  const form = { action: 'ship', productId: 'XRT50EXO', qty: '4' };
  const i1 = ids.take('ship', form), i2 = ids.take('ship', Object.assign({ clientId: i1 }, form));
  check('the same shipment sent again keeps its clientId', [i1, i2], ['id1', 'id1']);
  check('a changed form is a new submission', ids.take('ship', Object.assign({}, form, { qty: '5' })), 'id2');
  ids.done('ship');
  check('after a real answer the same fields are a new submission', ids.take('ship', Object.assign({}, form, { qty: '5' })), 'id3');
  check('kinds do not share ids', ids.take('rev', form), 'id4');

  /* ---- tokens / dates ------------------------------------------------------- */
  const sig = 'a'.repeat(64);
  check('expiry read from a 3.04.0 token', N.tokenExpiry('1798000000000.' + sig), 1798000000000);
  check('expired', N.tokenExpired('1000000000000.' + sig, 1700000000000), true);
  check('still good', N.tokenExpired('1798000000000.' + sig, 1700000000000), false);
  check('no token / pre-3.04.0 token: can\'t tell, so not "expired"', [N.tokenExpired(''), N.tokenExpired('deadbeef')], [false, false]);
  check('localIso is the PHONE\'s date, not UTC', N.localIso(new Date(2026, 9, 31, 23, 59)), '2026-10-31');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
