// netlify/functions/lib/supabase.js
// Shared Supabase client + tenant helpers.
// Uses the service_role key so it bypasses Row Level Security — this is server-
// side only. Never import this from any frontend / browser bundle.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client = null;
function supa() {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('Supabase env vars missing: SUPABASE_URL / SUPABASE_SERVICE_KEY');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

// Tenant resolution. For now, every clan site running on this codebase resolves
// to 'ocomain'. When clan #2 ships, this becomes request-aware (hostname or
// build-time env var → slug → clan_id).
const DEFAULT_CLAN_SLUG = process.env.CLAN_SLUG || 'ocomain';
let _cachedClanId = null;
async function clanId(slug = DEFAULT_CLAN_SLUG) {
  if (_cachedClanId) return _cachedClanId;
  const { data, error } = await supa().from('clans').select('id').eq('slug', slug).single();
  if (error) throw new Error(`clanId lookup failed for slug "${slug}": ${error.message}`);
  _cachedClanId = data.id;
  return _cachedClanId;
}

// Canonical tier objects, keyed by canonical slug. The single source of truth
// for the 8 paid tiers and what they look like in the dashboard / cert / emails.
const TIER_BY_SLUG = {
  'clan-ind':     { tier: 'clan-ind',     label: 'Clan Member',                       tier_family: false },
  'clan-fam':     { tier: 'clan-fam',     label: 'Clan Member (Family)',              tier_family: true  },
  'guardian-ind': { tier: 'guardian-ind', label: 'Guardian of the Clan',              tier_family: false },
  'guardian-fam': { tier: 'guardian-fam', label: 'Guardian of the Clan (Family)',     tier_family: true  },
  'steward-ind':  { tier: 'steward-ind',  label: 'Steward of the Clan',               tier_family: false },
  'steward-fam':  { tier: 'steward-fam',  label: 'Steward of the Clan (Family)',      tier_family: true  },
  'life-ind':     { tier: 'life-ind',     label: 'Life Member',                       tier_family: false },
  'life-fam':     { tier: 'life-fam',     label: 'Life Member (Family)',              tier_family: true  },
};

// Charged-amount → tier slug. The most reliable detection signal because the
// amount is what the buyer actually paid, regardless of how the Stripe
// product/price is labelled. Covers BOTH regular Stripe payment-link
// purchases and the gift-checkout flow (gift Guardian prices differ).
//
// IMPORTANT: if you ever change a price in Stripe, update this map. A
// missing amount falls through to product-name parsing, which works
// when the product name contains the word 'family' but is otherwise a
// best-guess fallback.
const AMOUNT_CENTS_TO_TIER_SLUG = {
  // Regular (annual) tier amounts
  4900:   'clan-ind',     // €49
  7900:   'clan-fam',     // €79
  15000:  'guardian-ind', // €150
  22000:  'guardian-fam', // €220
  35000:  'steward-ind',  // €350
  48000:  'steward-fam',  // €480
  75000:  'life-ind',     // €750
  110000: 'life-fam',     // €1,100
  // Gift-only Guardian amounts (different from regular Guardian — see
  // create-gift-checkout.js GIFT_PRICE_CENTS)
  19500:  'guardian-ind', // gift €195
  31500:  'guardian-fam', // gift €315
};

// Fuzzy tier normalisation. Resolves a Stripe checkout to a canonical tier
// using the most reliable signal available:
//   1. Charged amount (deterministic — what they actually paid)
//   2. Product name containing 'family' / 'guardian' / 'steward' / 'life'
//   3. Default to clan-ind
//
// Keeping the function signature backward-compatible (productName positional
// first) means existing callers that don't yet pass the amount continue to
// work, just less precisely.
function normaliseTier(productName, amountCents) {
  // Primary signal: charged amount maps directly to a known tier
  if (amountCents && AMOUNT_CENTS_TO_TIER_SLUG[amountCents]) {
    return TIER_BY_SLUG[AMOUNT_CENTS_TO_TIER_SLUG[amountCents]];
  }

  // Fallback: parse the product name (works when name contains 'family',
  // otherwise lands on individual variant of the matched base tier)
  const p = (productName || '').toLowerCase();
  const isFamily = p.includes('family');
  const family = isFamily ? '-fam' : '-ind';
  const label = (base) => base + (isFamily ? ' (Family)' : '');

  if (p.includes('life'))                              return { tier: 'life'     + family, label: label('Life Member'),       tier_family: isFamily };
  if (p.includes('steward') || p.includes('patron'))   return { tier: 'steward'  + family, label: label('Steward of the Clan'),tier_family: isFamily };
  if (p.includes('guardian'))                          return { tier: 'guardian' + family, label: label('Guardian of the Clan'),tier_family: isFamily };
  if (p.includes('clan member'))                       return { tier: 'clan'     + family, label: label('Clan Member'),       tier_family: isFamily };
  return { tier: 'clan' + family, label: label('Clan Member'), tier_family: isFamily };
}

// Log an event for audit / debugging / future analytics.
// Non-blocking: failure here should never kill the caller.
async function logEvent({ clan_id, member_id, event_type, payload }) {
  try {
    await supa().from('events').insert({
      clan_id: clan_id || null,
      member_id: member_id || null,
      event_type,
      payload: payload || {},
    });
  } catch (e) {
    console.error('logEvent failed (non-fatal):', e.message);
  }
}

// Determine whether a member's tier qualifies them for the public Founding
// Members Register at ocomain.org/register.
//
// Policy: the public register is a Guardian+ benefit. Entry-tier Clan Member
// purchases do NOT appear on the public register, and attempts to flip the
// public_register_visible flag true on a clan-* tier row are rejected at
// the endpoint level. The member's privacy fields remain on the row (so
// upgrading later flips them live), but the flags stay false while the
// member is on a clan-* tier.
//
// Tier key format is {base}-{ind|fam} — 'clan-ind', 'clan-fam',
// 'guardian-ind', 'guardian-fam', 'steward-*', 'life-*'. Everything
// starting with 'clan-' is entry-tier. Everything else qualifies.
function canAppearOnPublicRegister(tierKey) {
  if (!tierKey) return false;
  return !tierKey.startsWith('clan-');
}

// ─────────────────────────────────────────────────────────────────────────
// Founder admin tool: auth allowlist
//
// The founder-gift admin tool (and any future admin-only endpoints) is
// scoped to a small set of allowlisted email addresses. For now that's
// just clan@ocomain.org — Linda's address. Fergus works through her, or
// via her session, keeping the tool's blast radius small and the access
// control simple. Adding more addresses later is a one-line edit here.
//
// IMPORTANT: this is a defense-in-depth check. The PRIMARY authentication
// is the standard Supabase JWT verification (auth.getUser). This helper
// runs AFTER that succeeds, on the verified email, to confirm the
// authenticated user is one of the allowlisted operators.
//
// Usage in a Netlify function:
//
//   const authUser = (await supa().auth.getUser(token)).data?.user;
//   if (!isFounderAdmin(authUser?.email)) {
//     return { statusCode: 403, body: JSON.stringify({ error: 'Not permitted' }) };
//   }
//
// Returns true ONLY if email is in the allowlist (case-insensitive,
// whitespace-trimmed). Returns false for any nullish or non-matching
// input — never throws.
const FOUNDER_ADMIN_ALLOWLIST = new Set([
  'clan@ocomain.org',
  // Add additional admin emails here, lowercase, one per line.
  // Anyone added here gets full founder-gift admin access — no
  // tier-of-permission system, no per-action gating. Add carefully.
]);

function isFounderAdmin(email) {
  if (!email || typeof email !== 'string') return false;
  return FOUNDER_ADMIN_ALLOWLIST.has(email.toLowerCase().trim());
}

// ─── filterEmailsAlreadyMembers ──────────────────────────────────────────
// Given a list of email strings, returns the subset that already exist as
// rows in public.members for the given clan. Comparison is case-
// insensitive — both sides are lowercased + trimmed before checking
// against the unique index members(clan_id, lower(email)).
//
// Used by the abandoned-cart and cart-reengage sweeps as a defensive
// filter: a member who reaches us through one path (gift redemption,
// re-submitted herald form, etc.) may leave a pending application row
// behind that the stripe-webhook didn't successfully flip — and we do
// not want to email a confirmed member telling them their place is
// 'still open'. This helper lets the sweeps drop any application
// whose email has since become a member.
//
// We don't filter on members.status — even cancelled / lapsed members
// shouldn't receive the abandoned-cart sequence on stale application
// rows, since the message ('your place is still open') would read
// confusingly. Renewal nudges are a separate flow.
//
// @param {string} clan_id
// @param {string[]} emails
// @returns {Promise<Set<string>>} lowercase emails that match an existing member
async function filterEmailsAlreadyMembers(clan_id, emails) {
  const cleaned = (emails || [])
    .filter(e => typeof e === 'string' && e.length > 0)
    .map(e => e.toLowerCase().trim());
  if (cleaned.length === 0) return new Set();
  const { data, error } = await supa()
    .from('members')
    .select('email')
    .eq('clan_id', clan_id)
    .in('email', cleaned);
  if (error) {
    // Best-effort: if the lookup fails, return empty so the caller
    // proceeds as before (no false-negatives blocking a real reminder).
    // The tradeoff is that a Supabase outage could let one false-
    // positive abandoned email through, which is acceptable.
    console.warn('filterEmailsAlreadyMembers failed (returning empty):', error.message);
    return new Set();
  }
  return new Set((data || []).map(r => (r.email || '').toLowerCase().trim()));
}

module.exports = { supa, clanId, normaliseTier, logEvent, canAppearOnPublicRegister, isFounderAdmin, filterEmailsAlreadyMembers, TIER_BY_SLUG };
