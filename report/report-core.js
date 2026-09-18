/* Aquamentor production report — parsing + math.
 * Runs in Node (to bake the snapshot) and in the page (to refresh live from
 * the sheet through the Google Drive connector). One implementation, so the
 * snapshot and the live numbers can never disagree. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AQReport = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /* ---- Parse the Drive connector's markdown rendering of the sheet ------- */
  // Tables arrive as blank-line-separated pipe tables with no tab names, so
  // each one is recognised by its header row.
  var SIGNATURES = {
    products: ['ProductID', 'ProductName', 'Line'],
    stages:   ['Line', 'Order', 'Stage'],
    stagelog: ['Timestamp', 'WorkDate', 'Employee', 'ProductID'],
    planning: ['ProductID', 'ProductName', 'Stage', 'DailyTarget'],
    employees: ['Name', 'Active']
  };
  function unescapeCell(s) { return s.replace(/\\([\\|_#&*~`])/g, '$1').trim(); }
  function parseTable(block) {
    var rows = block.split('\n').filter(function (l) { return l.trim().indexOf('|') === 0; })
      .map(function (l) { var c = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(unescapeCell); return c; })
      .filter(function (c) { return !c.every(function (x) { return x === '' || /^:?-+:?$/.test(x); }); });
    return rows;
  }
  function parseSheet(md) {
    var out = {};
    String(md || '').split(/\n\s*\n/).forEach(function (block) {
      var rows = parseTable(block);
      if (!rows.length) return;
      var header = rows[0];
      Object.keys(SIGNATURES).forEach(function (name) {
        if (out[name]) return;
        var sig = SIGNATURES[name];
        var ok = sig.every(function (h, i) { return header[i] === h; });
        if (!ok) return;
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

    // Every StageLog row, typed. Rows for products the sheet no longer lists
    // are kept in the activity totals but cannot join a pipeline.
    var all = (t.stagelog || []).map(function (r) {
      return { ts: r.Timestamp, date: String(r.WorkDate).slice(0, 10), who: r.Employee, pid: r.ProductID,
               stage: r.Stage, qty: num(r.Qty), notes: r.Notes || '', hours: r.Hours === '' ? null : num(r.Hours) };
    }).filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.date); });

    // Likely duplicates: the same person, product, stage, quantity and day
    // logged more than once. A phone that retried, or a tap that repeated.
    var groups = {};
    all.forEach(function (r) {
      var k = [r.date, r.who, r.pid, r.stage, r.qty, r.notes].join('|');
      (groups[k] = groups[k] || []).push(r);
    });
    var dups = Object.keys(groups).filter(function (k) { return groups[k].length > 1; }).map(function (k) {
      var g = groups[k];
      return { date: g[0].date, who: g[0].who, pid: g[0].pid, name: (byId[g[0].pid] || {}).ProductName || g[0].pid,
               stage: g[0].stage, qty: g[0].qty, times: g.length, extra: (g.length - 1) * g[0].qty,
               timestamps: g.map(function (r) { return r.ts; }) };
    }).sort(function (a, b) { return b.extra - a.extra; });
    var dupExtra = dups.reduce(function (s, d) { return s + d.extra; }, 0);
    var rows = all;
    if (opts.dedupe) {
      var seen = {};
      rows = all.filter(function (r) {
        var k = [r.date, r.who, r.pid, r.stage, r.qty, r.notes].join('|');
        if (seen[k]) return false; seen[k] = true; return true;
      });
    }

    var dates = rows.map(function (r) { return r.date; }).sort();
    var lastDate = dates.length ? dates[dates.length - 1] : (opts.today || new Date().toISOString().slice(0, 10));
    var today = opts.today || lastDate;
    var windowDays = opts.windowDays === undefined ? 14 : opts.windowDays;
    var since = windowDays ? addDays(today, -(windowDays - 1)) : '0000-00-00';
    var inWin = rows.filter(function (r) { return r.date >= since && r.date <= today; });

    /* Cumulative pipeline, all history: what is sitting where right now. */
    var cum = {};
    rows.forEach(function (r) { cum[r.pid + '|' + r.stage] = (cum[r.pid + '|' + r.stage] || 0) + r.qty; });
    var C = function (pid, stage) { return cum[pid + '|' + stage] || 0; };

    /* Observed pace in the window, per product-stage and per line-station. */
    var psUnits = {}, psDays = {}, lsUnits = {}, lsDays = {};
    inWin.forEach(function (r) {
      var line = (byId[r.pid] || {}).Line;
      var k = r.pid + '|' + r.stage, lk = line + '|' + r.stage;
      psUnits[k] = (psUnits[k] || 0) + r.qty; (psDays[k] = psDays[k] || {})[r.date] = 1;
      lsUnits[lk] = (lsUnits[lk] || 0) + r.qty; (lsDays[lk] = lsDays[lk] || {})[r.date] = 1;
    });
    var rateOf = function (units, days) { var n = Object.keys(days || {}).length; return n ? { perDay: round1(units / n), days: n } : null; };

    /* Stations: one row per line + stage that any active product uses. */
    var stations = [];
    Object.keys(lines).forEach(function (line) {
      var prods = products.filter(function (p) { return p.Line === line; });
      if (!prods.length) return;
      lines[line].forEach(function (s) {
        var lk = line + '|' + s.stage;
        var r = rateOf(lsUnits[lk] || 0, lsDays[lk]);
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
      if (!pools[f.ProductID]) pools[f.ProductID] = { feeder: f, finished: C(f.ProductID, lastStage(fStages).stage), taken: 0, variants: [] };
      var first = (lines[p.Line] || [])[0];
      pools[f.ProductID].taken += first ? C(p.ProductID, first.stage) : 0;
      pools[f.ProductID].variants.push(p.ProductID);
    });
    Object.keys(pools).forEach(function (k) { pools[k].uncommitted = pools[k].finished - pools[k].taken; });

    var pipelines = products.map(function (p) {
      var st = lines[p.Line] || [];
      var stagesOut = [], prev = null, anomalies = [];
      st.forEach(function (s, i) {
        var done = C(p.ProductID, s.stage);
        var waiting = null, shared = false;
        if (i === 0) {
          if (p.FeedsFrom && pools[p.FeedsFrom]) { waiting = pools[p.FeedsFrom].uncommitted; shared = true; }
        } else waiting = prev - done;
        if (waiting !== null && waiting < 0 && !shared) anomalies.push({ stage: s.stage, overrun: -waiting });
        var pr = rateOf(psUnits[p.ProductID + '|' + s.stage] || 0, psDays[p.ProductID + '|' + s.stage]);
        var lr = rateOf(lsUnits[p.Line + '|' + s.stage] || 0, lsDays[p.Line + '|' + s.stage]);
        var rate = pr ? pr.perDay : (lr ? lr.perDay : null), rateSource = pr ? 'product' : (lr ? 'station' : null);
        var w = waiting === null ? 0 : Math.max(0, waiting);
        stagesOut.push({ stage: s.stage, done: done, waiting: waiting, shared: shared, rate: rate, rateSource: rateSource,
          daysToClear: w > 0 && rate ? round1(w / rate) : (w > 0 ? null : 0),
          target: targets[p.ProductID + '|' + s.stage] || null });
        prev = done;
      });
      var finished = st.length ? C(p.ProductID, lastStage(st).stage) : 0;
      var wip = stagesOut.reduce(function (s, x) { return s + (x.shared || x.waiting === null ? 0 : Math.max(0, x.waiting)); }, 0);
      // Bottleneck: the stage that takes longest to clear what is waiting at
      // it. A pile with no observed pace ranks by size, below any rated pile.
      var bn = null;
      stagesOut.forEach(function (x) {
        if (x.shared || !(x.waiting > 0)) return;
        var score = x.daysToClear === null ? x.waiting / 1e6 : x.daysToClear;
        if (!bn || score > bn.score) bn = { stage: x.stage, waiting: x.waiting, rate: x.rate, daysToClear: x.daysToClear, score: score };
      });
      return { id: p.ProductID, name: p.ProductName, family: p.Family || 'Other', line: p.Line, feedsFrom: p.FeedsFrom || null,
        stages: stagesOut, finished: finished, wip: wip, bottleneck: bn, anomalies: anomalies,
        active: rows.some(function (r) { return r.pid === p.ProductID; }) };
    });

    /* Progress in the window. Finished = last stage of the product's own
     * line. Started = its first stage (Cut for a blank, Meshed for an Exo). */
    var famOrder = [];
    products.forEach(function (p) { var f = p.Family || 'Other'; if (famOrder.indexOf(f) === -1) famOrder.push(f); });
    var days = [];
    for (var d = windowDays ? since : (dates[0] || today); d <= today; d = addDays(d, 1)) {
      days.push({ date: d, finished: 0, logged: 0, byFamily: {} });
      if (days.length > 400) break;
    }
    var dayIx = {}; days.forEach(function (x, i) { dayIx[x.date] = i; });
    var perProduct = {}, perPerson = {}, hours = 0, hourRows = 0;
    inWin.forEach(function (r) {
      var p = byId[r.pid]; var st = p ? (lines[p.Line] || []) : [];
      var isLast = st.length && lastStage(st).stage === r.stage, isFirst = st.length && st[0].stage === r.stage;
      var dd = days[dayIx[r.date]];
      if (dd) { dd.logged += r.qty; if (isLast) { dd.finished += r.qty; var f = p.Family || 'Other'; dd.byFamily[f] = (dd.byFamily[f] || 0) + r.qty; } }
      var pp = perProduct[r.pid] = perProduct[r.pid] || { id: r.pid, name: p ? p.ProductName : r.pid, family: p ? (p.Family || 'Other') : 'Other', started: 0, finished: 0, logged: 0 };
      pp.logged += r.qty; if (isLast) pp.finished += r.qty; if (isFirst) pp.started += r.qty;
      var pe = perPerson[r.who] = perPerson[r.who] || { name: r.who, units: 0, entries: 0, hours: 0, days: {} };
      pe.units += r.qty; pe.entries += 1; pe.days[r.date] = 1;
      if (r.hours) { pe.hours += r.hours; hours += r.hours; hourRows += 1; }
    });
    var people = Object.keys(perPerson).map(function (k) { var x = perPerson[k]; x.days = Object.keys(x.days).length; return x; })
      .sort(function (a, b) { return b.units - a.units; });
    var finishedWin = days.reduce(function (s, x) { return s + x.finished; }, 0);
    var loggedWin = days.reduce(function (s, x) { return s + x.logged; }, 0);
    var activeDays = days.filter(function (x) { return x.logged > 0; }).length;

    /* Ranked bottlenecks across the floor. */
    var bottlenecks = pipelines.filter(function (p) { return p.bottleneck; }).map(function (p) {
      return { product: p.name, id: p.id, family: p.family, stage: p.bottleneck.stage, waiting: p.bottleneck.waiting,
               rate: p.bottleneck.rate, daysToClear: p.bottleneck.daysToClear, score: p.bottleneck.score };
    }).sort(function (a, b) { return b.score - a.score; });

    return {
      today: today, lastEntry: lastDate, windowDays: windowDays, since: windowDays ? since : (dates[0] || today),
      rows: rows.length, rowsRaw: all.length, dedupe: !!opts.dedupe,
      duplicates: dups, duplicateExtra: dupExtra,
      totals: { finished: finishedWin, logged: loggedWin, entries: inWin.length, activeDays: activeDays, hours: round1(hours), hourRows: hourRows },
      days: days, families: famOrder,
      products: Object.keys(perProduct).map(function (k) { return perProduct[k]; }).sort(function (a, b) { return b.logged - a.logged; }),
      people: people, stations: stations, pipelines: pipelines, pools: pools, bottlenecks: bottlenecks
    };
  }

  return { parseSheet: parseSheet, compute: compute };
}));
