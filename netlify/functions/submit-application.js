// netlify/functions/submit-application.js
// Called when herald conversation completes.
// (1) Writes a row to public.applications (status='pending') so the nightly
//     sweep can email people who never reach Stripe.
// (2) Emails the clan inbox with full applicant details (existing behaviour).

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, country, connection, source, tier, invite } = data;
  if (!name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and email required' }) };
  }

  // ── Sponsor lookup (if invite token present) ─────────────────────────────
  // Surfaces who invited this applicant so the Office sees the sponsor at
  // triage time, not just after the Stripe webhook lands. Crucially: this
  // does NOT REPLACE the existing Stripe-metadata-based attribution path
  // (which is the source of truth for the actual member-to-member sponsor
  // link in the database). It just gives OPS visibility at the application
  // stage, before payment, so the Office can:
  //   - Recognise repeat sponsors (e.g. Antoin sending many invites)
  //   - Greet the new applicant with sponsor context if they need
  //     follow-up between application and payment
  //   - Notice broken attribution early (e.g. token mismatch) rather
  //     than discovering it weeks later
  //
  // Lookup is best-effort — failures don't block the submission. If the
  // token is malformed, missing from DB, or the lookup errors out, we
  // simply omit the sponsor row from the notification email.
  let sponsor = null;
  if (typeof invite === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invite)) {
    try {
      const { data: invRow } = await supa()
        .from('invitations')
        .select('inviter_member_id')
        .eq('invite_token', invite)
        .maybeSingle();
      if (invRow && invRow.inviter_member_id) {
        const { data: memRow } = await supa()
          .from('members')
          .select('name, email')
          .eq('id', invRow.inviter_member_id)
          .maybeSingle();
        if (memRow) sponsor = { name: memRow.name, email: memRow.email };
      }
    } catch (e) {
      // Lookup failed — log for diagnostics but continue. The application
      // submission itself must not fail because we couldn't enrich one row.
      console.warn('submit-application sponsor lookup failed:', e.message);
    }
  }

  // ── 1. Persist the application (pre-payment) ─────────────────────────────
  // This is what makes abandoned-email recovery actually work: the email is
  // captured here, *before* Stripe. Herald submitted → paid → application
  // status flips to 'paid'. Herald submitted → never paid → nightly sweep
  // catches it after 24h and emails the reminder.
  try {
    const clan_id = await clanId();
    const { data: inserted, error } = await supa()
      .from('applications')
      .insert({
        clan_id,
        email: email.toLowerCase().trim(),
        name,
        tier,
        country,
        connection,
        source,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error) {
      console.error('applications insert failed:', error.message);
    } else {
      await logEvent({ clan_id, event_type: 'application_submitted', payload: { application_id: inserted.id, email, tier } });
    }
  } catch (e) {
    console.error('submit-application Supabase write failed:', e.message);
    // Don't block the user flow on DB failure — they've done their part.
  }

  // ── 2. Notify clan inbox (existing behaviour) ────────────────────────────
  // Sponsor row is only emitted when an invite token was present AND
  // resolved to a member. When absent (cold signups, founder-invite flow,
  // or unattributable invites), no row appears — keeps the email clean.
  const sponsorRow = sponsor
    ? `<tr><td style="padding:10px;border:1px solid #ddd;color:#666">Invited by</td><td style="padding:10px;border:1px solid #ddd"><strong style="color:#0C1A0C">${sponsor.name}</strong>${sponsor.email ? ` &middot; <a href="mailto:${sponsor.email}" style="color:#B8975A">${sponsor.email}</a>` : ''}</td></tr>`
    : '';

  const html = `<div style="font-family:sans-serif;max-width:500px">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px">New membership application — Clan Ó Comáin</h2>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666;width:130px">Name</td><td style="padding:10px;border:1px solid #ddd"><strong>${name}</strong></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Email</td><td style="padding:10px;border:1px solid #ddd"><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Country</td><td style="padding:10px;border:1px solid #ddd">${country || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Connection</td><td style="padding:10px;border:1px solid #ddd">${connection || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Heard via</td><td style="padding:10px;border:1px solid #ddd">${source || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Tier selected</td><td style="padding:10px;border:1px solid #ddd"><strong style="color:#B8975A">${tier || 'Not specified'}</strong></td></tr>
      ${sponsorRow}
    </table>
    <p style="font-size:13px;color:#666">This application was submitted via the Clan Herald. Payment may or may not have been completed — check Stripe for confirmation.${sponsor ? ' Sponsor attribution will be confirmed in the database when the Stripe webhook lands.' : ''}</p>
  </div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: CLAN_EMAIL,
        subject: `New application: ${name} — ${tier || 'tier not selected'}`,
        html,
      }),
    });
  } catch (err) {
    console.error('Email failed:', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
