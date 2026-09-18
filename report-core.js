/* Aquamentor floor report — parsing + math, shared three ways:
 *   • the app's Floor tab (fed by the backend's floorData action)
 *   • the Floor Report artifact (fed live by the Google Drive connector, or a
 *     baked snapshot)
 *   • Node, to bake that snapshot and to run test-report.js
 * One implementation, so no two views of the floor can disagree. Plain ES5 on
 * purpose: it runs inside the phone app. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AQReport = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /* ---- Parse the Drive connector's markdown rendering of the sheet ------- */
  // Tables arrive as blank-line-separated pipe tables with no tab names, so
  // each one is recognised by its header row.
  var SIGNATURES = {
    products:  ['ProductID', 'ProductName', 'Line'],
    stages:    ['Line', 'Order', 'Stage'],
    stagelog:  ['Timestamp', 'WorkDate', 'Employee', 'ProductID'],
    planning:  ['ProductID', 'ProductName', 'Stage', 'DailyTarget'],
    wipbase:   ['Timestamp', 'ProductID', 'ProductName', 'Stage', 'WaitingBefore'],
    employees: ['Name', 'Active']
  };
  function unescapeCell(s) { return s.replace(/\\([\\|_#&*~`])/g, '$1').trim(); }
  function parseTable(block) {
    return block.split('\n').filter(function (l) { return l.trim().indexOf('|') === 0; })
      .map(function (l) {
        // An escaped pipe inside a cell must not split the row.
        return l.trim().replace(/^\|/, '').replace(/\|$/, '').replace(/\\\|/g, '\u0001').split('|')
          .map(function (c) { return unescapeCell(c.replace(/\u0001/g, '\\|')); });
      })
      .filter(function (c) { return !c.every(function (x) { return x === '' || /^:?-+:?$/.test(x); }); });
  }
  function parseSheet(md) {
    var out = {};
    String(md || '').split(/\n\s*\n/).forEach(function (block) {
      var rows = parseTable(block);
      if (!rows.length) return;
      var header = rows[0];
      Object.keys(SIGNATURES).forEach(function (name) {
        if (out[name]) return;
        if (!SIGNATURES[name].every(function (h, i) { return header[i] === h; })) return;
        out[name] = rows.slice(1).map(function (r) {
          var o = {}; header.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; }); return o;
        });
      });
    });
    return out;
  }

  /* ---- Helpers ------------------------------------------------------------- */
  function num(v) { var n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function round1(n) { return Math.round(n * 10) / 10; }
  function addDays(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.toISOString().slice(0, 10);
  }
  function lastStage(stages) { return stages[stages.length - 1]; }
  // Timestamps reach us as ISO (from the app backend), as the sheet's
  // "8/6/2026 11:39:45" (from the Drive connector), or as a Date.
  function ts(v) {
    if (v instanceof Date) return v.getTime();
    var s = String(v || '').trim(); if (!s) return NaN;
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    var t = Date.parse(s); return isNaN(t) ? NaN : t;
  }
  function isoDate(v) {
    var s = String(v || ''); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var t = ts(s); if (isNaN(t)) return '';
    var d = new Date(t); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  var WIP_FINISHED = '(finished)';

  /* ---- The report ---------------------------------------------------------- */
  // opts: { windowDays: 7|14|30|0 (0 = everything), dedupe: bool, today: 'YYYY-MM-DD' }
  function compute(t, opts) {
    opts = opts || {};
    var products = (t.products || []).filter(function (p) { return String(p.Active).toUpperCase() !== 'NO'; });
    var byId = {}; products.forEach(function (p) { byId[p.ProductID] = p; });
    var lines = {};
    (t.stages || []).forEach(function (s) {
      (lines[s.Line] = lines[s.Line] || []).push({ stage: s.Stage, order: num(s.Order), floorPerHr: num(s.FloorRate_perHr), idealPerHr: num(s.IdealRate_perHr) });
    });
    Object.keys(lines).forEach(function (k) { lines[k].sort(function (a, b) { return a.order - b.order; }); });
    var targets = {};
    (t.planning || []).forEach(function (r) { targets[r.ProductID + '|' + r.Stage] = num(r.DailyTarget); });

    var all = (t.stagelog || []).map(function (r) {
      return { ts: ts(r.Timestamp), tsRaw: r.Timestamp, date: isoDate(r.WorkDate), who: String(r.Employee || ''), pid: r.ProductID,
               stage: r.Stage, qty: num(r.Qty), notes: String(r.Notes || ''), hours: (r.Hours === '' || r.Hours === null || r.Hours === undefined) ? null : num(r.Hours) };
    }).filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.date); });

    /* Opening counts. Newest walk per product wins; rows timestamped before
     * it describe units already standing in the piles and are skipped. */
    var baseline = {};
    (t.wipbase || []).forEach(function (r) {
      var at = ts(r.Timestamp); if (!r.ProductID || isNaN(at)) return;
      var b = baseline[r.ProductID];
      if (!b || at > b.at) b = baseline[r.ProductID] = { at: at, piles: {}, finished: 0, by: r.CountedBy || '' };
      if (at !== b.at) return;
      var q = num(r.WaitingBefore);
      if (r.Stage === WIP_FINISHED) b.finished = q; else b.piles[r.Stage] = q;
    });
    Object.keys(baseline).forEach(function (pid) {
      var b = baseline[pid], st = lines[(byId[pid] || {}).Line] || [], running = b.finished; b.completed = {};
      for (var i = st.length - 1; i >= 0; i--) { b.completed[st[i].stage] = running; running += (b.piles[st[i].stage] || 0); }
    });
    var afterBaseline = function (r) { var b = baseline[r.pid]; return !b || isNaN(r.ts) || r.ts > b.at; };

    /* Likely duplicates: the same person, product, stage, quantity and day
     * logged more than once. A reversal already on the books for that
     * product / stage / day pays the extra down before it is counted. */
    var groups = {}, reversed = {};
    all.forEach(function (r) {
      if (r.qty < 0) { var rk = r.date + '|' + r.pid + '|' + r.stage; reversed[rk] = (reversed[rk] || 0) - r.qty; return; }
      var k = [r.date, r.who, r.pid, r.stage, r.qty, r.notes].join('|');
      (groups[k] = groups[k] || []).push(r);
    });
    var dups = Object.keys(groups).filter(function (k) { return groups[k].length > 1; }).map(function (k) {
      var g = groups[k].slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      return { date: g[0].date, who: g[0].who, pid: g[0].pid, name: (byId[g[0].pid] || {}).ProductName || g[0].pid,
               stage: g[0].stage, qty: g[0].qty, times: g.length, extra: (g.length - 1) * g[0].qty, notes: g[0].notes,
               timestamps: g.map(function (r) { return r.tsRaw; }) };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : b.extra - a.extra; });
    dups.forEach(function (d) {
      var rk = d.date + '|' + d.pid + '|' + d.stage, avail = reversed[rk] || 0;
      d.reversed = Math.min(avail, d.extra); reversed[rk] = avail - d.reversed; d.open = d.extra - d.reversed;
    });
    dups.sort(function (a, b) { return b.open - a.open || b.extra - a.extra; });
    var dupExtra = dups.reduce(function (s, d) { return s + d.open; }, 0);
    var rows = all;
    if (opts.dedupe) {
      // Drop the later copies outright (their hours and entry counts go with
      // them); a partial reversal leaves a remainder, which comes off as one
      // negative row stamped like the copy it cancels so an opening count
      // still supersedes it correctly.
      var drop = [], extra = [];
      dups.forEach(function (d) {
        if (d.open <= 0) return;
        var g = groups[[d.date, d.who, d.pid, d.stage, d.qty, d.notes].join('|')].slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        var n = Math.min(g.length - 1, Math.floor(d.open / d.qty)), rem = d.open - n * d.qty;
        for (var i = 0; i < n; i++) drop.push(g[g.length - 1 - i]);
        if (rem > 0) extra.push({ ts: g[g.length - 1].ts, tsRaw: g[g.length - 1].tsRaw, date: d.date, who: d.who, pid: d.pid, stage: d.stage, qty: -rem, notes: '(duplicate remainder dropped by report)', hours: null, synthetic: true });
      });
      rows = all.filter(function (r) { return drop.indexOf(r) === -1; }).concat(extra);
    }

    var dates = rows.map(function (r) { return r.date; }).sort();
    var lastDate = dates.length ? dates[dates.length - 1] : (opts.today || isoDate(new Date()));
    var today = opts.today || lastDate;
    var windowDays = opts.windowDays === undefined ? 14 : opts.windowDays;
    var since = windowDays ? addDays(today, -(windowDays - 1)) : '0000-00-00';
    var inWin = rows.filter(function (r) { return r.date >= since && r.date <= today; });

    /* Cumulative pipeline: opening count + everything logged since. */
    var cum = {};
    rows.forEach(function (r) { if (afterBaseline(r)) cum[r.pid + '|' + r.stage] = (cum[r.pid + '|' + r.stage] || 0) + r.qty; });
    var C = function (pid, stage) { var b = baseline[pid]; return ((b && b.completed[stage]) || 0) + (cum[pid + '|' + stage] || 0); };

    /* Observed pace in the window, per product-stage and per line-station. */
    var psUnits = {}, psDays = {}, lsUnits = {}, lsDays = {};
    inWin.forEach(function (r) {
      var line = (byId[r.pid] || {}).Line, k = r.pid + '|' + r.stage, lk = line + '|' + r.stage;
      psUnits[k] = (psUnits[k] || 0) + r.qty; (psDays[k] = psDays[k] || {})[r.date] = 1;
      lsUnits[lk] = (lsUnits[lk] || 0) + r.qty; (lsDays[lk] = lsDays[lk] || {})[r.date] = 1;
    });
    var rateOf = function (units, days) { var n = Object.keys(days || {}).length; return n && units > 0 ? { perDay: round1(units / n), days: n } : null; };

    var stations = [];
    Object.keys(lines).forEach(function (line) {
      var prods = products.filter(function (p) { return p.Line === line; });
      if (!prods.length) return;
      lines[line].forEach(function (s) {
        var lk = line + '|' + s.stage, r = rateOf(lsUnits[lk] || 0, lsDays[lk]);
        var target = prods.reduce(function (sum, p) { return sum + (targets[p.ProductID + '|' + s.stage] || 0); }, 0);
        stations.push({ line: line, stage: s.stage, order: s.order, products: prods.map(function (p) { return p.ProductID; }),
          units: lsUnits[lk] || 0, perDay: r ? r.perDay : null, daysObserved: r ? r.days : 0,
          target: target || null, ratedPerDay: s.floorPerHr ? s.floorPerHr * 8 : null,
          pctOfTarget: r && target ? Math.round(100 * r.perDay / target) : null });
      });
    });

    /* Pipelines with the shared blank pool. */
    var pools = {};
    products.forEach(function (p) {
      if (!p.FeedsFrom || !byId[p.FeedsFrom]) return;
      var f = byId[p.FeedsFrom], fStages = lines[f.Line] || [];
      if (!pools[f.ProductID]) pools[f.ProductID] = { feeder: f, finished: fStages.length ? C(f.ProductID, lastStage(fStages).stage) : 0, taken: 0, variants: [] };
      var first = (lines[p.Line] || [])[0];
      pools[f.ProductID].taken += first ? C(p.ProductID, first.stage) : 0;
      pools[f.ProductID].variants.push(p.ProductID);
    });
    Object.keys(pools).forEach(function (k) { pools[k].uncommitted = pools[k].finished - pools[k].taken; });

    var pipelines = products.map(function (p) {
      var st = lines[p.Line] || [], stagesOut = [], prev = null, anomalies = [];
      st.forEach(function (s, i) {
        var done = C(p.ProductID, s.stage), waiting = null, shared = false;
        if (i === 0) { if (p.FeedsFrom && pools[p.FeedsFrom]) { waiting = pools[p.FeedsFrom].uncommitted; shared = true; } }
        else waiting = prev - done;
        if (waiting !== null && waiting < 0 && !shared) anomalies.push({ stage: s.stage, overrun: -waiting });
        var pr = rateOf(psUnits[p.ProductID + '|' + s.stage] || 0, psDays[p.ProductID + '|' + s.stage]);
        var lr = rateOf(lsUnits[p.Line + '|' + s.stage] || 0, lsDays[p.Line + '|' + s.stage]);
        var rate = pr ? pr.perDay : (lr ? lr.perDay : null);
        var w = waiting === null ? 0 : Math.max(0, waiting);
        stagesOut.push({ stage: s.stage, done: done, waiting: waiting, shared: shared, rate: rate, rateSource: pr ? 'product' : (lr ? 'station' : null),
          daysToClear: w > 0 && rate ? round1(w / rate) : (w > 0 ? null : 0), target: targets[p.ProductID + '|' + s.stage] || null });
        prev = done;
      });
      var bn = null;
      stagesOut.forEach(function (x) {
        if (x.shared || !(x.waiting > 0)) return;
        var score = x.daysToClear === null ? x.waiting / 1e6 : x.daysToClear;
        if (!bn || score > bn.score) bn = { stage: x.stage, waiting: x.waiting, rate: x.rate, daysToClear: x.daysToClear, score: score };
      });
      return { id: p.ProductID, name: p.ProductName, family: p.Family || 'Other', line: p.Line, feedsFrom: p.FeedsFrom || null,
        stages: stagesOut, finished: st.length ? C(p.ProductID, lastStage(st).stage) : 0,
        wip: stagesOut.reduce(function (s, x) { return s + (x.shared || x.waiting === null ? 0 : Math.max(0, x.waiting)); }, 0),
        bottleneck: bn, anomalies: anomalies, baselineAt: baseline[p.ProductID] ? baseline[p.ProductID].at : null,
        active: rows.some(function (r) { return r.pid === p.ProductID; }) };
    });

    /* Progress in the window. */
    var famOrder = [];
    products.forEach(function (p) { var f = p.Family || 'Other'; if (famOrder.indexOf(f) === -1) famOrder.push(f); });
    var days = [];
    for (var d = windowDays ? since : (dates[0] || today); d <= today; d = addDays(d, 1)) { days.push({ date: d, finished: 0, logged: 0, byFamily: {} }); if (days.length > 400) break; }
    var dayIx = {}; days.forEach(function (x, i) { dayIx[x.date] = i; });
    var perProduct = {}, perPerson = {}, hours = 0, hourRows = 0, entries = 0;
    inWin.forEach(function (r) {
      var p = byId[r.pid], st = p ? (lines[p.Line] || []) : [];
      var isLast = st.length && lastStage(st).stage === r.stage, isFirst = st.length && st[0].stage === r.stage;
      var dd = days[dayIx[r.date]];
      if (dd) { dd.logged += r.qty; if (isLast) { dd.finished += r.qty; var f = p.Family || 'Other'; dd.byFamily[f] = (dd.byFamily[f] || 0) + r.qty; } }
      var pp = perProduct[r.pid] = perProduct[r.pid] || { id: r.pid, name: p ? p.ProductName : r.pid, family: p ? (p.Family || 'Other') : 'Other', started: 0, finished: 0, logged: 0 };
      pp.logged += r.qty; if (isLast) pp.finished += r.qty; if (isFirst) pp.started += r.qty;
      if (r.synthetic) return;
      entries += 1;
      var pe = perPerson[r.who] = perPerson[r.who] || { name: r.who, units: 0, entries: 0, hours: 0, days: {} };
      pe.units += r.qty; pe.entries += 1; pe.days[r.date] = 1;
      if (r.hours) { pe.hours += r.hours; hours += r.hours; hourRows += 1; }
    });
    var people = Object.keys(perPerson).map(function (k) { var x = perPerson[k]; x.days = Object.keys(x.days).length; return x; }).sort(function (a, b) { return b.units - a.units; });
    var bottlenecks = pipelines.filter(function (p) { return p.bottleneck; }).map(function (p) {
      return { product: p.name, id: p.id, family: p.family, stage: p.bottleneck.stage, waiting: p.bottleneck.waiting,
               rate: p.bottleneck.rate, daysToClear: p.bottleneck.daysToClear, score: p.bottleneck.score, anomalies: p.anomalies };
    }).sort(function (a, b) { return b.score - a.score; });

    return {
      today: today, lastEntry: lastDate, windowDays: windowDays, since: windowDays ? since : (dates[0] || today),
      rows: all.length, dedupe: !!opts.dedupe, duplicates: dups, duplicateExtra: dupExtra,
      baselines: Object.keys(baseline).length,
      totals: { finished: days.reduce(function (s, x) { return s + x.finished; }, 0), logged: days.reduce(function (s, x) { return s + x.logged; }, 0),
                entries: entries, activeDays: days.filter(function (x) { return x.logged > 0; }).length, hours: round1(hours), hourRows: hourRows },
      days: days, families: famOrder,
      products: Object.keys(perProduct).map(function (k) { return perProduct[k]; }).sort(function (a, b) { return b.logged - a.logged; }),
      people: people, stations: stations, pipelines: pipelines, pools: pools, bottlenecks: bottlenecks
    };
  }

  return { parseSheet: parseSheet, compute: compute, ts: ts, isoDate: isoDate };
}));
