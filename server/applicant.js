// Applicant routes: profile, documents, POPIA consent, loan application.
import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from './config.js';
import { query, one, tx } from './db.js';
import { requireVerified, httpError, wrap, normalizeZaPhone } from './auth.js';
import { quote, validLoan, saDatePlus } from './quote.js';
import { putObject, deleteObject } from './storage.js';
import { sendEmail, templates } from './email.js';

export const applicantRouter = express.Router();
applicantRouter.use('/api/me', requireVerified);
applicantRouter.use('/api/applications', requireVerified);

// SA ID: 13 digits, Luhn check and a plausible embedded date.
export function validSaId(id) {
  if (!/^[0-9]{13}$/.test(id)) return false;
  const m = +id.slice(2, 4), d = +id.slice(4, 6);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let dig = +id[i];
    if ((13 - i) % 2 === 0) { dig *= 2; if (dig > 9) dig -= 9; }
    sum += dig;
  }
  return sum % 10 === 0;
}

const EMPLOYMENT = ['permanent', 'contract', 'self_employed', 'pensioner', 'unemployed'];
const OPEN_STATUSES = ['pending_kyc', 'under_review', 'approved', 'debicheck_authorized', 'disbursed'];

function text(v, max) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

// Everything the dashboard needs in one call.
applicantRouter.get('/api/me', wrap(async (req, res) => {
  const profile = await one(
    `select first_name, last_name, sa_id_number, phone_number, employment_status, employer, job_title,
            monthly_net_income, physical_address, documents_submitted_at, popia_accepted, popia_accepted_at
       from profiles where user_id = $1`, [req.user.id]);
  const application = await one(
    `select id, requested_amount, term_days, initiation_fee, service_fee, interest_amount, total_repayable,
            due_date, status, submitted_at, created_at
       from loan_applications where user_id = $1 order by created_at desc limit 1`, [req.user.id]);
  res.json({
    user: { email: req.user.email, emailVerified: !!req.user.emailVerifiedAt, phone: req.user.phone, hasPassword: req.user.hasPassword },
    profile,
    application,
  });
}));

// Step 2 of apply.html (creates the profile) and profile.html (updates it).
// ID number and cellphone can only be set when the profile is first created.
applicantRouter.put('/api/me/profile', wrap(async (req, res) => {
  const b = req.body || {};
  const first = text(b.first_name, 80), last = text(b.last_name, 80);
  const employment = String(b.employment_status || '');
  const income = Number(b.monthly_net_income);
  if (!first || !last) throw httpError(400, 'Please fill in your first and last name.');
  if (!EMPLOYMENT.includes(employment)) throw httpError(400, 'Please choose your employment status.');
  if (!(income >= 0 && income < 10_000_000)) throw httpError(400, 'Please enter your monthly income after deductions.');

  const fields = [first, last, employment, text(b.employer, 120), text(b.job_title, 120), Math.round(income * 100) / 100, text(b.physical_address, 400)];
  const existing = await one('select user_id from profiles where user_id = $1', [req.user.id]);

  if (existing) {
    await query(
      `update profiles set first_name=$2, last_name=$3, employment_status=$4, employer=$5, job_title=$6,
              monthly_net_income=$7, physical_address=$8, updated_at=now() where user_id=$1`,
      [req.user.id, ...fields]);
    return res.json({ ok: true });
  }

  const said = String(b.sa_id_number || '').replace(/\s+/g, '');
  if (!said) throw httpError(409, 'Please complete your application first.', { step: 'details' });
  if (!validSaId(said)) throw httpError(400, 'That doesn’t look like a valid SA ID number — please check the digits.');
  const phone = normalizeZaPhone(b.phone_number);
  if (!phone) throw httpError(400, 'Please enter a valid South African cellphone number.');
  try {
    await query(
      `insert into profiles (user_id, email, first_name, last_name, employment_status, employer, job_title,
                             monthly_net_income, physical_address, sa_id_number, phone_number)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [req.user.id, req.user.email, ...fields, said, phone]);
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'That ID number is already registered with another account.');
    throw err;
  }
  res.status(201).json({ ok: true });
}));

// ----- documents -----

const MAX_FILE = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 8 },
}).fields([{ name: 'id', maxCount: 1 }, { name: 'payslip', maxCount: 1 }, { name: 'statements', maxCount: 6 }]);

// Trust the file's first bytes, not its name or the browser's claimed type.
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', type: 'application/pdf' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  return null;
}

applicantRouter.post('/api/me/documents', (req, res, next) => {
  upload(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10MB or smaller.' : 'Could not read your upload — please try again.';
      return next(httpError(400, msg));
    }
    next();
  });
}, wrap(async (req, res) => {
  const profile = await one('select user_id from profiles where user_id = $1', [req.user.id]);
  if (!profile) throw httpError(409, 'Please save your personal details first.');

  const f = req.files || {};
  const items = [];
  if (f.id?.[0]) items.push({ kind: 'id', file: f.id[0] });
  if (f.payslip?.[0]) items.push({ kind: 'payslip', file: f.payslip[0] });
  for (const s of f.statements || []) items.push({ kind: 'statement', file: s });

  const kinds = new Set(items.map((i) => i.kind));
  if (!kinds.has('id') || !kinds.has('payslip') || !kinds.has('statement')) {
    throw httpError(400, 'Please attach your ID, your latest payslip and at least one bank statement.');
  }
  for (const it of items) {
    it.sniffed = sniff(it.file.buffer);
    if (!it.sniffed) throw httpError(400, `“${it.file.originalname}” isn’t a PDF, JPG or PNG file.`);
  }

  const previous = (await query('select id, object_key from documents where user_id = $1', [req.user.id])).rows;
  const saved = [];
  try {
    for (const it of items) {
      const key = `applicants/${req.user.id}/${it.kind}-${crypto.randomUUID()}.${it.sniffed.ext}`;
      await putObject(key, it.file.buffer, it.sniffed.type);
      saved.push({ ...it, key });
    }
  } catch (err) {
    await Promise.allSettled(saved.map((s) => deleteObject(s.key)));
    console.error('[documents] upload failed:', err.message);
    throw httpError(502, 'Could not store your documents right now — please try again.');
  }

  await tx(async (c) => {
    // A fresh upload replaces the previous set.
    await c.query('delete from documents where user_id = $1', [req.user.id]);
    for (const s of saved) {
      await c.query(
        `insert into documents (user_id, kind, object_key, original_name, content_type, size_bytes) values ($1,$2,$3,$4,$5,$6)`,
        [req.user.id, s.kind, s.key, String(s.file.originalname || '').slice(0, 200), s.sniffed.type, s.file.size]);
    }
    await c.query('update profiles set documents_submitted_at = now(), updated_at = now() where user_id = $1', [req.user.id]);
  });
  await Promise.allSettled(previous.map((p) => deleteObject(p.object_key)));
  res.json({ ok: true, count: saved.length });
}));

// ----- POPIA consent -----
// The wording is fixed here so what's recorded is exactly what was shown (apply.html mirrors it).
export const CONSENT_VERSION = 'popia-v1.0';
export const CONSENTS = {
  personal_information_processing: 'I consent to snapcash processing my personal information to assess this credit application, as described in the Privacy Policy.',
  bank_statement_retrieval: 'I will provide my ID, latest payslip and last 3 months’ bank statements, and authorise snapcash to use these to assess my application.',
  credit_bureau_enquiry: 'I authorise snapcash to perform a credit bureau enquiry on my profile.',
  debicheck_mandate: 'I understand repayment will be collected through a single, pre-authorised debit order for the exact agreed amount, processed via snapcash’s accredited collections partner.',
};

applicantRouter.post('/api/me/consents', wrap(async (req, res) => {
  const given = new Set(Array.isArray(req.body.consents) ? req.body.consents.map(String) : []);
  const missing = Object.keys(CONSENTS).filter((k) => !given.has(k));
  if (missing.length) throw httpError(400, 'All four consents are required to assess a credit application.');
  const profile = await one('select documents_submitted_at from profiles where user_id = $1', [req.user.id]);
  if (!profile) throw httpError(409, 'Please save your personal details first.');

  await tx(async (c) => {
    for (const [type, wording] of Object.entries(CONSENTS)) {
      await c.query(
        `insert into popia_consents (user_id, consent_type, consent_text, version, granted, ip, user_agent)
         values ($1,$2,$3,$4,true,$5,$6)`,
        [req.user.id, type, wording, CONSENT_VERSION, req.ip || null, String(req.get('user-agent') || '').slice(0, 250)]);
    }
    await c.query('update profiles set popia_accepted = true, popia_accepted_at = now(), updated_at = now() where user_id = $1', [req.user.id]);
  });
  res.json({ ok: true });
}));

// ----- submit an application -----

applicantRouter.post('/api/applications', wrap(async (req, res) => {
  const amount = Number(req.body.amount), days = Number(req.body.days);
  if (!validLoan(amount, days)) throw httpError(400, 'Choose an amount between R500 and R2 000 and a term of 5 to 30 days.');

  const profile = await one('select first_name, last_name, documents_submitted_at, popia_accepted from profiles where user_id = $1', [req.user.id]);
  if (!profile) throw httpError(409, 'Please complete your personal details first.', { step: 'details' });
  if (!profile.documents_submitted_at) throw httpError(409, 'Please upload your documents first.', { step: 'documents' });
  if (!profile.popia_accepted) throw httpError(409, 'Please give your POPIA consent first.', { step: 'popia' });

  const q = quote(amount, days);
  let app;
  try {
    app = await tx(async (c) => {
      const row = (await c.query(
        `insert into loan_applications (user_id, requested_amount, term_days, initiation_fee, service_fee, interest_amount, total_repayable, due_date)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [req.user.id, amount, days, q.initiationFee, q.serviceFee, q.interest, q.total, saDatePlus(days)])).rows[0];
      await c.query(
        `insert into loan_application_events (loan_application_id, event_type, new_status, notes) values ($1, 'submitted', 'under_review', null)`,
        [row.id]);
      return row;
    });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'You already have an open application.', { step: 'dashboard' });
    throw err;
  }

  if (config.adminNotifyEmail) {
    sendEmail({
      to: config.adminNotifyEmail, type: 'new_application_notification', applicationId: app.id,
      template: templates.newApplication({ name: `${profile.first_name} ${profile.last_name}`, amount, days }),
    }).catch(() => {});
  }
  res.status(201).json({ ok: true, id: app.id });
}));

export { OPEN_STATUSES };
