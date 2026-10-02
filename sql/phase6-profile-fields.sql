/* ============================================================
   Phase 6 — Additional applicant profile fields.
   Run this in Supabase SQL Editor, once.
   ============================================================ */

alter table profiles add column if not exists employer text;
alter table profiles add column if not exists job_title text;
alter table profiles add column if not exists physical_address text;
