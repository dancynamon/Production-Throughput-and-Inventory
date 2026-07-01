/* ============================================================================
 *  Aquamentor Production — phone/web app logic
 *  Talks to the Apps Script backend over JSONP (Apps Script sends no CORS
 *  headers, so a normal fetch from another origin would be blocked).
 * ========================================================================== */
(function () {
  'use strict';

  var API = (window.AEGIS_CONFIG && window.AEGIS_CONFIG.API_URL || '').trim();
  var el = function (id) { return document.getElementById(id); };
  var STAGES = [];   // filled from config

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
      STAGES = data.stages || [];
      var emp = data.employees.map(function (n) { return { value: n, label: n }; });
      fillSelect(el('employee'), emp, 'Select your name');
      fillSelect(el('recvEmployee'), emp, 'Select your name');
      fillSelect(el('product'), data.products.map(function (p) { return { value: p.id, label: p.name }; }), 'Select a product');
      fillSelect(el('recvMaterial'), (data.materials || []).map(function (m) {
        return { value: m.id, label: m.name + (m.unit ? ' (' + m.unit + ')' : '') };
      }), 'Select a material');
      buildStageInputs();
    }).catch(function (err) { toast('⚠ ' + err.message); });
  }

  function buildStageInputs() {
    var wrap = el('stageInputs');
    if (!STAGES.length) { wrap.innerHTML = '<div class="muted">No stages configured.</div>'; return; }
    wrap.innerHTML = STAGES.map(function (s) {
      return '<label class="stage-row"><span class="stage-row__name">' + escapeHtml(s) + '</span>'
           + '<input class="stage-row__input" type="number" inputmode="numeric" min="0" step="1" '
           + 'data-stage="' + escapeHtml(s) + '" placeholder="0"></label>';
    }).join('');
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

    var btn = el('dayBtn'); btn.disabled = true; btn.textContent = 'Submitting…';
    el('dayResult').hidden = true;
    api(payload).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Submit failed');
      showDayResult(data);
      document.querySelectorAll('#stageInputs [data-stage]').forEach(function (i) { i.value = ''; });
      el('notes').value = '';
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

  /* ---- Tabs -------------------------------------------------------------- */
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('tab--active'); });
      document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('screen--active'); });
      tab.classList.add('tab--active');
      var name = tab.getAttribute('data-screen');
      el('screen-' + name).classList.add('screen--active');
      if (name === 'overview') loadOverview();
    });
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
  loadConfig();
})();
