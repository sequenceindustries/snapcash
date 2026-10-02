/* ============================================================
   Phase 4 — Loan lifecycle: disbursement, settlement, arrears
   Run this in Supabase SQL Editor, once.
   ============================================================ */

/* 1) Ledger fields on loan_applications */
alter table loan_applications add column if not exists disbursed_at timestamp with time zone;
alter table loan_applications add column if not exists disbursed_amount numeric(10,2);
alter table loan_applications add column if not exists disbursement_reference text;

alter table loan_applications add column if not exists settled_at timestamp with time zone;
alter table loan_applications add column if not exists amount_collected numeric(10,2);
alter table loan_applications add column if not exists collection_reference text;

/* 2) Denormalised email on profiles, so admins can see it without needing
      service-role access to auth.users from the client. Populated going
      forward by apply.html; existing rows will show blank until updated. */
alter table profiles add column if not exists email text;

/* 3) A loan is "in arrears" once its due date has passed and it's disbursed
      but not yet settled. View, not a stored flag — always accurate. */
create or replace view loans_in_arrears as
select *, (current_date - due_date::date) as days_overdue
from loan_applications
where status = 'disbursed' and settled_at is null and due_date < now();

/* 4) Admin actions: mark disbursed / mark settled.
      Same shape as approve_loan_application()/decline_loan_application() —
      SECURITY DEFINER so RLS doesn't block the write, with the admin check
      done INSIDE the function rather than relying on a table policy. */
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
  where id = app_id and status = 'approved';

  if not found then
    raise exception 'Application not found or not in approved status';
  end if;

  insert into loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, notes)
  values (app_id, 'disbursed', 'approved', 'disbursed', v_admin_id, reference);

  return true;
end;
$$ language plpgsql security definer;

create or replace function mark_loan_settled(
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
  set status = 'settled',
      settled_at = now(),
      amount_collected = amount,
      collection_reference = reference
  where id = app_id and status = 'disbursed';

  if not found then
    raise exception 'Application not found or not in disbursed status';
  end if;

  insert into loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, notes)
  values (app_id, 'settled', 'disbursed', 'settled', v_admin_id, reference);

  return true;
end;
$$ language plpgsql security definer;
