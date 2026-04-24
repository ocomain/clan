// netlify/functions/member-info.js
// GET /api/member-info with Authorization: Bearer <supabase-jwt>
// Verifies the JWT using service_role, looks up the member by email,
// links auth_user_id on first call, returns the member record.
//
// Extended: if this member's membership was a gift, the response includes a
// `gift` object with buyer context and (first-time only) triggers a
// "your gift was accepted" email to the giver.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { notifyGiverOfActivation } = require('./lib/notify-giver-activated');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  // Verify the Supabase JWT by asking the auth server who the token belongs to.
  // The service_role client can call auth.getUser(token) for verification.
  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const authUser = authData.user;
  const email = (authUser.email || '').toLowerCase().trim();

  try {
    const clan_id = await clanId();

    // First: look up by auth_user_id (faster once linked).
    let { data: member, error } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id, partner_name, children_first_names, display_name_on_register, family_details_completed_at, public_register_visible, children_visible_on_register, cert_version')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authUser.id)
      .maybeSingle();

    // `isFirstActivation` means this member's auth_user_id is being linked for
    // the VERY FIRST TIME on this API call. That's the "recipient signed in
    // for the first time" signal we use to fire the giver-activation email.
    let isFirstActivation = false;

    // Fallback: look up by email, then link the auth_user_id for next time.
    if (!member) {
      ({ data: member, error } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id, partner_name, children_first_names, display_name_on_register, family_details_completed_at, public_register_visible, children_visible_on_register, cert_version')
        .eq('clan_id', clan_id)
        .eq('email', email)
        .maybeSingle());

      if (member && !member.auth_user_id) {
        await supa().from('members').update({ auth_user_id: authUser.id }).eq('id', member.id);
        await logEvent({ clan_id, member_id: member.id, event_type: 'auth_linked', payload: { email } });
        member.auth_user_id = authUser.id;
        isFirstActivation = true;
      }
    }

    if (!member) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not a member', email }),
      };
    }

    // ── Gift enrichment ──────────────────────────────────────────────────
    // If this member's record was created through the gift flow, surface the
    // gift context (giver name, personal message, gift date) so the dashboard
    // can render a permanent "This membership was a gift from..." card.
    //
    // Also: if this is the recipient's first activation AND the gift record
    // has not already notified the giver, fire the activation email now.
    // The activated_notified_at timestamp guards against duplicate emails if
    // the recipient signs out and signs back in.
    let giftContext = null;
    try {
      const { data: gift } = await supa()
        .from('gifts')
        .select('id, buyer_email, buyer_name, personal_message, tier_label, created_at, sent_to_recipient_at, activated_notified_at')
        .eq('clan_id', clan_id)
        .eq('member_id', member.id)
        .eq('status', 'paid')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (gift) {
        giftContext = {
          buyer_name: gift.buyer_name,
          buyer_email: gift.buyer_email,
          personal_message: gift.personal_message,
          gifted_at: gift.sent_to_recipient_at || gift.created_at,
          tier_label: gift.tier_label,
        };

        // First-activation trigger for giver notification.
        if (isFirstActivation && !gift.activated_notified_at && gift.buyer_email) {
          // Stamp the gift row FIRST so a parallel/retry invocation can't
          // double-send. Email send is best-effort and logged on failure.
          const now = new Date().toISOString();
          await supa().from('gifts').update({ activated_notified_at: now }).eq('id', gift.id);
          await logEvent({ clan_id, member_id: member.id, event_type: 'gift_activated', payload: { gift_id: gift.id, buyer_email: gift.buyer_email } });

          // Fire async (don't await) so the dashboard doesn't wait on email
          // latency. Errors are caught internally by the notify module.
          notifyGiverOfActivation({
            buyerEmail: gift.buyer_email,
            buyerName: gift.buyer_name,
            recipientName: member.name,
            recipientEmail: member.email,
            tierLabel: gift.tier_label,
          }).catch(err => console.error('giver activation notify failed:', err.message));
        }
      }
    } catch (giftErr) {
      // Non-fatal — gift enrichment failing should not block sign-in.
      console.error('gift enrichment in member-info (non-fatal):', giftErr.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...member, gift: giftContext }),
    };
  } catch (e) {
    console.error('member-info failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
