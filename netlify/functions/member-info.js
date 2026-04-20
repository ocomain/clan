// netlify/functions/member-info.js
// GET /api/member-info with Authorization: Bearer <supabase-jwt>
// Verifies the JWT using service_role, looks up the member by email,
// links auth_user_id on first call, returns the member record.

const { supa, clanId, logEvent } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  // Verify the Supabase JWT by asking the auth server who the token belongs to.
  // The service_role client can call auth.getUser(token) for verification.
  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const authUser = authData.user;
  const email = (authUser.email || '').toLowerCase().trim();

  try {
    const clan_id = await clanId();

    // First: look up by auth_user_id (faster once linked).
    let { data: member, error } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authUser.id)
      .maybeSingle();

    // Fallback: look up by email, then link the auth_user_id for next time.
    if (!member) {
      ({ data: member, error } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, status, joined_at, renewed_at, expires_at, auth_user_id')
        .eq('clan_id', clan_id)
        .eq('email', email)
        .maybeSingle());

      if (member && !member.auth_user_id) {
        await supa().from('members').update({ auth_user_id: authUser.id }).eq('id', member.id);
        await logEvent({ clan_id, member_id: member.id, event_type: 'auth_linked', payload: { email } });
        member.auth_user_id = authUser.id;
      }
    }

    if (!member) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not a member', email }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(member),
    };
  } catch (e) {
    console.error('member-info failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
