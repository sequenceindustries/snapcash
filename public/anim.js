/* Snapcash — animation & interaction layer (no external deps, reduced-motion aware) */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Scroll progress bar ---- */
  var bar = document.querySelector('.scroll-progress');
  /* ---- Back to top ---- */
  var toTop = document.querySelector('.to-top');

  function onScroll() {
    var st = window.scrollY || document.documentElement.scrollTop;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.width = (h > 0 ? (st / h) * 100 : 0) + '%';
    if (toTop) toTop.classList.toggle('show', st > 500);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (toTop) toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });

  /* ---- Scroll reveals via IntersectionObserver ---- */
  var reveals = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---- Slider fill (paint the track up to the thumb) ---- */
  function paintRange(input) {
    var min = +input.min || 0, max = +input.max || 100, val = +input.value;
    var pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }
  document.querySelectorAll('input[type=range]').forEach(function (r) {
    paintRange(r);
    r.addEventListener('input', function () { paintRange(r); });
  });

  /* ---- Animated number count-up when a stat scrolls in ---- */
  function animateNumber(el) {
    if (reduce) { return; }
    var target = parseFloat(el.getAttribute('data-count'));
    if (isNaN(target)) return;
    var dur = 1100, start = null, prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + Math.round(target * eased).toLocaleString('en-ZA') + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !reduce) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { animateNumber(e.target); cio.unobserve(e.target); } });
    }, { threshold: 0.6 });
    counters.forEach(function (c) { cio.observe(c); });
  } else {
    counters.forEach(function (c) {
      var t = parseFloat(c.getAttribute('data-count'));
      if (!isNaN(t)) c.textContent = (c.getAttribute('data-prefix') || '') + t.toLocaleString('en-ZA') + (c.getAttribute('data-suffix') || '');
    });
  }

  if (reduce) return; /* everything below is decorative motion */

  /* ---- Magnetic CTA buttons ---- */
  document.querySelectorAll('[data-magnetic]').forEach(function (btn) {
    btn.addEventListener('mousemove', function (e) {
      var r = btn.getBoundingClientRect();
      var mx = e.clientX - r.left - r.width / 2;
      var my = e.clientY - r.top - r.height / 2;
      btn.style.transform = 'translate(' + mx * 0.22 + 'px,' + my * 0.28 + 'px)';
    });
    btn.addEventListener('mouseleave', function () { btn.style.transform = ''; });
  });

  /* ---- Subtle 3D tilt on feature cards ---- */
  document.querySelectorAll('[data-tilt]').forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = 'translateY(-6px) rotateX(' + (-py * 5) + 'deg) rotateY(' + (px * 5) + 'deg)';
    });
    card.addEventListener('mouseleave', function () { card.style.transform = ''; });
  });

  /* ---- Parallax on floating blobs ---- */
  var blobs = Array.prototype.slice.call(document.querySelectorAll('.blob'));
  if (blobs.length) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY;
        blobs.forEach(function (b, i) {
          var speed = (i + 1) * 0.03;
          b.style.transform = 'translateY(' + (y * speed) + 'px)';
        });
        ticking = false;
      });
    }, { passive: true });
  }

  /* ---- Staggered hero entrance ---- */
  var heroItems = document.querySelectorAll('[data-hero]');
  heroItems.forEach(function (el, i) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity .8s cubic-bezier(.2,.7,.3,1), transform .8s cubic-bezier(.2,.7,.3,1)';
    el.style.transitionDelay = (0.1 + i * 0.12) + 's';
  });
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      heroItems.forEach(function (el) { el.style.opacity = ''; el.style.transform = ''; });
    });
  });
})();
