// netlify/functions/get-pending-cert-details.js
//
// Returns a member's current cert details (name, ancestor, family info)
// based on the Stripe session_id from the post-payment redirect URL.
//
// Used by the welcome page to pre-fill the cert-details form so the
// buyer sees their Herald-captured name (now stored on the member row)
// pre-filled in the field, instead of typing it from scratch.
//
// Looks up Stripe checkout session → buyer email → member row.
// Returns minimal data (no PII the buyer didn't already provide).

const { supa, clanId } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params = new URLSearchParams(event.rawQuery || event.queryStringParameters || '');
  const sessionId = params.get ? params.get('session_id') : (event.queryStringParameters?.session_id);
  // Netlify gives queryStringParameters as an object, not a URLSearchParams,
  // so handle both shapes defensively
  const session_id = sessionId || event.queryStringParameters?.session_id;

  if (!session_id || typeof session_id !== 'string' || session_id.length < 5) {
    return { statusCode: 400, body: JSON.stringify({ error: 'session_id required' }) };
  }

  try {
    // ── Fetch the buyer email from Stripe ──────────────────────────────
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY not set');
      return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text().catch(() => '');
      console.error(`Stripe session lookup failed (${sessionResp.status}):`, errBody.slice(0, 200));
      return { statusCode: 404, body: JSON.stringify({ error: 'Session not found' }) };
    }
    const session = await sessionResp.json();
    const email = (
      session?.customer_details?.email
      || session?.customer_email
      || ''
    ).toLowerCase().trim();

    if (!email) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No buyer email on session' }) };
    }

    // ── Fetch the member row by email ──────────────────────────────────
    const clan_id = await clanId();
    const { data: member } = await supa()
      .from('members')
      .select('id, name, tier, tier_label, tier_family, partner_name, children_first_names, ancestor_dedication, name_confirmed_on_cert, public_register_visible, children_visible_on_register, cert_locked_at, postal_address, postal_address_provided_at, cert_posted_at')
      .eq('clan_id', clan_id)
      .eq('email', email)
      .maybeSingle();

    if (!member) {
      // Member row not written yet — Stripe webhook is racing the welcome
      // redirect. Fall back to the applications table (the herald form
      // writes there BEFORE Stripe checkout, so the buyer's name is
      // already on file). Then to the Stripe customer name as a last
      // resort, for buyers who skipped the herald.
      let pendingName = '';
      try {
        const { data: app } = await supa()
          .from('applications')
          .select('name')
          .eq('clan_id', clan_id)
          .eq('email', email)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (app?.name && app.name.trim()) {
          pendingName = app.name.trim();
        }
      } catch (lookupErr) {
        console.error('applications fallback lookup failed (non-fatal):', lookupErr.message);
      }
      if (!pendingName) {
        const stripeName = (session?.customer_details?.name || '').trim();
        if (stripeName) pendingName = stripeName;
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          found: !!pendingName,
          pending: true,
          name: pendingName,
          // Family/postal/register fields can't be inferred pre-webhook —
          // tier comes from the URL ?tier= param the welcome page already has
          partnerName: '',
          childrenFirstNames: [],
          ancestorDedication: '',
          nameConfirmed: false,
          publicRegisterVisible: false,
          childrenVisibleOnRegister: false,
          certLocked: false,
          postalAddress: null,
          postalAddressProvidedAt: null,
          certPostedAt: null,
        }),
      };
    }

    // Member exists. Belt-and-braces: if member.name is somehow blank
    // (legacy rows pre-herald-capture, or a manual row created without a
    // name), fall back to the herald application name then the Stripe
    // customer name. This guarantees the welcome form pre-fills with
    // *something* whenever a name is recoverable from anywhere upstream.
    let resolvedName = (member.name || '').trim();
    if (!resolvedName) {
      try {
        const { data: app } = await supa()
          .from('applications')
          .select('name')
          .eq('clan_id', clan_id)
          .eq('email', email)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (app?.name && app.name.trim()) resolvedName = app.name.trim();
      } catch (lookupErr) {
        console.error('applications fallback lookup failed (non-fatal):', lookupErr.message);
      }
      if (!resolvedName) {
        const stripeName = (session?.customer_details?.name || '').trim();
        if (stripeName) resolvedName = stripeName;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        found: true,
        name: resolvedName,
        tier: member.tier,
        tierLabel: member.tier_label,
        tierFamily: !!member.tier_family,
        partnerName: member.partner_name || '',
        childrenFirstNames: member.children_first_names || [],
        ancestorDedication: member.ancestor_dedication || '',
        nameConfirmed: !!member.name_confirmed_on_cert,
        publicRegisterVisible: !!member.public_register_visible,
        childrenVisibleOnRegister: !!member.children_visible_on_register,
        certLocked: !!member.cert_locked_at,
        postalAddress: member.postal_address || null,
        postalAddressProvidedAt: member.postal_address_provided_at || null,
        certPostedAt: member.cert_posted_at || null,
      }),
    };
  } catch (err) {
    console.error('get-pending-cert-details error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
