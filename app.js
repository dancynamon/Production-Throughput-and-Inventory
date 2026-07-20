/* ============================================================================
 *  Aquamentor Production — phone/web app logic
 *  Talks to the Apps Script backend over JSONP (Apps Script sends no CORS
 *  headers, so a normal fetch from another origin would be blocked).
 * ========================================================================== */
(function () {
  'use strict';

  var API = (window.AEGIS_CONFIG && window.AEGIS_CONFIG.API_URL || '').trim();
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
    if (!API) { el('setupBanner').hidden = false; return; }
    api({ action: 'config' }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Could not load config');
      LINES = data.lines || {};
      PLINE = {};
      (data.products || []).forEach(function (p) { PLINE[p.id] = p.line || 'Tube'; });
      var emp = data.employees.map(function (n) { return { value: n, label: n }; });
      fillSelect(el('employee'), emp, 'Select your name');
      fillSelect(el('recvEmployee'), emp, 'Select your name');
      fillSelect(el('product'), data.products.map(function (p) { return { value: p.id, label: p.name }; }), 'Select a product');
      fillSelect(el('recvMaterial'), (data.materials || []).map(function (m) {
        return { value: m.id, label: m.name + (m.unit ? ' (' + m.unit + ')' : '') };
      }), 'Select a material');
      buildStageInputs();
      loadToday();
    }).catch(function (err) { toast('⚠ ' + err.message); });
  }

  function buildStageInputs() {
    var wrap = el('stageInputs');
    var pid = el('product').value;
    if (!pid) { wrap.innerHTML = '<div class="muted">Pick a product to see its stages.</div>'; return; }
    var stages = LINES[PLINE[pid]] || [];
    if (!stages.length) { wrap.innerHTML = '<div class="muted">No stages set for this product.</div>'; return; }
    wrap.innerHTML = stages.map(function (s) {
      return '<label class="stage-row"><span class="stage-row__name">' + escapeHtml(s) + '</span>'
           + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
           + 'data-stage="' + escapeHtml(s) + '" placeholder="0"></label>';
    }).join('');
  }
  el('product').addEventListener('change', buildStageInputs);

  /* ---- Shop PIN ----------------------------------------------------------- */
  // Every write (Submit My Day, Receive) must carry the shared shop PIN. It's
  // asked once and remembered on the device; a "wrong PIN" reply clears it so
  // the next attempt re-prompts.
  function shopPin() {
    var pin = (localStorage.getItem('aq_shop_pin') || '').trim();
    if (!pin) {
      pin = (window.prompt('Shop PIN (ask a manager):') || '').trim();
      if (pin) localStorage.setItem('aq_shop_pin', pin);
    }
    return pin;
  }
  function forgetShopPinIfRejected(err) {
    if (/pin/i.test(String(err && err.message || ''))) localStorage.removeItem('aq_shop_pin');
  }

  /* ---- Submit the day ---------------------------------------------------- */
  el('dayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var counts = {}, total = 0;
    document.querySelectorAll('#stageInputs [data-stage]').forEach(function (inp) {
      var v = parseInt(inp.value, 10);
      if (v > 0) { counts[inp.getAttribute('data-stage')] = v; total += v; }
    });
    var payload = {
      action: 'submitDay',
      workDate: el('workDate').value,
      employee: el('employee').value,
      productId: el('product').value,
      counts: JSON.stringify(counts),
      notes: el('notes').value
    };
    if (!payload.workDate)  { toast('Pick the work date'); return; }
    if (!payload.employee)  { toast('Pick who you are'); return; }
    if (!payload.productId) { toast('Pick a product'); return; }
    if (total <= 0)         { toast('Enter at least one stage count'); return; }
    payload.pin = shopPin();
    if (!payload.pin)       { toast('Shop PIN required to submit'); return; }

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
    }).catch(function (err) { forgetShopPinIfRejected(err); toast('⚠ ' + err.message); })
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
      (data.products || []).forEach(function (pr) {
        html += '<div class="ov-card"><div class="ov-card__head">' + escapeHtml(pr.name)
             + '<span class="ov-card__meta">target ' + pr.dailyTarget + '/day · finished ' + pr.finished + '</span></div>'
             + '<table class="ov-table"><thead><tr><th>Stage</th><th>Done</th><th>WIP</th><th>Next day</th></tr></thead><tbody>';
        pr.stages.forEach(function (s) {
          html += '<tr' + (s.starved ? ' class="ov-starved"' : '') + '><td>' + escapeHtml(s.stage) + '</td>'
               + '<td>' + fmt(s.completed) + '</td>'
               + '<td>' + (s.waiting === null ? '—' : fmt(s.waiting)) + '</td>'
               + '<td class="ov-goal">' + fmt(s.suggest) + (s.starved ? ' <span class="ov-flag">↑short</span>' : '') + '</td></tr>';
        });
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
    payload.pin = shopPin();
    if (!payload.pin)               { toast('Shop PIN required'); return; }
    var btn = el('recvBtn'); btn.disabled = true; btn.textContent = 'Adding…'; el('recvResult').hidden = true;
    api(payload).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Receive failed');
      var m = data.material || {};
      el('recvResult').innerHTML = '<div class="result__ok">✓ ' + escapeHtml(data.message) + '</div>'
        + '<div class="result__list"><li><span>' + escapeHtml(m.name || '') + '</span>'
        + '<span class="result__num">now ' + fmt(m.onHand) + ' ' + escapeHtml(m.unit || '') + '</span></li></div>';
      el('recvResult').hidden = false; el('recvForm').reset();
      loadConfig();
    }).catch(function (err) { forgetShopPinIfRejected(err); toast('⚠ ' + err.message); })
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
  loadConfig();
})();
