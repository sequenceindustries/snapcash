/* ============================================================
   Phase 3b — Applicant document storage (Supabase Storage)
   Run this in Supabase SQL Editor, once.
   ============================================================ */

/* 1) Create a PRIVATE bucket for ID/payslip/bank-statement uploads.
      Private = files are never publicly reachable by URL guessing;
      access is only via signed URLs we generate for admins. */
insert into storage.buckets (id, name, public)
values ('applicant-documents', 'applicant-documents', false)
on conflict (id) do nothing;

/* 2) Applicants can upload ONLY into their own folder (path prefixed
      with their own user id), and can re-read/replace their own files. */
drop policy if exists "Users upload their own documents" on storage.objects;
create policy "Users upload their own documents" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'applicant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users read their own documents" on storage.objects;
create policy "Users read their own documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'applicant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users replace their own documents" on storage.objects;
create policy "Users replace their own documents" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'applicant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

/* 3) Admins can read EVERY applicant's documents (for review),
      reusing the same is_active_admin() function from Phase 3. */
drop policy if exists "Admins read all documents" on storage.objects;
create policy "Admins read all documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'applicant-documents'
    and public.is_active_admin()
  );

/* 4) Track submission on the profile so the app and dashboard can
      check "has this person sent their documents?" with one column
      instead of listing storage every time. */
alter table profiles add column if not exists documents_submitted_at timestamp with time zone;
