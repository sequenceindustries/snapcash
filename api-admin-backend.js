/**
 * Snapcash Phase 3 — Admin Backend API
 * 
 * This runs on a Node.js serverless platform (Vercel, Netlify, or your own server).
 * It handles:
 * - Approve/decline decisions
 * - Email sending via Resend
 * - Admin invites
 * 
 * Setup:
 * 1. Create a .env.local file with:
 *    SUPABASE_URL=your_url
 *    SUPABASE_SERVICE_ROLE_KEY=your_service_role_key (NEVER expose this to frontend)
 *    RESEND_API_KEY=your_resend_key
 * 
 * 2. If using Vercel: paste these values into Settings > Environment Variables
 *    If using your own server: create .env and use dotenv
 * 
 * 3. Deploy and set BASE_URL in config.js to this server's /api/admin/ path
 */

import Resend from 'resend';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Server-only key with all permissions
);

const resend = new Resend(process.env.RESEND_API_KEY);

/* Approve or decline an application */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { app_id, decision, notes } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token || !app_id || !decision) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    /* Verify user is admin */
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: admin } = await supabase.from('admin_users')
      .select('id, role')
      .eq('email', user.email)
      .eq('status', 'active')
      .maybeSingle();

    if (!admin || (decision === 'approved' && admin.role === 'reviewer')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    /* Get application + applicant email */
    const { data: app } = await supabase.from('loan_applications')
      .select('id, user_id, status, requested_amount, total_repayable, profiles(first_name, last_name)')
      .eq('id', app_id)
      .maybeSingle();

    if (!app || app.status !== 'under_review') {
      return res.status(400).json({ error: 'Application not found or already processed' });
    }

    const { data: userAuth } = await supabase.auth.admin.getUserById(app.user_id);
    const recipientEmail = userAuth?.email;

    /* Update application status */
    const updateData = {
      status: decision,
      reviewed_by: admin.id,
      reviewed_at: new Date().toISOString()
    };
    if (decision === 'declined') updateData.decision_reason = notes;
    if (decision === 'approved') updateData.review_notes = notes;

    const { error: updateError } = await supabase.from('loan_applications')
      .update(updateData)
      .eq('id', app_id);

    if (updateError) throw updateError;

    /* Log event */
    await supabase.from('loan_application_events').insert({
      loan_application_id: app_id,
      event_type: decision,
      previous_status: 'under_review',
      new_status: decision,
      actor_id: admin.id,
      actor_email: user.email,
      notes: notes
    });

    /* Send email */
    let emailSubject, emailHtml;
    const name = app.profiles?.first_name + ' ' + app.profiles?.last_name;
    const fmt = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 });

    if (decision === 'approved') {
      emailSubject = '✅ Your Snapcash application is approved';
      emailHtml = `
        <h2>Good news, ${name}!</h2>
        <p>Your application for <strong>${fmt.format(app.requested_amount)}</strong> has been <strong>approved</strong>.</p>
        <p>Your total repayment amount is <strong>${fmt.format(app.total_repayable)}</strong>.</p>
        <p><a href="https://snapcash.sequenceindustries.xyz/dashboard.html">Log in to your dashboard</a> to complete the next steps (bank verification, DebiCheck mandate).</p>
        <p>Questions? <a href="https://snapcash.sequenceindustries.xyz/contact.html">Get in touch</a>.</p>
      `;
    } else {
      emailSubject = 'Your Snapcash application';
      emailHtml = `
        <h2>Hi ${name},</h2>
        <p>We've reviewed your application for <strong>${fmt.format(app.requested_amount)}</strong>.</p>
        <p>Unfortunately, we weren't able to approve it at this time.${notes ? ' ' + notes : ''}</p>
        <p>You're welcome to apply again in the future. If you'd like to discuss, <a href="https://snapcash.sequenceindustries.xyz/contact.html">reach out to us</a>.</p>
      `;
    }

    const { error: emailError } = await resend.emails.send({
      from: 'Snapcash <applications@snapcash.sequenceindustries.xyz>',
      to: recipientEmail,
      subject: emailSubject,
      html: emailHtml
    });

    /* Log email attempt */
    await supabase.from('email_logs').insert({
      recipient_email: recipientEmail,
      recipient_user_id: app.user_id,
      email_type: decision === 'approved' ? 'application_approved' : 'application_declined',
      subject: emailSubject,
      loan_application_id: app_id,
      status: emailError ? 'failed' : 'sent',
      error_message: emailError?.message
    });

    if (emailError) {
      console.error('Email send failed:', emailError);
      return res.status(200).json({
        success: true,
        message: `Application ${decision}, but email send failed. Check logs.`,
        email_error: emailError.message
      });
    }

    res.status(200).json({ success: true, message: `Application ${decision}. Email sent.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
