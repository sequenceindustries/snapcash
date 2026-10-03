// Sessions, the verification state machine, and every sign-in route
// (email + password, Google, email confirmation, password reset, WhatsApp codes).
import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { query, one, tx } from './db.js';
import { randomToken, sha256, otpCode, otpHash, safeEqual, sign, unsign, pkcePair } from './crypto.js';
import { sendEmail, templates } from './email.js';
import { sendOtp } from './whatsapp.js';

const COOKIE = config.isProd ? '__Host-snapcash' : 'snapcash_dev';
const OAUTH_COOKIE = config.isProd ? '__Host-snapcash-oauth' : 'snapcash_oauth_dev';
const BCRYPT_ROUNDS = 12;
const OTP_TTL_MIN = 5;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 6;
const SAFE_NEXT = new Set(['dashboard.html', 'apply.html', 'profile.html', 'admin.html']);

// ---------- small helpers ----------

export function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.isProd) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearCookie(res, name) { setCookie(res, name, '', 0); }

export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254 ? e : null;
}

export function normalizeZaPhone(raw) {
  const d = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^\+27[6-8][0-9]{8}$/.test(d)) return d;
  if (/^27[6-8][0-9]{8}$/.test(d)) return '+' + d;
  if (/^0[6-8][0-9]{8}$/.test(d)) return '+27' + d.slice(1);
  return null;
}

export function maskPhone(e164) {
  const m = /^\+27([0-9]{2})[0-9]{3}([0-9]{4})$/.exec(e164 || '');
  return m ? `+27 ${m[1]} *** ${m[2]}` : '';
}

// Same rules as the checklist on apply.html.
export function passwordProblems(pw) {
  pw = String(pw || '');
  const p = [];
  if (pw.length < 12) p.push('at least 12 characters');
  if (pw.length > 200) p.push('at most 200 characters');
  if (!/[a-z]/.test(pw)) p.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) p.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) p.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) p.push('a symbol');
  return p;
}

function safeNext(next) { return SAFE_NEXT.has(next) ? next : null; }

// ---------- sessions ----------

async function createSession(res, req, userId, { otpVerified = false } = {}) {
  const token = randomToken(32);
  const s = await one(
    `insert into sessions (user_id, token_hash, otp_verified_at, ip, user_agent, expires_at)
     values ($1, $2, case when $3 then now() end, $4, $5, now() + make_interval(days => $6)) returning id`,
    [userId, sha256(token), otpVerified, req.ip || null, String(req.get('user-agent') || '').slice(0, 300), config.sessionDays],
  );
  setCookie(res, COOKIE, token, config.sessionDays * 86400);
  return s.id;
}

// Attaches req.user / req.session when a valid session cookie is present.
export const loadSession = wrap(async (req, res, next) => {
  req.user = null; req.session = null;
  const token = readCookie(req, COOKIE);
  if (!token) return next();
  const row = await one(
    `select s.id as session_id, s.otp_verified_at, s.last_seen_at, s.expires_at,
            u.id, u.email, u.email_verified_at, u.phone, u.phone_verified_at, u.google_sub,
            (u.password_hash is not null) as has_password
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
        and s.last_seen_at > now() - make_interval(hours => $2)`,
    [sha256(token), config.sessionIdleHours],
  );
  if (!row) { clearCookie(res, COOKIE); return next(); }
  req.session = { id: row.session_id, otpVerifiedAt: row.otp_verified_at };
  req.user = {
    id: row.id, email: row.email, emailVerifiedAt: row.email_verified_at,
    phone: row.phone, phoneVerifiedAt: row.phone_verified_at, hasPassword: row.has_password, googleLinked: !!row.google_sub,
  };
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    query('update sessions set last_seen_at = now() where id = $1', [row.session_id]).catch(() => {});
  }
  next();
});

// The single source of truth for what this person may do right now.
export function authState(req) {
  if (!req.user) return 'signed_out';
  if (!req.user.emailVerifiedAt) return 'awaiting_email_confirmation';
  if (!req.user.phoneVerifiedAt) return 'requires_phone_enrolment';
  if (!req.session.otpVerifiedAt) return 'requires_login_whatsapp_otp';
  return 'fully_verified';
}

export function requireState(...allowed) {
  return (req, res, next) => {
    const state = authState(req);
    if (allowed.includes(state)) return next();
    res.status(state === 'signed_out' ? 401 : 403).json({ error: 'Not allowed in your current sign-in state.', state });
  };
}

export const requireVerified = requireState('fully_verified');

// ---------- rate limits ----------

const limiter = (windowMinutes, limit, message) => rateLimit({
  windowMs: windowMinutes * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: message || 'Too many attempts — please wait a few minutes and try again.' },
});
const loginLimiter = limiter(15, 10);
const signupLimiter = limiter(60, 10);
const emailLimiter = limiter(60, 6);
const otpLimiter = limiter(15, 20);

// ---------- emailed links ----------

async function issueAuthToken(userId, purpose, ttlMinutes) {
  const token = randomToken(32);
  await query(
    `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, sha256(token), ttlMinutes],
  );
  return token;
}

async function sendVerificationEmail(user) {
  const recent = await one(
    `select 1 from auth_tokens where user_id = $1 and purpose = 'email_verify' and created_at > now() - interval '60 seconds'`,
    [user.id],
  );
  if (recent) throw httpError(429, 'Please wait a minute before asking for another email.');
  const token = await issueAuthToken(user.id, 'email_verify', 24 * 60);
  const link = `${config.appUrl}/auth/verify-email?token=${token}`;
  return sendEmail({ to: user.email, type: 'email_verification', template: templates.verifyEmail(link), userId: user.id });
}

// ---------- WhatsApp codes ----------

async function issueOtp({ userId, sessionId, phone, purpose }) {
  const recent = await one(
    `select count(*)::int as n,
            max(created_at) filter (where purpose = $2) as last_at
       from phone_otps where user_id = $1 and created_at > now() - interval '1 hour'`,
    [userId, purpose],
  );
  if (recent.last_at && Date.now() - new Date(recent.last_at).getTime() < OTP_RESEND_SECONDS * 1000) {
    throw httpError(429, 'Please wait a minute before requesting another code.');
  }
  if (recent.n >= OTP_MAX_PER_HOUR) throw httpError(429, 'Too many codes requested — please wait a while and try again.');

  const code = otpCode();
  await tx(async (c) => {
    // Only the newest code for this purpose is valid.
    await c.query(`update phone_otps set consumed_at = now() where user_id = $1 and purpose = $2 and consumed_at is null`, [userId, purpose]);
    const row = (await c.query(
      `insert into phone_otps (user_id, session_id, phone, purpose, code_hash, expires_at)
       values ($1,$2,$3,$4,'\\x00', now() + make_interval(mins => $5)) returning id`,
      [userId, sessionId, phone, purpose, OTP_TTL_MIN],
    )).rows[0];
    await c.query('update phone_otps set code_hash = $2 where id = $1', [row.id, otpHash(row.id, code)]);
  });
  try {
    await sendOtp(phone, code);
  } catch (err) {
    console.error('[otp] send failed:', err.message);
    await query(`update phone_otps set consumed_at = now() where user_id = $1 and purpose = $2 and consumed_at is null`, [userId, purpose]);
    throw httpError(502, 'We couldn’t send a code right now. Please try again shortly.');
  }
}

// Checks a code; returns the OTP row on success.
async function checkOtp({ userId, sessionId, purpose, code }) {
  if (!/^[0-9]{6}$/.test(String(code || ''))) throw httpError(400, 'Please enter all 6 digits.');
  return tx(async (c) => {
    const row = (await c.query(
      `select * from phone_otps where user_id = $1 and purpose = $2 and consumed_at is null
        and ($3::uuid is null or session_id = $3) order by created_at desc limit 1 for update`,
      [userId, purpose, sessionId],
    )).rows[0];
    if (!row) throw httpError(400, 'That code has expired. Request a new one below.');
    if (new Date(row.expires_at) < new Date()) {
      await c.query('update phone_otps set consumed_at = now() where id = $1', [row.id]);
      throw httpError(400, 'That code has expired. Request a new one below.');
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await c.query('update phone_otps set consumed_at = now() where id = $1', [row.id]);
      throw httpError(429, 'Too many attempts — request a new code.');
    }
    if (!safeEqual(otpHash(row.id, String(code)), row.code_hash)) {
      await c.query('update phone_otps set attempts = attempts + 1 where id = $1', [row.id]);
      throw httpError(400, 'That code isn’t right. Check the digits and try again.');
    }
    await c.query('update phone_otps set consumed_at = now() where id = $1', [row.id]);
    return row;
  });
}

// ---------- routes ----------

export const authRouter = express.Router();

// Who is signed in, and which step they're on.
authRouter.get('/api/auth/state', wrap(async (req, res) => {
  const state = authState(req);
  if (state === 'signed_out') return res.json({ state });
  const prof = await one('select 1 from profiles where user_id = $1', [req.user.id]);
  res.json({
    state,
    user: {
      email: req.user.email,
      emailVerified: !!req.user.emailVerifiedAt,
      maskedPhone: maskPhone(req.user.phone),
      hasPassword: req.user.hasPassword,
    },
    hasProfile: !!prof,
  });
}));

authRouter.post('/api/auth/signup', signupLimiter, wrap(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) throw httpError(400, 'Please enter a valid email address.');
  const problems = passwordProblems(req.body.password);
  if (problems.length) throw httpError(400, 'Your password needs ' + problems.join(', ') + '.');

  const hash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
  let user;
  try {
    user = await one('insert into users (email, password_hash) values ($1, $2) returning id, email', [email, hash]);
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'That email already has an account — please log in instead.');
    throw err;
  }
  await createSession(res, req, user.id);
  await sendVerificationEmail(user);
  res.status(201).json({ state: 'awaiting_email_confirmation' });
}));

authRouter.post('/api/auth/resend-verification', emailLimiter, requireState('awaiting_email_confirmation'), wrap(async (req, res) => {
  await sendVerificationEmail(req.user);
  res.json({ ok: true });
}));

// Equalises response time when the email doesn't exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + randomToken(8), BCRYPT_ROUNDS);

authRouter.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = email ? await one('select id, password_hash from users where email = $1', [email]) : null;
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) throw httpError(401, 'Incorrect email or password.');
  if (req.session) await query('delete from sessions where id = $1', [req.session.id]);
  await createSession(res, req, user.id);
  res.json({ ok: true });
}));

authRouter.post('/api/auth/logout', wrap(async (req, res) => {
  if (req.session) await query('delete from sessions where id = $1', [req.session.id]);
  clearCookie(res, COOKIE);
  res.json({ ok: true });
}));

authRouter.post('/api/auth/forgot', emailLimiter, wrap(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const user = email ? await one('select id, email from users where email = $1', [email]) : null;
  if (user) {
    const recent = await one(
      `select 1 from auth_tokens where user_id = $1 and purpose = 'password_reset' and created_at > now() - interval '60 seconds'`, [user.id]);
    if (!recent) {
      const token = await issueAuthToken(user.id, 'password_reset', 60);
      await sendEmail({ to: user.email, type: 'password_reset', template: templates.passwordReset(`${config.appUrl}/reset.html?token=${token}`), userId: user.id });
    }
  }
  // Same answer either way, so this can't be used to discover accounts.
  res.json({ ok: true });
}));

authRouter.post('/api/auth/reset', emailLimiter, wrap(async (req, res) => {
  const problems = passwordProblems(req.body.password);
  if (problems.length) throw httpError(400, 'Your password needs ' + problems.join(', ') + '.');
  const hash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
  const done = await tx(async (c) => {
    const t = (await c.query(
      `update auth_tokens set used_at = now()
        where token_hash = $1 and purpose = 'password_reset' and used_at is null and expires_at > now()
        returning user_id`, [sha256(String(req.body.token || ''))])).rows[0];
    if (!t) return false;
    // Clicking the emailed link also proves the address is theirs.
    await c.query(`update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1`, [t.user_id, hash]);
    await c.query('delete from sessions where user_id = $1', [t.user_id]);
    return true;
  });
  if (!done) throw httpError(400, 'This reset link has expired or was already used — request a new one from the login page.');
  clearCookie(res, COOKIE);
  res.json({ ok: true });
}));

// Change password while signed in (fully verified). Signs out every other device.
authRouter.post('/api/me/password', requireVerified, wrap(async (req, res) => {
  const problems = passwordProblems(req.body.password);
  if (problems.length) throw httpError(400, 'Your password needs ' + problems.join(', ') + '.');
  const hash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
  await query('update users set password_hash = $2, updated_at = now() where id = $1', [req.user.id, hash]);
  await query('delete from sessions where user_id = $1 and id <> $2', [req.user.id, req.session.id]);
  res.json({ ok: true });
}));

// The link in the confirmation email.
authRouter.get('/auth/verify-email', wrap(async (req, res) => {
  const t = await one(
    `update auth_tokens set used_at = now()
      where token_hash = $1 and purpose = 'email_verify' and used_at is null and expires_at > now()
      returning user_id`, [sha256(String(req.query.token || ''))]);
  if (!t) return res.redirect('/login.html?verify=expired');
  await query('update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1', [t.user_id]);
  res.redirect('/login.html?verified=1');
}));

// ----- WhatsApp: attach a phone number to the account -----

authRouter.post('/api/auth/phone/start', otpLimiter, requireState('requires_phone_enrolment'), wrap(async (req, res) => {
  const phone = normalizeZaPhone(req.body.phone);
  if (!phone) throw httpError(400, 'Please enter a valid South African cellphone number.');
  const taken = await one('select 1 from users where phone = $1 and id <> $2', [phone, req.user.id]);
  if (taken) throw httpError(409, 'That number couldn’t be used. Please try a different one or contact support.');
  await issueOtp({ userId: req.user.id, sessionId: req.session.id, phone, purpose: 'enrol' });
  res.json({ ok: true, maskedPhone: maskPhone(phone) });
}));

authRouter.post('/api/auth/phone/verify', otpLimiter, requireState('requires_phone_enrolment'), wrap(async (req, res) => {
  const row = await checkOtp({ userId: req.user.id, sessionId: req.session.id, purpose: 'enrol', code: req.body.code });
  try {
    await tx(async (c) => {
      await c.query('update users set phone = $2, phone_verified_at = now(), updated_at = now() where id = $1', [req.user.id, row.phone]);
      // Proving the phone in this session also satisfies this login's challenge.
      await c.query('update sessions set otp_verified_at = now() where id = $1', [req.session.id]);
    });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'That number couldn’t be used. Please try a different one or contact support.');
    throw err;
  }
  res.json({ ok: true });
}));

// ----- WhatsApp: the challenge on every new login -----

authRouter.post('/api/auth/otp/send', otpLimiter, requireState('requires_login_whatsapp_otp'), wrap(async (req, res) => {
  await issueOtp({ userId: req.user.id, sessionId: req.session.id, phone: req.user.phone, purpose: 'login' });
  res.json({ ok: true, maskedPhone: maskPhone(req.user.phone) });
}));

authRouter.post('/api/auth/otp/verify', otpLimiter, requireState('requires_login_whatsapp_otp'), wrap(async (req, res) => {
  await checkOtp({ userId: req.user.id, sessionId: req.session.id, purpose: 'login', code: req.body.code });
  await query('update sessions set otp_verified_at = now() where id = $1', [req.session.id]);
  res.json({ ok: true });
}));

// ----- Google sign-in (authorization code + PKCE) -----

export function googleEnabled() { return !!(config.google.clientId && config.google.clientSecret); }

const googleRedirectUri = () => `${config.appUrl}/auth/google/callback`;

authRouter.get('/auth/google/start', (req, res) => {
  if (!googleEnabled()) return res.redirect('/login.html?error=google_unavailable');
  const state = randomToken(24);
  const { verifier, challenge } = pkcePair();
  const next = safeNext(String(req.query.next || '')) || null;
  setCookie(res, OAUTH_COOKIE, sign({ state, verifier, next, exp: Date.now() + 10 * 60_000 }), 600);
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

authRouter.get('/auth/google/callback', wrap(async (req, res) => {
  const saved = unsign(readCookie(req, OAUTH_COOKIE));
  clearCookie(res, OAUTH_COOKIE);
  const fail = (why) => { console.error('[google] sign-in failed:', why); res.redirect('/login.html?error=google'); };

  if (req.query.error) return res.redirect('/login.html?error=google_cancelled');
  if (!saved || saved.exp < Date.now() || saved.state !== req.query.state) return fail('state mismatch');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(req.query.code || ''),
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.id_token) return fail(tok.error_description || tok.error || `token HTTP ${tokenRes.status}`);

  // The ID token came straight from Google over TLS in exchange for our secret,
  // so its claims can be read directly (OpenID Connect Core §3.1.3.7).
  let claims;
  try { claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return fail('unreadable id_token'); }
  if (claims.aud !== config.google.clientId) return fail('audience mismatch');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) return fail('issuer mismatch');
  if (!claims.sub || !claims.email || claims.email_verified !== true) return fail('email not verified by Google');
  if (claims.exp * 1000 < Date.now()) return fail('expired id_token');

  const email = normalizeEmail(claims.email);
  if (!email) return fail('bad email');

  const userId = await tx(async (c) => {
    const bySub = (await c.query('select id from users where google_sub = $1', [claims.sub])).rows[0];
    if (bySub) return bySub.id;
    const byEmail = (await c.query('select id, email_verified_at from users where email = $1 for update', [email])).rows[0];
    if (byEmail) {
      // If the existing account never confirmed its email, someone else may have
      // registered it — drop that password so only the real owner (via Google) gets in.
      await c.query(
        `update users set google_sub = $2,
                password_hash = case when email_verified_at is null then null else password_hash end,
                email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
          where id = $1`, [byEmail.id, claims.sub]);
      if (!byEmail.email_verified_at) await c.query('delete from sessions where user_id = $1', [byEmail.id]);
      return byEmail.id;
    }
    return (await c.query(
      'insert into users (email, google_sub, email_verified_at) values ($1, $2, now()) returning id', [email, claims.sub])).rows[0].id;
  });

  if (req.session) await query('delete from sessions where id = $1', [req.session.id]);
  await createSession(res, req, userId);
  res.redirect('/auth-callback.html' + (saved.next ? '?next=' + encodeURIComponent(saved.next) : ''));
}));

authRouter.get('/api/auth/providers', (req, res) => res.json({ google: googleEnabled() }));
