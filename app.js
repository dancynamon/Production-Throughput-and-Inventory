/* ============================================================================
 *  Aquamentor Production — phone/web app logic
 *  Talks to the Apps Script backend over JSONP (Apps Script sends no CORS
 *  headers, so a normal fetch from another origin would be blocked).
 * ========================================================================== */
(function () {
  'use strict';

  var API = (window.AEGIS_CONFIG && window.AEGIS_CONFIG.API_URL || '').trim();

  // Shown in the footer so you can tell at a glance what a given phone is
  // actually running. BUMP THIS whenever you change index.html / app.js /
  // style.css / config.js, and bump CACHE in sw.js to the same number —
  // otherwise the service worker keeps serving the old shell and this number
  // is how you'll notice.
  var APP_VERSION = '2.21.0';

  var el = function (id) { return document.getElementById(id); };
  var LINES = {};    // line -> [stage names], from config
  var TODAY = {};    // productId -> {stage: qty} already logged for the picked date
  var PLINE = {};    // productId -> line, from config

  /* ---- JSONP ------------------------------------------------------------- */
  var seq = 0;
  function api(params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!API) { reject(new Error('API_URL is not set (edit config.js)')); return; }
      var cb = '__aq_cb_' + (++seq);
      var script = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('Request timed out.')); }, timeoutMs || 15000);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (script.parentNode) script.parentNode.removeChild(script); }
      window[cb] = function (data) {
        cleanup();
        // The backend refused a manager action: our token is stale (a PIN was
        // changed) or missing. Drop to employee view and say why, once.
        if (data && data.locked) lockOut('Manager PIN changed — tap the lock to unlock again.');
        resolve(data);
      };
      // Manager actions carry the token the unlock earned. Harmless on open
      // actions; the backend ignores it there.
      if (localStorage.getItem('aq_role') === 'mgr' && localStorage.getItem('aq_mgr_token') && !params.token) {
        params = Object.assign({}, params, { token: localStorage.getItem('aq_mgr_token'),
                                             mgrName: localStorage.getItem('aq_mgr_name') || '' });
      }
      var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
      script.src = API + '?' + qs + '&callback=' + cb;
      script.onerror = function () { cleanup(); reject(new Error('Network error reaching the server.')); };
      document.body.appendChild(script);
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = el('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }

  function fillSelect(sel, items, placeholder) {
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = placeholder; ph.disabled = true; ph.selected = true;
    sel.appendChild(ph);
    items.forEach(function (it) {
      var o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o);
    });
  }

  /* Same as fillSelect but with <optgroup> headings. Native grouping rather
   * than indented labels: phone pickers render optgroups as real section
   * headers, and a screen reader announces them. Families arrive in the
   * backend's order; anything it doesn't know about is appended rather than
   * dropped. */
  function fillSelectGrouped(sel, items, placeholder, order) {
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = placeholder; ph.disabled = true; ph.selected = true;
    sel.appendChild(ph);

    var byFamily = {};
    items.forEach(function (it) {
      var f = it.family || 'Other';
      (byFamily[f] = byFamily[f] || []).push(it);
    });
    var families = (order || []).filter(function (f) { return byFamily[f]; })
      .concat(Object.keys(byFamily).filter(function (f) {
        return (order || []).indexOf(f) === -1;
      }));

    families.forEach(function (f) {
      var group = document.createElement('optgroup');
      group.label = f;
      byFamily[f].forEach(function (it) {
        var o = document.createElement('option');
        o.value = it.value; o.textContent = it.label;
        group.appendChild(o);
      });
      sel.appendChild(group);
    });
  }

  /* ---- Config: dropdowns + stage inputs ---------------------------------- */
  function loadConfig() {
    if (!API) { el('setupBanner').hidden = false; renderBuildInfo(); return; }
    api({ action: 'config' }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Could not load config');
      buildFacts.backend = data.backendVersion || null;
      buildFacts.sheet   = data.sheetName || null;
      buildFacts.sheetId = data.sheetId || null;
      buildFacts.buildStamp = data.buildStamp || null;
      renderBuildInfo();
      buildFacts.pinIsDefault = !!data.pinIsDefault;
      showPinNag();
      LINES = data.lines || {};
      PLINE = {};
      (data.products || []).forEach(function (p) { PLINE[p.id] = p.line || 'Blank'; });
      var emp = data.employees.map(function (n) { return { value: n, label: n }; });
      fillSelect(el('employee'), emp, 'Select your name');
      fillSelect(el('recvEmployee'), emp, 'Select your name');
      fillSelect(el('invEmployee'), emp, 'Select your name');
      fillSelect(el('wipEmployee'), emp, 'Select your name');
      fillSelect(el('floorWho'), emp, 'Select your name');
      var prodOpts = data.products.map(function (p) {
        return { value: p.id, label: p.name, family: p.family };
      });
      var famOrder = data.familyOrder || [];
      fillSelectGrouped(el('product'), prodOpts, 'Select a product', famOrder);
      fillSelectGrouped(el('wipProduct'), prodOpts, 'Select a product', famOrder);
      fillSelect(el('recvMaterial'), (data.materials || []).map(function (m) {
        return { value: m.id, label: m.name + (m.unit ? ' (' + m.unit + ')' : '') };
      }), 'Select a material');
      var flt = el('rcvFilter');
      flt.innerHTML = '<option value="">All materials</option>' + (data.materials || []).map(function (m) {
        return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>';
      }).join('');
      flt.value = RCV.filter;
      buildStageInputs();
      loadToday();
      renderQueue();
      flushQueue();
    }).catch(function (err) { renderBuildInfo(); toast('⚠ ' + err.message); });
  }

  /* ---- Build info -------------------------------------------------------- */
  /* A muted line at the bottom of every screen: tap it for the full picture.
   * Everything here is a debugging aid — which shell this device cached, which
   * Apps Script deployment it talks to, and which spreadsheet that deployment
   * is bound to. `backend`, `sheet` and `sheetId` arrive from ?action=config,
   * so they stay blank until the Apps Script side is redeployed. */
  var buildFacts = { backend: null, sheet: null, sheetId: null, buildStamp: null, pinIsDefault: false };

  /* Nag for as long as the PIN is the one printed in a public repo. Only a
   * manager can act on it, so it shows only in manager mode — and it has to
   * be re-evaluated on unlock, not just on load, or the person who just typed
   * the default PIN is the one person who never sees the warning about it. */
  function showPinNag() {
    el('pinBanner').hidden = !(buildFacts.pinIsDefault && localStorage.getItem('aq_role') === 'mgr');
  }

  function apiLabel() {
    if (!API) return 'not set';
    var m = API.match(/\/macros\/s\/([^/]+)/);
    return m ? 'deployment …' + m[1].slice(-8) : API;
  }

  function renderBuildInfo() {
    // Both numbers, always, each labelled. The app and the backend deploy
    // separately and drift constantly — showing one unlabelled "v2.0.1" just
    // invites reading it as whichever half you last touched.
    el('buildToggle').textContent =
      'app ' + APP_VERSION
      + ' · backend ' + (buildFacts.backend || 'not reported')
      + (buildFacts.sheet ? ' · ' + buildFacts.sheet : '')
      + '  ⓘ';

    var rows = [
      ['App version',     APP_VERSION],
      ['Backend version', buildFacts.backend || 'not reported — redeploy Apps Script'],
      ['Backend built',    buildFacts.buildStamp || 'not reported'],
      ['Sheet',           buildFacts.sheet   || '—'],
      ['Sheet ID',        buildFacts.sheetId || '—'],
      ['API',             apiLabel()],
      ['Cached shell',    'checking…'],
      ['Loaded',          new Date().toLocaleString()]
    ];
    el('buildDetails').innerHTML = rows.map(function (r, i) {
      return '<div class="buildinfo__row"><span>' + escapeHtml(r[0]) + '</span>'
           + '<code' + (r[0] === 'Cached shell' ? ' id="buildCache"' : '') + '>' + escapeHtml(r[1]) + '</code></div>';
    }).join('');

    var cacheCell = el('buildCache');
    if (!cacheCell) return;
    if (!window.caches || !caches.keys) { cacheCell.textContent = 'unavailable'; return; }
    caches.keys().then(function (keys) {
      var mine = keys.filter(function (k) { return k.indexOf('aquamentor') === 0; });
      cacheCell.textContent = mine.length ? mine.join(', ') : 'none (network)';
    }).catch(function () { cacheCell.textContent = 'unavailable'; });
  }

  el('buildToggle').addEventListener('click', function () {
    var details = el('buildDetails'), isOpen = !details.hidden;
    details.hidden = isOpen;
    el('buildToggle').setAttribute('aria-expanded', String(!isOpen));
  });

  function buildStageInputs() {
    var wrap = el('stageInputs');
    var pid = el('product').value;
    if (!pid) { wrap.innerHTML = '<div class="muted">Pick a product to see its stages.</div>'; return; }
    var line = PLINE[pid];
    var stages = LINES[line] || [];
    if (!stages.length) {
      // Almost always a schema mismatch: the sheet assigns this product to a
      // line the deployed backend no longer defines. Name both sides rather
      // than showing an empty box, which says nothing about what to fix.
      var known = Object.keys(LINES);
      wrap.innerHTML = '<div class="muted">No stages for line <b>'
        + escapeHtml(line || '(blank)') + '</b>.<br>The backend defines: '
        + escapeHtml(known.length ? known.join(', ') : '(none)') + '.<br>'
        + 'Fix the product\'s <b>Line</b> cell in the sheet, or run '
        + '<b>Aquamentor → Migrate to Blank → Exo/Standard</b> if the sheet '
        + 'predates the current backend.</div>';
      return;
    }
    // Hours is optional per stage. Left blank the day still records production,
    // it just can't contribute to a units/hour rate.
    wrap.innerHTML = '<div class="stage-head"><span></span><span>done</span><span>hrs</span><span></span></div>'
      + stages.map(function (s) {
          var st = escapeHtml(s);
          // A note per stage, hidden behind the pencil so the common case
          // (numbers only) stays three taps. "Boxed: ran out of tape" lands
          // on that row in StageLog, not in a shared day note.
          return '<div class="stage-row"><span class="stage-row__name">' + st + '</span>'
               + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
               + 'data-stage="' + st + '" placeholder="0">'
               + '<input class="stage-row__hours" type="number" inputmode="decimal" min="0" step="any" '
               + 'data-hours="' + st + '" placeholder="—">'
               + '<button type="button" class="stage-row__note-btn" data-note-for="' + st + '" title="Note for this stage">\u270e</button>'
               + '<input class="stage-row__note" type="text" maxlength="200" data-note="' + st + '" '
               + 'placeholder="Note for ' + st + '\u2026" hidden>'
               + '</div>';
        }).join('');
  }
  el('product').addEventListener('change', buildStageInputs);
  el('stageInputs').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-note-for]');
    if (!b) return;
    var box = document.querySelector('#stageInputs [data-note="' + b.getAttribute('data-note-for') + '"]');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) box.focus();
  });

  /* ---- Submit the day ---------------------------------------------------- */
  el('dayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var counts = {}, hours = {}, total = 0;
    document.querySelectorAll('#stageInputs [data-stage]').forEach(function (inp) {
      var v = parseInt(inp.value, 10);
      if (v > 0) { counts[inp.getAttribute('data-stage')] = v; total += v; }
    });
    document.querySelectorAll('#stageInputs [data-hours]').forEach(function (inp) {
      var stage = inp.getAttribute('data-hours');
      var h = Number(inp.value);
      // Only meaningful next to a count — hours with no output isn't a rate.
      if (inp.value !== '' && h > 0 && counts[stage]) hours[stage] = h;
    });
    var stageNotes = {};
    document.querySelectorAll('#stageInputs [data-note]').forEach(function (inp) {
      var stage = inp.getAttribute('data-note');
      var t = (inp.value || '').trim();
      // A note without a count has no row to sit on — it goes with the day.
      if (t && counts[stage]) stageNotes[stage] = t;
    });
    var payload = {
      action: 'submitDay',
      workDate: el('workDate').value,
      employee: el('employee').value,
      productId: el('product').value,
      counts: JSON.stringify(counts),
      hours: JSON.stringify(hours),
      notes: el('notes').value,
      stageNotes: JSON.stringify(stageNotes)
    };
    // A double-tap and a genuine second batch are identical in the data, and
    // only the person at the phone knows which this is. Ask, don't block.
    var already = (TODAY[payload.productId] || {});
    var repeats = Object.keys(counts).filter(function (st) { return already[st] > 0; });
    if (repeats.length) {
      var msg = repeats.map(function (st) {
        return '\u2022 ' + st + ': ' + already[st] + ' already logged, adding ' + counts[st];
      }).join('\n');
      if (!window.confirm('Already logged today for this product:\n\n' + msg
            + '\n\nSubmit anyway? (Cancel if you tapped twice.)')) return;
    }

    if (!payload.workDate)  { toast('Pick the work date'); return; }
    if (!payload.employee)  { toast('Pick who you are'); return; }
    if (!payload.productId) { toast('Pick a product'); return; }
    if (total <= 0)         { toast('Enter at least one stage count'); return; }

    // Stamped once and kept with the entry, so a retry of this exact
    // submission is recognised by the backend and not logged twice.
    payload.clientId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

    var btn = el('dayBtn'); btn.disabled = true; btn.textContent = 'Submitting…';
    el('dayResult').hidden = true;
    api(payload).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Submit failed');
      showDayResult(data);
      // Reset for the next product (keep employee + date so they can log another).
      el('product').selectedIndex = 0;
      el('notes').value = '';
      buildStageInputs();   // back to "pick a product" until they choose the next
      loadToday();          // Today's totals now includes what they just logged
    }).catch(function (err) {
      if (isNetworkError(err)) {
        /* Shop-floor wifi. The entry is not lost: it waits on this phone and
         * goes when the network is back. Whether the server actually got this
         * one before the line dropped does not matter — the clientId makes the
         * resend a no-op if it did. */
        enqueueDay(payload);
        el('product').selectedIndex = 0; el('notes').value = ''; buildStageInputs();
        toast('No signal — saved on this phone, will send when back online');
      } else {
        toast('⚠ ' + err.message);
      }
    }).then(function () { btn.disabled = false; btn.textContent = 'Submit My Day'; });
  });

  function isNetworkError(err) { return /network|timed out/i.test(String(err && err.message)); }

  var QUEUE_KEY = 'aq_day_queue';
  function readQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
  function writeQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {} renderQueue(); }
  function enqueueDay(payload) { var q = readQueue(); q.push(payload); writeQueue(q); }

  function renderQueue() {
    var q = readQueue(), b = el('queueBanner');
    b.hidden = !q.length;
    if (!q.length) return;
    el('queueText').textContent = q.length + ' entr' + (q.length === 1 ? 'y' : 'ies')
      + ' waiting to send: ' + q.map(function (p) {
          var name = (el('product').querySelector('option[value="' + cssEsc(p.productId) + '"]') || {}).textContent || p.productId;
          return name + ' (' + p.workDate + ')';
        }).join(', ');
  }

  var flushing = false;
  function flushQueue() {
    if (flushing || !API) return;
    var q = readQueue();
    if (!q.length) return;
    flushing = true;
    var p = q[0];
    api(p, 20000).then(function (data) {
      // Sent, or already there (a replay). Either way it is off this phone.
      q.shift(); writeQueue(q);
      if (data.ok) toast('Sent: ' + (data.replayed ? 'already logged' : data.message));
      else toast('⚠ Server refused a queued entry: ' + (data.error || 'unknown'));
      loadToday();
      flushing = false;
      flushQueue();
    }).catch(function (err) {
      flushing = false;
      if (!isNetworkError(err)) { q.shift(); writeQueue(q); toast('⚠ ' + err.message); flushQueue(); }
      // Network still down: leave it and try again on the next online event.
    });
  }
  window.addEventListener('online', flushQueue);
  el('queueRetry').addEventListener('click', flushQueue);

  function showDayResult(data) {
    var html = '<div class="result__ok">✓ ' + escapeHtml(data.message) + '</div>';
    if (data.logged && data.logged.length) {
      html += '<div class="result__label">Logged</div><ul class="result__list">';
      data.logged.forEach(function (l) {
        html += '<li><span>' + escapeHtml(l.stage) + '</span><span class="result__num">' + l.qty + '</span></li>';
      });
      html += '</ul>';
    }
    if (data.consumed && data.consumed.length) {
      html += '<div class="result__label">Materials deducted</div><ul class="result__list">';
      data.consumed.forEach(function (c) {
        html += '<li><span>' + escapeHtml(c.name) + '</span><span class="result__num">−' + fmt(c.used) + ' '
             + escapeHtml(c.unit) + ' → ' + fmt(c.onHand) + '</span></li>';
      });
      html += '</ul>';
    }
    // Backstop for the pre-submit confirm — catches a stale Today's-totals
    // cache, or two people logging the same stage from different phones.
    if (data.duplicates && data.duplicates.length) {
      html += '<div class="result__dup"><b>Already logged today</b><ul>'
           + data.duplicates.map(function (x) {
               return '<li>' + escapeHtml(x.stage) + ' — ' + fmt(x.priorQty)
                    + ' by ' + escapeHtml(x.priorBy || 'someone')
                    + ', now <b>' + fmt(x.newTotal) + '</b> total</li>';
             }).join('')
           + '</ul>If that was a double-tap, delete the extra row in StageLog.</div>';
    }
    if (data.warnings && data.warnings.length) {
      html += '<div class="result__warn">⚠ ' + data.warnings.map(escapeHtml).join('<br>⚠ ') + '</div>';
    }
    html += '<div class="result__hint">Pick another product above to keep logging today →</div>';
    el('dayResult').innerHTML = html; el('dayResult').hidden = false;
  }

  /* ---- Overview ---------------------------------------------------------- */
  function loadOverview() {
    var body = el('overviewBody'); body.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'overview' }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Could not load overview');
      var html = '';
      var runway = data.runway || {};
      var lastFamily = null;
      /* Twenty-one products, most of them at zero on any given week. A product
       * is "active" if anything has ever been completed on it, anything is
       * queued, or it has a baseline. The rest are one tap away, not gone. */
      var all = data.products || [];
      var active = all.filter(function (pr) {
        return pr.baselineAt || pr.finished > 0 || pr.stages.some(function (s) { return s.completed > 0 || s.waiting > 0; });
      });
      var hidden = all.length - active.length;
      var showAll = OV.showAll || !active.length;
      html += '<div class="ov-toolbar"><span>' + (showAll ? all.length + ' products' : active.length + ' active')
        + '</span>' + (hidden > 0 ? '<button type="button" class="inv-mini" id="ovToggle">'
        + (showAll ? 'Active only' : 'Show all ' + all.length) + '</button>' : '') + '</div>';
      (showAll ? all : active).forEach(function (pr) {
        var fam = pr.family || 'Other';
        if (fam !== lastFamily) {
          html += '<div class="ov-family">' + escapeHtml(fam) + '</div>';
          lastFamily = fam;
        }
        html += '<div class="ov-card"><div class="ov-card__head">' + escapeHtml(pr.name)
             + '<span class="ov-card__meta">'
             + (pr.feedsFrom ? 'from ' + escapeHtml(pr.feedsFrom) + ' · ' : '')
             + 'finished ' + pr.finished
             + (pr.baselineAt ? ' · WIP base ' + escapeHtml(pr.baselineAt)
                              : ' · <b>no WIP baseline</b>')
             + '</span></div>'
             + '<table class="ov-table"><thead><tr><th>Stage</th><th>Done</th><th>WIP</th><th>Target</th><th>Next day</th></tr></thead><tbody>';
        pr.stages.forEach(function (s) {
          html += '<tr' + (s.starved ? ' class="ov-starved"' : '') + '><td>' + escapeHtml(s.stage) + '</td>'
               + '<td>' + fmt(s.completed) + '</td>'
               + '<td>' + (s.waiting === null ? '—' : fmt(s.waiting)) + '</td>'
               + '<td><button type="button" class="ov-target" title="Tap to change" data-tpid="' + escapeHtml(pr.productId)
               +   '" data-tstage="' + escapeHtml(s.stage) + '" data-tcur="' + fmt(s.target) + '">' + fmt(s.target) + '</button></td>'
               + '<td class="ov-goal">' + fmt(s.suggest) + (s.starved ? ' <span class="ov-flag">↑short</span>' : '') + '</td></tr>';
        });
        // Runway: what the material on hand can still support, and what runs
        // out first. The constraint is the actionable half — "webbing is low"
        // is a nag, "webbing stops the line in 53 units" is a decision.
        var rw = runway[pr.productId];
        if (rw) {
          html += '<div class="runway">';
          if (rw.buildable === null) {
            html += '<span class="runway__none">No counted materials — runway unknown</span>';
          } else if (rw.negative && rw.negative.length) {
            /* A material below zero is not a shortage you can plan around, it
             * is a count that never happened — the recipe has been deducting
             * against an opening balance nobody set. Saying "0 buildable"
             * alone would read as "we are out of foam", which is probably
             * false and would send someone to buy foam they already have. */
            html += '<span class="runway__n">0</span> buildable — <b>'
                 + escapeHtml(rw.negative[0].name) + '</b> is '
                 + fmt(rw.negative[0].owed) + ' ' + escapeHtml(rw.negative[0].unit || '')
                 + ' below zero'
                 + (rw.negative.length > 1 ? ', and ' + (rw.negative.length - 1) + ' more' : '')
                 + '<div class="runway__warn">Below zero means never counted, not empty. '
                 + 'Count it on the Inventory tab and this becomes a real number.</div>';
          } else {
            html += '<span class="runway__n">' + fmt(rw.buildable) + '</span> buildable'
                 + (rw.constraint ? ' · limited by <b>' + escapeHtml(rw.constraint.name) + '</b> ('
                     + fmt(rw.constraint.onHand) + ' ' + escapeHtml(rw.constraint.unit || '')
                     + ' ÷ ' + fmt(rw.constraint.perUnit) + '/unit)' : '');
          }
          if (rw.uncounted && rw.uncounted.length) {
            html += '<div class="runway__warn">Not counted, so excluded: '
                 + rw.uncounted.map(function (u) { return escapeHtml(u.name); }).join(', ')
                 + '</div>';
          }
          html += '</div>';
        }
        html += '</tbody></table></div>';
      });
      // Low materials
      var low = (data.materials || []).filter(function (m) { return m.low; });
      html += '<div class="ov-card"><div class="ov-card__head">Raw materials to reorder</div>';
      if (!low.length) html += '<div class="muted" style="padding:10px">Nothing below its reorder point.</div>';
      else html += '<ul class="result__list" style="padding:0 14px 12px">' + low.map(function (m) {
        return '<li><span>' + escapeHtml(m.name) + '</span><span class="result__num">' + fmt(m.onHand) + ' ' + escapeHtml(m.unit) + '</span></li>';
      }).join('') + '</ul>';
      html += '</div>';
      body.innerHTML = html;
      var tg = el('ovToggle');
      if (tg) tg.addEventListener('click', function () { OV.showAll = !OV.showAll; loadOverview(); });
    }).catch(function (err) { body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message) + '</div>'; });
  }
  var OV = { showAll: false };

  // Targets drift with the order book and "open the sheet, find the row" is
  // enough friction that they don't get updated. A tap on the number is not.
  el('overviewBody').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.ov-target') : null;
    if (!t) return;
    var pid = t.getAttribute('data-tpid'), stage = t.getAttribute('data-tstage'), cur = t.getAttribute('data-tcur');
    var raw = window.prompt('Daily target for ' + stage + ' (' + pid + '):', cur);
    if (raw === null) return;
    var n = Number(raw);
    if (!isFinite(n) || n < 0) { toast('Enter a number, 0 or more'); return; }
    api({ action: 'setTarget', productId: pid, stage: stage, target: n }, 20000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not set target');
        toast(stage + ' target ' + (d.was === null ? 'set to ' : fmt(d.was) + ' → ') + fmt(d.target));
        loadOverview();
      })
      .catch(function (err) { toast('⚠ ' + err.message); });
  });

  /* ---- Receive ----------------------------------------------------------- */
  el('recvForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = { action: 'receive', employee: el('recvEmployee').value, materialId: el('recvMaterial').value,
                    qty: el('recvQty').value, notes: el('recvNotes').value };
    if (!payload.employee)          { toast('Pick who you are'); return; }
    if (!payload.materialId)        { toast('Pick a material'); return; }
    if (!(Number(payload.qty) > 0)) { toast('Enter a quantity'); return; }
    var btn = el('recvBtn'); btn.disabled = true; btn.textContent = 'Adding…'; el('recvResult').hidden = true;
    api(payload).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Receive failed');
      var m = data.material || {};
      el('recvResult').innerHTML = '<div class="result__ok">✓ ' + escapeHtml(data.message) + '</div>'
        + '<div class="result__list"><li><span>' + escapeHtml(m.name || '') + '</span>'
        + '<span class="result__num">now ' + fmt(m.onHand) + ' ' + escapeHtml(m.unit || '') + '</span></li></div>';
      el('recvResult').hidden = false; el('recvForm').reset();
      loadConfig();
      loadReceiving();
    }).catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Add to Stock'; });
  });

  /* ---- Today's totals (employee landing) --------------------------------- */
  function loadToday() {
    var date = el('workDate').value;
    if (!API || !date) return;
    api({ action: 'today', workDate: date }).then(function (d) {
      if (!d.ok) return;
      var card = el('todayCard'), body = el('todayBody');
      el('todayMeta').textContent = d.workDate;
      var me = el('employee').value;
      var mine = (d.people || []).filter(function (p) { return p.name === me; })[0];
      var youLine = me
        ? '<div class="today-you">' + (mine
            ? '<b>' + escapeHtml(me) + ', today:</b> ' + fmt(mine.units) + ' units across ' + mine.entries
              + ' entr' + (mine.entries === 1 ? 'y' : 'ies') + (mine.hours ? ' · ' + fmt(mine.hours) + 'h logged' : ' · no hours logged')
            : '<b>' + escapeHtml(me) + ':</b> nothing logged yet today') + '</div>'
        : '';
      if (!d.products || !d.products.length) {
        body.innerHTML = youLine + '<div class="muted" style="padding:12px">Nothing logged yet today.</div>';
      } else {
        body.innerHTML = youLine + d.products.map(function (pr) {
          // Each chip is a button: tap to take some or all of it back. The
          // alternative — "delete the row in the sheet" — fixes the count and
          // leaves the materials deducted forever.
          var chips = pr.rows.filter(function (r) { return r.qty > 0; }).map(function (r) {
            return '<button type="button" class="today-chip today-chip--undo" title="Tap to reverse"'
              + ' data-undo-pid="' + escapeHtml(pr.productId) + '" data-undo-name="' + escapeHtml(pr.name) + '"'
              + ' data-undo-stage="' + escapeHtml(r.stage) + '" data-undo-qty="' + r.qty + '">'
              + escapeHtml(r.stage) + ' <b>' + fmt(r.qty) + '</b></button>';
          }).join('');
          // "started → finished", never a sum: one chair through three
          // stations is one chair, not three.
          return '<div class="today-prod"><div class="today-prod__name">' + escapeHtml(pr.name)
               + ' <span class="today-prod__total">' + fmt(pr.started) + ' started → '
               + fmt(pr.finished) + ' finished</span></div>'
               + '<div class="today-chips">' + (chips || '<span class="muted">—</span>') + '</div></div>';
        }).join('');
        if (d.notes && d.notes.length) {
          body.innerHTML += '<div class="today-notes"><div class="today-notes__h">Notes</div>'
            + d.notes.map(function (n) {
                return '<div class="today-note"><b>' + escapeHtml(n.stage) + '</b> · '
                  + escapeHtml(n.product) + ' — ' + escapeHtml(n.note)
                  + (n.by ? '<small>' + escapeHtml(n.by) + '</small>' : '') + '</div>';
              }).join('') + '</div>';
        }
      }
      TODAY = {};
      (d.products || []).forEach(function (pr) {
        TODAY[pr.productId] = {};
        (pr.rows || []).forEach(function (r) { TODAY[pr.productId][r.stage] = r.qty; });
      });
      card.hidden = false;
    }).catch(function () {});
  }
  el('workDate').addEventListener('change', loadToday);
  el('employee').addEventListener('change', loadToday);

  el('todayBody').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-undo-stage]') : null;
    if (!t) return;
    var stage = t.getAttribute('data-undo-stage'), max = Number(t.getAttribute('data-undo-qty'));
    var pid = t.getAttribute('data-undo-pid'), name = t.getAttribute('data-undo-name');
    var who = el('employee').value;
    if (!who) { toast('Pick who you are first'); return; }
    var raw = window.prompt('Reverse how many of the ' + fmt(max) + ' ' + stage + ' logged for ' + name + ' today?', String(max));
    if (raw === null) return;
    var n = Number(raw);
    if (!(n > 0) || n > max) { toast('Enter 1 to ' + fmt(max)); return; }
    var reason = window.prompt('Why? (goes in the log)', 'double tap');
    if (reason === null || !reason.trim()) { toast('A reason is required'); return; }
    api({ action: 'reverse', employee: who, by: localStorage.getItem('aq_mgr_name') || who, productId: pid, workDate: el('workDate').value,
          stage: stage, qty: n, reason: reason.trim() }, 30000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not reverse');
        var back = (d.restored || []).map(function (r) { return '+' + fmt(r.restored) + ' ' + r.name; }).join(', ');
        toast('Reversed ' + fmt(n) + ' ' + stage + (back ? ' · ' + back : ''));
        loadToday();
      })
      .catch(function (err) { toast('⚠ ' + err.message); });
  });

  /* ---- Role (employee vs manager) ---------------------------------------- */
  function applyRole() {
    var mgr = localStorage.getItem('aq_role') === 'mgr';
    document.querySelectorAll('.tab[data-mgr]').forEach(function (t) { t.style.display = mgr ? '' : 'none'; });
    el('mgrBtn').textContent = mgr ? '🔓' : '🔒';
    var mgrName = localStorage.getItem('aq_mgr_name');
    el('mgrBtn').title = mgr ? 'Manager mode' + (mgrName ? ' — ' + mgrName : '') + ' (tap to lock)' : 'Manager access';
    el('mgrHint').hidden = mgr;
    showPinNag();
    // The Floor tab is a different page for each role; never show a manager's
    // load to the next person who picks the tab.
    FLOOR.tables = null; FLOOR.who = null;
    if (el('floorWhoWrap')) el('floorWhoWrap').hidden = mgr;
    if (!mgr) {  // if an employee somehow lands on a manager screen, bounce to Log My Day
      var active = document.querySelector('.screen--active');
      if (active && active.id !== 'screen-day') selectScreen('day');
    }
  }
  var lockOutShown = false;
  function lockOut(msg) {
    var was = localStorage.getItem('aq_role') === 'mgr';
    localStorage.removeItem('aq_role'); localStorage.removeItem('aq_mgr_name'); localStorage.removeItem('aq_mgr_token');
    applyRole();
    if (was && !lockOutShown) { lockOutShown = true; toast(msg); }
  }
  el('mgrBtn').addEventListener('click', function () {
    if (localStorage.getItem('aq_role') === 'mgr') {
      lockOut(''); toast('Locked — employee view'); return;
    }
    // Name first, so a personal PIN can be checked against the right
    // person. Blank name means the shared manager PIN, exactly as before.
    var name = window.prompt('Your name (blank for the shared manager PIN):', localStorage.getItem('aq_mgr_name') || el('employee').value || '');
    if (name == null) return;
    var pin = window.prompt('PIN:');
    if (pin == null) return;
    api({ action: 'auth', name: name.trim(), pin: pin }).then(function (d) {
      if (d && d.ok) {
        localStorage.setItem('aq_role', 'mgr');
        if (d.name) localStorage.setItem('aq_mgr_name', d.name); else localStorage.removeItem('aq_mgr_name');
        if (d.token) localStorage.setItem('aq_mgr_token', d.token); else localStorage.removeItem('aq_mgr_token');
        lockOutShown = false;
        applyRole();
        toast('Unlocked' + (d.name ? ' as ' + d.name : '') + (d.personal ? '' : ' (shared PIN)'));
      } else toast('Wrong PIN');
    }).catch(function (err) { toast('⚠ ' + err.message); });
  });

  /* ---- Tabs -------------------------------------------------------------- */
  function selectScreen(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('tab--active'); });
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('screen--active'); });
    var tab = document.querySelector('.tab[data-screen="' + name + '"]');
    if (tab) tab.classList.add('tab--active');
    el('screen-' + name).classList.add('screen--active');
    if (name === 'summary') { loadSummary(); loadFixups(); }
    if (name === 'floor') loadFloor();
    if (name === 'overview') loadOverview();
    if (name === 'capacity') { loadCapacity(); loadCrew(); }
    if (name === 'receive') loadReceiving();
    if (name === 'inventory') loadInventory();
    if (name === 'buy') loadBuy();
    if (name === 'wip') buildWipRows();
    if (name === 'day') loadToday();
  }
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { selectScreen(tab.getAttribute('data-screen')); });
  });

  el('refreshBtn').addEventListener('click', function () {
    loadConfig();
    if (el('screen-overview').classList.contains('screen--active')) loadOverview();
    toast('Refreshed');
  });


  /* ---- Inventory: look at current stock, and correct it ------------------ */
  /* One screen, two jobs, because on the floor they are the same job: you look
   * at the numbers *because* you are about to fix them.
   *
   * Every row carries the estimate, a box for the real number, and the gap
   * between them computed as you type. The gap has to be visible at the shelf —
   * that is the only moment when "that can't be right, let me recount" costs
   * nothing. Discovering it in a confirmation screen back at the desk means
   * either walking back or filing a number you don't believe.
   *
   * DIRECTION. The gap is shown in words — "12 short", "5 extra" — never as a
   * bare signed number. CountLog stores variance as estimate − counted, so
   * "short" is filed as POSITIVE. Two conventions, one screen, is how you end
   * up correcting a recipe in the wrong direction; words don't have that
   * failure mode.
   *
   * Edits live in INV.edits keyed by material, not in the DOM, so filtering and
   * searching can re-render freely without dropping numbers someone has already
   * walked the floor to collect. */
  var INV = { materials: [], summary: {}, filter: 'all', search: '', edits: {}, open: {} };

  function loadInventory() {
    var wrap = el('invRows');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'inventory' }, 20000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load inventory');
      INV.materials = d.materials || [];
      INV.summary = d.summary || {};
      INV.countNext = d.countNext || [];
      renderInvSummary();
      renderInvRows();
    }).catch(function (err) {
      // A backend that predates this screen answers "Unknown action: inventory".
      // Say which half is behind rather than showing a bare error.
      var stale = /unknown action/i.test(err.message);
      wrap.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The Apps Script backend is older than this app — '
                 + 'redeploy it (Deploy → Manage deployments → Edit → New version).' : '')
        + '</div>';
    });
  }

  /* Headline counts, each one also a filter. The numbers that matter here are
   * all "how much of this inventory is not trustworthy yet", so every stat
   * doubles as the way to go fix it. */
  function renderInvSummary() {
    var s = INV.summary;
    var stats = [
      { key: 'all',      n: s.materials,    label: 'materials' },
      { key: 'never',    n: s.neverCounted, label: 'never counted', warn: s.neverCounted > 0 },
      { key: 'negative', n: s.negative,     label: 'negative',      warn: s.negative > 0 },
      { key: 'low',      n: s.low,          label: 'below reorder', warn: s.low > 0 },
      { key: 'drift',    n: s.drifting,     label: 'drifting',      warn: s.drifting > 0 },
      { key: 'next',     n: (INV.countNext || []).length, label: 'count next', warn: false }
    ];
    var html = stats.map(function (st) {
      return '<button type="button" class="inv-stat' + (st.warn ? ' inv-stat--warn' : '')
        + '" data-filter="' + st.key + '"><b>' + fmt(st.n || 0) + '</b>'
        + '<span>' + st.label + '</span></button>';
    }).join('');
    html += '<div class="inv-stat inv-stat--flat"><b>'
      + (s.lastCountAt ? escapeHtml(s.lastCountAt) : 'never')
      + '</b><span>last stocktake'
      + (s.daysSinceLastCount === null || s.daysSinceLastCount === undefined
          ? '' : ' · ' + fmt(s.daysSinceLastCount) + 'd ago')
      + '</span></div>';
    el('invSummary').innerHTML = html;
  }

  function invVisible() {
    var q = INV.search.toLowerCase();
    return INV.materials.filter(function (m) {
      if (q && (String(m.name) + ' ' + String(m.id) + ' ' + String(m.category || ''))
                 .toLowerCase().indexOf(q) === -1) return false;
      switch (INV.filter) {
        case 'never':    return !m.lastCountedAt;
        case 'negative': return m.onHand < 0;
        case 'low':      return !!m.low;
        case 'drift':    return !!m.drifting;
        case 'edited':   return INV.edits[m.id] !== undefined && INV.edits[m.id] !== '';
        case 'next':     return (INV.countNext || []).indexOf(m.id) !== -1;
        default:         return true;
      }
    });
  }

  function renderInvRows() {
    var wrap = el('invRows'), list = invVisible();
    if (!list.length) {
      wrap.innerHTML = '<div class="muted">Nothing matches that filter.</div>';
      updateInvBar();
      return;
    }
    var byCat = {}, order = [];
    list.forEach(function (m) {
      var c = m.category || 'Other';
      if (!byCat[c]) { byCat[c] = []; order.push(c); }
      byCat[c].push(m);
    });
    wrap.innerHTML = order.map(function (cat) {
      return '<div class="count-cat">' + escapeHtml(cat) + '</div>'
        + byCat[cat].map(invRowHtml).join('');
    }).join('');
    list.forEach(function (m) { paintInvDiff(m.id); });
    updateInvBar();
  }

  function invRowHtml(m) {
    var id = escapeHtml(m.id);
    var meta = [];
    if (m.lastCountedAt) {
      meta.push('counted ' + escapeHtml(m.lastCountedAt)
        + (m.daysSinceCount === null ? '' : ' (' + fmt(m.daysSinceCount) + 'd)'));
      if (m.lastVariance !== null) meta.push(varianceWords(m.lastVariance) + ' that time');
    } else {
      meta.push('never counted');
    }
    if (m.supplier) meta.push('from ' + escapeHtml(m.supplier));
    if (m.lastReceivedAt) meta.push('received +' + fmt(m.lastReceivedQty) + ' on ' + escapeHtml(m.lastReceivedAt));
    if (m.reorderPoint) meta.push('reorder at ' + fmt(m.reorderPoint));

    var flags = '';
    if (m.drifting) flags += '<span class="inv-flag inv-flag--drift">' + fmt(m.driftRun)
      + ' counts the same way</span>';
    if (m.low)      flags += '<span class="inv-flag inv-flag--low">low</span>';
    if (m.onHand < 0) flags += '<span class="inv-flag inv-flag--low">negative</span>';

    // "=" fills the estimate in: a shelf that matches is a real, useful count,
    // and typing 172.78 by hand to say "yes, that" invites a typo. Withheld on
    // a negative estimate — copying that in would file nonsense as an actual.
    var same = m.counted && m.onHand >= 0
      ? '<button type="button" class="inv-mini" data-same="' + id + '">= est</button>' : '';
    var hist = m.countsRecorded
      ? '<button type="button" class="inv-mini" data-hist="' + id + '">history ('
        + fmt(m.countsRecorded) + ')</button>' : '';

    return '<div class="inv-row" data-row="' + id + '">'
      + '<div class="inv-row__main">'
      +   '<div class="inv-row__name">' + escapeHtml(m.name)
      +     ' <span class="inv-row__id">' + id + '</span>' + flags + '</div>'
      +   '<div class="inv-row__meta">' + meta.join(' · ') + '</div>'
      +   '<div class="inv-row__acts">' + same + hist + '</div>'
      + '</div>'
      + '<div class="inv-row__est"><span class="inv-lbl">Est.</span>'
      +   '<b class="' + (m.onHand < 0 ? 'inv-neg' : '') + '">'
      +   (m.counted ? fmt(m.onHand) : '—') + '</b>'
      +   '<small>' + escapeHtml(m.unit || '') + '</small></div>'
      + '<div class="inv-row__actual"><span class="inv-lbl">Actual</span>'
      +   '<input class="inv-input" type="number" inputmode="decimal" min="0" step="any" '
      +   'placeholder="qty" data-mat="' + id + '" value="'
      +   escapeHtml(INV.edits[m.id] === undefined ? '' : INV.edits[m.id]) + '"></div>'
      + '<div class="inv-row__diff" data-diff="' + id + '"></div>'
      + '<div class="inv-hist" data-histbox="' + id + '"'
      +   (INV.open[m.id] ? '' : ' hidden') + '>' + invHistHtml(m) + '</div>'
      + '</div>';
  }

  function invHistHtml(m) {
    if (!m.history || !m.history.length) return '';
    return '<table class="inv-hist__t"><thead><tr><th>Date</th><th>Est</th>'
      + '<th>Counted</th><th>Gap</th><th>Who</th></tr></thead><tbody>'
      + m.history.map(function (h) {
          return '<tr><td>' + escapeHtml(h.at) + '</td><td>' + fmt(h.estimated) + '</td>'
            + '<td>' + fmt(h.counted) + '</td><td>' + varianceWords(h.variance)
            + (h.variancePct === null ? '' : ' (' + fmt(Math.abs(h.variancePct)) + '%)')
            + '</td><td>' + escapeHtml(h.by || '—') + '</td></tr>';
        }).join('')
      + '</tbody></table>';
  }

  /* Stored variance is estimate − counted, so positive = the shelf held LESS
   * than the recipe predicted. Rendered as a word so the sign never has to be
   * decoded by whoever is reading it. */
  function varianceWords(v) {
    v = Number(v) || 0;
    if (v === 0) return 'matched';
    return fmt(Math.abs(v)) + (v > 0 ? ' short' : ' extra');
  }

  function invById(id) {
    for (var i = 0; i < INV.materials.length; i++) if (INV.materials[i].id === id) return INV.materials[i];
    return null;
  }

  /* The live gap for one row. Recomputed on every keystroke — cheap, and the
   * alternative (only on blur) means the number someone is reasoning about is
   * the one from before their last correction. */
  function paintInvDiff(id) {
    var cell = document.querySelector('[data-diff="' + cssEsc(id) + '"]');
    if (!cell) return;
    var m = invById(id), raw = INV.edits[id];
    var row = document.querySelector('[data-row="' + cssEsc(id) + '"]');
    if (row) row.classList.toggle('inv-row--edited', raw !== undefined && raw !== '');

    if (raw === undefined || raw === '') { cell.className = 'inv-row__diff'; cell.innerHTML = ''; return; }
    var n = Number(raw);
    if (isNaN(n) || n < 0) {
      cell.className = 'inv-row__diff inv-diff--bad';
      cell.innerHTML = '<span class="inv-lbl">Diff</span><b>not a count</b>';
      return;
    }
    if (!m || !m.counted) {
      // No estimate to differ from — this count creates the baseline instead of
      // correcting one, which is a different act and worth saying so.
      cell.className = 'inv-row__diff inv-diff--new';
      cell.innerHTML = '<span class="inv-lbl">Diff</span><b>first count</b>';
      return;
    }
    var v = Math.round((m.onHand - n) * 100) / 100;          // same sign as CountLog
    var pct = m.onHand === 0 ? null : Math.abs(v / m.onHand) * 100;
    var off = pct !== null && pct >= 10;
    cell.className = 'inv-row__diff'
      + (v === 0 ? ' inv-diff--match' : v > 0 ? ' inv-diff--short' : ' inv-diff--extra')
      + (off ? ' inv-diff--off' : '');
    cell.innerHTML = '<span class="inv-lbl">Diff</span><b>' + varianceWords(v) + '</b>'
      + (off ? '<small>' + fmt(pct) + '% off</small>' : '');
  }

  function updateInvBar() {
    var short = 0, extra = 0, match = 0, first = 0, n = 0;
    Object.keys(INV.edits).forEach(function (id) {
      var raw = INV.edits[id];
      if (raw === '' || raw === undefined) return;
      var v = Number(raw);
      if (isNaN(v) || v < 0) return;
      n++;
      var m = invById(id);
      if (!m || !m.counted) { first++; return; }
      var d = m.onHand - v;
      if (d > 0) short++; else if (d < 0) extra++; else match++;
    });
    var parts = [];
    if (short) parts.push(short + ' short');
    if (extra) parts.push(extra + ' extra');
    if (match) parts.push(match + ' matching');
    if (first) parts.push(first + ' first count' + (first === 1 ? '' : 's'));
    el('invBarText').textContent = n
      ? n + ' counted — ' + parts.join(', ')
      : 'Nothing entered yet';
    el('invBtn').disabled = !n;
  }

  // Attribute selectors need the id escaped; material ids are tame today, but a
  // stray quote in a sheet cell shouldn't be able to break the screen.
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  el('invRows').addEventListener('input', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-mat');
    if (!id) return;
    INV.edits[id] = e.target.value;
    paintInvDiff(id);
    updateInvBar();
  });

  el('invRows').addEventListener('click', function (e) {
    var same = e.target.getAttribute && e.target.getAttribute('data-same');
    if (same) {
      var m = invById(same);
      if (!m) return;
      INV.edits[same] = String(m.onHand);
      var box = document.querySelector('[data-mat="' + cssEsc(same) + '"]');
      if (box) box.value = INV.edits[same];
      paintInvDiff(same); updateInvBar();
      return;
    }
    var hist = e.target.getAttribute && e.target.getAttribute('data-hist');
    if (hist) {
      var panel = document.querySelector('[data-histbox="' + cssEsc(hist) + '"]');
      if (!panel) return;
      INV.open[hist] = panel.hidden;
      panel.hidden = !panel.hidden;
    }
  });

  el('invSearch').addEventListener('input', function () {
    INV.search = el('invSearch').value.trim();
    renderInvRows();
  });

  function setInvFilter(f) {
    INV.filter = f;
    document.querySelectorAll('#invFilters .inv-chip').forEach(function (c) {
      c.classList.toggle('inv-chip--on', c.getAttribute('data-filter') === f);
    });
    renderInvRows();
  }
  el('invFilters').addEventListener('click', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-filter');
    if (f) setInvFilter(f);
  });
  el('invSummary').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-filter]') : null;
    if (t) setInvFilter(t.getAttribute('data-filter'));
  });

  el('invForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var counts = {}, n = 0;
    Object.keys(INV.edits).forEach(function (id) {
      var raw = INV.edits[id];
      if (raw === '' || raw === undefined) return;   // blank = not counted, leave alone
      var v = Number(raw);
      if (isNaN(v) || v < 0) return;
      counts[id] = v; n++;
    });
    if (!el('invEmployee').value) { toast('Pick who you are'); return; }
    if (!n) { toast('Enter at least one counted quantity'); return; }

    // Every recorded count overwrites an estimate. Cheap to confirm, expensive
    // to undo — the old estimate is gone once the row is written.
    if (!window.confirm('Record ' + n + ' counted material' + (n === 1 ? '' : 's') + '?\n\n'
          + 'This replaces the estimate with your number and logs the difference.')) return;

    var btn = el('invBtn'); btn.disabled = true; btn.textContent = 'Recording…';
    api({ action: 'count', employee: el('invEmployee').value,
          counts: JSON.stringify(counts), notes: el('invNotes').value }, 30000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Count failed');
        var box = el('invResult');
        box.innerHTML = '<div class="result__ok">✓ ' + escapeHtml(d.message) + '</div>'
          + '<ul class="result__list">' + (d.counted || []).map(function (c) {
              var cls = Math.abs(Number(c.variancePct) || 0) >= 10 ? ' count-off' : '';
              return '<li class="' + cls + '"><span>' + escapeHtml(c.name) + '</span>'
                + '<span class="result__num">est ' + fmt(c.estimated) + ' → ' + fmt(c.counted)
                + ' (' + varianceWords(c.variance)
                + (c.variancePct === '' ? '' : ', ' + fmt(Math.abs(Number(c.variancePct))) + '%')
                + ')</span></li>';
            }).join('') + '</ul>'
          + (d.unknown && d.unknown.length
              ? '<div class="result__warn">⚠ Not in the sheet, so skipped: '
                + d.unknown.map(escapeHtml).join(', ') + '</div>' : '')
          + '<div class="result__note">Estimates re-baselined to your counts. '
          + 'Anything off by 10%+ is flagged — a material that misses the same '
          + 'way every count is a BOM number to fix, not shrinkage.</div>';
        box.hidden = false;
        INV.edits = {};
        el('invNotes').value = '';
        loadInventory();
        toast('Count recorded');
      })
      .catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () {
        btn.textContent = 'Record Count';
        // Re-derive rather than blanket-enable: after a successful submit there
        // is nothing left to record, and an enabled button that only produces a
        // scolding toast is worse than a disabled one.
        updateInvBar();
      });
  });


  /* ---- WIP: opening work-in-progress baseline ---------------------------- */
  /* The first stage of a line is deliberately absent. On a variant line its
   * input is the shared blank pool, which the backend already derives from the
   * feeder; on a Blank line it is raw foam, which isn't tracked as WIP. */
  function buildWipRows() {
    var wrap = el('wipRows'), pid = el('wipProduct').value;
    if (!pid) { wrap.innerHTML = '<div class="muted">Pick a product.</div>'; return; }
    var stages = LINES[PLINE[pid]] || [];
    if (stages.length < 2) {
      wrap.innerHTML = '<div class="muted">This line has too few stages to hold WIP between stations.</div>';
      return;
    }
    var rows = stages.slice(1).map(function (s) {
      return { key: s, label: 'Waiting for ' + s };
    });
    rows.push({ key: '(finished)', label: 'Finished, past ' + stages[stages.length - 1] });
    wrap.innerHTML = '<p class="section-label">How many are sitting at each point right now?</p>'
      + rows.map(function (r) {
          return '<label class="stage-row"><span class="stage-row__name">' + escapeHtml(r.label) + '</span>'
               + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
               + 'data-pile="' + escapeHtml(r.key) + '" value="0"></label>';
        }).join('');
  }
  el('wipProduct').addEventListener('change', buildWipRows);

  /* The whole floor in one scroll. Every product, every station, all under
   * one timestamp on the server — which matters, because that timestamp is
   * what decides which logged rows the baseline supersedes. */
  var WALK = { on: false };
  function buildWalk() {
    var wrap = el('walkRows');
    var opts = Array.prototype.slice.call(el('wipProduct').querySelectorAll('optgroup'));
    if (!opts.length) { wrap.innerHTML = '<div class="muted">Products have not loaded yet.</div>'; return; }
    wrap.innerHTML = opts.map(function (g) {
      return '<div class="ov-family">' + escapeHtml(g.label) + '</div>'
        + Array.prototype.slice.call(g.querySelectorAll('option')).map(function (o) {
            var pid = o.value, stages = LINES[PLINE[pid]] || [];
            if (stages.length < 2) return '';
            var rows = stages.slice(1).map(function (s) { return { key: s, label: 'Waiting for ' + s }; });
            rows.push({ key: '(finished)', label: 'Finished, past ' + stages[stages.length - 1] });
            return '<div class="walk-prod" data-walk="' + escapeHtml(pid) + '">'
              + '<div class="walk-prod__h"><b>' + escapeHtml(o.textContent) + '</b>'
              + '<label class="walk-skip"><input type="checkbox" data-skip="' + escapeHtml(pid) + '"> not walked</label></div>'
              + rows.map(function (r) {
                  return '<label class="stage-row"><span class="stage-row__name">' + escapeHtml(r.label) + '</span>'
                    + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
                    + 'data-walk-pid="' + escapeHtml(pid) + '" data-walk-stage="' + escapeHtml(r.key) + '" value="0"></label>';
                }).join('')
              + '</div>';
          }).join('');
    }).join('');
  }
  el('walkToggle').addEventListener('click', function () {
    WALK.on = !WALK.on;
    el('wipSingle').hidden = WALK.on;
    el('walkPanel').hidden = !WALK.on;
    el('walkToggle').textContent = WALK.on ? 'Back to one product at a time' : 'Walk the whole floor instead';
    if (WALK.on) buildWalk();
  });
  el('walkRows').addEventListener('change', function (e) {
    var pid = e.target.getAttribute && e.target.getAttribute('data-skip');
    if (!pid) return;
    var box = document.querySelector('.walk-prod[data-walk="' + cssEsc(pid) + '"]');
    if (box) box.classList.toggle('walk-prod--skip', e.target.checked);
  });
  el('walkForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var who = el('wipEmployee').value;
    if (!who) { toast('Pick who you are'); return; }
    var walk = {}, skipped = 0;
    document.querySelectorAll('.walk-prod').forEach(function (box) {
      var pid = box.getAttribute('data-walk');
      if (box.querySelector('[data-skip]').checked) { skipped++; return; }
      walk[pid] = {};
      box.querySelectorAll('[data-walk-stage]').forEach(function (inp) {
        var v = Number(inp.value); walk[pid][inp.getAttribute('data-walk-stage')] = (isNaN(v) || v < 0) ? 0 : v;
      });
    });
    var n = Object.keys(walk).length;
    if (!n) { toast('Every product is marked not walked'); return; }
    if (!window.confirm('Record opening WIP for ' + n + ' product' + (n === 1 ? '' : 's')
          + (skipped ? ' (' + skipped + ' skipped)' : '') + '?\n\nThis supersedes any earlier baseline for them.')) return;
    var btn = el('walkBtn'); btn.disabled = true; btn.textContent = 'Recording…';
    api({ action: 'wipWalk', employee: who, notes: el('wipNotes').value, walk: JSON.stringify(walk) }, 60000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not record the walk');
        el('wipResult').innerHTML = '<div class="result__ok">✓ ' + escapeHtml(d.message) + '</div>'
          + '<ul class="result__list">' + (d.products || []).map(function (p) {
              return '<li><span>' + escapeHtml(p.name) + '</span><span class="result__num">'
                + p.piles.reduce(function (a, x) { return a + x.qty; }, 0) + ' on the floor</span></li>';
            }).join('') + '</ul>';
        el('wipResult').hidden = false;
        toast('Floor walk recorded');
      })
      .catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Record the whole walk'; });
  });

  el('wipForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!el('wipEmployee').value) { toast('Pick who you are'); return; }
    if (!el('wipProduct').value)  { toast('Pick a product'); return; }
    var piles = {};
    document.querySelectorAll('#wipRows [data-pile]').forEach(function (inp) {
      var v = Number(inp.value);
      piles[inp.getAttribute('data-pile')] = (isNaN(v) || v < 0) ? 0 : v;
    });
    var btn = el('wipBtn'); btn.disabled = true; btn.textContent = 'Recording…';
    api({ action: 'wipBaseline', employee: el('wipEmployee').value,
          productId: el('wipProduct').value, piles: JSON.stringify(piles),
          notes: el('wipNotes').value }, 30000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not record WIP');
        var box = el('wipResult');
        box.innerHTML = '<div class="result__head">' + escapeHtml(d.message) + '</div>'
          + '<ul class="result__list">' + Object.keys(d.completed || {}).map(function (st) {
              return '<li><span>' + escapeHtml(st) + '</span>'
                   + '<span class="result__num">' + fmt(d.completed[st]) + ' through</span></li>';
            }).join('') + '</ul>'
          + '<div class="result__note">These are the cumulative totals the pipeline '
          + 'now starts from. Anything logged before this moment is superseded, so '
          + 'the same units are not counted twice.</div>';
        box.hidden = false;
        toast('Opening WIP recorded');
      })
      .catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Record Opening WIP'; });
  });



  /* ---- Summary: the top layer over everything else ----------------------- */
  /* Three screens each answer their own question well, and none of them
   * answers the first one anybody asks. This is that layer.
   *
   * It ends with how much of itself to believe. Most of these numbers
   * currently rest on figures nobody has established — materials never
   * counted, products with no opening WIP, days logged without hours — and a
   * dashboard that showed them without saying so would be worse than none,
   * because it would be believed. */
  function loadSummary() {
    var body = el('sumBody');
    body.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'summary' }, 30000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load summary');
      body.innerHTML = renderSummary(d);
    }).catch(function (err) {
      var stale = /unknown action/i.test(err.message);
      body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The Apps Script backend is older than this app — paste '
                 + 'Code.gs and cut a new deployment version.' : '') + '</div>';
    });
  }

  /* ---- Floor: the crew's own read of progress, pace and piles ----------
   * Same math as the Floor Report (report-core.js). The backend hands over
   * the tables; nothing here needs a PIN. Likely duplicates are dropped
   * from the numbers and listed for a manager to reverse. */
  var FLOOR = { win: 14, tables: null, at: null, who: null };
  function isMgr() { return localStorage.getItem('aq_role') === 'mgr'; }
  function loadFloor(force) {
    var body = el('floorBody');
    if (!isMgr()) {
      // Crew: your own pace only. The backend sends nobody else's rows.
      var who = el('floorWho').value || el('employee').value;
      if (who && el('floorWho').value !== who) el('floorWho').value = who;
      if (!who) { body.innerHTML = '<div class="muted">Pick your name to see your pace.</div>'; return; }
      if (FLOOR.tables && FLOOR.who === who && !force) { renderMyPace(); return; }
      body.innerHTML = '<div class="muted">Loading…</div>';
      api({ action: 'myPace', name: who }, 45000).then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not load your pace');
        FLOOR.tables = d.tables; FLOOR.at = d.generatedAt; FLOOR.who = d.name;
        renderMyPace();
      }).catch(function (err) { body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message) + '</div>'; });
      return;
    }
    if (FLOOR.tables && FLOOR.who === null && !force) { renderFloor(); return; }
    body.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'floorData' }, 45000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load the floor');
      FLOOR.tables = d.tables; FLOOR.at = d.generatedAt; FLOOR.who = null;
      renderFloor();
    }).catch(function (err) {
      var stale = /unknown action/i.test(err.message);
      body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The backend is older than this app — paste Code.gs and cut a new deployment version.' : '') + '</div>';
    });
  }
  el('floorWin').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-fw]');
    if (b) {
      FLOOR.win = Number(b.getAttribute('data-fw'));
      document.querySelectorAll('#floorWin [data-fw]').forEach(function (x) { x.classList.toggle('inv-chip--on', x === b); });
      if (isMgr()) renderFloor(); else renderMyPace(); return;
    }
    if (e.target.closest && e.target.closest('#floorReload')) loadFloor(true);
  });
  el('floorWho').addEventListener('change', function () { loadFloor(true); });

  /* One person's numbers. Same math as the floor, on their rows only. */
  function renderMyPace() {
    if (!FLOOR.tables || FLOOR.who === null || typeof AQReport === 'undefined') return;
    var r = AQReport.compute(FLOOR.tables, { windowDays: FLOOR.win, dedupe: true });
    var t = r.totals, winLabel = FLOOR.win === 7 ? 'this week' : 'last ' + FLOOR.win + ' days';
    var todayIso = el('workDate').value || '';
    var todayRow = r.days.filter(function (d) { return d.date === todayIso; })[0];
    var h = '<div class="fl-tiles">'
      + '<div class="fl-tile"><span class="inv-lbl">Today</span><b>' + fmt(todayRow ? todayRow.logged : 0) + '</b><small>units logged</small></div>'
      + '<div class="fl-tile"><span class="inv-lbl">' + escapeHtml(winLabel) + '</span><b>' + fmt(t.logged) + '</b><small>' + t.entries + ' entr' + (t.entries === 1 ? 'y' : 'ies') + ' · ' + t.activeDays + ' day' + (t.activeDays === 1 ? '' : 's') + '</small></div>'
      + '<div class="fl-tile"><span class="inv-lbl">Hours</span><b>' + fmt(t.hours) + '</b><small>' + (t.hours ? fmt(t.logged / t.hours) + ' units/hr' : 'add hours to see a rate') + '</small></div>'
      + '</div>';
    var mine = r.stations.filter(function (s) { return s.units > 0; });
    h += sumCard('Your pace by station', 'units per day you worked · tick = station target',
      mine.length ? '<div class="cap-wrap"><table class="fl-table"><thead><tr><th>Station</th><th class="r">/day</th><th></th><th class="r">Target</th><th class="r">Days</th></tr></thead><tbody>'
        + mine.map(function (s) {
          var ref = Math.max(s.perDay || 0, s.target || 0, 1), w = s.perDay ? Math.min(100, 100 * s.perDay / ref) : 0, tk = s.target ? 100 * s.target / ref : null;
          return '<tr><td>' + escapeHtml(s.stage) + '<br><small class="muted">' + escapeHtml(s.line) + '</small></td><td class="r"><b>' + fmt(s.perDay) + '</b></td>'
            + '<td><div class="fl-bar"><i class="' + (s.target && s.perDay >= s.target ? 'over' : '') + '" style="width:' + w + '%"></i>' + (tk !== null ? '<em style="left:' + tk + '%"></em>' : '') + '</div></td>'
            + '<td class="r">' + (s.target ? fmt(s.target) : '—') + '</td><td class="r">' + s.daysObserved + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="muted" style="padding:8px 0">Nothing logged ' + escapeHtml(winLabel) + '.</div>');
    var days = r.days, max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.logged; })));
    h += sumCard('Your units per day', winLabel,
      '<div class="fl-chart">' + days.map(function (d) {
        return '<div class="fl-col" title="' + escapeHtml(d.date + ': ' + d.logged + ' logged') + '"><i style="height:' + Math.round(100 * d.logged / max) + '%"></i><span>' + (d.logged ? fmt(d.logged) : '') + '</span><small>' + d.date.slice(8) + '</small></div>';
      }).join('') + '</div>');
    if (r.duplicateExtra > 0) h += '<div class="fl-note">' + fmt(r.duplicateExtra) + ' units look like the same entry saved twice and are not counted here. Tell a manager if that was two real batches.</div>';
    el('floorBody').innerHTML = h;
  }
  function floorSev(days) { return days === null ? 'unk' : days >= 5 ? 'crit' : days >= 2 ? 'warn' : 'ok'; }
  function renderFloor() {
    if (!FLOOR.tables || typeof AQReport === 'undefined') return;
    var r = AQReport.compute(FLOOR.tables, { windowDays: FLOOR.win, dedupe: true });
    var t = r.totals, h = '';
    var winLabel = FLOOR.win === 7 ? 'this week' : 'last ' + FLOOR.win + ' days';

    h += '<div class="fl-tiles">'
      + '<div class="fl-tile"><span class="inv-lbl">Finished</span><b>' + fmt(t.finished) + '</b><small>' + winLabel + '</small></div>'
      + '<div class="fl-tile"><span class="inv-lbl">Logged</span><b>' + fmt(t.logged) + '</b><small>' + t.entries + ' entries · ' + t.activeDays + ' day' + (t.activeDays === 1 ? '' : 's') + '</small></div>'
      + '<div class="fl-tile"><span class="inv-lbl">Hours</span><b>' + fmt(t.hours) + '</b><small>' + t.hourRows + ' of ' + t.entries + ' entries</small></div>'
      + '</div>';

    // Piles: where work is waiting, worst first.
    var bns = r.bottlenecks.filter(function (b) { return b.waiting >= 1; }).slice(0, 8);
    h += sumCard('Where work is piling up', 'days to clear at the logged pace',
      bns.length ? bns.map(function (b) {
        var sev = floorSev(b.daysToClear);
        return '<div class="fl-pile fl-pile--' + sev + '"><div class="fl-pile__main"><b>' + escapeHtml(b.product) + '</b>'
          + '<span>' + fmt(b.waiting) + ' waiting at <b>' + escapeHtml(b.stage) + '</b>' + (b.rate ? ' · ' + fmt(b.rate) + '/day' : ' · no pace yet') + '</span>'
          + (b.anomalies.length ? '<small>Stages logged out of order (' + escapeHtml(b.anomalies.map(function (a) { return a.stage; }).join(', ')) + ') — pile size is a guess until the floor is counted on the WIP tab.</small>' : '')
          + '</div><div class="fl-pile__days"><b>' + (b.daysToClear === null ? '—' : fmt(b.daysToClear)) + '</b><small>days</small></div></div>';
      }).join('') : '<div class="muted" style="padding:8px 0">Nothing is waiting anywhere.</div>');
    var poolNotes = Object.keys(r.pools).filter(function (k) { return r.pools[k].uncommitted < 0; }).map(function (k) {
      var p = r.pools[k];
      return '<div class="fl-note">' + escapeHtml(p.feeder.ProductName) + ': variants have taken <b>' + fmt(p.taken) + '</b> from a pool showing <b>' + fmt(p.finished) + '</b> finished. The blank\'s last stage is not being logged.</div>';
    }).join('');
    if (poolNotes) h += poolNotes;

    // Stations: pace vs target.
    var lineOrder = [], byLine = {};
    r.stations.forEach(function (s) { if (!(s.units > 0 || s.target)) return; if (!byLine[s.line]) { byLine[s.line] = []; lineOrder.push(s.line); } byLine[s.line].push(s); });
    h += sumCard('Pace by station', 'units per active day · tick = target',
      '<div class="cap-wrap"><table class="fl-table"><thead><tr><th>Station</th><th class="r">/day</th><th></th><th class="r">Target</th><th class="r">Days</th></tr></thead><tbody>'
      + lineOrder.map(function (line) {
        return '<tr><td class="fl-line" colspan="5">' + escapeHtml(line) + '</td></tr>' + byLine[line].map(function (s) {
          var ref = Math.max(s.perDay || 0, s.target || 0, 1), w = s.perDay ? Math.min(100, 100 * s.perDay / ref) : 0, tk = s.target ? 100 * s.target / ref : null;
          return '<tr><td>' + escapeHtml(s.stage) + '</td><td class="r"><b>' + (s.perDay === null ? '—' : fmt(s.perDay)) + '</b></td>'
            + '<td><div class="fl-bar"><i class="' + (s.target && s.perDay >= s.target ? 'over' : '') + '" style="width:' + w + '%"></i>' + (tk !== null ? '<em style="left:' + tk + '%"></em>' : '') + '</div></td>'
            + '<td class="r">' + (s.target ? fmt(s.target) : '—') + '</td><td class="r">' + s.daysObserved + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div>');

    // Finished per day.
    var days = r.days, max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.finished; })));
    h += sumCard('Finished per day', winLabel,
      '<div class="fl-chart">' + days.map(function (d) {
        var hh = Math.round(100 * d.finished / max);
        return '<div class="fl-col" title="' + escapeHtml(d.date + ': ' + d.finished + ' finished, ' + d.logged + ' logged') + '"><i style="height:' + hh + '%"></i><span>' + (d.finished ? fmt(d.finished) : '') + '</span><small>' + d.date.slice(8) + '</small></div>';
      }).join('') + '</div>');

    // Trust.
    var oo = r.pipelines.filter(function (p) { return p.anomalies.length; });
    var trust = [];
    if (r.duplicates.some(function (d) { return d.open > 0; })) trust.push('<b>' + fmt(r.duplicateExtra) + ' units</b> look like repeated entries and are left out here. A manager can reverse them from Summary.');
    if (oo.length) trust.push('Stages were logged out of order on <b>' + oo.length + ' product' + (oo.length === 1 ? '' : 's') + '</b>. Count the floor on the WIP tab to reset the piles.');
    if (!r.baselines) trust.push('No floor count on record yet. Piles are built from the log alone.');
    trust.push(t.hourRows + ' of ' + t.entries + ' entries carry hours, so pace is per active day, not per hour.');
    h += sumCard('How much to trust this', '', '<ul class="fl-trust">' + trust.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>');
    el('floorBody').innerHTML = h;
  }

  /* ---- Fix-ups (manager): reverse repeated entries in one tap ------------ */
  function loadFixups() {
    var box = el('fixups'); if (!box) return;
    var go = function () {
      var r = AQReport.compute(FLOOR.tables, { windowDays: 0, dedupe: false });
      var open = r.duplicates.filter(function (d) { return d.open > 0; });
      box.innerHTML = sumCard('Fix-ups', open.length ? open.length + ' repeated entr' + (open.length === 1 ? 'y' : 'ies') : 'nothing to fix',
        open.length ? '<div class="muted small" style="margin-bottom:6px">Same person, product, stage, quantity and day logged more than once. Reversing puts the materials back too.</div>'
          + open.map(function (d, i) {
            return '<div class="fix-row"><div><b>' + escapeHtml(d.who) + '</b> · ' + escapeHtml(d.name) + '<br><span class="muted">' + escapeHtml(d.stage) + ' ' + fmt(d.qty) + ' on ' + escapeHtml(d.date) + ' — logged ' + d.times + '×</span></div>'
              + '<button type="button" class="inv-mini" data-fix="' + i + '">Reverse ' + fmt(d.open) + '</button></div>';
          }).join('') : '<div class="muted small">No repeated entries in the log.</div>');
      box.querySelectorAll('[data-fix]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var d = open[Number(btn.getAttribute('data-fix'))];
          if (!window.confirm('Reverse ' + d.open + ' ' + d.stage + ' for ' + d.name + ' on ' + d.date + '?\n\nLogged ' + d.times + ' times by ' + d.who + '. One stays, ' + d.open + ' comes off and the materials go back.')) return;
          btn.disabled = true; btn.textContent = 'Reversing…';
          api({ action: 'reverse', employee: d.who, by: localStorage.getItem('aq_mgr_name') || d.who, productId: d.pid, workDate: d.date,
                stage: d.stage, qty: d.open, reason: 'Duplicate entry — logged ' + d.times + ' times' }, 30000).then(function (res) {
            if (!res.ok) throw new Error(res.error || 'Could not reverse');
            toast('Reversed ' + fmt(d.open) + ' ' + d.stage);
            FLOOR.tables = null; loadFloorThen(go);
          }).catch(function (err) { btn.disabled = false; btn.textContent = 'Reverse ' + fmt(d.open); toast('⚠ ' + err.message); });
        });
      });
    };
    loadFloorThen(go);
  }
  function loadFloorThen(fn) {
    if (FLOOR.tables) { fn(); return; }
    api({ action: 'floorData' }, 45000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load');
      FLOOR.tables = d.tables; FLOOR.at = d.generatedAt; fn();
    }).catch(function (err) { var box = el('fixups'); if (box) box.innerHTML = sumCard('Fix-ups', '', '<div class="muted small">⚠ ' + escapeHtml(err.message) + '</div>'); });
  }

  function sumCard(title, meta, inner) {
    return '<div class="sum-card"><div class="sum-card__h">' + escapeHtml(title)
      + (meta ? '<span>' + meta + '</span>' : '') + '</div>' + inner + '</div>';
  }

  function renderSummary(d) {
    var p = d.production, pipe = d.pipeline, inv = d.inventory, buy = d.buying, t = d.trust;
    var html = '';

    /* --- Production --------------------------------------------------- */
    var peak = Math.max(1, Math.max.apply(null, p.days.map(function (x) {
      return Math.max(x.started, x.finished);
    }).concat([1])));
    var bars = p.days.map(function (x) {
      return '<div class="spark__col" title="' + escapeHtml(x.date) + '">'
        + '<div class="spark__bars">'
        +   '<i class="spark__in" style="height:' + Math.round(x.started / peak * 100) + '%"></i>'
        +   '<i class="spark__out" style="height:' + Math.round(x.finished / peak * 100) + '%"></i>'
        + '</div><span>' + escapeHtml(x.date.slice(5)) + '</span></div>';
    }).join('');

    html += sumCard('Last 7 days', 'since ' + escapeHtml(p.since),
      '<div class="sum-figs">'
      + fig(p.started, 'entered the shop', 'new units cut or started')
      + fig(p.finished, 'finished goods', 'off the end of a line, ready to ship')
      + fig(p.activeDays, 'days worked', p.events + ' entries logged')
      + '</div>'
      + (p.days.length
          ? '<div class="spark">' + bars + '</div>'
            + '<div class="spark__key"><i class="spark__in"></i> started '
            + '<i class="spark__out"></i> finished</div>'
          : '<p class="sum-note">Nothing logged in the last 7 days.</p>'));

    /* --- What is on the floor ------------------------------------------ */
    var big = pipe.biggest;
    html += sumCard('On the floor', pipe.productsTracked + ' products',
      '<div class="sum-figs">'
      + fig(pipe.wipTotal, 'units in progress', 'waiting between stations')
      + fig(pipe.starvedStages, 'stages starved', 'want more than is queued')
      + '</div>'
      + (big ? '<p class="sum-note"><b>Biggest pile:</b> ' + fmt(big.units) + ' '
             + escapeHtml(big.name) + ' waiting at <b>' + escapeHtml(big.stage)
             + '</b> — that is where the line is stuck.</p>' : '')
      + ((buy.pools || []).length
          ? '<p class="sum-note">' + buy.pools.map(function (x) {
              return fmt(x.units) + ' ' + escapeHtml(x.feeder)
                + ' not yet committed to a variant.';
            }).join(' ') + '</p>' : ''));

    /* --- Stock and buying ---------------------------------------------- */
    html += sumCard('Stock', inv.lastCountAt
        ? 'last counted ' + escapeHtml(inv.lastCountAt)
          + (inv.daysSinceLastCount === null ? '' : ' · ' + fmt(inv.daysSinceLastCount) + 'd ago')
        : 'never counted',
      '<div class="sum-figs">'
      + fig(buy.short, 'to order', 'pipeline needs more than the shelf holds', buy.short > 0)
      + fig(inv.negative, 'below zero', 'no opening baseline', inv.negative > 0)
      + fig(inv.neverCounted, 'never counted', 'of ' + fmt(inv.materials) + ' materials', inv.neverCounted > 0)
      + '</div>'
      + (buy.biggest
          ? '<p class="sum-note"><b>Worst shortfall:</b> ' + escapeHtml(buy.biggest.name)
            + ', short ' + fmt(buy.biggest.short) + ' ' + escapeHtml(buy.biggest.unit || '')
            + '. See the Buy tab.</p>'
          : '<p class="sum-note">Nothing counted is short of what the pipeline needs.</p>'));

    /* --- How much of this to believe ------------------------------------ */
    html += sumCard('How much of this to trust', '',
      '<div class="trust">'
      + trustRow('Materials with a real count', t.materialsCounted, t.materialsTotal,
          'Everything above about stock is an estimate until these are counted.')
      + trustRow('Products with an opening WIP baseline', t.productsWithBaseline, t.productsTracked,
          'Without one, "in progress" assumes the floor was empty when logging began.')
      + trustRow('Day entries carrying hours', t.rowsWithHours, t.stageLogRows,
          'Hours are what turn "we did 60" into "we can do 60 a day".')
      + '</div>');

    return html;
  }

  function fig(n, label, note, warn) {
    return '<div class="sum-fig' + (warn ? ' sum-fig--warn' : '') + '">'
      + '<b>' + fmt(n) + '</b><span>' + escapeHtml(label) + '</span>'
      + (note ? '<small>' + escapeHtml(note) + '</small>' : '') + '</div>';
  }

  function trustRow(label, have, total, why) {
    var pct = total ? Math.round(have / total * 100) : 0;
    return '<div class="trust__row">'
      + '<div class="trust__top"><span>' + escapeHtml(label) + '</span>'
      + '<b>' + fmt(have) + ' / ' + fmt(total) + '</b></div>'
      + '<div class="trust__bar"><i style="width:' + pct + '%"></i></div>'
      + '<small>' + escapeHtml(why) + '</small></div>';
  }


  /* ---- Capacity: rates, bottlenecks, and when an order could ship -------- */
  /* Every line has one stage that sets its pace. Nothing upstream of it can
   * make the line faster, and everything queued up to it has to pass through
   * it first — so "when could 200 ship" is: what is ahead of the bottleneck,
   * plus the 200, divided by the bottleneck's observed pace.
   *
   * The pace is in OBSERVED days — days on which that stage did work — and
   * the promise converts to calendar days by assuming Monday to Friday. That
   * assumption is stated on screen, as is how thin the data behind the rate
   * is: a rate from two afternoons is a rate the way one swallow is a summer. */
  var CAP = { products: [], byId: {} };

  function loadCapacity() {
    var body = el('capBody');
    body.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'capacity' }, 30000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load capacity');
      CAP.products = d.products || [];
      CAP.byId = {};
      CAP.products.forEach(function (p) { CAP.byId[p.id] = p; });
      fillSelectGrouped(el('promProduct'), CAP.products.map(function (p) {
        return { value: p.id, label: p.name, family: p.family };
      }), 'Select a product', d.familyOrder || []);
      renderCapacity(d);
      renderPromise();
    }).catch(function (err) {
      var stale = /unknown action/i.test(err.message);
      body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The Apps Script backend is older than this app — paste '
                 + 'Code.gs and cut a new deployment version.' : '') + '</div>';
    });
  }

  var CONF = {
    none:    ['no rate yet',     'Nothing logged for this line.'],
    partial: ['partly known',    'Some stages have never been logged — the real bottleneck may be one of them.'],
    thin:    ['thin data',       'Every stage has a rate, but from fewer than five days.'],
    ok:      ['five+ days',      '']
  };

  function renderCapacity(d) {
    var html = '', lastFam = null;
    CAP.products.forEach(function (p) {
      if (p.family !== lastFam) { html += '<div class="ov-family">' + escapeHtml(p.family) + '</div>'; lastFam = p.family; }
      var conf = CONF[p.confidence] || CONF.none;
      html += '<div class="ov-card"><div class="ov-card__head">' + escapeHtml(p.name)
        + '<span class="ov-card__meta">'
        + (p.lineRate === null
            ? 'no rate yet'
            : '<b>' + fmt(p.lineRate) + '/day</b> · set by ' + escapeHtml(p.bottleneck.stage))
        + ' · <span class="cap-conf cap-conf--' + escapeHtml(p.confidence) + '">' + conf[0] + '</span>'
        + '</span></div>';
      if (conf[1]) html += '<p class="cap-note">' + escapeHtml(conf[1]) + '</p>';
      // Five columns, not six: a phone is 390px wide and the sixth column —
      // days to clear, the one that matters — was the one falling off the edge.
      html += '<div class="cap-wrap"><table class="ov-table cap-table"><thead><tr><th>Stage</th><th>Rate</th><th>Seen</th><th>Queued</th><th>Clear in</th></tr></thead><tbody>';
      p.stages.forEach(function (s) {
        html += '<tr' + (s.isBottleneck ? ' class="cap-bn"' : '') + '><td>' + escapeHtml(s.stage)
          + (s.isBottleneck ? '<span class="ov-flag cap-flag">bottleneck</span>' : '') + '</td>'
          + '<td>' + (s.unitsPerDay === null ? '—' : fmt(s.unitsPerDay) + '<small>/day</small>')
          + (s.unitsPerHour === null ? '' : '<small class="cap-hr">' + fmt(s.unitsPerHour) + '/hr</small>') + '</td>'
          + '<td>' + (s.daysObserved || 0) + '</td>'
          + '<td>' + (s.waiting === null ? '—' : fmt(s.waiting)) + '</td>'
          + '<td>' + (s.daysToClear === null ? (s.waiting > 0 ? '<span class="cap-unk">no pace</span>' : '—') : fmt(s.daysToClear) + '<small>days</small>') + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    var cov = d.coverage || {};
    html += '<p class="cap-cov">' + fmt(cov.stageLogRows || 0) + ' entries logged, '
      + fmt(cov.rowsWithHours || 0) + ' with hours. Per-hour rates need hours; '
      + 'per-day rates need days. Both need weeks.</p>';
    el('capBody').innerHTML = html;
  }

  /* Calendar date N working days out, Monday to Friday. */
  function addWorkDays(from, n) {
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var left = Math.ceil(n);
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
    return d;
  }

  function renderPromise() {
    var out = el('promOut');
    var p = CAP.byId[el('promProduct').value], qty = Number(el('promQty').value);
    if (!p || !(qty > 0)) { out.className = 'promise__out muted'; out.textContent = 'Pick a product and a quantity.'; return; }
    out.className = 'promise__out';

    var parts = [];
    if (p.lineRate === null) {
      out.innerHTML = '<b>Can\'t say yet.</b> No stage of ' + escapeHtml(p.name)
        + ' has been logged, so there is no pace to divide by. A week of Log My Day fixes that.';
      return;
    }
    var days = (p.aheadOfBottleneck + qty) / p.lineRate;
    var when = addWorkDays(new Date(), days);
    parts.push('<div class="promise__big"><b>' + fmt(Math.ceil(days)) + ' working days</b> → '
      + when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + '</div>');
    parts.push('<div class="promise__why">' + fmt(p.aheadOfBottleneck) + ' already queued ahead of <b>'
      + escapeHtml(p.bottleneck.stage) + '</b> + ' + fmt(qty) + ' new, at '
      + fmt(p.lineRate) + '/day. Mon–Fri assumed.</div>');

    // Materials: the other thing that can say no.
    if (p.negative && p.negative.length) {
      parts.push('<div class="promise__flag promise__flag--warn">Materials unknown — <b>'
        + escapeHtml(p.negative[0].name) + '</b> is below zero (never counted). Count it before promising.</div>');
    } else if (p.buildable !== null && p.buildable < qty) {
      parts.push('<div class="promise__flag promise__flag--warn">Only <b>' + fmt(p.buildable)
        + '</b> buildable from stock — limited by ' + escapeHtml(p.constraint.name)
        + '. Order material or the date above is fiction.</div>');
    } else if (p.uncounted && p.uncounted.length) {
      parts.push('<div class="promise__flag">Some materials have never been counted ('
        + p.uncounted.map(function (u) { return escapeHtml(u.name); }).join(', ') + '), so stock is not checked for them.</div>');
    }
    var conf = CONF[p.confidence] || CONF.none;
    if (p.confidence !== 'ok') {
      parts.push('<div class="promise__flag">Rate is <b>' + conf[0] + '</b>. ' + escapeHtml(conf[1]) + '</div>');
    }
    out.innerHTML = parts.join('');
  }
  el('promProduct').addEventListener('change', renderPromise);
  el('promQty').addEventListener('input', renderPromise);


  /* ---- Deliveries: the half of the ledger that was write-only ------------ */
  var RCV = { filter: '' };

  function loadReceiving() {
    var wrap = el('rcvList');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    var params = { action: 'receiving', limit: 30 };
    if (RCV.filter) params.materialId = RCV.filter;
    api(params, 20000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load deliveries');
      if (!d.deliveries.length) {
        wrap.innerHTML = '<div class="muted">' + (RCV.filter ? 'No deliveries logged for this material.' : 'No deliveries logged yet.') + '</div>';
        return;
      }
      wrap.innerHTML = d.deliveries.map(function (r) {
        return '<div class="rcv-row"><span class="rcv-row__at">' + escapeHtml(r.at) + '</span>'
          + '<span class="rcv-row__what">' + escapeHtml(r.name)
          + '<small>' + escapeHtml(r.by) + (r.notes ? ' · ' + escapeHtml(r.notes) : '') + '</small></span>'
          + '<span class="rcv-row__qty">+' + fmt(r.qty) + '</span></div>';
      }).join('')
      + (d.total > d.deliveries.length
          ? '<div class="rcv-more">Showing ' + d.deliveries.length + ' of ' + d.total + '. Export the full log from the Summary tab.</div>' : '');
    }).catch(function (err) {
      var stale = /unknown action/i.test(err.message);
      wrap.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The backend is older than this app — paste Code.gs and deploy.' : '') + '</div>';
    });
  }
  el('rcvFilter').addEventListener('change', function () { RCV.filter = el('rcvFilter').value; loadReceiving(); });

  /* ---- Crew: who did what ------------------------------------------------- */
  function loadCrew() {
    var wrap = el('crewBody');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'crew', days: 30 }, 20000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load crew');
      if (!d.crew.length) { wrap.innerHTML = '<div class="muted">Nothing logged in the last ' + d.days + ' days.</div>'; return; }
      wrap.innerHTML = '<div class="crew">' + d.crew.map(function (c) {
        var rate = c.unitsPerHour === null
          ? '<span class="crew-card__rate"><small>no hours logged — no rate</small></span>'
          : '<span class="crew-card__rate"><b>' + fmt(c.unitsPerHour) + '</b>/hr <small>over '
            + fmt(c.hours) + 'h · covers ' + fmt(c.hoursCoverage) + '% of output</small></span>';
        return '<div class="crew-card"><div class="crew-card__top">'
          + '<span class="crew-card__name">' + escapeHtml(c.name) + '</span>' + rate + '</div>'
          + '<div class="crew-card__meta">' + fmt(c.units) + ' units · ' + c.entries + ' entries · '
          + c.daysWorked + ' day' + (c.daysWorked === 1 ? '' : 's') + '</div>'
          + '<div class="crew-stages">' + c.stages.map(function (st) {
              return '<span class="crew-stage">' + escapeHtml(st.stage) + ' <b>' + fmt(st.units) + '</b>'
                + (st.unitsPerHour === null ? '' : ' <small>' + fmt(st.unitsPerHour) + '/hr</small>') + '</span>';
            }).join('') + '</div></div>';
      }).join('') + '</div>';
    }).catch(function (err) {
      wrap.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message) + '</div>';
    });
  }

  /* ---- Export: a tab as a CSV, from the phone ------------------------------ */
  /* JSONP cannot carry a file, so the rows come as JSON and the CSV is built
   * here. RFC 4180 quoting: any field holding a comma, a quote or a newline is
   * wrapped in quotes with inner quotes doubled — the one rule that, skipped,
   * turns "1\" Red PP Webbing" into two columns in Excel. */
  function toCsv(headers, rows) {
    var cell = function (v) {
      var t = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    return [headers].concat(rows).map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n';
  }

  function downloadText(name, text) {
    // The BOM makes Excel read UTF-8 correctly (the ″ in 50″ otherwise mangles).
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  document.querySelectorAll('[data-export]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var table = btn.getAttribute('data-export');
      btn.disabled = true;
      el('exportNote').textContent = 'Fetching ' + table + '…';
      api({ action: 'export', table: table }, 60000).then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Export failed');
        var stamp = new Date().toISOString().slice(0, 10);
        downloadText('aquamentor-' + table + '-' + stamp + '.csv', toCsv(d.headers, d.rows));
        el('exportNote').textContent = d.rows.length + ' rows of ' + (d.tab || table) + ' downloaded.';
      }).catch(function (err) {
        el('exportNote').textContent = '⚠ ' + err.message;
      }).then(function () { btn.disabled = false; });
    });
  });

  /* ---- Buy: what the committed work needs ------------------------------- */
  /* The Overview's reorder list answers "what is low". This answers the
   * question that actually precedes a purchase order: "what does the work I
   * have already started need, and do I have it?"
   *
   * Committed demand comes from the backend and needs no assumptions — those
   * units are physically on the floor. The planned column is Dan's, typed in
   * here, and recomputes locally against the per-unit recipes so a what-if
   * costs nothing. Uncounted materials are shown but never called short: you
   * cannot be short of a quantity nobody has ever established. */
  var BUY = { materials: [], perUnit: {}, products: [], pools: [], plan: {} };

  function loadBuy() {
    var wrap = el('buyRows');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'purchasing' }, 25000).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load');
      BUY.materials = d.materials || [];
      BUY.perUnit = d.perUnit || {};
      BUY.products = d.products || [];
      BUY.pools = d.pools || [];
      renderBuyPlan(d.familyOrder || []);
      renderPools();
      renderBuy();
    }).catch(function (err) {
      var stale = /unknown action/i.test(err.message);
      wrap.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message)
        + (stale ? '<br>The Apps Script backend is older than this app — paste '
                 + 'Code.gs and cut a new deployment version.' : '') + '</div>';
    });
  }

  function renderBuyPlan(order) {
    var byFam = {};
    BUY.products.forEach(function (p) {
      (byFam[p.family || 'Other'] = byFam[p.family || 'Other'] || []).push(p);
    });
    var fams = (order || []).filter(function (f) { return byFam[f]; })
      .concat(Object.keys(byFam).filter(function (f) { return (order || []).indexOf(f) === -1; }));

    el('buyPlan').innerHTML =
      '<div class="plan__head">Planning to build <span class="plan__hint">on top of what is already started</span></div>'
      + '<div class="plan__grid">'
      + fams.map(function (f) {
          return byFam[f].map(function (p) {
            return '<label class="plan__row"><span>' + escapeHtml(p.name) + '</span>'
              + '<input class="plan__input" type="number" inputmode="numeric" min="0" step="1" '
              + 'placeholder="0" data-plan="' + escapeHtml(p.id) + '" value="'
              + escapeHtml(BUY.plan[p.id] === undefined ? '' : BUY.plan[p.id]) + '"></label>';
          }).join('');
        }).join('')
      + '</div>';
  }

  function renderPools() {
    if (!BUY.pools.length) { el('buyPools').innerHTML = ''; return; }
    // Called out rather than folded in: these blanks could still become either
    // variant, so charging their downstream materials to one would be a guess
    // and charging them to both would double the order.
    el('buyPools').innerHTML = '<div class="pool">'
      + BUY.pools.map(function (p) {
          return '<b>' + fmt(p.units) + '</b> ' + escapeHtml(p.feeder)
            + ' not yet committed to a variant — their downstream materials are '
            + 'not counted below. Plan them above to include them.';
        }).join('<br>')
      + '</div>';
  }

  /* Planned demand for one material: every planned quantity times that
   * product's whole per-unit recipe. */
  function plannedFor(materialId) {
    var total = 0;
    Object.keys(BUY.plan).forEach(function (pid) {
      var n = Number(BUY.plan[pid]);
      if (!isFinite(n) || n <= 0) return;
      var per = (BUY.perUnit[pid] || {})[materialId];
      if (per) total += n * per;
    });
    return Math.round(total * 100) / 100;
  }

  function renderBuy() {
    var rows = BUY.materials.map(function (m) {
      var planned = plannedFor(m.id);
      var need = Math.round((m.committed + planned) * 100) / 100;
      var short = m.counted ? Math.round((need - m.onHand) * 100) / 100 : null;
      var upTo = short !== null && short > 0
        ? Math.max(short, Math.round((need + m.reorderPoint - m.onHand) * 100) / 100) : 0;
      return { m: m, planned: planned, need: need, short: short, upTo: upTo };
    });

    // Shortest first — the buy list, in the order it costs you.
    rows.sort(function (a, b) {
      var aShort = a.short !== null && a.short > 0, bShort = b.short !== null && b.short > 0;
      if (aShort !== bShort) return aShort ? -1 : 1;
      // Both short: the one that must be ordered soonest first, then by size.
      if (aShort) {
        var ad = a.m.orderByDays === null || a.m.orderByDays === undefined ? 1e9 : a.m.orderByDays;
        var bd = b.m.orderByDays === null || b.m.orderByDays === undefined ? 1e9 : b.m.orderByDays;
        if (ad !== bd) return ad - bd;
      }
      var as = a.short === null ? -1e12 : a.short, bs = b.short === null ? -1e12 : b.short;
      if (bs !== as) return bs - as;
      return b.need - a.need;
    });

    var buying = rows.filter(function (r) { return r.short !== null && r.short > 0; });
    var uncounted = rows.filter(function (r) { return r.short === null && r.need > 0; });
    var fine = rows.filter(function (r) { return r.short !== null && r.short <= 0 && r.need > 0; });
    var idle = rows.filter(function (r) { return r.need === 0; });

    var html = '';
    html += '<div class="buy-tally"><b>' + buying.length + '</b> to order'
         + (uncounted.length ? ' · <b>' + uncounted.length + '</b> unknown (never counted)' : '')
         + ' · <b>' + fine.length + '</b> covered</div>';

    if (buying.length) {
      /* Grouped by supplier, because that is the unit a purchase order is
       * raised in. Materials with no supplier set land in one group with a
       * pointer to the column that fixes it. */
      var bySup = {}, supOrder = [];
      buying.forEach(function (r) {
        var k = r.m.supplier || '';
        if (!bySup[k]) { bySup[k] = []; supOrder.push(k); }
        bySup[k].push(r);
      });
      supOrder.sort(function (a, b) { return (a === '') - (b === '') || a.localeCompare(b); });
      html += '<div class="buy-sec"><div class="buy-sec__h">Order these <span>' + buying.length + '</span></div>'
        + '<p class="buy-sec__note">The pipeline needs more than the shelf holds. One group per supplier — one PO each.</p>'
        + supOrder.map(function (k) {
            var list = bySup[k];
            return '<div class="buy-sup"><div class="buy-sup__h"><b>'
              + (k ? escapeHtml(k) : 'No supplier set')
              + '</b><span>' + list.length + '</span>'
              + '<button type="button" class="inv-mini" data-copy-sup="' + escapeHtml(k) + '">Copy order list</button>'
              + '</div>'
              + (k ? '' : '<p class="buy-sec__note">Fill the <b>Supplier</b> column on RawMaterials and these group themselves.</p>')
              + list.map(buyRow).join('') + '</div>';
          }).join('')
        + '</div>';
      BUY.lastGroups = bySup;
    } else {
      html += '<div class="buy-none">Nothing short — everything in progress is covered.</div>';
    }
    if (uncounted.length) {
      html += buySection('Needed, but never counted', uncounted,
        'These are consumed by work in progress and have no stock figure, so no '
        + 'shortfall can be computed. Count them on the Inventory tab.');
    }
    if (fine.length) html += buySection('Covered', fine, '');
    if (idle.length) {
      html += '<details class="buy-rest"><summary>' + idle.length
           + (idle.length === 1 ? ' material ' : ' materials ')
           + 'nothing in progress needs</summary>'
           + idle.map(buyRow).join('') + '</details>';
    }
    el('buyRows').innerHTML = html;
  }

  function buySection(title, list, note) {
    return '<div class="buy-sec"><div class="buy-sec__h">' + escapeHtml(title)
      + ' <span>' + list.length + '</span></div>'
      + (note ? '<p class="buy-sec__note">' + escapeHtml(note) + '</p>' : '')
      + list.map(buyRow).join('') + '</div>';
  }

  function buyRow(r) {
    var m = r.m;
    var why = (m.sources || []).map(function (s) {
      return fmt(s.units) + ' ' + escapeHtml(s.name) + ' at ' + escapeHtml(s.stage);
    }).join(' · ');
    if (m.supplier) why = 'from ' + escapeHtml(m.supplier) + (why ? ' · ' + why : '');

    // When to place the order: days of stock at the observed burn, less the
    // supplier's lead time. Working days throughout. Nothing shown until the
    // material has a count and a burn; "pace unknown" names the product whose
    // line has no rate yet rather than pretending.
    var when = '', late = false;
    if (m.daysOfStock !== null && m.daysOfStock !== undefined) {
      var stock = Math.round(m.daysOfStock) + 'd of stock';
      if (m.leadDays !== null && m.leadDays !== undefined && m.orderByDays !== null && m.orderByDays !== undefined) {
        late = m.orderByDays <= 0;
        when = (late ? 'order today' : 'order by ' + shortDate(m.orderBy)) + ' — ' + stock + ', ' + m.leadDays + 'd lead';
      } else {
        when = stock + (m.leadDays === null || m.leadDays === undefined ? ' · no lead time set' : '');
      }
    } else if (m.burnUnknownFor && m.burnUnknownFor.length) {
      when = 'pace unknown — no rate yet for ' + escapeHtml(m.burnUnknownFor.join(', '));
    }
    var whenHtml = when ? '<div class="buy-when' + (late ? ' buy-late' : '') + '">' + when + '</div>' : '';

    var verdict;
    if (r.short === null) {
      verdict = '<span class="buy-unknown">never counted</span>';
    } else if (r.short > 0) {
      // Order up to the reorder point where that is the bigger number — buying
      // exactly the shortfall leaves you at zero the day it arrives.
      verdict = '<span class="buy-short">short ' + fmt(r.short) + '</span>'
        + '<small>order ' + fmt(r.upTo) + ' ' + escapeHtml(m.unit || '') + '</small>';
    } else {
      verdict = '<span class="buy-ok">covered</span>'
        + '<small>' + fmt(-r.short) + ' spare</small>';
    }

    return '<div class="buy-row' + (r.short > 0 ? ' buy-row--short' : '') + '">'
      + '<div class="buy-row__main"><div class="buy-row__name">' + escapeHtml(m.name)
      +   ' <span class="buy-row__id">' + escapeHtml(m.id) + '</span></div>'
      +   (why ? '<div class="buy-row__why">' + why + '</div>' : '')
      + '</div>'
      + '<div class="buy-row__n"><span class="inv-lbl">Have</span><b'
      +   (m.onHand < 0 ? ' class="inv-neg"' : '') + '>'
      +   (m.counted ? fmt(m.onHand) : '—') + '</b></div>'
      + '<div class="buy-row__n"><span class="inv-lbl">In progress</span><b>' + fmt(m.committed) + '</b></div>'
      + '<div class="buy-row__n"><span class="inv-lbl">Planned</span><b>' + fmt(r.planned) + '</b></div>'
      + '<div class="buy-row__v">' + verdict + '</div>'
      + whenHtml
      + '</div>';
  }

  // A PO-ready list on the clipboard: one line per material, quantity in its
  // own unit, ready to paste into an email or a supplier portal.
  el('buyRows').addEventListener('click', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-copy-sup');
    if (k === null || k === undefined) return;
    var list = (BUY.lastGroups || {})[k] || [];
    var text = (k ? k : 'Order') + ' — ' + new Date().toISOString().slice(0, 10) + '\n'
      + list.map(function (r) { return r.m.name + ' (' + r.m.id + ') — ' + fmt(r.upTo) + ' ' + (r.m.unit || ''); }).join('\n');
    var done = function () { toast('Copied ' + list.length + ' line' + (list.length === 1 ? '' : 's')); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this:', text); });
    else window.prompt('Copy this:', text);
  });

  el('buyPlan').addEventListener('input', function (e) {
    var pid = e.target.getAttribute && e.target.getAttribute('data-plan');
    if (!pid) return;
    BUY.plan[pid] = e.target.value;
    renderBuy();
  });

  /* ---- Utils ------------------------------------------------------------- */
  function fmt(n) { n = Number(n) || 0; return (Math.round(n * 100) / 100).toLocaleString(); }
  // 'YYYY-MM-DD' -> 'Thu Sep 17'. Parsed as local so the day never shifts.
  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- Go ---------------------------------------------------------------- */
  (function initDate() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    el('workDate').value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();
  applyRole();
  renderBuildInfo();   // show the app version immediately; the rest fills in from ?action=config
  loadConfig();
})();
