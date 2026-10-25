/* ============================================================================
 *  Aquamentor Floor mode: one screen, only to track production speed.
 *  Writes through the SAME actions as the full app (submitDay, reverse), plus
 *  clock and floorPace, so every report keeps working. JSONP like app.js.
 * ========================================================================== */
(function () {
  'use strict';
  var API = (window.AEGIS_CONFIG && window.AEGIS_CONFIG.API_URL || '').trim();
  var FLOOR_VERSION = '3.02.0';
  // Every tube job, in floor order (3.01.5). Cut and Glued log against the
  // blank (BLANK50/40), the rest against the tube, Strap against STRAP6.
  var JOBS = [
    { stage: 'Cut', kind: 'blank' }, { stage: 'Glued', kind: 'blank' },
    { stage: 'Meshed', kind: 'tube' }, { stage: 'Patched', kind: 'tube' },
    { stage: 'Paint 1', kind: 'tube' }, { stage: 'Paint 2', kind: 'tube' },
    { stage: 'Printed', kind: 'tube' }, { stage: 'Straps Attached', kind: 'tube' },
    { stage: 'Boxed', kind: 'tube' }, { stage: 'Made', kind: 'strap', label: 'Strap made' }
  ];
  var UNDO_MS = 120000;
  // 3.01.1: new key, so every phone logs in with a PIN once; aq_floor_name (tap-only) is ignored.
  var K = { name: 'aq_floor_login', queue: 'aq_floor_queue', prod: 'aq_floor_prod', cfg: 'aq_floor_cfg', pace: 'aq_floor_pace' };
  // Stages and products the pace strip counts; same lists as FLOOR_STAGES / FLOOR_PRODUCTS in Code.gs.
  var PACE_STAGES = ['Meshed', 'Patched', 'Boxed'], PACE_PRODUCTS = ['XRT50EXO', 'XRT40EXO', 'XRT50STD', 'XRT40STD'];
  var RETRY_MS = [3000, 6000, 15000, 30000];

  var el = function (id) { return document.getElementById(id); };
  var S = { cfg: null, name: '', prod: 'TUBE', size: '50', std: false, stage: 'Boxed', busy: false, pace: null, undo: null,
            flushing: null, inflight: '', retry: 0, retryTimer: null, offline: false };
  // Round-trip times this session, newest last, for anyone measuring: window.__flPerf.
  var perf = window.__flPerf = [];
  function note(what, t0, r) { perf.push({ what: what, ms: Math.round(Date.now() - t0), serverMs: r && r.serverMs }); if (perf.length > 50) perf.shift(); }

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  /* ---- JSONP (same shape as app.js) --------------------------------------- */
  var seq = 0;
  function api(params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!API) { reject(new Error('API_URL is not set (edit config.js)')); return; }
      var cb = '__fl_cb_' + (++seq), script = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('No answer. Check signal.')); }, timeoutMs || 15000);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (script.parentNode) script.parentNode.removeChild(script); }
      var t0 = Date.now();
      window[cb] = function (data) { cleanup(); note(params.action, t0, data); resolve(data); };
      var qs = Object.keys(params).filter(function (k) { return k !== '__retry'; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
      script.src = API + '?' + qs + '&callback=' + cb;
      script.onerror = function () {
        cleanup();
        if (!params.__retry) { setTimeout(function () { api(Object.assign({}, params, { __retry: 1 }), timeoutMs).then(resolve, reject); }, 1500); return; }
        reject(new Error('No signal.'));
      };
      document.body.appendChild(script);
    });
  }

  /* ---- toast / undo -------------------------------------------------------- */
  var toastTimer;
  function toast(msg, opts) {
    opts = opts || {};
    var t = el('flToast'); el('flToastT').textContent = msg;
    t.classList.toggle('bad', !!opts.bad);
    el('flUndo').hidden = !opts.undo;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; S.undo = null; }, opts.undo ? UNDO_MS : 4000);
  }

  /* ---- product / stage ------------------------------------------------------ */
  /* What is being made (3.01.6): "Rescue tube" keeps the size / Exo-Standard
   * pickers and the tube JOBS above; every other active product (chairs,
   * foam shapes, kickboards, anything added to the sheet later) is picked by
   * name and offers its own line's stations. */
  var TUBE_LINES = ['Blank', 'TubeExo', 'TubeStd', 'Strap', 'Tube'];
  function otherProducts() {
    return ((S.cfg && S.cfg.products) || []).filter(function (p) { return TUBE_LINES.indexOf(p.line) === -1; });
  }
  function prodInfo() {
    if (S.prod === 'TUBE') return null;
    var hit = null; otherProducts().forEach(function (p) { if (p.id === S.prod) hit = p; });
    return hit;
  }
  function renderProducts() {
    var sel = el('flProd'); sel.innerHTML = '';
    var o = document.createElement('option'); o.value = 'TUBE'; o.textContent = 'Rescue tube'; sel.appendChild(o);
    var groups = {};
    otherProducts().forEach(function (p) { (groups[p.family || 'Other'] = groups[p.family || 'Other'] || []).push(p); });
    Object.keys(groups).forEach(function (g) {
      var og = document.createElement('optgroup'); og.label = g;
      groups[g].forEach(function (p) { var op = document.createElement('option'); op.value = p.id; op.textContent = p.name || p.id; og.appendChild(op); });
      sel.appendChild(og);
    });
    if (S.prod !== 'TUBE' && !prodInfo()) S.prod = 'TUBE';
    sel.value = S.prod;
  }
  function jobOf(stage) { for (var i = 0; i < JOBS.length; i++) if (JOBS[i].stage === stage) return JOBS[i]; return JOBS[JOBS.length - 2]; }
  function productFor(stage) {
    if (S.prod !== 'TUBE') return S.prod;
    var k = jobOf(stage).kind;
    if (k === 'blank') return 'BLANK' + S.size;
    if (k === 'strap') return 'STRAP6';
    return 'XRT' + S.size + (S.std ? 'STD' : 'EXO');
  }
  function productId() { return productFor(S.stage); }
  function productLabel(stage) {
    var pi = prodInfo(); if (pi) return pi.name || pi.id;
    var k = jobOf(stage).kind;
    if (k === 'strap') return '';
    if (k === 'blank') return S.size + '" blank';
    return S.size + '"' + (S.std ? ' Std' : '');
  }
  function lineStages(pid) {
    var cfg = S.cfg, line = null;
    ((cfg && cfg.products) || []).forEach(function (p) { if (p.id === pid) line = p.line || 'Blank'; });
    return (line && cfg.lines && cfg.lines[line]) || null;
  }
  function jobOk(j) {
    var valid = lineStages(productFor(j.stage));
    return valid ? valid.indexOf(j.stage) !== -1 : !(j.stage === 'Meshed' && S.std);
  }
  function renderStages() {
    var pi = prodInfo();
    // "+12 box" is a case of tubes; chairs and shapes don't come twelve to a box (3.01.8).
    el('fl12').hidden = !!pi;
    el('fl12').parentNode.classList.toggle('fl-qty2--one', !!pi);
    if (pi) {
      var st = (S.cfg.lines && S.cfg.lines[pi.line]) || [];
      if (st.indexOf(S.stage) === -1) S.stage = st[st.length - 1] || '';
      var ps = el('flStage'); ps.innerHTML = '';
      st.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; if (s === S.stage) o.selected = true; ps.appendChild(o); });
      el('flSizeRow').hidden = true; el('flStd').hidden = true;
      return;
    }
    var list = JOBS.filter(jobOk);
    if (!list.some(function (j) { return j.stage === S.stage; })) S.stage = 'Boxed';
    var sel = el('flStage'); sel.innerHTML = '';
    list.forEach(function (j) {
      var o = document.createElement('option');
      o.value = j.stage; o.textContent = j.label || j.stage;
      if (j.stage === S.stage) o.selected = true;
      sel.appendChild(o);
    });
    el('flSizeRow').hidden = jobOf(S.stage).kind === 'strap';
    el('flStd').hidden = jobOf(S.stage).kind !== 'tube';
  }
  function known(pid) { return !S.cfg || (S.cfg.products || []).some(function (p) { return p.id === pid; }); }

  /* ---- pace ------------------------------------------------------------------ */
  // Par comes from the backend: crew clocked hours so far x (weekly target / weekly crew hours).
  var grade = FloorCore.grade, fmt = FloorCore.fmt;

  /* Optimistic pace (3.02.0): an entry counts on the strip the moment it is
   * tapped. The server's numbers replace ours on every refresh, and entries
   * still on the phone are added back on top so nothing flickers down. */
  function bumpPace(p, pl, sign) {
    if (!p || !p.ok || !p.crew || pl.workDate !== p.today || PACE_PRODUCTS.indexOf(pl.productId) === -1) return;
    var c = {}; try { c = JSON.parse(pl.counts || '{}'); } catch (e) { c = {}; }
    if (pl.action === 'reverse') { c = {}; c[pl.stage] = Number(pl.qty) || 0; sign = -sign; }
    PACE_STAGES.forEach(function (st) {
      var n = (Number(c[st]) || 0) * sign; if (!n) return;
      p.crew.today[st] += n; p.crew.week[st] += n;
      if (p.me && pl.employee === p.me.name) { p.me.today[st] += n; p.me.week[st] += n; }
    });
    var hrs = p.crew.hoursToday;
    p.crew.boxedPerHourToday = hrs > 0 ? Math.round(p.crew.today.Boxed / hrs * 100) / 100 : null;
  }
  function withPending(p) { readQ().forEach(function (pl) { bumpPace(p, pl, 1); }); return p; }
  function savePace() { if (S.pace && S.pace.ok) ls(K.pace, JSON.stringify({ name: S.name, pace: S.pace })); }

  function renderPace() {
    var p = S.pace; if (!p || !p.ok) return;
    var dayT = p.target.dailyBoxed, weekT = p.target.weeklyBoxed;
    var dayExp = p.par.today, weekExp = p.par.week;
    el('dayV').innerHTML = fmt(p.crew.today.Boxed) + ' <small>/ ' + fmt(dayT) + '</small>';
    el('weekV').innerHTML = fmt(p.crew.week.Boxed) + ' <small>/ ' + fmt(weekT) + '</small>';
    el('cellDay').className = 'fl-cell ' + grade(p.crew.today.Boxed, dayExp);
    el('cellWeek').className = 'fl-cell ' + grade(p.crew.week.Boxed, weekExp);
    var ph = p.crew.boxedPerHourToday;
    el('dayS').textContent = 'par now ' + fmt(dayExp) + (ph !== null && ph !== undefined ? '  ·  ' + fmt(ph) + '/hr' : '');
    el('weekS').textContent = 'par now ' + fmt(weekExp) + '  ·  goal ' + fmt(weekT);
    var m = p.me;
    if (m) {
      var mine = m.hoursToday > 0 ? fmt(m.today.Boxed / m.hoursToday) : '-';
      var crew = ph !== null && ph !== undefined ? fmt(ph) : '-';
      el('meV').textContent = 'Meshed ' + fmt(m.today.Meshed) + '  ·  Patched ' + fmt(m.today.Patched) + '  ·  Boxed ' + fmt(m.today.Boxed)
        + '\nBoxed/hr: me ' + mine + '  ·  crew ' + crew + '  ·  par ' + fmt(p.target.parPerHour);
    }
    renderClock(m);
  }

  /* ---- clock ------------------------------------------------------------------ */
  function clockTime(ms) { var d = new Date(ms); var h = d.getHours() % 12 || 12; return h + ':' + pad(d.getMinutes()) + (d.getHours() < 12 ? 'am' : 'pm'); }
  function renderClock(m) {
    var b = el('flClock');
    if (!m) { b.disabled = true; return; }
    b.disabled = S.busy;
    b.classList.toggle('out', !!m.clockedIn);
    el('clockT').textContent = m.clockedIn ? 'Clock out' : 'Clock in';
    el('clockS').textContent = (m.clockedIn ? 'in since ' + clockTime(m.since) + '  ·  ' : '') + fmt(m.hoursToday) + ' h today';
  }
  /* Every punch: PIN pad -> locating -> result. The server checks the PIN and the fence. */
  var PIN = { digits: '', dir: '', busy: false, who: '' };
  function renderDots() {
    var box = el('flPinDots'); box.innerHTML = '';
    for (var i = 0; i < 4; i++) { var d = document.createElement('i'); if (i < PIN.digits.length) d.className = 'on'; box.appendChild(d); }
  }
  function pinMsg(text, cls, spin) {
    var m = el('flPinMsg'); m.className = 'fl-pinmsg ' + (cls || ''); m.textContent = '';
    if (spin) { var sp = document.createElement('span'); sp.className = 'fl-spin'; m.appendChild(sp); }
    m.appendChild(document.createTextNode(text || ''));
  }
  function openPin(dir) {
    PIN.dir = dir; PIN.digits = ''; PIN.busy = false; renderDots(); pinMsg('');
    // Start the GPS fix while the PIN is typed: it used to start after the 4th digit (3.02.0).
    PIN.fix = dir === 'login' ? null : locate();
    el('flPinTitle').textContent = dir === 'login' ? PIN.who + ': enter your PIN'
      : dir === 'in' ? 'Clock in: enter your PIN' : 'Clock out: enter your PIN';
    el('flPin').hidden = false;
  }
  function buildPad() {
    var pad = el('flPad'), keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '\u232b'];
    keys.forEach(function (k) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = k; b.dataset.k = k;
      if (k === 'Clear') b.className = 'small';
      pad.appendChild(b);
    });
    pad.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || PIN.busy) return;
      var k = b.dataset.k;
      if (k === 'Clear') PIN.digits = '';
      else if (k === '\u232b') PIN.digits = PIN.digits.slice(0, -1);
      else if (PIN.digits.length < 4) PIN.digits += k;
      renderDots(); pinMsg('');
      if (PIN.digits.length === 4) { if (PIN.dir === 'login') doLogin(); else doPunch(); }
    });
  }
  function locate() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    });
  }
  function doPunch() {
    PIN.busy = true; pinMsg('Finding you...', '', true);
    var dir = PIN.dir, pin = PIN.digits;
    (PIN.fix || locate()).then(function (fix) {
      pinMsg('Checking...', '', true);
      var q = { action: 'clock', employee: S.name, dir: dir, pin: pin, clientId: uid(), workDate: todayIso() };
      if (fix) { q.lat = fix.lat; q.lng = fix.lng; q.accuracy = fix.accuracy; }
      return api(q, 20000);
    }).then(function (r) {
      PIN.busy = false;
      if (!r.ok) {
        PIN.digits = ''; renderDots();
        pinMsg(r.error || 'Could not punch', 'bad');
        if (r.locked) el('flPad').style.visibility = 'hidden';
        return;
      }
      el('flPin').hidden = true; PIN.fix = null;
      var t = clockTime(Date.now());
      toast(dir === 'in' ? (r.already ? 'Already clocked in' : 'Clocked in ' + t + (r.atShop ? ' at shop \u2713' : ''))
                         : 'Clocked out ' + t + (r.atShop ? ' at shop \u2713' : '') + '. Shift ' + fmt(r.shiftHours) + ' h');
      // The punch reply carries the new state: show it now, refresh the rest behind it.
      if (S.pace && S.pace.me) { S.pace.me.clockedIn = r.clockedIn; S.pace.me.since = r.since; S.pace.me.hoursToday = r.hoursToday; renderClock(S.pace.me); }
      var boxed = S.pace && S.pace.ok ? S.pace.crew.today.Boxed : 1;
      if (dir === 'out' && boxed <= 0 && S.prod === 'TUBE') { el('flAskQty').value = ''; el('flAsk').hidden = false; }
      refresh();
    }).catch(function (e) { PIN.busy = false; PIN.digits = ''; renderDots(); pinMsg(e.message, 'bad'); });
  }
  /* Log in once per phone: name + clock PIN, checked by the server. */
  function doLogin() {
    PIN.busy = true; pinMsg('Checking...', '', true);
    var who = PIN.who;
    api({ action: 'login', name: who, pin: PIN.digits }, 20000).then(function (r) {
      PIN.busy = false;
      if (r && !r.ok && /Unknown action/i.test(r.error || '')) {
        // Backend not updated yet: let them in so production still gets logged.
        r = { ok: true, name: who, unchecked: true };
      }
      if (!r.ok) {
        PIN.digits = ''; renderDots();
        pinMsg(r.error || 'Could not log in', 'bad');
        if (r.locked) el('flPad').style.visibility = 'hidden';
        return;
      }
      el('flPin').hidden = true;
      S.name = r.name || who; ls(K.name, S.name);
      start();
      if (r.unchecked) toast('PIN not checked: the sheet is still updating.', { bad: true });
    }).catch(function (e) { PIN.busy = false; PIN.digits = ''; renderDots(); pinMsg(e.message, 'bad'); });
  }
  function onClock() {
    var m = S.pace && S.pace.me; if (!m || S.busy) return;
    el('flPad').style.visibility = '';
    openPin(m.clockedIn ? 'out' : 'in');
  }

  /* "I forgot to punch": a request to a manager, with the PIN, never an edit. */
  var FOR = { dir: 'in', day: '0' };
  function openForgot() {
    FOR.dir = 'in'; FOR.day = '0';
    ['flForDir', 'flForDay'].forEach(function (id) { Array.prototype.forEach.call(el(id).children, function (c, i) { c.classList.toggle('on', i === 0); }); });
    el('flForTime').value = ''; el('flForReason').value = ''; el('flForPin').value = ''; el('flForMsg').textContent = '';
    el('flFor').hidden = false;
  }
  function sendForgot() {
    var tv = el('flForTime').value, msg = el('flForMsg');
    msg.className = 'fl-pinmsg bad';
    if (!tv) { msg.textContent = 'Pick the time.'; return; }
    if (!el('flForReason').value.trim()) { msg.textContent = 'Say why.'; return; }
    if (!/^\d{4}$/.test(el('flForPin').value)) { msg.textContent = 'Enter your 4-digit PIN.'; return; }
    var d = new Date(); d.setDate(d.getDate() - Number(FOR.day));
    var hm = tv.split(':'); d.setHours(Number(hm[0]), Number(hm[1]), 0, 0);
    msg.className = 'fl-pinmsg'; msg.textContent = 'Sending...';
    api({ action: 'timeRequest', employee: S.name, dir: FOR.dir, at: d.getTime(), reason: el('flForReason').value.trim(), pin: el('flForPin').value }).then(function (r) {
      if (r.ok) { el('flFor').hidden = true; toast(r.message || 'Sent'); }
      else { msg.className = 'fl-pinmsg bad'; msg.textContent = r.error || 'Not sent'; }
    }).catch(function (e) { msg.className = 'fl-pinmsg bad'; msg.textContent = e.message; });
  }

  function refresh() {
    if (!S.name) return Promise.resolve();
    return api({ action: 'floorPace', employee: S.name, workDate: todayIso() }).then(function (r) {
      if (r && r.ok) { S.pace = withPending(r); renderPace(); savePace(); }
      else if (r && r.error) toast(r.error, { bad: true });
    }).catch(function () { /* stale numbers beat a scary error; the queue banner covers writes */ });
  }

  /* ---- log --------------------------------------------------------------------- */
  function qty() { var n = Math.floor(Number(el('flQty').value)); return isFinite(n) && n > 0 ? n : 0; }
  function setQty(n) { el('flQty').value = String(Math.max(0, n)); el('flSubmit').disabled = qty() <= 0; }

  function readQ() { try { return JSON.parse(ls(K.queue) || '[]'); } catch (e) { return []; } }
  /* The queue lives in localStorage, so it survives a reload, a dead battery
   * swap and no signal. It is drained from the page (iPhones have no
   * background sync): on load, on every save, when signal or the screen comes
   * back, and on a backoff timer while anything is waiting. */
  function writeQ(q) { ls(K.queue, JSON.stringify(q)); showQ(q); }
  function showQ(q) {
    q = q || readQ(); var b = el('flQueue');
    b.hidden = !q.length;
    b.textContent = !q.length ? '' : S.offline
      ? q.length + ' saved on this phone. Sends itself when there is signal.'
      : q.length + ' sending…';
  }
  function dropQ(clientId) { writeQ(readQ().filter(function (x) { return x.clientId !== clientId; })); }
  function dupText(r) { return FloorCore.dupText(r.duplicates, S.name); }
  function payloadFor(stage, n) {
    var counts = {}; counts[stage] = n;
    var id = uid();
    var j = prodInfo() ? { label: stage } : jobOf(stage), lbl = productLabel(stage);
    return { action: 'submitDay', workDate: todayIso(), employee: S.name, productId: productFor(stage), counts: JSON.stringify(counts),
             notes: 'floor ' + id.slice(-6), clientId: 'fl-' + id, _label: n + ' ' + (j.label || stage) + (lbl ? ' ' + lbl : '') };
  }
  function send(payload) {
    var wire = Object.assign({}, payload); delete wire._label;
    return api(wire, 20000);
  }
  function scheduleRetry() {
    clearTimeout(S.retryTimer);
    var wait = RETRY_MS[Math.min(S.retry, RETRY_MS.length - 1)]; S.retry++;
    S.retryTimer = setTimeout(flush, wait);
  }
  // One at a time, oldest first, so an undo never reaches the sheet before its entry.
  function flush() {
    if (S.flushing) return S.flushing;
    clearTimeout(S.retryTimer);
    var sent = 0;
    function next() {
      var q = readQ();
      if (!q.length) { S.retry = 0; S.offline = false; showQ(q); if (sent) refresh(); return null; }
      var item = q[0]; S.inflight = item.clientId;
      return send(item).then(function (r) {
        S.inflight = ''; S.offline = false; S.retry = 0;
        if (r && (r.ok || r.replayed)) {
          sent++; dropQ(item.clientId);
          var dup = item.action === 'submitDay' ? dupText(r) : '', dn = el('flDup');
          if (dup) { dn.hidden = false; dn.textContent = dup; }
          return next();
        }
        // Refused (bad product, nothing to reverse...): retrying cannot help.
        dropQ(item.clientId);
        toast('Not saved: ' + (item._label || item.action) + '. ' + ((r && r.error) || 'The sheet refused it.'), { bad: true });
        return refresh().then(next);
      }, function () {
        S.inflight = ''; S.offline = true; showQ(); scheduleRetry();
      });
    }
    // Anything saved while this run was finishing gets a run of its own.
    function done() { S.flushing = null; if (readQ().length && !S.offline) flush(); }
    S.flushing = Promise.resolve().then(next).then(done, done);
    return S.flushing;
  }

  /* Saved means saved on the phone (3.02.0). The tap shows "Saved" and moves
   * the numbers at once; the sheet catches up in the background. The same
   * clientId on every retry means the sheet logs it once. */
  function submit(stage, n) {
    if (n <= 0) return;
    var pl = payloadFor(stage, n);
    var q = readQ(); q.push(pl); writeQ(q);
    setQty(0);
    el('flDup').hidden = true;
    S.undo = { clientId: pl.clientId, employee: S.name, productId: pl.productId, workDate: pl.workDate, stage: stage, qty: n, label: pl._label };
    bumpPace(S.pace, pl, 1); renderPace(); savePace();
    toast('Saved ' + pl._label, { undo: true });
    flush();
  }

  function onUndo() {
    var u = S.undo; if (!u) return;
    S.undo = null; el('flUndo').hidden = true; el('flDup').hidden = true;
    var q = readQ(), waiting = q.filter(function (x) { return x.clientId === u.clientId; })[0];
    if (waiting && S.inflight !== u.clientId) {
      // Never left the phone: just take it back.
      writeQ(q.filter(function (x) { return x !== waiting; }));
      bumpPace(S.pace, waiting, -1);
    } else {
      var rv = { action: 'reverse', employee: u.employee, by: u.employee, productId: u.productId, workDate: u.workDate,
                 stage: u.stage, qty: u.qty, reason: 'floor undo', clientId: 'rv-' + u.clientId, _label: 'undo ' + u.label };
      q.push(rv); writeQ(q);
      bumpPace(S.pace, rv, 1);
      flush();
    }
    renderPace(); savePace();
    toast('Undone: ' + u.label);
  }

  /* ---- who am I ----------------------------------------------------------------- */
  function showPick() {
    el('flApp').hidden = true; el('flPick').hidden = false; el('flNotYou').hidden = true; el('flWho').textContent = 'Floor';
    var box = el('flNames'); box.innerHTML = '';
    var names = (S.cfg && S.cfg.employees) || [];
    if (!names.length) box.textContent = 'Loading names...';
    names.forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = n;
      b.addEventListener('click', function () { PIN.who = n; el('flPad').style.visibility = ''; openPin('login'); });
      box.appendChild(b);
    });
  }
  function start() {
    el('flPick').hidden = true; el('flApp').hidden = false; el('flNotYou').hidden = false;
    el('flNotYou').textContent = 'log out';
    el('flWho').textContent = S.name;
    S.prod = ls(K.prod) || 'TUBE'; renderProducts();
    renderStages(); setQty(0);
    if (!known(productId())) toast('Product ' + productId() + ' is not set up in the sheet.', { bad: true });
    // Last numbers this phone saw, today's only, painted before the network answers.
    var saved = null; try { saved = JSON.parse(ls(K.pace) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.name === S.name && saved.pace && saved.pace.today === todayIso()) { S.pace = saved.pace; renderPace(); }
    showQ(); refresh(); flush();
  }

  function wire() {
    el('flNotYou').addEventListener('click', function () { S.name = ''; ls(K.name, null); S.pace = null; showPick(); });
    el('flClock').addEventListener('click', onClock);
    buildPad();
    el('flPinCancel').addEventListener('click', function () { if (!PIN.busy) el('flPin').hidden = true; });
    el('flForgot').addEventListener('click', openForgot);
    el('flForCancel').addEventListener('click', function () { el('flFor').hidden = true; });
    el('flForGo').addEventListener('click', sendForgot);
    [['flForDir', 'dir'], ['flForDay', 'day']].forEach(function (p) {
      el(p[0]).addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        FOR[p[1]] = b.dataset.v;
        Array.prototype.forEach.call(el(p[0]).children, function (c) { c.classList.toggle('on', c === b); });
      });
    });
    el('flSize').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.size = b.dataset.size;
      Array.prototype.forEach.call(el('flSize').children, function (c) { c.classList.toggle('on', c === b); });
      renderStages();
    });
    el('flStd').addEventListener('click', function () {
      S.std = !S.std; el('flStd').setAttribute('aria-pressed', String(S.std)); renderStages();
    });
    el('flProd').addEventListener('change', function () {
      S.prod = el('flProd').value; ls(K.prod, S.prod); renderStages();
    });
    el('flStage').addEventListener('change', function () {
      S.stage = el('flStage').value; renderStages();
      if (!known(productId())) toast('Product ' + productId() + ' is not set up in the sheet.', { bad: true });
    });
    document.querySelector('.fl-log').addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]'); if (!b) return;
      setQty(qty() + Number(b.dataset.add));
    });
    el('flQty').addEventListener('input', function () { el('flSubmit').disabled = qty() <= 0; });
    el('flSubmit').addEventListener('click', function () { submit(S.stage, qty()); });
    el('flUndo').addEventListener('click', onUndo);
    el('flAskSkip').addEventListener('click', function () { el('flAsk').hidden = true; });
    el('flAskGo').addEventListener('click', function () {
      var n = Math.floor(Number(el('flAskQty').value));
      el('flAsk').hidden = true;
      if (n > 0) submit('Boxed', n);
    });
    window.addEventListener('online', function () { S.offline = false; showQ(); flush(); });
    window.addEventListener('offline', function () { S.offline = true; showQ(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); flush(); } });
    setInterval(function () { if (!document.hidden && S.name) refresh(); }, 60000);
  }

  function boot() {
    wire();
    ls('aq_floor_name', null);
    if (ls('aq_floor_epoch') !== '3.01.2') { ls(K.name, null); ls('aq_floor_epoch', '3.01.2'); }  // everyone logs in once more
    S.name = ls(K.name) || '';
    S.offline = navigator.onLine === false;
    if (!API) { el('flPick').hidden = false; el('flNames').textContent = 'API_URL is not set (edit config.js).'; return; }
    /* Names, products and stations from the last visit draw the screen at once;
     * the sheet's answer replaces them in the background (3.02.0). */
    var cached = null; try { cached = JSON.parse(ls(K.cfg) || 'null'); } catch (e) { cached = null; }
    var shown = false;
    if (cached && cached.ok) {
      S.cfg = cached; shown = true;
      if (S.name && cached.employees.indexOf(S.name) === -1) { S.name = ''; ls(K.name, null); }
      if (S.name) start(); else showPick();
    }
    api({ action: 'config' }).then(function (c) {
      if (!c || !c.ok) throw new Error((c && c.error) || 'Could not load names');
      var was = JSON.stringify(S.cfg && { p: S.cfg.products, e: S.cfg.employees, l: S.cfg.lines });
      S.cfg = c;
      var keep = Object.assign({}, c); delete keep.serverMs; delete keep.cached; ls(K.cfg, JSON.stringify(keep));
      if (S.name && c.employees.indexOf(S.name) === -1) { S.name = ''; ls(K.name, null); showPick(); return; }
      if (!shown) { if (S.name) start(); else showPick(); return; }
      if (was === JSON.stringify({ p: c.products, e: c.employees, l: c.lines })) return;
      // Something changed in the sheet: redraw what depends on it, keep the person where they are.
      if (S.name) { renderProducts(); renderStages(); } else showPick();
    }).catch(function (e) {
      if (shown) return;   // the cached screen is already up; the next load tries again
      // Offline with a remembered name: still let them log; the queue holds it.
      if (S.name) start(); else { el('flPick').hidden = false; el('flNames').textContent = e.message + ' Reload when you have signal.'; }
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  boot();
})();
