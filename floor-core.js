/* Floor mode pure helpers, shared by floor.js (phone) and test-floor.js (Node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FloorCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function fmt(n) { return String(Math.round((Number(n) || 0) * 10) / 10); }
  // Green at 95% of par or better, amber at 75%, red below. No par yet (nobody clocked in) is green.
  function grade(actual, par) {
    if (!(par > 0)) return 'g';
    var r = actual / par;
    return r >= 0.95 ? 'g' : r >= 0.75 ? 'a' : 'r';
  }
  // Only when someone ELSE already logged that stage today; the person's own prior entries stay quiet.
  function dupText(duplicates, me) {
    me = String(me || '').trim().toLowerCase();
    return (duplicates || []).filter(function (d) {
      return String(d.priorBy || '').split(',').some(function (n) { n = n.trim().toLowerCase(); return n && n !== me; });
    }).map(function (d) {
      return d.priorBy + ' already logged ' + fmt(d.priorQty) + ' ' + d.stage + ' today, total now ' + fmt(d.newTotal);
    }).join('. ');
  }
  return { fmt: fmt, grade: grade, dupText: dupText };
}));
