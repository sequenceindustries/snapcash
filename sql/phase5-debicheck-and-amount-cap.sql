/* ============================================================
   Phase 5 — Loan amount cap reduced to R2,000; new DebiCheck
   Authorization stage between Approved and Disbursed.
   Run this in Supabase SQL Editor, once.
   ============================================================ */

/* 1) Reduce max loan amount to R2,000. Drops whatever the existing
      requested_amount constraint is called (name may vary) and replaces
      it, so this works regardless of what phase2 originally named it. */
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'loan_applications'::regclass
      and pg_get_constraintdef(oid) ilike '%requested_amount%'
  loop
    execute format('alter table loan_applications drop constraint %I', con.conname);
  end loop;
end $$;

alter table loan_applications
  add constraint requested_amount_range check (requested_amount between 500 and 2000);

/* 2) New status value: debicheck_authorized, sits between approved and
      disbursed. If your status column uses a Postgres ENUM type named
      loan_status, this adds the value. If it errors with "type does not
      exist", tell Claude the actual type/column name and this gets fixed. */
alter type loan_status add value if not exists 'debicheck_authorized';

/* 3) Admin action: mark DebiCheck authorised (manual flag, since DebiCheck
      itself isn't integrated yet — an admin confirms it happened). */
create or replace function mark_debicheck_authorized(
  app_id uuid
) returns boolean as $$
declare
  v_admin_id uuid;
begin
  if not is_active_admin() then
    raise exception 'Not an active admin';
  end if;

  select id into v_admin_id from admin_users where id = auth.uid();

  update loan_applications
  set status = 'debicheck_authorized'
  where id = app_id and status = 'approved';

  if not found then
    raise exception 'Application not found or not in approved status';
  end if;

  insert into loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id)
  values (app_id, 'debicheck_authorized', 'approved', 'debicheck_authorized', v_admin_id);

  return true;
end;
$$ language plpgsql security definer;

/* 4) mark_loan_disbursed now requires debicheck_authorized status first,
      not approved directly — disbursement only happens after the debit
      order authority is in place. Redefining the whole function since
      Postgres can't just patch the WHERE clause of an existing one. */
create or replace function mark_loan_disbursed(
  app_id uuid,
  amount numeric,
  reference text
) returns boolean as $$
declare
  v_admin_id uuid;
begin
  if not is_active_admin() then
    raise exception 'Not an active admin';
  end if;

  select id into v_admin_id from admin_users where id = auth.uid();

  update loan_applications
  set status = 'disbursed',
      disbursed_at = now(),
      disbursed_amount = amount,
      disbursement_reference = reference
  where id = app_id and status = 'debicheck_authorized';

  if not found then
    raise exception 'Application not found or not in debicheck_authorized status';
  end if;

  insert into loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, notes)
  values (app_id, 'disbursed', 'debicheck_authorized', 'disbursed', v_admin_id, reference);

  return true;
end;
$$ language plpgsql security definer;
