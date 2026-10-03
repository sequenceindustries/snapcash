// Transactional email through Resend's HTTP API. Every send attempt is logged in email_logs.
import { config } from './config.js';
import { query } from './db.js';

const BRAND = '#1f6feb';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 });

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:Inter,Arial,sans-serif;color:#0b1b33;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;">
  <div style="font-size:22px;font-weight:800;margin-bottom:20px;">snapcash</div>
  <div style="background:#fff;border-radius:14px;padding:28px;line-height:1.55;font-size:15px;">
    <h2 style="margin:0 0 14px;font-size:20px;">${esc(title)}</h2>
    ${bodyHtml}
  </div>
  <p style="font-size:12px;color:#6b7a90;margin-top:18px;">snapcash · ${esc(config.appUrl.replace(/^https?:\/\//, ''))} · This is a transactional email about your account.</p>
</div></body></html>`;
}

function button(href, label) {
  return `<p style="margin:22px 0;"><a href="${esc(href)}" style="background:${BRAND};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block;">${esc(label)}</a></p>
<p style="font-size:12.5px;color:#6b7a90;">Or paste this link into your browser:<br>${esc(href)}</p>`;
}

export const templates = {
  verifyEmail: (link) => ({
    subject: 'Confirm your email for snapcash',
    html: layout('Confirm your email', `<p>Tap the button below to confirm this is your email address. The link works for 24 hours.</p>${button(link, 'Confirm my email')}<p>If you didn't create a snapcash account, you can ignore this email.</p>`),
  }),
  passwordReset: (link) => ({
    subject: 'Reset your snapcash password',
    html: layout('Reset your password', `<p>Someone (hopefully you) asked to reset your snapcash password. The link works for 1 hour and can only be used once.</p>${button(link, 'Choose a new password')}<p>If you didn't ask for this, you can ignore this email — your password won't change.</p>`),
  }),
  approved: ({ name, amount, total }) => ({
    subject: 'Your snapcash application is approved',
    html: layout(`Good news, ${name}!`, `<p>Your application for <strong>${zar.format(amount)}</strong> has been <strong>approved</strong>.</p><p>Your single repayment will be <strong>${zar.format(total)}</strong>.</p><p>Next, we'll set up your DebiCheck debit order authority, then pay out your cash.</p>${button(config.appUrl + '/dashboard.html', 'Open my dashboard')}<p>Questions? Reply to this email or write to ${esc(config.resend.replyTo)}.</p>`),
  }),
  declined: ({ name, amount, reason }) => ({
    subject: 'Your snapcash application',
    html: layout(`Hi ${name},`, `<p>We've reviewed your application for <strong>${zar.format(amount)}</strong>.</p><p>Unfortunately, we weren't able to approve it at this time.${reason ? ' ' + esc(reason) : ''}</p><p>You're welcome to apply again when your situation changes. Questions? Reply to this email or write to ${esc(config.resend.replyTo)}.</p>`),
  }),
  adminInvite: ({ role }) => ({
    subject: 'You have been added as a snapcash admin',
    html: layout('Admin access', `<p>You've been added to the snapcash back office as <strong>${esc(role)}</strong>.</p><p>Sign in with this email address (or create an account with it) and complete WhatsApp verification, then open the admin page.</p>${button(config.appUrl + '/admin.html', 'Open admin')}`),
  }),
  newApplication: ({ name, amount, days }) => ({
    subject: `New application: ${name} · ${zar.format(amount)}`,
    html: layout('New application in the queue', `<p><strong>${esc(name)}</strong> applied for <strong>${zar.format(amount)}</strong> over ${Number(days)} days.</p>${button(config.appUrl + '/admin.html', 'Review in admin')}`),
  }),
};

// Sends and logs. Never throws; returns { ok, error }.
export async function sendEmail({ to, type, template, userId = null, applicationId = null }) {
  let status = 'pending', providerId = null, error = null;

  if (!config.resend.apiKey) {
    status = 'skipped';
    error = 'RESEND_API_KEY not set';
    console.log(`[email] (not sent — no RESEND_API_KEY) ${type} → ${to}: ${template.subject}`);
    if (!config.isProd) {
      const link = (template.html.match(/href="([^"]+)"/) || [])[1];
      if (link) console.log(`[email] link: ${link.replace(/&amp;/g, '&')}`);
    }
  } else {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resend.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.resend.from, to: [to], reply_to: config.resend.replyTo, subject: template.subject, html: template.html }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { status = 'sent'; providerId = body.id || null; }
      else { status = 'failed'; error = body.message || `Resend HTTP ${r.status}`; }
    } catch (e) {
      status = 'failed';
      error = e.message;
    }
  }

  await query(
    `insert into email_logs (recipient_email, recipient_user_id, email_type, subject, loan_application_id, status, provider_message_id, error_message, sent_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $6 = 'sent' then now() end)`,
    [to, userId, type, template.subject, applicationId, status, providerId, error],
  ).catch((e) => console.error('[email] could not log', e.message));

  if (status === 'failed') console.error(`[email] ${type} → ${to} failed: ${error}`);
  return { ok: status === 'sent' || status === 'skipped', status, error };
}
