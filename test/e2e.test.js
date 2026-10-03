// End-to-end smoke test: run against a server started with a fresh database.
//   BASE=http://localhost:3999 LOG=server.log node --test test/
// The server must run in development mode, so emailed links and WhatsApp codes appear in its log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3999';
const LOG = process.env.LOG || 'server.log';
const ORIGIN = { Origin: BASE };

function client() {
  let cookie = '';
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { ...ORIGIN, ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    const set = r.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (value === '') cookie = ''; else cookie = `${name}=${value}`;
    }
    let data = {};
    try { data = await r.clone().json(); } catch { /* not json */ }
    return { status: r.status, data, headers: r.headers, res: r };
  }
  return { call };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fromLog(re) {
  for (let i = 0; i < 30; i++) {
    const m = [...fs.readFileSync(LOG, 'utf8').matchAll(re)];
    if (m.length) return m[m.length - 1][1];
    await sleep(100);
  }
  throw new Error('not found in log: ' + re);
}

const pdf = () => new Blob([Buffer.from('%PDF-1.4\n%test\n')], { type: 'application/pdf' });
const png = () => new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], { type: 'image/png' });

const stamp = Date.now();
const applicantEmail = `applicant${stamp}@example.com`;
const PW = 'Str0ng!Passw0rd';
const PHONE = '082' + String(stamp).slice(-7);

test('full applicant + admin journey', async () => {
  const u = client();

  // pages are served, secrets are not
  assert.equal((await u.call('GET', '/apply.html')).status, 200);
  assert.equal((await u.call('GET', '/apply')).status, 200);
  assert.notEqual((await fetch(BASE + '/package.json')).headers.get('content-type')?.includes('json'), true);

  // CSRF: no Origin → blocked
  const noOrigin = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);

  assert.equal((await u.call('GET', '/api/auth/state')).data.state, 'signed_out');
  assert.equal((await u.call('GET', '/api/me')).status, 401);

  // weak password rejected
  assert.equal((await u.call('POST', '/api/auth/signup', { email: applicantEmail, password: 'short' })).status, 400);

  // sign up
  let r = await u.call('POST', '/api/auth/signup', { email: applicantEmail, password: PW });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await u.call('GET', '/api/auth/state')).data.state, 'awaiting_email_confirmation');
  assert.equal((await u.call('POST', '/api/auth/signup', { email: applicantEmail, password: PW })).status, 409);

  // confirm email via the logged link
  const link = await fromLog(/\[email\] link: (http\S+verify-email\S+)/g);
  r = await u.call('GET', new URL(link).pathname + new URL(link).search);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /verified=1/);
  // link is single use
  r = await u.call('GET', new URL(link).pathname + new URL(link).search);
  assert.match(r.headers.get('location'), /verify=expired/);
  assert.equal((await u.call('GET', '/api/auth/state')).data.state, 'requires_phone_enrolment');

  // protected routes still closed
  assert.equal((await u.call('GET', '/api/me')).status, 403);

  // enrol phone
  r = await u.call('POST', '/api/auth/phone/start', { phone: PHONE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let code = await fromLog(/\[otp\] DEV — code for \+27\d+: (\d{6})/g);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await u.call('POST', '/api/auth/phone/verify', { code: wrong })).status, 400);
  r = await u.call('POST', '/api/auth/phone/verify', { code });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await u.call('GET', '/api/auth/state')).data.state, 'fully_verified');

  // profile
  r = await u.call('PUT', '/api/me/profile', {
    first_name: 'Thandi', last_name: '<b>Nkosi</b>', sa_id_number: '1234567890123', phone_number: PHONE,
    employment_status: 'permanent', monthly_net_income: 12500,
  });
  assert.equal(r.status, 400); // invalid ID (Luhn)
  r = await u.call('PUT', '/api/me/profile', {
    first_name: 'Thandi', last_name: '<b>Nkosi</b>', sa_id_number: '8001015009087', phone_number: PHONE,
    employment_status: 'permanent', employer: 'Acme', job_title: 'Clerk', monthly_net_income: 12500, physical_address: '1 Main Rd',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // cannot submit before documents
  r = await u.call('POST', '/api/applications', { amount: 1500, days: 21 });
  assert.equal(r.status, 409);
  assert.equal(r.data.step, 'documents');

  // documents: fake extension rejected by content sniffing
  let fd = new FormData();
  fd.append('id', new Blob([Buffer.from('MZ not a pdf')]), 'id.pdf');
  fd.append('payslip', pdf(), 'payslip.pdf');
  fd.append('statements', pdf(), 's1.pdf');
  assert.equal((await u.call('POST', '/api/me/documents', fd)).status, 400);

  fd = new FormData();
  fd.append('id', png(), 'id.png');
  fd.append('payslip', pdf(), 'payslip.pdf');
  fd.append('statements', pdf(), 's1.pdf');
  fd.append('statements', pdf(), 's2.pdf');
  r = await u.call('POST', '/api/me/documents', fd);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.count, 4);

  // consents
  assert.equal((await u.call('POST', '/api/me/consents', { consents: ['credit_bureau_enquiry'] })).status, 400);
  r = await u.call('POST', '/api/me/consents', { consents: ['personal_information_processing', 'bank_statement_retrieval', 'credit_bureau_enquiry', 'debicheck_mandate'] });
  assert.equal(r.status, 200);

  // application: invalid amount, then valid, then duplicate
  assert.equal((await u.call('POST', '/api/applications', { amount: 5000, days: 21 })).status, 400);
  r = await u.call('POST', '/api/applications', { amount: 1500, days: 21 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const appId = r.data.id;
  assert.equal((await u.call('POST', '/api/applications', { amount: 1000, days: 10 })).status, 409);

  r = await u.call('GET', '/api/me');
  assert.equal(r.data.application.status, 'under_review');
  // R1500 / 21 days: init 165+50=215, service 42, interest 53.55, total 1810.55
  assert.equal(r.data.application.total_repayable, 1810.55);
  assert.equal(r.data.application.initiation_fee, 215);

  // applicant cannot use admin routes
  assert.equal((await u.call('GET', '/api/admin/overview')).status, 403);

  // ---------- admin (OWNER_ADMIN_EMAIL=owner@example.com) ----------
  const a = client();
  r = await a.call('POST', '/api/auth/signup', { email: 'owner@example.com', password: PW });
  if (r.status === 409) r = await a.call('POST', '/api/auth/login', { email: 'owner@example.com', password: PW });
  const st0 = (await a.call('GET', '/api/auth/state')).data.state;
  if (st0 === 'awaiting_email_confirmation') {
    const l2 = await fromLog(/\[email\] link: (http\S+verify-email\S+)/g);
    await a.call('GET', new URL(l2).pathname + new URL(l2).search);
  }
  if ((await a.call('GET', '/api/auth/state')).data.state === 'requires_phone_enrolment') {
    await a.call('POST', '/api/auth/phone/start', { phone: '0831234567' });
    await a.call('POST', '/api/auth/phone/verify', { code: await fromLog(/\[otp\] DEV — code for \+27831234567: (\d{6})/g) });
  }
  assert.equal((await a.call('GET', '/api/auth/state')).data.state, 'fully_verified');

  r = await a.call('GET', '/api/admin/me');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.role, 'owner');

  r = await a.call('GET', '/api/admin/overview');
  assert.ok(r.data.queue.some((x) => x.id === appId));

  r = await a.call('GET', `/api/admin/applications/${appId}`);
  assert.equal(r.data.application.sa_id_number, '8001015009087');

  r = await a.call('GET', `/api/admin/users/${r.data.application.user_id}/documents`);
  assert.equal(r.data.documents.length, 4);
  const doc = await a.call('GET', `/api/admin/documents/${r.data.documents[0].id}`);
  assert.equal(doc.status, 200);
  // applicant cannot fetch documents through admin route
  assert.equal((await u.call('GET', `/api/admin/documents/${r.data.documents[0].id}`)).status, 403);

  // lifecycle out of order is rejected
  assert.equal((await a.call('POST', `/api/admin/applications/${appId}/disburse`, { amount: 1500, reference: 'X' })).status, 409);
  r = await a.call('POST', `/api/admin/applications/${appId}/decision`, { decision: 'approved', notes: 'ok' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await a.call('POST', `/api/admin/applications/${appId}/decision`, { decision: 'declined' })).status, 409);
  assert.equal((await a.call('POST', `/api/admin/applications/${appId}/debicheck`, {})).status, 200);
  r = await a.call('POST', `/api/admin/applications/${appId}/disburse`, { amount: 1500, reference: 'EFT-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // paid out the same day as the application: same 21 days to payday, same total
  assert.equal(r.data.days, 21);
  assert.equal(r.data.total, 1810.55);
  assert.equal((await a.call('POST', `/api/admin/applications/${appId}/settle`, { amount: 1810.55, reference: 'DC-1' })).status, 200);
  r = await a.call('GET', `/api/admin/applications/${appId}`);
  assert.equal(r.data.application.status, 'settled');
  assert.equal(r.data.events.length, 5);

  // invite a reviewer; reviewers can't decide
  assert.equal((await a.call('POST', '/api/admin/admins', { email: 'rev@example.com', role: 'reviewer' })).status, 200);

  // ---------- new login needs the WhatsApp challenge ----------
  const u2 = client();
  assert.equal((await u2.call('POST', '/api/auth/login', { email: applicantEmail, password: 'wrong' })).status, 401);
  assert.equal((await u2.call('POST', '/api/auth/login', { email: applicantEmail, password: PW })).status, 200);
  assert.equal((await u2.call('GET', '/api/auth/state')).data.state, 'requires_login_whatsapp_otp');
  assert.equal((await u2.call('GET', '/api/me')).status, 403);
  assert.equal((await u2.call('POST', '/api/auth/otp/send', {})).status, 200);
  assert.equal((await u2.call('POST', '/api/auth/otp/send', {})).status, 429); // resend cooldown
  code = await fromLog(/\[otp\] DEV — code for \+27\d+: (\d{6})/g);
  assert.equal((await u2.call('POST', '/api/auth/otp/verify', { code })).status, 200);
  assert.equal((await u2.call('GET', '/api/auth/state')).data.state, 'fully_verified');

  // password reset revokes sessions
  assert.equal((await u2.call('POST', '/api/auth/forgot', { email: applicantEmail })).status, 200);
  const resetLink = await fromLog(/\[email\] link: (http\S+reset\.html\?token=\S+)/g);
  const token = new URL(resetLink).searchParams.get('token');
  assert.equal((await u2.call('POST', '/api/auth/reset', { token, password: 'weak' })).status, 400);
  assert.equal((await u2.call('POST', '/api/auth/reset', { token, password: 'N3w!Passw0rd!!' })).status, 200);
  assert.equal((await u.call('GET', '/api/auth/state')).data.state, 'signed_out');
  assert.equal((await u2.call('POST', '/api/auth/reset', { token, password: 'N3w!Passw0rd!!' })).status, 400);
  assert.equal((await u2.call('POST', '/api/auth/login', { email: applicantEmail, password: 'N3w!Passw0rd!!' })).status, 200);

  // logout
  assert.equal((await u2.call('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await u2.call('GET', '/api/auth/state')).data.state, 'signed_out');
});
