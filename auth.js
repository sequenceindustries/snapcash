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

    validZaPhone(p) { return /^(\+27|0)[6-8][0-9]{8}$/.test(p.replace(/\s+/g, '')); },

    /* Normalizes any of: 0821234567 / 082 123 4567 / 27821234567 / +27821234567
       into strict E.164 (+27XXXXXXXXX). Returns null if not a valid SA mobile
       number, so callers can reject before ever hitting the network. */
    normalizeZaPhone(raw) {
      var digits = String(raw || '').replace(/[\s\-\(\)\.]/g, '');
      if (/^\+27[6-8][0-9]{8}$/.test(digits)) return digits;
      if (/^27[6-8][0-9]{8}$/.test(digits)) return '+' + digits;
      if (/^0[6-8][0-9]{8}$/.test(digits)) return '+27' + digits.slice(1);
      return null;
    },

    /* Shared post-auth routing check: does this session's user already have
       a profile row? Used to send new users to apply.html (profile
       completion) and returning users to dashboard.html, regardless of
       whether they authenticated with email/password or WhatsApp OTP. */
    async hasProfile(userId) {
      if (!ready) return false;
      var r = await this.client.from('profiles').select('id').eq('id', userId).maybeSingle();
      return !!r.data;
    },

    /* ============================================================
       TEMPORARY MANDATORY-2FA ENFORCEMENT LAYER
       ------------------------------------------------------------
       Supabase's free plan has no Phone MFA / AAL2, so this block is
       a hand-built stand-in. It is deliberately isolated here so it
       can be deleted wholesale and replaced with real AAL2 checks
       later — nothing outside this block should know HOW enforcement
       works, only that getAuthState()/guardProtected() exist.
       ============================================================ */

    /* Supabase's JWT includes a "session_id" claim that stays stable
       for the life of one continuous login (even across silent token
       refreshes) and changes on every new sign-in. Decoding it here
       needs no secret — it's the same signed token already sitting in
       the browser's session, we're just reading a public claim from it.
       Fails closed (returns null) on anything unexpected. */
    getSessionId(session) {
      try {
        var part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        var payload = JSON.parse(decodeURIComponent(escape(atob(part))));
        return payload.session_id || null;
      } catch (e) { return null; }
    },

    maskPhone(e164) {
      var m = /^\+27([0-9]{2})[0-9]{3}([0-9]{4})$/.exec(e164 || '');
      return m ? '+27 ' + m[1] + ' *** ' + m[2] : (e164 || '');
    },

    /* Has THIS specific login session already passed the WhatsApp
       challenge? Deliberately server-validated (a real row, RLS-scoped
       to the caller) rather than a client-side flag anyone could set. */
    async isLoginVerified(userId, sessionId) {
      if (!ready || !sessionId) return false;
      var r = await this.client.from('login_verifications')
        .select('id').eq('user_id', userId).eq('session_id', sessionId).maybeSingle();
      return !!r.data;
    },

    async recordLoginVerified(userId, sessionId) {
      if (!ready || !sessionId) return false;
      var r = await this.client.from('login_verifications')
        .insert({ user_id: userId, session_id: sessionId });
      /* A duplicate insert (e.g. double-click) hits the unique constraint
         and errors — that's fine, it just means it was already recorded. */
      return !r.error || r.error.code === '23505';
    },

    /* The single source of truth for "what should this person see right
       now": signed_out -> awaiting_email_confirmation -> requires_phone_enrolment
       -> requires_login_whatsapp_otp -> fully_verified. */
    async getAuthState() {
      var s = await this.session();
      if (!s) return { state: 'signed_out' };

      var u = s.user;
      if (!u.email_confirmed_at) return { state: 'awaiting_email_confirmation', session: s };
      if (!u.phone || !u.phone_confirmed_at) return { state: 'requires_phone_enrolment', session: s };

      var sid = this.getSessionId(s);
      var verified = await this.isLoginVerified(u.id, sid);
      if (!verified) return { state: 'requires_login_whatsapp_otp', session: s, sessionId: sid, maskedPhone: this.maskPhone(u.phone) };

      return { state: 'fully_verified', session: s };
    },

    /* Only these bare filenames are ever accepted as a post-verification
       destination — never an absolute URL, never a different origin.
       This is what stands between "remember where the user was going"
       and an open-redirect vulnerability. */
    safeNextPage(fallback) {
      var allowed = ['dashboard.html', 'apply.html', 'profile.html'];
      var p = new URLSearchParams(location.search).get('next');
      return allowed.indexOf(p) !== -1 ? p : (fallback || 'dashboard.html');
    },

    /* The guard every protected page calls before rendering anything.
       Returns the session if fully verified; otherwise redirects to the
       right step and returns null — callers must render nothing (or keep
       their loading overlay up) when this returns null. */
    async guardProtected(opts) {
      opts = opts || {};
      var st = await this.getAuthState();
      if (st.state === 'fully_verified') return st.session;

      if (st.state === 'awaiting_email_confirmation' && opts.allowUnconfirmedEmail) {
        return null; /* caller has its own "check your inbox" UI for this case */
      }

      var here = location.pathname.split('/').pop();
      var dest = {
        signed_out: 'login.html',
        awaiting_email_confirmation: 'login.html',
        requires_phone_enrolment: 'verify-phone.html',
        requires_login_whatsapp_otp: 'verify-login.html'
      }[st.state] || 'login.html';

      location.href = dest + (here ? '?next=' + encodeURIComponent(here) : '');
      return null;
    }
  };

  /* wire any sign-out buttons */
  document.addEventListener('click', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-signout')) {
      e.preventDefault(); window.SnapAuth.signOut();
    }
  });
})();
