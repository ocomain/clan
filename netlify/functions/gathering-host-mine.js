// netlify/functions/gathering-host-mine.js
//
// AUTHENTICATED. Returns the signed-in member's host pin for the
// requested year (if any) AND the list of other gatherings they've
// RSVP'd to. Used by:
//
//   /members/host-gathering.html   to pre-fill the host form
//   /members/index.html dashboard  to render the "your gathering" card
//
// Query: ?year=2027 (defaults to current year)
//
// Response:
//   {
//     ok: true,
//     year: 2027,
//     gathering: { ... } | null,       // the member's own pin
//     rsvps: [ { gathering_id, guest_count, note, gathering: { ... } }, ... ]
//   }

const { supa, clanId } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let memberRow = null;
  try {
    const { data: userResp, error: userErr } = await supa().auth.getUser(token);
    if (userErr || !userResp?.user?.email) throw new Error('Invalid session');
    const memberEmail = userResp.user.email.toLowerCase();
    const { data: m } = await supa()
      .from('members')
      .select('id, name, email, tier, status')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    memberRow = m;
  } catch (e) {
    console.error('auth failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  const q = event.queryStringParameters || {};
  let year = parseInt(q.year, 10);
  if (!Number.isInteger(year) || year < 2026 || year > 2099) {
    year = new Date().getUTCFullYear();
  }
  const gatheringDate = `${year}-03-17`;

  try {
    const clan_id = await clanId();

    // ── Member's own pin (if any) ─────────────────────────────────────
    const { data: ownRows } = await supa()
      .from('gatherings')
      .select('*')
      .eq('clan_id', clan_id)
      .eq('host_member_id', memberRow.id)
      .eq('gathering_date', gatheringDate)
      .neq('status', 'cancelled')   // cancelled rows hidden from "your gathering" UI
      .limit(1);
    const gathering = (ownRows && ownRows[0]) || null;

    // ── Member's RSVPs on other gatherings ────────────────────────────
    const { data: rsvpRows } = await supa()
      .from('gathering_rsvps')
      .select('id, gathering_id, guest_count, note, created_at')
      .eq('member_id', memberRow.id);

    let rsvps = [];
    if ((rsvpRows || []).length > 0) {
      const ids = rsvpRows.map(r => r.gathering_id);
      const { data: targets } = await supa()
        .from('gatherings')
        .select('id, host_display_name, host_avatar_url, venue_name, venue_city, venue_country, venue_lat, venue_lng, starts_local_time, gathering_date, status')
        .in('id', ids)
        .eq('clan_id', clan_id)
        .eq('gathering_date', gatheringDate)
        .eq('status', 'published');

      const byId = {};
      for (const t of targets || []) byId[t.id] = t;

      rsvps = rsvpRows
        .filter(r => byId[r.gathering_id])  // drop RSVPs to hidden/cancelled/wrong-year gatherings
        .map(r => ({
          id:           r.id,
          gathering_id: r.gathering_id,
          guest_count:  r.guest_count,
          note:         r.note,
          gathering:    byId[r.gathering_id],
        }));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        year,
        gathering,
        rsvps,
      }),
    };
  } catch (err) {
    console.error('gathering-host-mine failed:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Could not load gatherings — please try again shortly.' }) };
  }
};
