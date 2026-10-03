# snapcash

snapcash.money — NCA-compliant short-term lending. One Node service serves the pages in `public/` and the JSON API, backed by Railway Postgres and a Railway storage bucket.

## Layout

| Path | What it is |
|---|---|
| `public/` | The site (HTML, CSS, `auth.js` API helper, `site.js` quote calculator) |
| `server/` | Express API: sign-in, WhatsApp codes, applicant flow, admin back office |
| `migrations/` | SQL schema, applied automatically on every boot |
| `scripts/make-admin.js` | Add an admin from the command line |
| `test/e2e.test.js` | End-to-end test of the whole journey |

## Sign-in flow

Every account goes through the same steps, enforced by the server:

1. **Email** — password sign-up (confirmation link by email) or Google (already confirmed).
2. **Phone** — a WhatsApp code attaches a South African mobile number to the account.
3. **Every login** — a fresh WhatsApp code before any personal data or admin page is available.

Sessions are httpOnly cookies; only a hash of each session token is stored.

## Environment variables (Railway → service → Variables)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Reference the Postgres service: `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | yes | `production` |
| `APP_URL` | yes | `https://snapcash.money` (the Railway domain until DNS moves) |
| `SESSION_SECRET` | yes | 64+ random characters |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | From the Railway bucket's credentials |
| `OWNER_ADMIN_EMAIL` | yes | Becomes the owner admin after signing in and completing WhatsApp verification |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | Redirect URI: `${APP_URL}/auth/google/callback` |
| `RESEND_API_KEY`, `EMAIL_FROM` | for email | `EMAIL_FROM` defaults to `snapcash <applications@snapcash.money>` |
| `INFOBIP_BASE_URL`, `INFOBIP_API_KEY` | for WhatsApp codes | e.g. `https://xxxxx.api.infobip.com` |
| `INFOBIP_WHATSAPP_SENDER`, `INFOBIP_WHATSAPP_TEMPLATE` | for WhatsApp codes | Approved *authentication* template with one `{{1}}` code placeholder |
| `INFOBIP_WHATSAPP_LANGUAGE` | no | Default `en` |
| `INFOBIP_WHATSAPP_COPY_BUTTON` | no | Default `true` (authentication templates have a copy-code button) |
| `INFOBIP_SMS_SENDER` | no | SMS fallback if WhatsApp fails |
| `ADMIN_NOTIFY_EMAIL` | no | Gets an email for each new application |

Without Infobip set up, nobody can complete sign-in in production — the WhatsApp step is mandatory.

## Run locally

```bash
npm install
createdb snapcash
DATABASE_URL=postgres://localhost/snapcash OWNER_ADMIN_EMAIL=you@example.com npm run dev
```

In development, confirmation links and WhatsApp codes are printed to the server log instead of being sent, and uploads are stored in `.data/uploads`.

Test (against a running dev server with a fresh database, logging to `server.log`):

```bash
DATABASE_URL=... OWNER_ADMIN_EMAIL=owner@example.com PORT=3999 node server/index.js > server.log 2>&1 &
BASE=http://localhost:3999 LOG=server.log npm test
```

## Admins

- `OWNER_ADMIN_EMAIL` is made the owner on every boot.
- The owner can add reviewers (view only) and approvers (decide and run the loan lifecycle) from the admin page.
- Or: `npm run make-admin -- someone@example.com approver`
