/* ============================================================
   PHASE 3 — Admin panel, email logs, multi-admin support
   Run this AFTER phase2-supabase.sql has been applied
   ============================================================ */

/* Table: admin_users — who can approve/decline applications */
CREATE TABLE admin_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'reviewer', /* reviewer, approver, owner */
  invited_by UUID REFERENCES admin_users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending', /* pending, active, revoked */
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX ix_admin_users_email ON admin_users(email);
CREATE INDEX ix_admin_users_status ON admin_users(status);

/* Table: loan_application_events — audit trail of all status changes */
CREATE TABLE loan_application_events (
  id BIGSERIAL PRIMARY KEY,
  loan_application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, /* submitted, under_review, approved, declined, disbursed, settled */
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_id UUID REFERENCES admin_users(id),
  actor_email TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX ix_loan_events_app ON loan_application_events(loan_application_id);
CREATE INDEX ix_loan_events_status ON loan_application_events(new_status);

/* Table: email_logs — track all transactional emails sent */
CREATE TABLE email_logs (
  id BIGSERIAL PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  recipient_user_id UUID REFERENCES auth.users(id),
  email_type TEXT NOT NULL, /* application_approved, application_declined, new_application_notification, status_update */
  subject TEXT,
  template_id TEXT,
  loan_application_id UUID REFERENCES loan_applications(id),
  status TEXT DEFAULT 'pending', /* pending, sent, bounced, failed */
  resend_message_id TEXT,
  error_message TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX ix_email_logs_recipient ON email_logs(recipient_email);
CREATE INDEX ix_email_logs_type ON email_logs(email_type);
CREATE INDEX ix_email_logs_app ON email_logs(loan_application_id);

/* Update loan_applications to add admin review fields */
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES admin_users(id);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS decision_reason TEXT;

/* RLS: admin_users — only admins can read, owner can manage */
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read all admins" ON admin_users FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid() AND status = 'active'));
CREATE POLICY "Only owner can insert admins" ON admin_users FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid() AND role = 'owner'));

/* RLS: loan_application_events — admins read own actions, users read their own app events */
ALTER TABLE loan_application_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see events for their own applications" ON loan_application_events FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM loan_applications la WHERE la.id = loan_application_id AND la.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid() AND status = 'active')
  );
CREATE POLICY "Admins can insert events" ON loan_application_events FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid() AND status = 'active'));

/* RLS: email_logs — only admins can read */
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read all email logs" ON email_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid() AND status = 'active'));

/* Function: update loan status + create event + trigger email (to be called from admin API) */
CREATE OR REPLACE FUNCTION approve_loan_application(
  app_id UUID,
  admin_id UUID,
  notes TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_user_email TEXT;
  v_amount NUMERIC;
  v_total NUMERIC;
BEGIN
  -- Update status
  UPDATE loan_applications SET status = 'approved', reviewed_by = admin_id, reviewed_at = NOW(), review_notes = notes
  WHERE id = app_id;

  -- Log event
  INSERT INTO loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, notes)
  SELECT app_id, 'approved', 'under_review', 'approved', admin_id, notes;

  -- Get applicant email + loan details for email
  SELECT u.email, la.requested_amount, la.total_repayable INTO v_user_email, v_amount, v_total
  FROM auth.users u JOIN loan_applications la ON la.user_id = u.id WHERE la.id = app_id;

  -- Log email (will be sent by backend)
  INSERT INTO email_logs (recipient_email, recipient_user_id, email_type, loan_application_id, subject)
  VALUES (v_user_email, (SELECT user_id FROM loan_applications WHERE id = app_id), 'application_approved', app_id, 'Your Snapcash application is approved');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION decline_loan_application(
  app_id UUID,
  admin_id UUID,
  reason TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_user_email TEXT;
BEGIN
  -- Update status
  UPDATE loan_applications SET status = 'declined', reviewed_by = admin_id, reviewed_at = NOW(), decision_reason = reason
  WHERE id = app_id;

  -- Log event
  INSERT INTO loan_application_events (loan_application_id, event_type, previous_status, new_status, actor_id, notes)
  SELECT app_id, 'declined', 'under_review', 'declined', admin_id, reason;

  -- Get applicant email
  SELECT u.email INTO v_user_email
  FROM auth.users u JOIN loan_applications la ON la.user_id = u.id WHERE la.id = app_id;

  -- Log email
  INSERT INTO email_logs (recipient_email, recipient_user_id, email_type, loan_application_id, subject)
  VALUES (v_user_email, (SELECT user_id FROM loan_applications WHERE id = app_id), 'application_declined', app_id, 'Your Snapcash application');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

/* Seed the owner admin (you) — run once, manually */
-- INSERT INTO admin_users (id, email, role, status, accepted_at)
-- VALUES (auth.uid(), 'sequence.2027@gmail.com', 'owner', 'active', NOW())
-- ON CONFLICT DO NOTHING;
