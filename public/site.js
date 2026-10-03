/* snapcash — quote engine + shared calculator state.
   SnapQuote.quote mirrors server/quote.js exactly; the server recalculates on submit. */
(function () {
  var fmt = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 });
  var fmt0 = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  var LIMITS = { minAmount: 500, maxAmount: 2000, step: 100, minDays: 5, maxDays: 30 };

  function tc(z) { return Math.round((z + Number.EPSILON) * 100); }

  function quote(A, d) {
    var pc = tc(A);
    var init = Math.min(tc(1050), tc(165) + Math.round(Math.max(0, pc - tc(1000)) * 0.10));
    var svc = Math.round((tc(60) / 30) * d);
    var intr = Math.round(pc * 0.0017 * d);
    return { p: pc / 100, i: init / 100, s: svc / 100, r: intr / 100, t: (pc + init + svc + intr) / 100, cost: (init + svc + intr) / 100 };
  }

  function dueDate(d) {
    var dt = new Date(); dt.setDate(dt.getDate() + Number(d));
    return dt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function clampAmount(a) {
    a = Math.round(Number(a) / LIMITS.step) * LIMITS.step;
    return Math.min(LIMITS.maxAmount, Math.max(LIMITS.minAmount, a || 1500));
  }
  function clampDays(d) {
    d = Math.round(Number(d));
    return Math.min(LIMITS.maxDays, Math.max(LIMITS.minDays, d || 21));
  }

  var state = { amount: 1500, days: 21 };
  var listeners = [];

  function set(amount, days) {
    if (amount != null) state.amount = clampAmount(amount);
    if (days != null) state.days = clampDays(days);
    render();
  }

  function setText(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    /* a brief highlight shows what changed; the value itself is never hidden or animated */
    if (el.hasAttribute('data-flash')) {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  }

  function paintRange(input) {
    var min = +input.min || 0, max = +input.max || 100, val = +input.value;
    input.style.setProperty('--fill', ((val - min) / (max - min)) * 100 + '%');
  }

  function render() {
    var A = state.amount, d = state.days, q = quote(A, d);
    var values = {
      amount: fmt0.format(A), 'amount-c': fmt.format(A),
      days: d + (d === 1 ? ' day' : ' days'),
      p: fmt.format(q.p), i: fmt.format(q.i), s: fmt.format(q.s), r: fmt.format(q.r),
      t: fmt.format(q.t), cost: fmt.format(q.cost),
      'cost-pct': (q.cost / q.p * 100).toFixed(1).replace('.', ',') + '%'
    };
    document.querySelectorAll('[data-q]').forEach(function (el) {
      var k = el.getAttribute('data-q');
      if (k in values) setText(el, values[k]);
    });
    document.querySelectorAll('[data-q-bar]').forEach(function (el) {
      el.style.setProperty('--principal', (q.p / q.t * 100) + '%');
    });
    document.querySelectorAll('input[data-amount], #amt').forEach(function (r) {
      if (+r.value !== A) r.value = A;
      paintRange(r);
      r.setAttribute('aria-valuetext', values.amount);
    });
    document.querySelectorAll('input[data-days], #days').forEach(function (r) {
      if (+r.value !== d) r.value = d;
      paintRange(r);
      r.setAttribute('aria-valuetext', values.days);
    });
    document.querySelectorAll('a[data-apply-link]').forEach(function (a) {
      a.href = 'apply.html?amount=' + A + '&days=' + d;
      var label = a.querySelector('[data-apply-label]');
      if (label) label.textContent = 'Apply for ' + values.amount;
    });

    /* id-based bindings used by apply.html's quote step */
    function byId(id, text) { var el = document.getElementById(id); if (el) setText(el, text); }
    byId('amt-out', values['amount-c']);
    byId('days-out', values.days);
    byId('q-p', values.p); byId('q-i', values.i); byId('q-s', values.s); byId('q-r', values.r); byId('q-t', values.t);
    byId('q-s-label', 'Service fee (' + values.days + ')');
    byId('q-due', 'One repayment, ' + values.days + ' after payout');

    listeners.forEach(function (fn) { fn(state, q); });
  }

  window.SnapQuote = {
    fmt: fmt, fmt0: fmt0, quote: quote, dueDate: dueDate, limits: LIMITS,
    state: state, set: set, on: function (fn) { listeners.push(fn); }
  };

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'range') return;
    if (t.hasAttribute('data-amount') || t.id === 'amt') set(t.value, null);
    else if (t.hasAttribute('data-days') || t.id === 'days') set(null, t.value);
  });

  var p = new URLSearchParams(location.search);
  state.amount = clampAmount(p.get('amount') || 1500);
  state.days = clampDays(p.get('days') || 21);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
