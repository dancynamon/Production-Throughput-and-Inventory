/* ============================================================================
 *  Aquamentor Floor mode: one screen, only to track production speed.
 *  Writes through the SAME actions as the full app (submitDay, reverse), plus
 *  clock and floorPace, so every report keeps working. JSONP like app.js.
 * ========================================================================== */
(function () {
  'use strict';
  var API = (window.AEGIS_CONFIG && window.AEGIS_CONFIG.API_URL || '').trim();
  var FLOOR_VERSION = '3.01.0';
  var STAGES = ['Meshed', 'Patched', 'Boxed'];
  var UNDO_MS = 120000;
  var K = { name: 'aq_floor_name', queue: 'aq_floor_queue' };

  var el = function (id) { return document.getElementById(id); };
  var S = { cfg: null, name: '', size: '50', std: false, stage: 'Boxed', busy: false, pace: null, undo: null };

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
      window[cb] = function (data) { cleanup(); resolve(data); };
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
  function productId() { return 'XRT' + S.size + (S.std ? 'STD' : 'EXO'); }
  function productLabel() { return S.size + '"' + (S.std ? ' Std' : ''); }
  function stagesFor(pid) {
    var cfg = S.cfg, line = 'Blank';
    ((cfg && cfg.products) || []).forEach(function (p) { if (p.id === pid) line = p.line || 'Blank'; });
    var valid = (cfg && cfg.lines && cfg.lines[line]) || null;
    return valid ? STAGES.filter(function (s) { return valid.indexOf(s) !== -1; }) : STAGES.slice();
  }
  function renderStages() {
    var list = stagesFor(productId());
    if (list.indexOf(S.stage) === -1) S.stage = list.indexOf('Boxed') !== -1 ? 'Boxed' : list[0];
    var box = el('flStage'); box.innerHTML = '';
    list.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = s; b.dataset.stage = s;
      if (s === S.stage) b.className = 'on';
      box.appendChild(b);
    });
  }
  function known(pid) { return !S.cfg || (S.cfg.products || []).some(function (p) { return p.id === pid; }); }

  /* ---- pace ------------------------------------------------------------------ */
  // Par comes from the backend: crew clocked hours so far x (weekly target / weekly crew hours).
  var grade = FloorCore.grade, fmt = FloorCore.fmt;

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
  var PIN = { digits: '', dir: '', busy: false };
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
    el('flPinTitle').textContent = dir === 'in' ? 'Clock in: enter your PIN' : 'Clock out: enter your PIN';
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
      if (PIN.digits.length === 4) doPunch();
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
    locate().then(function (fix) {
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
      el('flPin').hidden = true;
      var t = clockTime(Date.now());
      toast(dir === 'in' ? (r.already ? 'Already clocked in' : 'Clocked in ' + t + (r.atShop ? ' at shop \u2713' : ''))
                         : 'Clocked out ' + t + (r.atShop ? ' at shop \u2713' : '') + '. Shift ' + fmt(r.shiftHours) + ' h');
      return refresh().then(function () {
        var boxed = S.pace && S.pace.ok ? S.pace.crew.today.Boxed : 1;
        if (dir === 'out' && boxed <= 0) { el('flAskQty').value = ''; el('flAsk').hidden = false; }
      });
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
      if (r && r.ok) { S.pace = r; renderPace(); }
      else if (r && r.error) toast(r.error, { bad: true });
    }).catch(function () { /* stale numbers beat a scary error; the queue banner covers writes */ });
  }

  /* ---- log --------------------------------------------------------------------- */
  function qty() { var n = Math.floor(Number(el('flQty').value)); return isFinite(n) && n > 0 ? n : 0; }
  function setQty(n) { el('flQty').value = String(Math.max(0, n)); el('flSubmit').disabled = qty() <= 0; }

  function readQ() { try { return JSON.parse(ls(K.queue) || '[]'); } catch (e) { return []; } }
  function writeQ(q) { ls(K.queue, JSON.stringify(q)); var b = el('flQueue'); b.hidden = !q.length; b.textContent = q.length + ' waiting to send (no signal). Sends itself.'; }
  function dupText(r) { return FloorCore.dupText(r.duplicates, S.name); }
  function payloadFor(stage, n) {
    var counts = {}; counts[stage] = n;
    var id = uid();
    return { action: 'submitDay', workDate: todayIso(), employee: S.name, productId: productId(), counts: JSON.stringify(counts),
             notes: 'floor ' + id.slice(-6), clientId: 'fl-' + id, _label: n + ' ' + stage + ' ' + productLabel() };
  }
  function send(payload) {
    var wire = Object.assign({}, payload); delete wire._label;
    return api(wire, 20000);
  }
  function flush() {
    var q = readQ(); if (!q.length) return Promise.resolve();
    var first = q[0];
    return send(first).then(function (r) {
      if (r && (r.ok || r.replayed)) { q.shift(); writeQ(q); return flush(); }
      if (r && r.error) { q.shift(); writeQ(q); toast('Server refused a saved entry: ' + r.error, { bad: true }); return flush(); }
    }).catch(function () {});
  }

  function submit(stage, n, quiet) {
    if (n <= 0 || S.busy) return Promise.resolve();
    var pl = payloadFor(stage, n);
    S.busy = true; el('flSubmit').disabled = true;
    return send(pl).then(function (r) {
      S.busy = false;
      if (!r.ok) { toast(r.error || 'Not saved', { bad: true }); setQty(qty()); return; }
      setQty(0);
      var dup = dupText(r), dn = el('flDup');
      dn.hidden = !dup; dn.textContent = dup;
      S.undo = { employee: S.name, productId: pl.productId, workDate: pl.workDate, stage: stage, qty: n };
      toast('Logged ' + pl._label, { undo: true });
      return refresh();
    }).catch(function () {
      S.busy = false;
      var q = readQ(); q.push(pl); writeQ(q);          // same clientId on retry: logs once
      setQty(0);
      toast('No signal. Saved on phone: ' + pl._label);
    });
  }

  function onUndo() {
    var u = S.undo; if (!u) return;
    S.undo = null; el('flUndo').hidden = true;
    api({ action: 'reverse', employee: u.employee, by: u.employee, productId: u.productId, workDate: u.workDate,
          stage: u.stage, qty: u.qty, reason: 'floor undo' }).then(function (r) {
      toast(r.ok ? 'Undone: ' + u.qty + ' ' + u.stage : (r.error || 'Could not undo'), { bad: !r.ok });
      el('flDup').hidden = true;
      refresh();
    }).catch(function (e) { toast(e.message, { bad: true }); });
  }

  /* ---- who am I ----------------------------------------------------------------- */
  function showPick() {
    el('flApp').hidden = true; el('flPick').hidden = false; el('flNotYou').hidden = true; el('flWho').textContent = 'Floor';
    var box = el('flNames'); box.innerHTML = '';
    var names = (S.cfg && S.cfg.employees) || [];
    if (!names.length) box.textContent = 'Loading names...';
    names.forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = n;
      b.addEventListener('click', function () { S.name = n; ls(K.name, n); start(); });
      box.appendChild(b);
    });
  }
  function start() {
    el('flPick').hidden = true; el('flApp').hidden = false; el('flNotYou').hidden = false;
    el('flWho').textContent = S.name;
    renderStages(); setQty(0);
    if (!known(productId())) toast('Product ' + productId() + ' is not set up in the sheet.', { bad: true });
    refresh(); flush(); writeQ(readQ());
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
    el('flStage').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.stage = b.dataset.stage; renderStages();
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
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); flush(); } });
    setInterval(function () { if (!document.hidden && S.name) refresh(); }, 60000);
  }

  function boot() {
    wire();
    S.name = ls(K.name) || '';
    if (!API) { el('flPick').hidden = false; el('flNames').textContent = 'API_URL is not set (edit config.js).'; return; }
    api({ action: 'config' }).then(function (c) {
      if (!c || !c.ok) throw new Error((c && c.error) || 'Could not load names');
      S.cfg = c;
      if (S.name && c.employees.indexOf(S.name) === -1) { S.name = ''; ls(K.name, null); }
      if (S.name) start(); else showPick();
    }).catch(function (e) {
      // Offline with a remembered name: still let them log; the queue holds it.
      if (S.name) start(); else { el('flPick').hidden = false; el('flNames').textContent = e.message + ' Reload when you have signal.'; }
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  boot();
})();
