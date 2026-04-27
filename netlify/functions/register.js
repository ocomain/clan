// netlify/functions/register.js
//
// Public-read endpoint backing /register.html. Returns JSON of all
// members eligible for the public Register: Guardian / Steward / Life,
// in current standing, who have asked to be publicly counted.
//
// Policy decisions baked in here (locked across multiple sessions of
// design discussion — see project context for full rationale):
//
//   - Tier filter: ONLY Guardian, Steward, Life appear. Clan-tier
//     members never on the public register, regardless of opt-in,
//     by design (the register's prestige comes from being restricted).
//     This applies to founders too — Fergus's Clan-tier gifts get
//     real memberships but no public roll entry.
//
//   - Status filter: status='active' only. Lapsed members drop off
//     the register until they renew. Their member row is preserved
//     (joined_at and everything else intact); they just don't appear
//     in this query result. When they renew, the same row reactivates
//     with the original joined_at — no special restoration logic
//     needed, the SQL just starts including them again.
//
//   - Opt-in: public_register_visible=true. The default is false (set
//     by migration 012). Members must explicitly tick the box at
//     publish time to appear.
//
//   - Order: Life Members first (the Roll of Honour), then Stewards,
//     then Guardians. Within each tier, chronological by joined_at
//     (founders first within each tier).
//
// Cached at the edge for 5 minutes. The register doesn't need
// sub-5min freshness — anyone publishing right now will see their
// name within 5 minutes, which is fine for a "permanent" record.
// Caching also protects Supabase from any traffic spike when
// founders are batch-emailed and click through together.
//
// No auth required — this is a public endpoint backing a public
// (though currently unlinked) page. The data exposed (name, tier,
// join date, optional ancestor dedication, optional children's
// first names if they ticked that box too) is exactly what members
// consented to publish at sealing time.

const { supa, clanId } = require('./lib/supabase');
const { computeRegisterDisplay } = require('./lib/generate-cert');

const REGISTER_TIERS = [
  'guardian-ind', 'guardian-fam',
  'steward-ind',  'steward-fam',
  'life-ind',     'life-fam',
];

// Tier sort weight for the Roll of Honour ordering. Lower = earlier
// in the response. Within a tier-group, joined_at ASC handles the
// founders-first-within-tier ordering.
const TIER_WEIGHT = {
  'life-ind': 1, 'life-fam': 1,
  'steward-ind': 2, 'steward-fam': 2,
  'guardian-ind': 3, 'guardian-fam': 3,
};

// Extract first name(s) from a full name string. For 'Anita Smith' returns
// 'Anita'; for 'Mary Catherine O'Brien' returns 'Mary Catherine'. Naive
// split on whitespace; takes everything except the last token. Privacy-
// respecting — keeps the partner's surname out of the public credit line
// since it's already implicit in the family display name above.
//
// (No longer used here — credit line is now computed by the shared cert
// helper, which uses the partner's full name. Kept for reference; can
// remove on next refactor.)
// function extractFirstName(fullName) {
//   if (!fullName) return null;
//   const tokens = fullName.trim().split(/\s+/);
//   if (tokens.length <= 1) return tokens[0] || null;
//   return tokens.slice(0, -1).join(' ');
// }

exports.handler = async (event) => {
  // Reject non-GET — this endpoint is read-only.
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const cid = await clanId();

    const { data, error } = await supa()
      .from('members')
      .select(`
        id,
        display_name_on_register,
        name,
        tier,
        tier_label,
        ancestor_dedication,
        joined_at,
        partner_name,
        children_visible_on_register,
        children_first_names
      `)
      .eq('clan_id', cid)
      .eq('public_register_visible', true)
      .eq('status', 'active')
      .in('tier', REGISTER_TIERS);

    if (error) {
      console.error('register query failed:', error.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not load register' }) };
    }

    // Sort: tier weight first, then joined_at ASC. Done in JS rather
    // than via Supabase's .order() because we want a CASE-style ordering
    // that .order() can't express directly.
    const sorted = (data || []).sort((a, b) => {
      const wa = TIER_WEIGHT[a.tier] || 99;
      const wb = TIER_WEIGHT[b.tier] || 99;
      if (wa !== wb) return wa - wb;
      // Within tier-group: oldest joined_at first (founders bubble up)
      return new Date(a.joined_at) - new Date(b.joined_at);
    });

    // For every row, recompute display + credit_line via the SAME helper
    // the cert generator uses. This guarantees what's sealed on the cert
    // matches what appears on the public register, with one exception:
    // the register's children_visible_on_register gate. When children
    // exist but are opted out, computeRegisterDisplay returns the
    // redacted credit line ('with [Partner], and children' or 'with
    // children') instead of naming them. The cert shows children
    // unconditionally (it's private to the household), the register
    // gates them. Display name itself is identical in both cases —
    // only the credit line under the name differs.
    const members = sorted.map(m => {
      const { displayName, creditLine } = computeRegisterDisplay(
        m.name,
        m.partner_name,
        m.children_first_names,
        m.children_visible_on_register === true
      );
      return {
        // No 'id' or 'email' returned — public payload, never expose
        // internal IDs or emails to anonymous viewers.
        display_name: displayName || m.display_name_on_register || m.name,
        // Optional small italic line under the name. null when no
        // family detail to credit (solo member or named couple).
        credit_line:  creditLine,
        tier:         m.tier,
        tier_label:   m.tier_label,
        ancestor_dedication: m.ancestor_dedication || null,
        joined_at:    m.joined_at,
      };
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // 5-minute edge cache. Stale-while-revalidate gives instant
        // response while the cache refreshes in the background.
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
      body: JSON.stringify({
        members,
        count: members.length,
        generated_at: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('register endpoint failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
