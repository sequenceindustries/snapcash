/* Snapcash auth helpers — requires supabase-js CDN + config.js loaded first */
(function () {
  var cfg = window.SNAPCASH || {};
  var libLoaded = !!(window.supabase && window.supabase.createClient);
  var configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
              cfg.SUPABASE_URL.indexOf('PASTE_') === -1 &&
              cfg.SUPABASE_ANON_KEY.indexOf('PASTE_') === -1;
  var ready = libLoaded && configured;

  window.SnapAuth = {
    ready: ready,
    libLoaded: libLoaded,
    configured: configured,
    client: ready ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null,

    async session() {
      if (!ready) return null;
      var r = await this.client.auth.getSession();
      return r.data.session || null;
    },

    async requireAuth(redirect) {
      var s = await this.session();
      if (!s) { location.href = redirect || 'login.html'; return null; }
      return s;
    },

    async signOut() {
      if (ready) await this.client.auth.signOut();
      location.href = 'index.html';
    },

    showConfigWarning(el) {
      if (ready) return false;
      if (!libLoaded) {
        el.textContent = 'Could not load a required library. If you use an ad-blocker or content blocker, please disable it for this site and reload.';
      } else {
        el.textContent = 'Setup needed: paste your Supabase URL and anon key into config.js, then reload.';
      }
      el.style.display = 'block';
      return true;
    },

    err(el, msg) { el.className = 'alert'; el.textContent = msg; el.style.display = 'block'; },
    ok(el, msg)  { el.className = 'alert ok'; el.textContent = msg; el.style.display = 'block'; },
    hide(el)     { el.style.display = 'none'; },

    /* SA ID: 13 digits + Luhn + embedded date sanity */
    validSaId(id) {
      if (!/^[0-9]{13}$/.test(id)) return false;
      var m = +id.slice(2, 4), d = +id.slice(4, 6);
      if (m < 1 || m > 12 || d < 1 || d > 31) return false;
      var sum = 0;
      for (var i = 0; i < 13; i++) {
        var dig = +id[i];
        if ((13 - i) % 2 === 0) { dig *= 2; if (dig > 9) dig -= 9; }
        sum += dig;
      }
      return sum % 10 === 0;
    },

    validZaPhone(p) { return /^(\+27|0)[6-8][0-9]{8}$/.test(p.replace(/\s+/g, '')); }
  };

  /* wire any sign-out buttons */
  document.addEventListener('click', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-signout')) {
      e.preventDefault(); window.SnapAuth.signOut();
    }
  });
})();
