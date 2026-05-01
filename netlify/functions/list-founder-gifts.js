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
  // Wrapped in defensive try/log: if the table doesn't exist yet
  // (migration 017 hasn't run in this environment), we log loudly
  // and continue with just the members-side query. This keeps the
  // admin panel functional in environments where the migration
  // hasn't been applied yet, rather than 500-erroring the whole
  // endpoint and making both the legacy gifts and any new send
  // invisible. Once the migration runs, this branch picks up
  // automatically. Any OTHER error (auth, network, real DB issue)
  // still 500s — only the specific 'relation does not exist' code
  // is treated as 'continue without pending data'.
  let pendingRows = [];
  try {
    // Phase 3 (2026-05-01): now also includes 'claimed' rows so the
    // admin panel can surface the WhatsApp tickbox for ALL founder
    // gifts, not just pre-acceptance ones. Fergus's WhatsApp follow-
    // up is just as relevant for already-claimed recipients (he may
    // want to message after they claim, OR he may have messaged
    // before they claimed and wants the tick to persist after they
    // accept). The members-table side of the union previously
    // owned 'claimed' rows; now both sides emit them and we dedupe
    // by pending_gift_id below.
    let pendingSelect = `
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
      member_id,
      whatsapp_sent_at
    `;
    let pendingQ = await supa()
      .from('pending_founder_gifts')
      .select(pendingSelect)
      .eq('clan_id', cid)
      .in('status', ['pending', 'lapsed', 'claimed'])
      .order('created_at', { ascending: false });

    // Defensive: if migration 020 hasn't been applied, the
    // whatsapp_sent_at column doesn't exist and Supabase returns
    // an error citing the missing column. Retry without it so the
    // panel still loads — the WhatsApp column will render as 'Send'
    // (untoggled) until the migration applies.
    if (pendingQ.error && /column .*whatsapp_sent_at.* does not exist/i.test(pendingQ.error.message || '')) {
      console.warn('list-founder-gifts: whatsapp_sent_at column missing — retrying without it. Run migration 020.');
      pendingSelect = pendingSelect.replace(/,\s*whatsapp_sent_at/, '');
      pendingQ = await supa()
        .from('pending_founder_gifts')
        .select(pendingSelect)
        .eq('clan_id', cid)
        .in('status', ['pending', 'lapsed', 'claimed'])
        .order('created_at', { ascending: false });
    }

    if (pendingQ.error) {
      // Postgres 'relation does not exist' = 42P01. Supabase surfaces
      // this as code '42P01' on the error object, but also via the
      // message string. Check both for resilience.
      const isMissingTable = pendingQ.error.code === '42P01'
        || /relation .* does not exist/i.test(pendingQ.error.message || '');
      if (isMissingTable) {
        console.warn('list-founder-gifts: pending_founder_gifts table missing — continuing with members query only. Run migration 017.');
      } else {
        console.error('list-founder-gifts pending query failed:', pendingQ.error.message);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Could not load pending founder gifts' }),
        };
      }
    } else {
      pendingRows = pendingQ.data || [];
    }
  } catch (e) {
    console.error('list-founder-gifts pending query threw:', e.message);
    // Same defensive posture — log and continue.
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
  //
  // Phase 3 (2026-05-01): the union now includes claimed pending
  // rows (so the WhatsApp tickbox surfaces on every founder gift,
  // not just pre-acceptance). When a pending row is 'claimed' it
  // also has a matching member row in the members table — both
  // sides of the union would emit the same person twice. Dedup
  // strategy: build a Set of pending member_ids, then skip member
  // rows whose id is in that set. Pending side wins because it
  // carries the WhatsApp tracking column; the member-derived
  // status (claimed/sealed) is recomputed on the pending row by
  // joining via member_id.
  const counts = { pending: 0, lapsed: 0, sent: 0, claimed: 0, sealed: 0 };

  // Pre-build a member-id → member-info map so pending claimed rows
  // can derive their downstream status (claimed vs sealed) and
  // pull cert_published_at + auth_user_id from the member side.
  const membersById = new Map();
  for (const m of (memberRows || [])) {
    membersById.set(m.id, m);
  }
  // Also collect the set of member_ids that were created via the
  // new flow (they have a matching pending row). Used below to
  // suppress the duplicate from the member-side iteration.
  const memberIdsFromPending = new Set();
  for (const p of (pendingRows || [])) {
    if (p.member_id) memberIdsFromPending.add(p.member_id);
  }

  // Pending/lapsed/claimed rows from the new table.
  const fromPending = (pendingRows || []).map(p => {
    // Derive the displayed status. Pending and lapsed pass through;
    // claimed needs to look at the joined member to decide claimed
    // vs sealed (cert_published_at presence).
    let displayStatus = p.status;
    let sealedAt = null;
    if (p.status === 'claimed' && p.member_id) {
      const linkedMember = membersById.get(p.member_id);
      if (linkedMember && linkedMember.cert_published_at) {
        displayStatus = 'sealed';
        sealedAt = linkedMember.cert_published_at;
      }
      // else stays 'claimed' — member exists, cert not yet published
    }
    counts[displayStatus] = (counts[displayStatus] || 0) + 1;
    return {
      id:           p.id,
      email:        p.recipient_email,
      name:         p.recipient_name,
      tier:         p.tier,
      tier_label:   p.tier_label,
      sent_at:      p.created_at,
      comped_note:  p.personal_note || null,
      status:       displayStatus,
      expires_at:   p.expires_at,
      claimed_at:   p.claimed_at,
      sealed_at:    sealedAt,
      source:       'pending',
      // WhatsApp follow-up tracking — surfaced on EVERY pending-
      // sourced row regardless of status. Fergus may want to
      // message someone after they claim too, or have already
      // messaged before they claimed and wants the tick to persist.
      pending_id:       p.id,
      whatsapp_sent_at: p.whatsapp_sent_at || null,
    };
  });

  // Members from the existing table — only those that DON'T have a
  // matching pending row. These are legacy direct-insert founder
  // gifts (created before the deferred-acceptance flow shipped).
  // The new-flow members are already represented above via fromPending,
  // and surfacing them here too would duplicate the row.
  const fromMembers = (memberRows || [])
    .filter(m => !memberIdsFromPending.has(m.id))
    .map(m => {
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
        // Legacy direct-insert rows have no pending row to attach
        // tracking to, so the WhatsApp tickbox renders as '—' for
        // them. Acceptable — these are old test/legacy rows that
        // pre-date the WhatsApp tracking feature anyway.
        pending_id:       null,
        whatsapp_sent_at: null,
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
