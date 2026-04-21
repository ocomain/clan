// netlify/functions/generate-certificate.js
// POST /api/generate-certificate — authenticated member cert download.
// Thin wrapper around cert-service — auth, look up member, delegate, sign, respond.

const { supa, clanId } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, sanitizeFilename } = require('./lib/cert-service');

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours for logged-in dashboard downloads

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'POST' && method !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const email = (authData.user.email || '').toLowerCase().trim();

  try {
    const clan_id = await clanId();

    let { data: member } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, status, joined_at')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();

    if (!member) {
      ({ data: member } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, status, joined_at')
        .eq('clan_id', clan_id)
        .eq('email', email)
        .maybeSingle());
    }

    if (!member) return { statusCode: 404, body: JSON.stringify({ error: 'Not a member' }) };

    const { storagePath, issuedAt } = await ensureCertificate(member, clan_id);

    const url = await signCertUrl(storagePath, {
      ttlSeconds: SIGNED_URL_TTL_SECONDS,
      downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(member.name || email)}.pdf`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        expires_at:  new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
        issued_at:   issuedAt,
        member_name: member.name,
      }),
    };
  } catch (e) {
    console.error('generate-certificate failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
