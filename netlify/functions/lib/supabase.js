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

// Fuzzy tier normalisation — maps any Stripe product name variant to a canonical
// tier slug ('guardian-ind', 'clan-fam', etc.) plus a display label. Matches the
// logic in stripe-webhook.js so every system reaches the same verdict.
function normaliseTier(productName) {
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

module.exports = { supa, clanId, normaliseTier, logEvent };
