/* ============================================================
   Phase 7 — Mandatory WhatsApp 2FA: server-side login verification.

   This table is the TEMPORARY enforcement layer standing in for
   Supabase Phone MFA / AAL2 (not available on the free plan). It
   records that a specific login session (identified by the Supabase
   session's own "session_id" JWT claim) has completed the mandatory
   WhatsApp challenge. It intentionally does NOT rely on a client-side
   localStorage flag, which a user could set themselves.

   When Supabase Phone MFA/AAL2 becomes available, this table and the
   guard logic that reads it (see auth.js: getAuthState/recordLoginVerified)
   should be retired in favour of checking the session's AAL directly.
   ============================================================ */

create table if not exists login_verifications (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  verified_at timestamptz not null default now(),
  unique (user_id, session_id)
);

alter table login_verifications enable row level security;

/* Append-only from the client's point of view — same pattern as
   popia_consents elsewhere in this project. No update/delete policy:
   a login verification, once recorded, is never edited. */
drop policy if exists "Users insert their own login verification" on login_verifications;
create policy "Users insert their own login verification" on login_verifications
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users read their own login verification" on login_verifications;
create policy "Users read their own login verification" on login_verifications
  for select to authenticated
  using (user_id = auth.uid());

/* Admins can read this for support/audit purposes (e.g. "did this user
   complete their WhatsApp challenge for their current session?"),
   reusing the existing is_active_admin() function from Phase 3. */
drop policy if exists "Admins read all login verifications" on login_verifications;
create policy "Admins read all login verifications" on login_verifications
  for select to authenticated
  using (public.is_active_admin());
