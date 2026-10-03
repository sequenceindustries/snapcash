/* snapcash auth + API helpers. Talks only to this site's own /api — the
   session lives in an httpOnly cookie the page can't read, so all checks
   happen on the server. */
(function () {
  var stateCache = null;

  async function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: 'Network problem — check your connection and try again.' };
    }
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok && method !== 'GET') stateCache = null;
    return { ok: res.ok, status: res.status, data: data, error: res.ok ? null : (data.error || 'Something went wrong — please try again.') };
  }

  window.SnapAuth = {
    api: api,

    /* Kept for page compatibility: there is no client-side setup any more. */
    showConfigWarning: function () { return false; },

    err: function (el, msg) { el.className = 'alert'; el.textContent = msg; el.style.display = 'block'; },
    ok: function (el, msg)  { el.className = 'alert ok'; el.textContent = msg; el.style.display = 'block'; },
    hide: function (el)     { el.style.display = 'none'; },

    /* SA ID: 13 digits + Luhn + embedded date sanity (the server checks again) */
    validSaId: function (id) {
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

    validZaPhone: function (p) { return /^(\+27|0)[6-8][0-9]{8}$/.test(String(p || '').replace(/\s+/g, '')); },

    normalizeZaPhone: function (raw) {
      var digits = String(raw || '').replace(/[\s\-\(\)\.]/g, '');
      if (/^\+27[6-8][0-9]{8}$/.test(digits)) return digits;
      if (/^27[6-8][0-9]{8}$/.test(digits)) return '+' + digits;
      if (/^0[6-8][0-9]{8}$/.test(digits)) return '+27' + digits.slice(1);
      return null;
    },

    maskPhone: function (e164) {
      var m = /^\+27([0-9]{2})[0-9]{3}([0-9]{4})$/.exec(e164 || '');
      return m ? '+27 ' + m[1] + ' *** ' + m[2] : (e164 || '');
    },

    /* Password rules — identical to the server's. */
    passwordChecks: function (pw) {
      pw = String(pw || '');
      return {
        len: pw.length >= 12,
        lower: /[a-z]/.test(pw),
        upper: /[A-Z]/.test(pw),
        digit: /[0-9]/.test(pw),
        symbol: /[^A-Za-z0-9]/.test(pw)
      };
    },
    passwordOk: function (c) { return c.len && c.lower && c.upper && c.digit && c.symbol; },

    /* signed_out -> awaiting_email_confirmation -> requires_phone_enrolment
       -> requires_login_whatsapp_otp -> fully_verified, decided by the server. */
    getAuthState: async function (fresh) {
      if (stateCache && !fresh) return stateCache;
      var r = await api('GET', '/api/auth/state');
      stateCache = r.ok ? r.data : { state: 'signed_out', error: r.error };
      return stateCache;
    },

    /* Only these bare filenames are accepted as a post-verification destination. */
    safeNextPage: function (fallback) {
      var allowed = ['dashboard.html', 'apply.html', 'profile.html', 'admin.html'];
      var p = new URLSearchParams(location.search).get('next');
      return allowed.indexOf(p) !== -1 ? p : (fallback || 'dashboard.html');
    },

    /* Page for a given state (null when fully verified). */
    pageForState: function (state) {
      return {
        signed_out: 'login.html',
        awaiting_email_confirmation: 'login.html',
        requires_phone_enrolment: 'verify-phone.html',
        requires_login_whatsapp_otp: 'verify-login.html'
      }[state] || null;
    },

    /* Every protected page calls this first. Returns the state object when
       fully verified; otherwise redirects to the right step and returns null. */
    guardProtected: async function () {
      var st = await this.getAuthState(true);
      if (st.state === 'fully_verified') return st;
      var here = location.pathname.split('/').pop();
      var dest = this.pageForState(st.state) || 'login.html';
      location.href = dest + (here ? '?next=' + encodeURIComponent(here) : '');
      return null;
    },

    signOut: async function () {
      await api('POST', '/api/auth/logout', {});
      location.href = 'index.html';
    }
  };

  /* wire any sign-out buttons */
  document.addEventListener('click', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-signout')) {
      e.preventDefault(); window.SnapAuth.signOut();
    }
  });
})();
