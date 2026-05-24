// ─────────────────────────────────────────────────────────────────────
// /api/oath-swear
//
// One-time ceremonial transaction: a member crosses the year-and-a-day
// threshold (created_at + 366 days) and chooses to swear the Oath of
// Standing. The act and date are recorded; the page UI flips from
// "swear" mode to "your oath, sworn on [date]" record mode.
//
// Gate: server-side check on created_at; the page UI mirrors it but
// this function is the source of truth — never trust client-side
// gating for state changes.
//
// Idempotent: if oath_sworn_at is already set, returns 409. The oath
// is not re-swearable; it's a marker of a moment, not a recurring
// commitment.
// ─────────────────────────────────────────────────────────────────────
const { supa, clanId, logEvent } = require('./lib/supabase');

const YEAR_AND_DAY_MS = 366 * 24 * 60 * 60 * 1000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };

  // Auth
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let member;
  try {
    const { data: userResp, error: userErr } = await supa().auth.getUser(token);
    if (userErr || !userResp?.user?.email) throw new Error('Invalid session');
    const memberEmail = userResp.user.email.toLowerCase();
    const { data: m } = await supa()
      .from('members')
      .select('id, name, email, status, created_at, oath_sworn_at')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    if (m.status !== 'active') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'The Oath of Standing requires an active membership.' }) };
    }
    member = m;
  } catch (e) {
    console.error('oath-swear auth failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // Gate: year and a day
  const createdAt = new Date(member.created_at).getTime();
  const eligibleAt = createdAt + YEAR_AND_DAY_MS;
  if (Date.now() < eligibleAt) {
    const daysRemaining = Math.ceil((eligibleAt - Date.now()) / (24 * 60 * 60 * 1000));
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: `The Oath unlocks at a year and a day of standing — ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining.`,
        eligibleAt: new Date(eligibleAt).toISOString(),
        daysRemaining,
      }),
    };
  }

  // Idempotent: already sworn
  if (member.oath_sworn_at) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        error: 'The Oath of Standing has already been sworn.',
        oathSwornAt: member.oath_sworn_at,
      }),
    };
  }

  // Record the swearing
  const nowIso = new Date().toISOString();
  try {
    const { error: updErr } = await supa().from('members')
      .update({ oath_sworn_at: nowIso })
      .eq('id', member.id)
      .is('oath_sworn_at', null);  // belt + braces against race
    if (updErr) throw updErr;
  } catch (e) {
    console.error('oath-swear update failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not record your oath — please try again' }) };
  }

  try {
    const clan_id = await clanId();
    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: 'oath_sworn',
      payload: { email: member.email, sworn_at: nowIso },
    });
  } catch (e) {
    // Logging is non-fatal — the row was updated, the oath is recorded.
    console.warn('oath-swear log failed (non-fatal):', e.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, oathSwornAt: nowIso }),
  };
};
