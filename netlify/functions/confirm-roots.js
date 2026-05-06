// netlify/functions/confirm-roots.js
//
// GET endpoint that handles clicks on the double-opt-in confirmation
// link embedded in the confirmation email. On a valid token:
//
//   1. Sets confirmed_at = NOW() on the matching pdf_subscribers row.
//   2. Sends Email 1 (the starter guide) immediately, synchronously,
//      so the recipient sees it in their inbox before the redirect
//      page finishes loading.
//   3. Redirects to /roots-confirmed.html for a friendly "you're in,
//      check your inbox" page.
//
// Idempotent — if confirmed_at is already set we DON'T fire Email 1
// again (clicking the link twice should not produce duplicate
// guide-delivery emails). We just redirect.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { sendEmail1_StarterGuide } = require('./lib/pdf-lead-email');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

exports.handler = async (event) => {
  const token = (event.queryStringParameters && event.queryStringParameters.t) || '';

  // Bad / missing token → redirect to a generic error page on /roots.
  if (!token || typeof token !== 'string' || token.length < 16) {
    return {
      statusCode: 302,
      headers: { Location: `${SITE}/roots?confirm=invalid` },
      body: '',
    };
  }

  try {
    const clan_id = await clanId();

    const { data: subscriber, error: lookupErr } = await supa()
      .from('pdf_subscribers')
      .select('id, email, first_name, confirm_token, confirmed_at, unsubscribed_at, unsubscribe_token, clan_id')
      .eq('clan_id', clan_id)
      .eq('confirm_token', token)
      .maybeSingle();

    if (lookupErr) {
      console.error('confirm-roots: lookup failed:', lookupErr.message);
      return { statusCode: 302, headers: { Location: `${SITE}/roots?confirm=error` }, body: '' };
    }

    if (!subscriber) {
      return { statusCode: 302, headers: { Location: `${SITE}/roots?confirm=invalid` }, body: '' };
    }

    // Already confirmed → just redirect (don't re-send Email 1).
    if (subscriber.confirmed_at) {
      return { statusCode: 302, headers: { Location: `${SITE}/roots-confirmed.html` }, body: '' };
    }

    // ── Member-check shortcut ─────────────────────────────────────────────
    //     If this email belongs to a confirmed member by the time the
    //     confirmation link is clicked, do not send the starter-guide
    //     Email 1. They may have signed up to /roots and then joined
    //     before clicking confirm; or this fix landed after they
    //     submitted but before they clicked. Either way, they don't
    //     need the lead-magnet drip.
    //
    //     Treatment: stamp confirmed_at + converted_to_member_at on the
    //     subscriber row (so the daily sweep also skips them if they
    //     ever resurrect), log the event, and redirect to
    //     /roots-confirmed.html. The confirmed page has the PDF link
    //     visible regardless, so a member who genuinely wants the PDF
    //     can grab it from there.
    const { data: memberMatch, error: memberErr } = await supa()
      .from('members')
      .select('id')
      .eq('clan_id', clan_id)
      .ilike('email', subscriber.email)
      .limit(1)
      .maybeSingle();
    if (memberErr) {
      console.warn('confirm-roots: member-check failed, proceeding with Email 1:', memberErr.message);
      // fall through to normal confirmation flow
    } else if (memberMatch) {
      const now = new Date().toISOString();
      await supa()
        .from('pdf_subscribers')
        .update({
          confirmed_at: now,
          unsubscribed_at: null,
          converted_to_member_at: now,
        })
        .eq('id', subscriber.id);
      await logEvent({
        clan_id,
        member_id: memberMatch.id,
        event_type: 'pdf_subscriber_confirmed_already_member',
        payload: { subscriber_id: subscriber.id },
      }).catch(() => {});
      return { statusCode: 302, headers: { Location: `${SITE}/roots-confirmed.html` }, body: '' };
    }

    // First confirmation: stamp confirmed_at, then send Email 1.
    const now = new Date().toISOString();
    const { error: updateErr } = await supa()
      .from('pdf_subscribers')
      .update({ confirmed_at: now, unsubscribed_at: null })
      .eq('id', subscriber.id);

    if (updateErr) {
      console.error('confirm-roots: update failed:', updateErr.message);
      return { statusCode: 302, headers: { Location: `${SITE}/roots?confirm=error` }, body: '' };
    }

    // Fire Email 1 synchronously so the guide arrives in their inbox
    // moments after the click.
    try {
      const ok = await sendEmail1_StarterGuide({ ...subscriber, confirmed_at: now });
      if (!ok) console.error('confirm-roots: Email 1 dispatch failed for', subscriber.email);
    } catch (err) {
      console.error('confirm-roots: Email 1 send error:', err.message);
      // Non-fatal — the cron will not redeliver Email 1, but the user
      // is on the list and will receive Emails 2-5 normally. The
      // attached PDF link in /roots-confirmed.html is the fallback.
    }

    await logEvent({
      clan_id,
      member_id: null,
      event_type: 'pdf_subscriber_confirmed',
      payload: { subscriber_id: subscriber.id },
    });

    return { statusCode: 302, headers: { Location: `${SITE}/roots-confirmed.html` }, body: '' };
  } catch (err) {
    console.error('confirm-roots: fatal:', err.message, err.stack);
    return { statusCode: 302, headers: { Location: `${SITE}/roots?confirm=error` }, body: '' };
  }
};
