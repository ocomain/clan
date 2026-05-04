// netlify/functions/resume.js
//
// GET /resume?token=<resume_token>
//
// One-click resume for an abandoned application. Looks up the
// application by token, validates it is still pending, then
// 302-redirects to the existing /api/create-checkout endpoint
// with tier + email pre-filled — so the visitor lands directly
// on the Stripe checkout page without having to re-enter the
// herald form.
//
// CONVERSION LEVER — this is the largest single conversion
// improvement in the re-engagement sequence. Asking an
// abandoned-cart user to "go back and start again" loses a
// large fraction; one-click resume keeps the friction at zero.
//
// Tokens are stamped on application creation (migration 024
// backfilled existing rows with random tokens; future inserts
// get one via column default). Tokens never expire — the
// application status itself is the gate (only 'pending' rows
// can resume; once 'paid' or 'cancelled' or other terminal
// state, the resume endpoint returns the user to /membership
// with a kind explanation).

const { supa, clanId, logEvent } = require('./lib/supabase');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

exports.handler = async (event) => {
  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';

  // Bad / missing token → friendly redirect to membership page.
  if (!token || typeof token !== 'string' || token.length < 16) {
    return {
      statusCode: 302,
      headers: { Location: `${SITE}/membership?resume=invalid` },
      body: '',
    };
  }

  try {
    const clan_id = await clanId();

    const { data: application, error: lookupErr } = await supa()
      .from('applications')
      .select('id, email, name, tier, status, resume_token')
      .eq('clan_id', clan_id)
      .eq('resume_token', token)
      .maybeSingle();

    if (lookupErr) {
      console.error('resume: lookup failed:', lookupErr.message);
      return { statusCode: 302, headers: { Location: `${SITE}/membership?resume=error` }, body: '' };
    }

    if (!application) {
      return { statusCode: 302, headers: { Location: `${SITE}/membership?resume=invalid` }, body: '' };
    }

    // Already converted — they paid and are a member. Send them
    // somewhere useful rather than re-charging them.
    if (application.status === 'paid') {
      return { statusCode: 302, headers: { Location: `${SITE}/members/?resume=already_complete` }, body: '' };
    }

    // Cancelled / abandoned terminal state — direct them to the
    // membership page where they can decide afresh.
    if (application.status !== 'pending') {
      return { statusCode: 302, headers: { Location: `${SITE}/membership?resume=expired` }, body: '' };
    }

    // Log the resume click — useful conversion analytics for the
    // re-engagement sequence (which email-bucket drove the click?
    // We can correlate against reengage_*_sent_at timestamps).
    await logEvent({
      clan_id,
      event_type: 'application_resume_clicked',
      payload: { application_id: application.id, tier: application.tier },
    });

    // 302 to the existing checkout endpoint with tier + email
    // pre-filled. Stripe Checkout takes it from there.
    const params = new URLSearchParams({
      tier: application.tier || 'clan-ind',
      ...(application.email ? { email: application.email } : {}),
    });

    return {
      statusCode: 302,
      headers: { Location: `${SITE}/api/create-checkout?${params.toString()}` },
      body: '',
    };
  } catch (err) {
    console.error('resume: fatal:', err.message, err.stack);
    return { statusCode: 302, headers: { Location: `${SITE}/membership?resume=error` }, body: '' };
  }
};
