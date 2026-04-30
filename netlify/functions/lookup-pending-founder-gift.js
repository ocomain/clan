// netlify/functions/lookup-pending-founder-gift.js
//
// GET /api/lookup-pending-founder-gift?token=<uuid>
//
// Public endpoint. The /founder-welcome.html landing page calls
// this on load to resolve the recipient's name + tier from the
// claim_token in the URL — without claiming the gift yet. The page
// then renders 'Welcome home, {firstName}' and the 'Claim my place'
// button.
//
// Why a separate read endpoint (rather than letting claim-founder-
// gift.js return the info on POST):
//   - The welcome page should be readable on first load — the user
//     might want to read the herald-voiced welcome before pressing
//     the button. POST-on-load would mean every page-view consumes
//     the claim, which is wrong.
//   - It also lets us show 'this gift has lapsed / already been
//     claimed' as a friendly message rather than a generic error
//     after a click.
//
// Security model: the claim_token is the secret. UUIDv4 has 122
// random bits — practically unguessable. We return only the bits
// the welcome page needs (recipient name, tier label, status); we
// never return the token itself or other identifying details.
//
// We DO return the recipient_email — the page needs to pre-fill the
// magic-link form after claim. The email isn't a secret given that
// the email itself was sent TO that address; whoever holds the
// token already knows the email.

const { supa, clanId } = require('./lib/supabase');

exports.handler = async (event) => {
  // Only GET. Anything else → 405.
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  if (!token) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing token' }),
    };
  }

  // UUID format check — defensive. If someone tampers with the URL
  // and sends a non-UUID, we 400 immediately rather than send a
  // potentially-malformed value to the DB query.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid token format' }),
    };
  }

  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal: clan lookup failed' }),
    };
  }

  const { data, error } = await supa()
    .from('pending_founder_gifts')
    .select('recipient_email, recipient_name, tier, tier_label, status, created_at, expires_at, claimed_at')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (error) {
    console.error('pending founder gift lookup failed:', error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal: lookup failed' }),
    };
  }

  if (!data) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No pending gift for this token' }),
    };
  }

  // Surface the gift info plus computed flags the welcome page can
  // use directly without parsing dates client-side. claimable=true
  // is the only state where the 'Claim my place' button should be
  // rendered active — claimed and lapsed gifts get friendly states.
  const claimable = data.status === 'pending';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      recipient_email: data.recipient_email,
      recipient_name:  data.recipient_name,
      tier:            data.tier,
      tier_label:      data.tier_label,
      status:          data.status,
      created_at:      data.created_at,
      expires_at:      data.expires_at,
      claimed_at:      data.claimed_at,
      claimable,
    }),
  };
};
