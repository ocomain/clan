// netlify/functions/list-founder-gifts.js
//
// Read endpoint for the founder admin tool's status table. Returns
// every member ever created via the founder admin tool, in
// reverse-chronological order, with their current state derived
// from the row's other fields:
//
//   pending  → comped_at set but cert_published_at null AND auth_user_id
//              null (we created the row, never sent? shouldn't happen
//              in normal flow, included for diagnostic completeness)
//   sent     → comped_at set, but recipient hasn't signed in yet
//              (auth_user_id null = magic-link never claimed)
//   claimed  → recipient signed in at least once (auth_user_id set)
//              but hasn't published their cert yet
//   sealed   → cert_published_at set
//
// AUTH: same allowlist as send-founder-gift. Bearer token + admin email.
//
// Response shape:
//
//   {
//     gifts: [
//       {
//         id, email, name, tier, tier_label,
//         comped_at, comped_note,
//         status: 'pending' | 'sent' | 'claimed' | 'sealed',
//         claimed_at: <ISO>|null,    // if claimed/sealed
//         sealed_at:  <ISO>|null,    // if sealed
//       },
//       ...
//     ],
//     count: <number>,
//     counts_by_status: { pending, sent, claimed, sealed }
//   }

const { supa, clanId, isFounderAdmin } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── Auth: Bearer token + admin allowlist ──────────────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Missing Authorization header' }),
    };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid or expired token' }),
    };
  }
  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Not permitted' }),
    };
  }

  // ── Query: all founder-comped members in reverse-chrono order ────
  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal: clan lookup failed' }),
    };
  }

  const { data, error } = await supa()
    .from('members')
    .select(`
      id,
      email,
      name,
      tier,
      tier_label,
      comped_at,
      comped_note,
      auth_user_id,
      cert_published_at,
      status
    `)
    .eq('clan_id', cid)
    .eq('comped_by_chief', true)
    .order('comped_at', { ascending: false });

  if (error) {
    console.error('list-founder-gifts query failed:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not load founder gifts' }),
    };
  }

  // Derive status per row from the existing fields. This avoids storing
  // a redundant 'status' column that could go stale relative to the
  // primary fields it's derived from.
  const counts = { pending: 0, sent: 0, claimed: 0, sealed: 0 };
  const gifts = (data || []).map(m => {
    let derivedStatus;
    if (m.cert_published_at) {
      derivedStatus = 'sealed';
    } else if (m.auth_user_id) {
      derivedStatus = 'claimed';
    } else if (m.comped_at) {
      derivedStatus = 'sent';
    } else {
      derivedStatus = 'pending';
    }
    counts[derivedStatus] = (counts[derivedStatus] || 0) + 1;

    return {
      id:           m.id,
      email:        m.email,
      name:         m.name,
      tier:         m.tier,
      tier_label:   m.tier_label,
      comped_at:    m.comped_at,
      comped_note:  m.comped_note || null,
      status:       derivedStatus,
      sealed_at:    m.cert_published_at || null,
      // claimed_at is harder to derive precisely — Supabase auth
      // doesn't expose first-signin timestamp on the member row.
      // For now, presence of auth_user_id signals 'claimed' but
      // we don't have a precise date. Acceptable for v1; if Linda
      // needs precise dates we add a member_first_signin_at column
      // and stamp it from member-info.js on first link.
      claimed_at:   null,
    };
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // No edge cache — admin tool always wants fresh data.
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({
      gifts,
      count: gifts.length,
      counts_by_status: counts,
    }),
  };
};
