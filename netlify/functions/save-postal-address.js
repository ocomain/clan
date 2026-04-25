// netlify/functions/save-postal-address.js
//
// Saves the postal address for Guardian+ members so Linda can post their
// physical certificate. Called from welcome.html (post-payment, after
// cert details have been confirmed) and from members area (during 30-day
// grace window for edits).
//
// Two auth paths:
//   (a) sessionId from Stripe success URL — unauthenticated, called
//       from welcome.html immediately post-purchase
//   (b) authenticated members area call — Authorization: Bearer <token>
//       called from dashboard edit modal
//
// Tier gate: only Guardian, Steward, Life tiers can have an address
// stored. Clan Member tier cannot — entry tier is digital-only.

const { supa, clanId, logEvent } = require('./lib/supabase');

// Tiers that include a physical certificate
const PHYSICAL_CERT_TIERS = new Set([
  'guardian-ind', 'guardian-fam',
  'steward-ind', 'steward-fam',
  'life-ind', 'life-fam',
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { sessionId, address } = body;

  // Validate address shape
  if (!address || typeof address !== 'object') {
    return { statusCode: 400, body: JSON.stringify({ error: 'address object required' }) };
  }
  const requiredFields = ['recipient_name', 'line1', 'city', 'postal_code', 'country'];
  for (const f of requiredFields) {
    if (!address[f] || typeof address[f] !== 'string' || !address[f].trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: `address.${f} is required` }) };
    }
  }

  // Authenticate caller — either session_id (Stripe) OR Authorization
  // header (members area). One must succeed.
  let resolvedEmail = null;

  // Path A: members area auth header (preferred when present)
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: process.env.SUPABASE_ANON_KEY,
        },
      });
      if (userResp.ok) {
        const u = await userResp.json();
        if (u?.email) resolvedEmail = u.email.toLowerCase().trim();
      }
    } catch (err) {
      console.error('auth user lookup failed:', err.message);
    }
  }

  // Path B: Stripe session_id from welcome page
  if (!resolvedEmail && sessionId) {
    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        if (sessionResp.ok) {
          const session = await sessionResp.json();
          const sessionEmail = session?.customer_details?.email || session?.customer_email || null;
          if (sessionEmail) resolvedEmail = sessionEmail.toLowerCase().trim();
        }
      }
    } catch (err) {
      console.error('Stripe session lookup error:', err.message);
    }
  }

  if (!resolvedEmail) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Could not authenticate. Sign in to your members area to update your address.' }) };
  }

  try {
    const clan_id = await clanId();

    // Look up the member
    const { data: member, error: lookupErr } = await supa()
      .from('members')
      .select('id, email, tier, postal_address, postal_address_provided_at')
      .eq('clan_id', clan_id)
      .eq('email', resolvedEmail)
      .maybeSingle();
    if (lookupErr) {
      console.error('member lookup failed:', lookupErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not look up member' }) };
    }
    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member not found.' }) };
    }

    // Tier gate: only Guardian/Steward/Life accept postal addresses
    if (!PHYSICAL_CERT_TIERS.has(member.tier)) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Your tier does not include a posted physical certificate. The Clan Member tier is digital only.',
          digitalOnly: true,
        }),
      };
    }

    // Sanitise + store. We trust the field shape (already validated above)
    // but trim whitespace consistently and lowercase the country_code.
    const cleanAddress = {
      recipient_name: address.recipient_name.trim(),
      line1:          address.line1.trim(),
      line2:          (address.line2 || '').trim() || null,
      city:           address.city.trim(),
      region:         (address.region || '').trim() || null,
      postal_code:    address.postal_code.trim(),
      country:        address.country.trim(),
      country_code:   (address.country_code || '').trim().toUpperCase() || null,
      instructions:   (address.instructions || '').trim() || null,
    };

    const now = new Date().toISOString();
    const { error: updateErr } = await supa()
      .from('members')
      .update({
        postal_address: cleanAddress,
        postal_address_provided_at: now,
        updated_at: now,
      })
      .eq('id', member.id);

    if (updateErr) {
      console.error('postal address update failed:', updateErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save address' }) };
    }

    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: member.postal_address_provided_at ? 'postal_address_updated' : 'postal_address_provided',
      payload: { city: cleanAddress.city, country: cleanAddress.country, country_code: cleanAddress.country_code },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, providedAt: now }),
    };
  } catch (err) {
    console.error('save-postal-address error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
