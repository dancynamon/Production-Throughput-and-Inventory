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
  var APP_VERSION = '2.5.0';

  var el = function (id) { return document.getElementById(id); };
  var LINES = {};    // line -> [stage names], from config
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
      window[cb] = function (data) { cleanup(); resolve(data); };
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
      LINES = data.lines || {};
      PLINE = {};
      (data.products || []).forEach(function (p) { PLINE[p.id] = p.line || 'Blank'; });
      var emp = data.employees.map(function (n) { return { value: n, label: n }; });
      fillSelect(el('employee'), emp, 'Select your name');
      fillSelect(el('recvEmployee'), emp, 'Select your name');
      fillSelect(el('countEmployee'), emp, 'Select your name');
      fillSelect(el('wipEmployee'), emp, 'Select your name');
      var prodOpts = data.products.map(function (p) { return { value: p.id, label: p.name }; });
      fillSelect(el('product'), prodOpts, 'Select a product');
      fillSelect(el('wipProduct'), prodOpts, 'Select a product');
      fillSelect(el('recvMaterial'), (data.materials || []).map(function (m) {
        return { value: m.id, label: m.name + (m.unit ? ' (' + m.unit + ')' : '') };
      }), 'Select a material');
      buildStageInputs();
      loadToday();
    }).catch(function (err) { renderBuildInfo(); toast('⚠ ' + err.message); });
  }

  /* ---- Build info -------------------------------------------------------- */
  /* A muted line at the bottom of every screen: tap it for the full picture.
   * Everything here is a debugging aid — which shell this device cached, which
   * Apps Script deployment it talks to, and which spreadsheet that deployment
   * is bound to. `backend`, `sheet` and `sheetId` arrive from ?action=config,
   * so they stay blank until the Apps Script side is redeployed. */
  var buildFacts = { backend: null, sheet: null, sheetId: null, buildStamp: null };

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
    wrap.innerHTML = '<div class="stage-head"><span></span><span>done</span><span>hrs</span></div>'
      + stages.map(function (s) {
          var st = escapeHtml(s);
          return '<label class="stage-row"><span class="stage-row__name">' + st + '</span>'
               + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
               + 'data-stage="' + st + '" placeholder="0">'
               + '<input class="stage-row__hours" type="number" inputmode="decimal" min="0" step="any" '
               + 'data-hours="' + st + '" placeholder="—">'
               + '</label>';
        }).join('');
  }
  el('product').addEventListener('change', buildStageInputs);

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
    var payload = {
      action: 'submitDay',
      workDate: el('workDate').value,
      employee: el('employee').value,
      productId: el('product').value,
      counts: JSON.stringify(counts),
      hours: JSON.stringify(hours),
      notes: el('notes').value
    };
    if (!payload.workDate)  { toast('Pick the work date'); return; }
    if (!payload.employee)  { toast('Pick who you are'); return; }
    if (!payload.productId) { toast('Pick a product'); return; }
    if (total <= 0)         { toast('Enter at least one stage count'); return; }

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
    }).catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Submit My Day'; });
  });

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
      (data.products || []).forEach(function (pr) {
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
               + '<td>' + fmt(s.target) + '</td>'
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
    }).catch(function (err) { body.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message) + '</div>'; });
  }

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
      if (!d.products || !d.products.length) {
        body.innerHTML = '<div class="muted" style="padding:12px">Nothing logged yet today.</div>';
      } else {
        body.innerHTML = d.products.map(function (pr) {
          var chips = pr.rows.filter(function (r) { return r.qty > 0; }).map(function (r) {
            return '<span class="today-chip">' + escapeHtml(r.stage) + ' <b>' + r.qty + '</b></span>';
          }).join('');
          return '<div class="today-prod"><div class="today-prod__name">' + escapeHtml(pr.name)
               + ' <span class="today-prod__total">' + pr.total + ' total</span></div>'
               + '<div class="today-chips">' + (chips || '<span class="muted">—</span>') + '</div></div>';
        }).join('');
      }
      card.hidden = false;
    }).catch(function () {});
  }
  el('workDate').addEventListener('change', loadToday);

  /* ---- Role (employee vs manager) ---------------------------------------- */
  function applyRole() {
    var mgr = localStorage.getItem('aq_role') === 'mgr';
    document.querySelectorAll('.tab[data-mgr]').forEach(function (t) { t.style.display = mgr ? '' : 'none'; });
    el('mgrBtn').textContent = mgr ? '🔓' : '🔒';
    el('mgrBtn').title = mgr ? 'Manager mode (tap to lock)' : 'Manager access';
    if (!mgr) {  // if an employee somehow lands on a manager screen, bounce to Log My Day
      var active = document.querySelector('.screen--active');
      if (active && active.id !== 'screen-day') selectScreen('day');
    }
  }
  el('mgrBtn').addEventListener('click', function () {
    if (localStorage.getItem('aq_role') === 'mgr') {
      localStorage.removeItem('aq_role'); applyRole(); toast('Locked — employee view'); return;
    }
    var pin = window.prompt('Manager PIN:');
    if (pin == null) return;
    api({ action: 'auth', pin: pin }).then(function (d) {
      if (d && d.ok) { localStorage.setItem('aq_role', 'mgr'); applyRole(); toast('Manager access unlocked'); }
      else toast('Wrong PIN');
    }).catch(function (err) { toast('⚠ ' + err.message); });
  });

  /* ---- Tabs -------------------------------------------------------------- */
  function selectScreen(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('tab--active'); });
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('screen--active'); });
    var tab = document.querySelector('.tab[data-screen="' + name + '"]');
    if (tab) tab.classList.add('tab--active');
    el('screen-' + name).classList.add('screen--active');
    if (name === 'overview') loadOverview();
    if (name === 'count') loadCountSheet();
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


  /* ---- Count: reconcile estimated vs actual ------------------------------ */
  /* Each row shows the recipe's estimate next to an empty box for the real
   * number. Showing the estimate matters: it lets whoever is counting notice a
   * wild disagreement while they are still standing at the shelf, which is the
   * only moment it is cheap to recheck. Blank means not counted. */
  function loadCountSheet() {
    var wrap = el('countRows');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    api({ action: 'stock' }).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Could not load stock');
      var byCat = {};
      (d.materials || []).forEach(function (m) {
        (byCat[m.category || 'Other'] = byCat[m.category || 'Other'] || []).push(m);
      });
      wrap.innerHTML = Object.keys(byCat).map(function (cat) {
        return '<div class="count-cat">' + escapeHtml(cat) + '</div>'
          + byCat[cat].map(function (m) {
              var est = m.counted ? fmt(m.onHand) : '—';
              var last = m.lastCountedAt
                ? 'last counted ' + escapeHtml(m.lastCountedAt)
                  + (m.lastVariance === null ? ''
                     : ' · var ' + (m.lastVariance > 0 ? '+' : '') + fmt(m.lastVariance))
                : 'never counted';
              return '<label class="count-row">'
                + '<span class="count-row__name">' + escapeHtml(m.name)
                + '<span class="count-row__meta">' + last + '</span></span>'
                + '<span class="count-row__est">est. ' + est + '</span>'
                + '<input class="count-row__input" type="number" inputmode="decimal" '
                + 'min="0" step="any" placeholder="count" data-mat="' + escapeHtml(m.id) + '">'
                + '<span class="count-row__unit">' + escapeHtml(m.unit || '') + '</span>'
                + '</label>';
            }).join('');
      }).join('');
    }).catch(function (err) {
      wrap.innerHTML = '<div class="muted">⚠ ' + escapeHtml(err.message) + '</div>';
    });
  }

  el('countForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var counts = {}, n = 0;
    document.querySelectorAll('#countRows [data-mat]').forEach(function (inp) {
      if (inp.value === '') return;              // blank = not counted, leave alone
      var v = Number(inp.value);
      if (isNaN(v) || v < 0) return;
      counts[inp.getAttribute('data-mat')] = v; n++;
    });
    if (!el('countEmployee').value) { toast('Pick who you are'); return; }
    if (!n) { toast('Enter at least one counted quantity'); return; }

    var btn = el('countBtn'); btn.disabled = true; btn.textContent = 'Recording…';
    api({ action: 'count', employee: el('countEmployee').value,
          counts: JSON.stringify(counts), notes: el('countNotes').value }, 30000)
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Count failed');
        var box = el('countResult');
        box.innerHTML = '<div class="result__head">' + escapeHtml(d.message) + '</div>'
          + '<ul class="result__list">' + (d.counted || []).map(function (c) {
              var sign = c.variance > 0 ? '+' : '';
              var cls  = Math.abs(Number(c.variancePct) || 0) >= 10 ? ' count-off' : '';
              return '<li class="' + cls + '"><span>' + escapeHtml(c.name) + '</span>'
                + '<span class="result__num">est ' + fmt(c.estimated)
                + ' → ' + fmt(c.counted)
                + '  (' + sign + fmt(c.variance)
                + (c.variancePct === '' ? '' : ', ' + sign + fmt(c.variancePct) + '%')
                + ')</span></li>';
            }).join('') + '</ul>'
          + '<div class="result__note">Estimates re-baselined to your counts. '
          + 'Anything off by 10%+ is flagged — a material that drifts the same '
          + 'way every count is a BOM number to fix, not shrinkage.</div>';
        box.hidden = false;
        loadCountSheet();
        toast('Count recorded');
      })
      .catch(function (err) { toast('⚠ ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Record Count'; });
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

  /* ---- Utils ------------------------------------------------------------- */
  function fmt(n) { n = Number(n) || 0; return (Math.round(n * 100) / 100).toLocaleString(); }
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
