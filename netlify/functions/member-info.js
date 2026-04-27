// netlify/functions/member-info.js
// GET /api/member-info with Authorization: Bearer <supabase-jwt>
// Verifies the JWT using service_role, looks up the member by email,
// links auth_user_id on first call, returns the member record.
//
// Extended: if this member's membership was a gift, the response includes a
// `gift` object with buyer context and stamps activated_notified_at on first
// signin (used to log the activation moment for admin observability).
// No email is sent on activation — gift givers receive (1) the payment
// confirmation at purchase, and (2) the cert keepsake when the recipient
// publishes their cert. See lib/publication-email's sendGiftBuyerCertKeepsake.

const { supa, clanId, logEvent } = require('./lib/supabase');

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
      .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id, partner_name, children_first_names, display_name_on_register, family_details_completed_at, public_register_visible, children_visible_on_register, dedication_visible_on_register, cert_version, cert_locked_at, cert_published_at, cert_publish_reminder_sent_at, ancestor_dedication, name_confirmed_on_cert, postal_address, postal_address_provided_at, cert_posted_at, comped_by_chief, comped_at')
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
        .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id, partner_name, children_first_names, display_name_on_register, family_details_completed_at, public_register_visible, children_visible_on_register, dedication_visible_on_register, cert_version, cert_locked_at, cert_published_at, cert_publish_reminder_sent_at, ancestor_dedication, name_confirmed_on_cert, postal_address, postal_address_provided_at, cert_posted_at, comped_by_chief, comped_at')
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

        // First-activation moment is still LOGGED (so the admin panel can
        // see when each gift was opened), but no longer triggers an email.
        // Per user direction, the giver receives only two emails:
        //   1. Payment confirmation at gift purchase (sendGiftConfirmations
        //      in stripe-webhook).
        //   2. Cert keepsake at recipient cert publish (sendGiftBuyerCertKeepsake
        //      in lib/publication-email — fires from both submit-family-details
        //      and update-family-details on first publish, with the published
        //      PDF attached).
        // The previous activation-email-on-first-signin between those two
        // moments was redundant and contained no cert. Removed.
        if (isFirstActivation && !gift.activated_notified_at && gift.buyer_email) {
          const now = new Date().toISOString();
          // Stamp the gift row so we don't relog this event on every future signin.
          await supa().from('gifts').update({ activated_notified_at: now }).eq('id', gift.id);
          await logEvent({ clan_id, member_id: member.id, event_type: 'gift_activated', payload: { gift_id: gift.id, buyer_email: gift.buyer_email } });
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
