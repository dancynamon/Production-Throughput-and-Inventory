/* Network helpers shared by the full app (app.js), Floor mode (floor.js) and
 * the Node tests (apps-script/test-net.js). 3.05.0.
 *
 *   jsonp()       the one way either page talks to the sheet. Every failure
 *                 rejects with err.transient = true when the same request can
 *                 work later (no answer, no signal, an error page instead of
 *                 a reply), so a queue keeps the entry and a form keeps the
 *                 typed numbers
 *   transient()   that test, for a rejection OR a reply ({retry: true}, or an
 *                 old backend's lock-timeout text)
 *   drainQueue()  Floor's send loop: oldest first, one at a time, an entry
 *                 for someone whose login ran out waits for them without
 *                 holding up anyone else's
 *   stableIds()   one clientId per submission, kept across a retry of the
 *                 same thing, so "tap again" after a timeout is a replay
 *   tokenExpiry() the expiry inside a 3.04.0 token, "<ms>.<signature>"
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NetCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  var TRANSIENT_RE = /lock timeout|timed out|too many times|service (error|unavailable)|temporarily unavailable|try again later|exceeded maximum execution|internal error|server error/i;

  function fail(msg, transient, kind) { var e = new Error(msg); e.transient = !!transient; e.kind = kind || ''; return e; }

  /* A reply or a rejection that says "not now" rather than "no". */
  function transient(x) {
    if (!x) return false;
    if (x instanceof Error) return !!x.transient;
    if (x.retry) return true;
    return !x.ok && !x.locked && TRANSIENT_RE.test(String(x.error || ''));
  }

  /* JSONP. o: { url, prefix, doc, win, messages: { timeout, offline, badReply }, onReply(data, params) }.
   * Returns api(params, timeoutMs). */
  function jsonp(o) {
    var doc = o.doc || document, win = o.win || window, seq = 0;
    var M = Object.assign({ timeout: 'No answer from the sheet. Check signal.', offline: 'No signal.',
                            badReply: 'The sheet answered with an error page. Trying again shortly.' }, o.messages || {});
    function api(params, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!o.url) { reject(fail('API_URL is not set (edit config.js)', false, 'config')); return; }
        var cb = (o.prefix || '__nc_cb_') + (++seq) + '_' + Math.random().toString(36).slice(2, 6);
        var script = doc.createElement('script'), settled = false;
        var timer = setTimeout(function () { finish(); reject(fail(M.timeout, true, 'timeout')); }, timeoutMs || 15000);
        /* A reply can still arrive after we gave up on it. The callback stays
         * defined as a no-op for a minute, so a late reply does not throw
         * "__cb is not defined" into the page; then it goes. */
        function finish() {
          settled = true; clearTimeout(timer);
          win[cb] = function () {};
          setTimeout(function () { try { delete win[cb]; } catch (e) { win[cb] = undefined; } }, 60000);
          if (script.parentNode) script.parentNode.removeChild(script);
        }
        win[cb] = function (data) {
          if (settled) return;
          finish();
          if (o.onReply) data = o.onReply(data, params) || data;
          resolve(data);
        };
        var qs = Object.keys(params).filter(function (k) { return k !== '__retry'; })
          .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
        script.src = o.url + '?' + qs + '&callback=' + cb;
        /* The script loaded but never called back: Google served an HTML
         * error page (quota, a script error before doGet, a sign-in page).
         * Say so now instead of waiting out the whole timeout. */
        script.onload = function () {
          setTimeout(function () { if (!settled) { finish(); reject(fail(M.badReply, true, 'badReply')); } }, 0);
        };
        // No answer at all: one quiet retry covers a dropped packet.
        script.onerror = function () {
          if (settled) return;
          finish();
          if (!params.__retry) {
            setTimeout(function () { api(Object.assign({}, params, { __retry: 1 }), timeoutMs).then(resolve, reject); }, 1500);
            return;
          }
          reject(fail(M.offline, true, 'offline'));
        };
        doc.body.appendChild(script);
      });
    }
    return api;
  }

  /* Floor's queue. o: { read(), write(q), send(item) -> Promise<reply>,
   *   onSent(item, reply), onRefused(item, reply), onNeedLogin(name, reply) }.
   * Resolves { sent, waitingFor: [names], offline: bool }.
   * - ok / replayed: off the phone
   * - needLogin / locked: stays, and so does everything after it for that
   *   person (an undo must never overtake its entry); other people's go on
   * - transient (no signal, lock timeout, error page) or any rejection:
   *   stop, everything stays, retry later
   * - anything else is a real refusal: off the phone, and said out loud */
  function drainQueue(o) {
    var waiting = {}, sent = 0;
    function head() {
      var q = o.read();
      for (var i = 0; i < q.length; i++) if (!waiting[q[i].employee]) return q[i];
      return null;
    }
    function done(offline, extra) { return Object.assign({ sent: sent, waitingFor: Object.keys(waiting), offline: offline }, extra || {}); }
    function drop(id) { o.write(o.read().filter(function (x) { return x.clientId !== id; })); }
    function next() {
      var item = head();
      if (!item) return Promise.resolve(done(false));
      return o.send(item).then(function (r) {
        if (r && (r.needLogin || r.locked)) {
          waiting[item.employee] = true;
          if (o.onNeedLogin) o.onNeedLogin(item.employee, r);
          return next();
        }
        if (r && (r.ok || r.replayed)) { sent++; drop(item.clientId); if (o.onSent) o.onSent(item, r); return next(); }
        if (transient(r)) return done(true, { reply: r });
        drop(item.clientId);
        if (o.onRefused) o.onRefused(item, r);
        return next();
      }, function (err) { return done(true, { error: err }); });
    }
    return next();
  }

  /* One clientId per submission. take(kind, fields) returns the id last used
   * for the very same fields of that kind, else a new one; done(kind) once
   * the sheet has answered for real. */
  function stableIds(make) {
    make = make || function () { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); };
    var last = {};
    return {
      take: function (kind, fields) {
        var sig = JSON.stringify(Object.keys(fields).sort().filter(function (k) { return k !== 'clientId'; })
          .map(function (k) { return [k, fields[k]]; }));
        if (last[kind] && last[kind].sig === sig) return last[kind].id;
        last[kind] = { sig: sig, id: make() };
        return last[kind].id;
      },
      done: function (kind) { delete last[kind]; }
    };
  }

  /* "<expiry ms>.<64 hex>" -> expiry ms; anything else (no token, a token
   * from before 3.04.0) -> null, meaning "the client cannot tell". */
  function tokenExpiry(tok) {
    var m = /^(\d{10,15})\.[0-9a-f]{64}$/.exec(String(tok || ''));
    return m ? Number(m[1]) : null;
  }
  function tokenExpired(tok, now) { var x = tokenExpiry(tok); return x !== null && x <= (now || Date.now()); }

  function localIso(d) {
    d = d || new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  return { jsonp: jsonp, transient: transient, drainQueue: drainQueue, stableIds: stableIds,
           tokenExpiry: tokenExpiry, tokenExpired: tokenExpired, localIso: localIso };
}));
