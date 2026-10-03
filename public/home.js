/* snapcash home — banknote linework, hero parallax, and the money card's journey. */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- guilloché: overlapping hypotrochoids, like the security pattern on a banknote ---------- */
  function trochoid(R, r, d, cx, cy, scale, steps) {
    var turns = r / gcd(R, r), pts = [], n = steps * turns;
    for (var i = 0; i <= n; i++) {
      var t = (i / steps) * Math.PI * 2;
      var x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
      var y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
      pts.push((cx + x * scale).toFixed(1) + ',' + (cy + y * scale).toFixed(1));
    }
    return 'M' + pts.join('L');
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  var PATTERNS = {
    hero:  [[96, 35, 58], [96, 35, 38], [120, 47, 62]],
    note:  [[80, 29, 46], [80, 29, 34]],
    trust: [[96, 35, 58], [96, 35, 40]]
  };
  document.querySelectorAll('svg[data-guilloche]').forEach(function (svg) {
    var spec = PATTERNS[svg.getAttribute('data-guilloche')] || PATTERNS.note;
    svg.setAttribute('viewBox', '0 0 400 400');
    var html = '';
    spec.forEach(function (s) {
      var R = s[0], r = s[1], d = s[2];
      var reach = (R - r) + d;
      html += '<path d="' + trochoid(R, r, d, 200, 200, 190 / reach, 90) + '"/>';
    });
    svg.innerHTML = html;
  });

  /* ---------- nav turns solid once you leave the hero ---------- */
  var nav = document.getElementById('nav');
  var hero = document.querySelector('.hero-stage');
  function onScroll() {
    var limit = hero ? hero.offsetHeight - 70 : 40;
    nav.classList.toggle('scrolled', window.scrollY > limit);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- one orchestrated entrance ---------- */
  root.classList.add('js');
  requestAnimationFrame(function () { root.classList.add('loaded'); });

  /* ---------- hero parallax: a few pixels of depth, desktop only ---------- */
  if (!reduce && finePointer && hero) {
    var layers = Array.prototype.slice.call(hero.querySelectorAll('[data-depth]'));
    var frame = null, mx = 0, my = 0;
    root.classList.add('parallax-ready');
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width - 0.5;
      my = (e.clientY - r.top) / r.height - 0.5;
      if (!frame) frame = requestAnimationFrame(apply);
    });
    hero.addEventListener('pointerleave', function () { mx = 0; my = 0; if (!frame) frame = requestAnimationFrame(apply); });
    function apply() {
      frame = null;
      if (window.innerWidth <= 960) { layers.forEach(function (l) { l.style.translate = ''; }); return; }
      layers.forEach(function (l) {
        var depth = parseFloat(l.getAttribute('data-depth')) || 1;
        l.style.translate = (mx * depth * -4).toFixed(2) + 'px ' + (my * depth * -4).toFixed(2) + 'px';
      });
    }
  }

  /* ---------- the journey: scroll position chooses the stage ---------- */
  var stage = document.querySelector('.story-stage');
  var steps = Array.prototype.slice.call(document.querySelectorAll('.story-step'));
  var railItems = stage ? Array.prototype.slice.call(stage.querySelectorAll('.rail li')) : [];
  var rail = stage ? stage.querySelector('.rail') : null;
  var card = stage ? stage.querySelector('.journey-card') : null;
  var current = -1;

  function setStage(n) {
    if (n === current || !stage) return;
    current = n;
    stage.setAttribute('data-stage', n);
    rail.style.setProperty('--stage', n);
    railItems.forEach(function (li, i) {
      li.classList.toggle('on', i === n);
      li.classList.toggle('past', i < n);
    });
    steps.forEach(function (s, i) {
      s.classList.toggle('is-active', i === n);
      s.classList.toggle('is-past', i < n);
    });
    positionCard();
  }

  /* line the card up with the active stop on the rail (desktop) */
  function positionCard() {
    if (!card || window.innerWidth <= 900) { if (card) card.style.removeProperty('--y'); return; }
    var dot = railItems[Math.max(0, current)].querySelector('i');
    var stageBox = stage.getBoundingClientRect();
    var dotY = dot.getBoundingClientRect().top + dot.offsetHeight / 2 - stageBox.top;
    var maxY = stage.offsetHeight - card.offsetHeight - 34 - 28;
    var y = Math.max(0, Math.min(maxY, dotY - 34 - 42));
    card.style.setProperty('--y', y + 'px');
  }

  function pickStage() {
    var mid = window.innerHeight * (window.innerWidth <= 900 ? 0.72 : 0.58);
    var best = 0;
    /* a step becomes current when its heading reaches the middle of the screen */
    steps.forEach(function (s, i) {
      var h = s.querySelector('h3') || s;
      if (h.getBoundingClientRect().top < mid) best = i;
    });
    setStage(best);
  }

  if (stage && steps.length) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; pickStage(); });
    }, { passive: true });
    window.addEventListener('resize', function () { positionCard(); pickStage(); });
    pickStage();

    /* R 0 becomes your amount the first time the card comes into view */
    if ('IntersectionObserver' in window && !reduce) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { setTimeout(function () { stage.classList.add('has-amount'); }, 350); io.disconnect(); }
        });
      }, { threshold: 0.5 });
      io.observe(stage);
    } else {
      stage.classList.add('has-amount');
    }
  }
})();
