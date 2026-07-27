/* Snapcash shared scripts — NCA quote engine (mirrors lib/creditEngine.ts) */
(function () {
  var fmt = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 });

  function tc(z) { return Math.round((z + Number.EPSILON) * 100); }

  function quote(A, d) {
    var pc = tc(A);
    var init = Math.min(tc(1050), tc(165) + Math.round(Math.max(0, pc - tc(1000)) * 0.10));
    var svc = Math.round((tc(60) / 30) * d);
    var intr = Math.round(pc * 0.0017 * d);
    return { p: pc / 100, i: init / 100, s: svc / 100, r: intr / 100, t: (pc + init + svc + intr) / 100 };
  }

  function dueDate(d) {
    var dt = new Date(); dt.setDate(dt.getDate() + Number(d));
    return dt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  window.SnapQuote = { fmt: fmt, quote: quote, dueDate: dueDate };

  /* Wire up any calculator present on the page */
  var amt = document.getElementById('amt'), days = document.getElementById('days');
  if (!amt || !days) return;

  function set(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }

  function render() {
    var A = Number(amt.value), d = Number(days.value), q = quote(A, d);
    set('amt-out', fmt.format(A));
    set('days-out', d + ' days');
    set('q-p', fmt.format(q.p));
    set('q-i', fmt.format(q.i));
    set('q-s', fmt.format(q.s));
    set('q-s-label', 'Service fee (' + d + ' days)');
    set('q-r', fmt.format(q.r));
    set('q-t', fmt.format(q.t));
    set('q-due', 'One repayment on ' + dueDate(d));
    var cta = document.getElementById('apply-cta');
    if (cta) {
      cta.textContent = 'Apply for ' + fmt.format(q.p);
      cta.href = 'apply.html?amount=' + A + '&days=' + d;
    }
  }
  amt.addEventListener('input', render);
  days.addEventListener('input', render);
  render();
})();
