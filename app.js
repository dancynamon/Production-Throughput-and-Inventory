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
  var APP_VERSION = '2.9.0';

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
      LINES = data.lines || {};
      PLINE = {};
      (data.products || []).forEach(function (p) { PLINE[p.id] = p.line || 'Blank'; });
      var emp = data.employees.map(function (n) { return { value: n, label: n }; });
      fillSelect(el('employee'), emp, 'Select your name');
      fillSelect(el('recvEmployee'), emp, 'Select your name');
      fillSelect(el('invEmployee'), emp, 'Select your name');
      fillSelect(el('wipEmployee'), emp, 'Select your name');
      var prodOpts = data.products.map(function (p) {
        return { value: p.id, label: p.name, family: p.family };
      });
      var famOrder = data.familyOrder || [];
      fillSelectGrouped(el('product'), prodOpts, 'Select a product', famOrder);
      fillSelectGrouped(el('wipProduct'), prodOpts, 'Select a product', famOrder);
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
      (data.products || []).forEach(function (pr) {
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
          // "started → finished", never a sum: one chair through three
          // stations is one chair, not three.
          return '<div class="today-prod"><div class="today-prod__name">' + escapeHtml(pr.name)
               + ' <span class="today-prod__total">' + fmt(pr.started) + ' started → '
               + fmt(pr.finished) + ' finished</span></div>'
               + '<div class="today-chips">' + (chips || '<span class="muted">—</span>') + '</div></div>';
        }).join('');
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
    if (name === 'inventory') loadInventory();
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
      { key: 'drift',    n: s.drifting,     label: 'drifting',      warn: s.drifting > 0 }
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
