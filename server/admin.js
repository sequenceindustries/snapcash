// Back-office routes for admin.html. Every route needs a fully verified login AND an active admin record.
import express from 'express';
import { config } from './config.js';
import { query, one, tx } from './db.js';
import { requireVerified, httpError, wrap, normalizeEmail } from './auth.js';
import { getObjectStream } from './storage.js';
import { sendEmail, templates } from './email.js';
import { saDatePlus, quote, LIMITS } from './quote.js';

export const adminRouter = express.Router();

// Resolves the signed-in user's admin record. A pending invite becomes active the
// first time the invited person signs in with that (verified) email address.
async function loadAdmin(req, res, next) {
  try {
    let admin = await one(
      `select * from admin_users where (user_id = $1 or (user_id is null and email = $2)) and status in ('active','pending')`,
      [req.user.id, req.user.email]);
    if (admin && (admin.status === 'pending' || !admin.user_id)) {
      admin = await one(
        `update admin_users set user_id = $2, status = 'active', accepted_at = coalesce(accepted_at, now())
          where id = $1 returning *`, [admin.id, req.user.id]);
    }
    if (!admin) return res.status(403).json({ error: 'This account is not registered as an admin.' });
    req.admin = admin;
    next();
  } catch (err) { next(err); }
}

const canDecide = (a) => a.role === 'approver' || a.role === 'owner';
function requireRole(check, message) {
  return (req, res, next) => (check(req.admin) ? next() : res.status(403).json({ error: message }));
}
const requireDecider = requireRole(canDecide, 'Your admin role is view-only. Ask the owner to make you an approver.');
const requireOwner = requireRole((a) => a.role === 'owner', 'Only the owner can manage admins.');

adminRouter.use('/api/admin', requireVerified, loadAdmin);

adminRouter.get('/api/admin/me', (req, res) => {
  res.json({ email: req.admin.email, role: req.admin.role, canDecide: canDecide(req.admin), isOwner: req.admin.role === 'owner' });
});

const APP_COLS = `a.id, a.user_id, a.requested_amount, a.term_days, a.total_repayable, a.status, a.created_at,
  a.reviewed_at, a.decision_reason, a.due_date, a.disbursed_at, a.disbursed_amount, a.settled_at,
  a.amount_collected, a.collection_reference, p.first_name, p.last_name`;

// All the lists the admin page shows, in one round trip.
adminRouter.get('/api/admin/overview', wrap(async (req, res) => {
  const apps = (await query(
    `select ${APP_COLS} from loan_applications a left join profiles p on p.user_id = a.user_id
      where a.status in ('under_review','approved','debicheck_authorized','disbursed','declined','settled')
      order by a.created_at desc limit 2000`)).rows;
  const by = (s) => apps.filter((a) => a.status === s);
  const today = saDatePlus(0);
  const disbursed = by('disbursed').sort((x, y) => String(x.due_date).localeCompare(String(y.due_date)));
  const byReviewed = (list) => list.sort((x, y) => new Date(y.reviewed_at || 0) - new Date(x.reviewed_at || 0));

  const emails = (await query(
    `select created_at, recipient_email, email_type, status, error_message from email_logs order by created_at desc limit 50`)).rows;
  const admins = (await query(
    `select email, role, status, invited_at, accepted_at from admin_users order by created_at desc`)).rows;

  res.json({
    queue: by('under_review'),
    approved: byReviewed(by('approved')),
    awaitingPayout: by('debicheck_authorized'),
    active: disbursed.filter((a) => !a.due_date || a.due_date >= today),
    arrears: disbursed.filter((a) => a.due_date && a.due_date < today),
    declined: byReviewed(by('declined')),
    settled: by('settled').sort((x, y) => new Date(y.settled_at || 0) - new Date(x.settled_at || 0)),
    emails,
    admins,
  });
}));

adminRouter.get('/api/admin/applications/:id', wrap(async (req, res) => {
  const a = await one(
    `select a.*, p.first_name, p.last_name, p.email, p.sa_id_number, p.phone_number, p.employment_status, p.employer,
            p.job_title, p.monthly_net_income, p.physical_address, p.popia_accepted, p.popia_accepted_at, p.documents_submitted_at
       from loan_applications a left join profiles p on p.user_id = a.user_id where a.id = $1`, [req.params.id]).catch(() => null);
  if (!a) throw httpError(404, 'Application not found.');
  const events = (await query(
    `select event_type, previous_status, new_status, actor_email, notes, created_at
       from loan_application_events where loan_application_id = $1 order by created_at`, [a.id])).rows;
  res.json({ application: a, events });
}));

adminRouter.get('/api/admin/users/:userId/documents', wrap(async (req, res) => {
  const docs = (await query(
    `select id, kind, original_name, content_type, size_bytes, created_at from documents where user_id = $1 order by kind, created_at`,
    [req.params.userId]).catch(() => ({ rows: [] }))).rows;
  res.json({ documents: docs });
}));

// Streams a document through the server, so files are never publicly addressable.
adminRouter.get('/api/admin/documents/:id', wrap(async (req, res) => {
  const d = await one('select * from documents where id = $1', [req.params.id]).catch(() => null);
  if (!d) throw httpError(404, 'Document not found.');
  const stream = await getObjectStream(d.object_key);
  const ext = d.content_type === 'application/pdf' ? 'pdf' : d.content_type === 'image/png' ? 'png' : 'jpg';
  res.setHeader('Content-Type', d.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${d.kind}.${ext}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  stream.on('error', (e) => { console.error('[documents] read failed', e.message); res.destroy(e); });
  stream.pipe(res);
}));

// Moves an application from one status to the next, with an audit event, atomically.
async function transition(c, { id, from, to, set = '', params = [], admin, notes = null }) {
  const row = (await c.query(
    `update loan_applications set status = $3 ${set} where id = $1 and status = $2 returning *`,
    [id, from, to, ...params])).rows[0];
  if (!row) throw httpError(409, `This application is no longer ${from.replace(/_/g, ' ')} — reload and try again.`);
  await c.query(
    `insert into loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, actor_email, notes)
     values ($1,$2,$3,$4,$5,$6,$7)`, [id, to, from, to, admin.id, admin.email, notes]);
  return row;
}

adminRouter.post('/api/admin/applications/:id/decision', requireDecider, wrap(async (req, res) => {
  const decision = req.body.decision;
  if (!['approved', 'declined'].includes(decision)) throw httpError(400, 'Decision must be approved or declined.');
  const notes = String(req.body.notes || '').trim().slice(0, 1000) || null;

  const app = await tx((c) => transition(c, {
    id: req.params.id, from: 'under_review', to: decision, admin: req.admin, notes,
    set: decision === 'approved'
      ? ', reviewed_by = $4, reviewed_at = now(), review_notes = $5'
      : ', reviewed_by = $4, reviewed_at = now(), decision_reason = $5',
    params: [req.admin.id, notes],
  }));

  const who = await one(
    `select u.email, p.first_name, p.last_name from users u left join profiles p on p.user_id = u.id where u.id = $1`, [app.user_id]);
  const name = [who.first_name, who.last_name].filter(Boolean).join(' ') || 'there';
  const template = decision === 'approved'
    ? templates.approved({ name, amount: app.requested_amount, total: app.total_repayable })
    : templates.declined({ name, amount: app.requested_amount, reason: notes });
  const sent = await sendEmail({
    to: who.email, type: decision === 'approved' ? 'application_approved' : 'application_declined',
    template, userId: app.user_id, applicationId: app.id,
  });
  res.json({ ok: true, email_status: sent.status, email_error: sent.status === 'failed' ? sent.error : null });
}));

adminRouter.post('/api/admin/applications/:id/debicheck', requireDecider, wrap(async (req, res) => {
  await tx((c) => transition(c, { id: req.params.id, from: 'approved', to: 'debicheck_authorized', admin: req.admin }));
  res.json({ ok: true });
}));

function moneyAndRef(body) {
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const reference = String(body.reference || '').trim().slice(0, 120);
  if (!(amount > 0 && amount < 100000)) throw httpError(400, 'Please enter a valid amount.');
  if (!reference) throw httpError(400, 'Please enter a reference.');
  return { amount, reference };
}

adminRouter.post('/api/admin/applications/:id/disburse', requireDecider, wrap(async (req, res) => {
  const { amount, reference } = moneyAndRef(req.body);
  const result = await tx(async (c) => {
    const cur = (await c.query(
      `select requested_amount, term_days, total_repayable, due_date from loan_applications where id = $1 for update`,
      [req.params.id])).rows[0];
    if (!cur) throw httpError(404, 'Application not found.');
    // The debit order runs on the payday the applicant chose. Per-day charges are
    // re-worked for the days from today's payout to that payday — never more than quoted.
    const today = saDatePlus(0);
    const daysLeft = Math.round((Date.parse(cur.due_date) - Date.parse(today)) / 86400000);
    if (daysLeft < LIMITS.minDays) {
      throw httpError(409, `Only ${daysLeft} day(s) to this applicant's payday (${cur.due_date}) — the minimum is ${LIMITS.minDays}. Contact them to move repayment to their next payday before paying out.`);
    }
    const days = Math.min(daysLeft, cur.term_days);
    const q = quote(Number(cur.requested_amount), days);
    const row = await transition(c, {
      id: req.params.id, from: 'debicheck_authorized', to: 'disbursed', admin: req.admin,
      notes: `${reference} · ${days} days to payday · total ${q.total.toFixed(2)}`,
      set: `, disbursed_at = now(), disbursed_amount = $4, disbursement_reference = $5,
             term_days = $6, service_fee = $7, interest_amount = $8, total_repayable = $9`,
      params: [amount, reference, days, q.serviceFee, q.interest, q.total],
    });
    return { total: row.total_repayable, previous: Number(cur.total_repayable), days, due_date: cur.due_date };
  });
  res.json({ ok: true, ...result });
}));

adminRouter.post('/api/admin/applications/:id/settle', requireDecider, wrap(async (req, res) => {
  const { amount, reference } = moneyAndRef(req.body);
  await tx((c) => transition(c, {
    id: req.params.id, from: 'disbursed', to: 'settled', admin: req.admin, notes: reference,
    set: ', settled_at = now(), amount_collected = $4, collection_reference = $5', params: [amount, reference],
  }));
  res.json({ ok: true });
}));

adminRouter.post('/api/admin/admins', requireOwner, wrap(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const role = req.body.role;
  if (!email) throw httpError(400, 'Please enter a valid email address.');
  if (!['reviewer', 'approver'].includes(role)) throw httpError(400, 'Role must be reviewer or approver.');
  const row = await one(
    `insert into admin_users (email, role, status, invited_by) values ($1, $2, 'pending', $3)
     on conflict (email) do update set role = excluded.role,
       status = case when admin_users.status = 'revoked' then 'pending' else admin_users.status end
     returning email, role, status`, [email, role, req.admin.id]);
  await sendEmail({ to: email, type: 'admin_invite', template: templates.adminInvite({ role }) });
  res.json({ ok: true, admin: row });
}));

// Makes OWNER_ADMIN_EMAIL the owner on boot, so the first admin never needs SQL.
export async function ensureOwnerAdmin() {
  if (!config.ownerAdminEmail) return;
  await query(
    `insert into admin_users (email, role, status) values ($1, 'owner', 'pending')
     on conflict (email) do update set role = 'owner',
       status = case when admin_users.status = 'revoked' then 'pending' else admin_users.status end`,
    [config.ownerAdminEmail]);
}
