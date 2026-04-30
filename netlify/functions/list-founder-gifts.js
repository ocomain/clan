// netlify/functions/list-founder-gifts.js
//
// Read endpoint for the founder admin tool's status table. Returns
// the union of:
//
//   1. PENDING + LAPSED gifts from `pending_founder_gifts` (the new
//      deferred-acceptance flow shipped 2026-04-28). These are
//      gifts where Fergus has sent the welcome email but the
//      recipient has not yet clicked 'Claim my place' on the
//      welcome page (or, for lapsed, did not click within 1 year).
//      Note: pending_founder_gifts.status='claimed' rows are NOT
//      surfaced here — once the recipient claims, the row in
//      `members` (created on claim) carries the live state.
//
//   2. SENT + CLAIMED + SEALED from `members` where comped_by_chief.
//      These are members who either:
//      - claimed via the new flow (auth_user_id set on creation,
//        so they appear as 'claimed' here from the moment of claim)
//      - or were created via the legacy direct-insert flow (pre-
//        2026-04-28) and may be in any state from 'sent' (never
//        signed in) through 'sealed' (cert published).
//
// Status taxonomy:
//   pending  → Recipient has not pressed 'Claim my place'. New flow.
//              Pending row exists; no member row yet.
//   lapsed   → 1 year passed without claim. Pending row terminal;
//              no member row.
//   sent     → Member row created (legacy or claim) but auth_user_id
//              missing — recipient never signed in. Mostly legacy.
//   claimed  → Auth user exists but cert not published.
//   sealed   → Cert published.
//
// AUTH: same allowlist as send-founder-gift. Bearer token + admin email.
//
// Response shape:
//
//   {
//     gifts: [
//       {
//         id, email, name, tier, tier_label,
//         comped_at | created_at,    // moment of gift; same field name 'sent_at' for both
//         comped_note,
//         status: 'pending' | 'lapsed' | 'sent' | 'claimed' | 'sealed',
//         expires_at: <ISO>|null,    // pending/lapsed only
//         claimed_at: <ISO>|null,    // pending->claimed transition
//         sealed_at:  <ISO>|null,    // if sealed
//         source: 'pending' | 'member',  // which table this came from
//       },
//       ...
//     ],
//     count: <number>,
//     counts_by_status: { pending, lapsed, sent, claimed, sealed }
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

  // ── Query 1: pending + lapsed from pending_founder_gifts ──────────
  const { data: pendingRows, error: pendingErr } = await supa()
    .from('pending_founder_gifts')
    .select(`
      id,
      recipient_email,
      recipient_name,
      tier,
      tier_label,
      personal_note,
      status,
      created_at,
      expires_at,
      claimed_at,
      member_id
    `)
    .eq('clan_id', cid)
    .in('status', ['pending', 'lapsed'])
    .order('created_at', { ascending: false });

  if (pendingErr) {
    console.error('list-founder-gifts pending query failed:', pendingErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not load pending founder gifts' }),
    };
  }

  // ── Query 2: comped members (sent / claimed / sealed) ─────────────
  const { data: memberRows, error: memberErr } = await supa()
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

  if (memberErr) {
    console.error('list-founder-gifts members query failed:', memberErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not load comped members' }),
    };
  }

  // ── Merge + status derivation ─────────────────────────────────────
  const counts = { pending: 0, lapsed: 0, sent: 0, claimed: 0, sealed: 0 };

  // Pending/lapsed rows from the new table.
  const fromPending = (pendingRows || []).map(p => {
    const status = p.status; // 'pending' or 'lapsed' — already canonical
    counts[status] = (counts[status] || 0) + 1;
    return {
      id:           p.id,
      email:        p.recipient_email,
      name:         p.recipient_name,
      tier:         p.tier,
      tier_label:   p.tier_label,
      sent_at:      p.created_at,
      comped_note:  p.personal_note || null,
      status,
      expires_at:   p.expires_at,
      claimed_at:   p.claimed_at,
      sealed_at:    null,
      source:       'pending',
    };
  });

  // Members from the existing table — these are the rows where the
  // gift either was claimed (new flow) or pre-dates the deferred
  // flow entirely (legacy direct-insert).
  const fromMembers = (memberRows || []).map(m => {
    let derivedStatus;
    if (m.cert_published_at) {
      derivedStatus = 'sealed';
    } else if (m.auth_user_id) {
      derivedStatus = 'claimed';
    } else if (m.comped_at) {
      derivedStatus = 'sent';
    } else {
      // Should not happen — a comped_by_chief row without comped_at
      // would be a data integrity problem. Bucket as 'sent' for
      // display rather than crashing the panel.
      derivedStatus = 'sent';
    }
    counts[derivedStatus] = (counts[derivedStatus] || 0) + 1;
    return {
      id:           m.id,
      email:        m.email,
      name:         m.name,
      tier:         m.tier,
      tier_label:   m.tier_label,
      sent_at:      m.comped_at,
      comped_note:  m.comped_note || null,
      status:       derivedStatus,
      expires_at:   null,
      claimed_at:   null,  // see comment in original — not derivable from members table
      sealed_at:    m.cert_published_at || null,
      source:       'member',
    };
  });

  // Combine and sort by sent_at desc — pending and members may
  // interleave in time order.
  const gifts = [...fromPending, ...fromMembers]
    .sort((a, b) => {
      const ta = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      const tb = b.sent_at ? new Date(b.sent_at).getTime() : 0;
      return tb - ta;
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
