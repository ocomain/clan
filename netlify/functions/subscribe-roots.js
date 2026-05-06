// netlify/functions/subscribe-roots.js
//
// Form POST endpoint for the /roots landing page. Accepts an email
// (and optional first name), creates or updates a pdf_subscribers
// row with confirmed_at = NULL, and sends a double-opt-in
// confirmation email.
//
// DOUBLE OPT-IN — required for ePrivacy / GDPR compliance and CAN-SPAM
// best practice. We do NOT send the PDF or any lifecycle email until
// the recipient has clicked the confirmation link in the email. This
// also serves as a low-friction spam filter — bots typically don't
// complete a click-through.
//
// IDEMPOTENCY — the same email submitting twice is fine: if the row
// already exists, we leave it alone and resend the confirmation. If
// the email is already confirmed (subscriber on the list), we still
// resend the confirmation rather than reveal that fact (slight
// privacy hardening — don't leak "this email is on our list" to
// anyone who guesses the address).

const crypto = require('crypto');
const { supa, clanId, logEvent } = require('./lib/supabase');
const { sendConfirmationEmail } = require('./lib/pdf-lead-email');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

exports.handler = async (event) => {
  // CORS — same-origin form, but POST + JSON content type.
  const cors = {
    'Access-Control-Allow-Origin': SITE,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'method_not_allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid_json' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const firstName = (body.first_name || '').trim().slice(0, 80) || null;

  if (!isValidEmail(email)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid_email' }) };
  }

  try {
    const clan_id = await clanId();

    // ── Member-check shortcut ─────────────────────────────────────────────
    //     Lead-magnet flow is for people NOT yet in the clan. If this
    //     email already corresponds to a confirmed member, do not
    //     create a pdf_subscribers row, do not send a confirmation
    //     email, and do not start a drip. Tell the form so it can
    //     show the 'you're already a member, here's the PDF directly'
    //     branch instead of the normal 'check your inbox' branch.
    //
    //     Case-insensitive match — the members.email column may carry
    //     mixed casing depending on the original signup path; we
    //     compare lowercase to lowercase.
    const { data: memberMatch, error: memberErr } = await supa()
      .from('members')
      .select('id, name')
      .eq('clan_id', clan_id)
      .ilike('email', email)
      .limit(1)
      .maybeSingle();
    if (memberErr) {
      // Fail-open: a transient DB error here shouldn't block a
      // legitimate non-member from getting the guide. Log and proceed
      // through the normal flow; worst case is one duplicate email to
      // someone who's already a member.
      console.warn('subscribe-roots: member-check failed, proceeding:', memberErr.message);
    } else if (memberMatch) {
      // Audit trail — useful to spot patterns of members trying to
      // re-enter the lead-magnet flow (suggests they want the PDF
      // for a friend, or have forgotten they joined).
      await logEvent({
        clan_id,
        member_id: memberMatch.id,
        event_type: 'pdf_subscriber_blocked_already_member',
        payload: { email_hash: crypto.createHash('sha256').update(email).digest('hex') },
      }).catch(() => {});
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          ok: true,
          already_member: true,
          message: "You're already a member of Clan Ó Comáin — there's no need to subscribe to the starter guide. The PDF is yours to download directly.",
        }),
      };
    }

    // Look up an existing row (case-insensitive match on email).
    const { data: existing, error: lookupErr } = await supa()
      .from('pdf_subscribers')
      .select('id, email, first_name, confirm_token, confirmed_at, unsubscribe_token, unsubscribed_at')
      .eq('clan_id', clan_id)
      .ilike('email', email)
      .maybeSingle();

    if (lookupErr) {
      console.error('subscribe-roots: lookup failed:', lookupErr.message);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'lookup_failed' }) };
    }

    let subscriber;
    if (existing) {
      // Reuse the existing row. Update first_name if newly supplied and
      // missing previously. If they had unsubscribed, this resubscribes
      // them — we treat resubmitting the form as renewed consent.
      const update = {};
      if (firstName && !existing.first_name) update.first_name = firstName;
      if (existing.unsubscribed_at) update.unsubscribed_at = null;

      if (Object.keys(update).length) {
        await supa().from('pdf_subscribers').update(update).eq('id', existing.id);
      }
      subscriber = { ...existing, ...update };
    } else {
      // Fresh row.
      const confirm_token = crypto.randomBytes(24).toString('hex');
      const { data: inserted, error: insertErr } = await supa()
        .from('pdf_subscribers')
        .insert({
          clan_id,
          email,
          first_name: firstName,
          confirm_token,
          source: 'roots',
        })
        .select('id, email, first_name, confirm_token, unsubscribe_token')
        .single();

      if (insertErr) {
        console.error('subscribe-roots: insert failed:', insertErr.message);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'insert_failed' }) };
      }
      subscriber = inserted;
    }

    // Send (or resend) the confirmation email.
    const confirmUrl = `${SITE}/.netlify/functions/confirm-roots?t=${encodeURIComponent(subscriber.confirm_token)}`;
    const sent = await sendConfirmationEmail(subscriber, confirmUrl);

    if (!sent) {
      console.error('subscribe-roots: confirmation email failed for', email);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'email_send_failed' }) };
    }

    await logEvent({
      clan_id,
      member_id: null,
      event_type: 'pdf_subscriber_signup',
      payload: { email_hash: crypto.createHash('sha256').update(email).digest('hex'), source: 'roots' },
    });

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ ok: true, message: 'Please check your inbox to confirm your email address.' }),
    };
  } catch (err) {
    console.error('subscribe-roots: fatal:', err.message, err.stack);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'internal_error' }) };
  }
};
