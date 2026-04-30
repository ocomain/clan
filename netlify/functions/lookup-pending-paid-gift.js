// netlify/functions/lookup-pending-paid-gift.js
//
// GET /api/lookup-pending-paid-gift?token=<uuid>
//
// Public endpoint. /gift-welcome.html calls this on load to resolve
// the recipient's name + giver + tier from the claim_token in the
// URL — without claiming the gift. The page then renders 'Welcome
// {firstName}', the giver's personal message, and the claim button.
//
// Phase 2 sibling of lookup-pending-founder-gift.js — same shape,
// different table (gifts vs pending_founder_gifts) and different
// status taxonomy (paid|pending_acceptance vs pending).
//
// Why a separate read endpoint (rather than letting claim-paid-
// gift.js return the info on POST):
//   - The welcome page should be readable on first load — recipient
//     might want to read the giver's note before pressing the
//     button. POST-on-load would consume the claim, which is wrong.
//   - Lets us show 'this gift has lapsed / already been claimed'
//     as a friendly message rather than a generic error after a
//     click.
//
// Security: the claim_token is the secret. UUIDv4 = 122 random
// bits. We return only the bits the welcome page needs (recipient
// name/email, giver name, tier, status, personal message).

const { supa, clanId } = require('./lib/supabase');

exports.handler = async (event) => {
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
    .from('gifts')
    .select('recipient_email, recipient_name, buyer_name, buyer_email, tier, tier_label, personal_message, status, created_at, expires_at, claimed_at, member_id')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (error) {
    console.error('paid gift lookup failed:', error.message);
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
      body: JSON.stringify({ error: 'No gift for this token' }),
    };
  }

  // Computed flags. claimable=true iff the gift is in a state where
  // the recipient should see the Claim button. The gift status
  // taxonomy is broader than founder gifts (legacy values exist
  // from pre-Phase-2 rows), so we explicitly enumerate the states
  // that should render claimable.
  const isClaimable = !data.member_id
    && (data.status === 'paid' || data.status === 'pending_acceptance');
  // Already-claimed: a member_id is set. Status will usually be
  // 'claimed' for Phase 2 gifts, but legacy gifts (pre-Phase 2) have
  // status='paid' WITH member_id set — those count as claimed too.
  const isClaimed = !!data.member_id;
  // Lapsed: explicit terminal status set by the cron, OR (defensive)
  // the expires_at has passed even if cron hasn't swept it yet.
  const expiredByDate = data.expires_at && new Date(data.expires_at).getTime() < Date.now();
  const isLapsed = data.status === 'lapsed' || (!data.member_id && expiredByDate);

  // Final state collapse — pick the strongest signal. Order matters:
  // claimed wins over lapsed (someone might have claimed in the last
  // second of the 1-year window), claimed wins over claimable.
  let state;
  if (isClaimed) state = 'claimed';
  else if (isLapsed) state = 'lapsed';
  else if (isClaimable) state = 'pending';
  else state = 'unknown';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      recipient_email:  data.recipient_email,
      recipient_name:   data.recipient_name,
      buyer_name:       data.buyer_name,
      buyer_email:      data.buyer_email,
      tier:             data.tier,
      tier_label:       data.tier_label,
      personal_message: data.personal_message,
      created_at:       data.created_at,
      expires_at:       data.expires_at,
      claimed_at:       data.claimed_at,
      state,
      claimable:        state === 'pending',
    }),
  };
};
