-- snapcash schema v1 (Railway Postgres). Replaces the Supabase phase1–7 scripts.
-- Access control lives in the Node API, not in row-level security: the
-- browser never talks to the database directly.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ============================================================
-- Identity and sessions
-- ============================================================

create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null unique,
  password_hash      text,                          -- null for Google-only accounts
  google_sub         text unique,                   -- Google account id, once linked
  email_verified_at  timestamptz,
  phone              text unique,                   -- E.164, only set once verified
  phone_verified_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One row per login. The cookie holds a random token; only its SHA-256 is stored.
-- otp_verified_at is the per-login WhatsApp challenge (replaces login_verifications).
create table sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  token_hash       bytea not null unique,
  otp_verified_at  timestamptz,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  expires_at       timestamptz not null
);
create index sessions_user_idx on sessions(user_id);

-- Single-use emailed links: email confirmation and password reset.
create table auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('email_verify', 'password_reset')),
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index auth_tokens_user_idx on auth_tokens(user_id, purpose);

-- WhatsApp one-time codes, for enrolling a phone and for the per-login challenge.
create table phone_otps (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  session_id   uuid references sessions(id) on delete cascade,
  phone        text not null,
  purpose      text not null check (purpose in ('enrol', 'login')),
  code_hash    bytea not null,
  attempts     int not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index phone_otps_user_idx on phone_otps(user_id, purpose, created_at desc);

-- ============================================================
-- Applicant data
-- ============================================================

create table profiles (
  user_id                 uuid primary key references users(id) on delete cascade,
  email                   citext,
  first_name              text not null,
  last_name               text not null,
  sa_id_number            text not null unique check (sa_id_number ~ '^[0-9]{13}$'),
  phone_number            text,
  employment_status       text not null check (employment_status in
                            ('permanent', 'contract', 'self_employed', 'pensioner', 'unemployed')),
  employer                text,
  job_title               text,
  monthly_net_income      numeric(12,2) not null check (monthly_net_income >= 0),
  physical_address        text,
  documents_submitted_at  timestamptz,
  popia_accepted          boolean not null default false,
  popia_accepted_at       timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Append-only record of each consent, with the exact wording shown.
create table popia_consents (
  id            bigserial primary key,
  user_id       uuid not null references users(id) on delete cascade,
  consent_type  text not null,
  consent_text  text not null,
  version       text not null,
  granted       boolean not null,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index popia_consents_user_idx on popia_consents(user_id);

-- Uploaded files live in the Railway bucket; this table indexes them.
create table documents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  kind           text not null check (kind in ('id', 'payslip', 'statement')),
  object_key     text not null unique,
  original_name  text,
  content_type   text not null,
  size_bytes     int not null,
  created_at     timestamptz not null default now()
);
create index documents_user_idx on documents(user_id);

-- ============================================================
-- Admins and loans
-- ============================================================

create table admin_users (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references users(id) on delete set null,  -- linked on first login
  email        citext not null unique,
  role         text not null default 'reviewer' check (role in ('reviewer', 'approver', 'owner')),
  status       text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  invited_by   uuid references admin_users(id),
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

create type loan_status as enum (
  'pending_kyc', 'under_review', 'approved', 'declined',
  'debicheck_authorized', 'disbursed', 'settled'
);

create table loan_applications (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete restrict,
  requested_amount        numeric(10,2) not null check (requested_amount between 500 and 2000),
  term_days               int not null check (term_days between 5 and 30),
  initiation_fee          numeric(10,2) not null,
  service_fee             numeric(10,2) not null,
  interest_amount         numeric(10,2) not null,
  total_repayable         numeric(10,2) not null,
  due_date                date,
  status                  loan_status not null default 'under_review',
  submitted_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  reviewed_by             uuid references admin_users(id),
  reviewed_at             timestamptz,
  review_notes            text,
  decision_reason         text,
  disbursed_at            timestamptz,
  disbursed_amount        numeric(10,2),
  disbursement_reference  text,
  settled_at              timestamptz,
  amount_collected        numeric(10,2),
  collection_reference    text
);
create index loan_applications_user_idx on loan_applications(user_id, created_at desc);
create index loan_applications_status_idx on loan_applications(status);
-- At most one open application per person.
create unique index loan_applications_one_open
  on loan_applications(user_id)
  where status in ('pending_kyc', 'under_review', 'approved', 'debicheck_authorized', 'disbursed');

create table loan_application_events (
  id                   bigserial primary key,
  loan_application_id  uuid not null references loan_applications(id) on delete cascade,
  event_type           text not null,
  previous_status      text,
  new_status           text not null,
  actor_id             uuid references admin_users(id),
  actor_email          citext,
  notes                text,
  created_at           timestamptz not null default now()
);
create index loan_events_app_idx on loan_application_events(loan_application_id);

create table email_logs (
  id                   bigserial primary key,
  recipient_email      citext not null,
  recipient_user_id    uuid references users(id) on delete set null,
  email_type           text not null,
  subject              text,
  loan_application_id  uuid references loan_applications(id) on delete set null,
  status               text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id  text,
  error_message        text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);
create index email_logs_created_idx on email_logs(created_at desc);
