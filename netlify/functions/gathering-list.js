// netlify/functions/gathering-list.js
//
// PUBLIC endpoint. No authentication required. Returns the published
// gatherings for the requested year, formatted for the map page.
//
// This is what feeds the /st-patricks-day page. It's deliberately
// public — the whole point of the map is that prospects and casual
// visitors can see the network and feel the conversion pull ("no
// O'Comáin in your town yet — be the first"). RSVPs and host actions
// require auth (see gathering-rsvp.js, gathering-host-upsert.js); only
// the read path is open.
//
// Query params:
//   ?year=2027  — defaults to current calendar year if omitted
//
// Returns:
//   {
//     ok: true,
//     year: 2027,
//     gathering_date: "2027-03-17",
//     gatherings: [
//       {
//         id, host_display_name, message,
//         venue_name, venue_city, venue_country, venue_address,
//         venue_lat, venue_lng, venue_url,
//         starts_local_time,
//         rsvp_count, total_attending  // rsvp_count = rows; total_attending = sum(guest_count)
//       },
//       ...
//     ],
//     stats: { gatherings: N, countries: M, cities: K }
//   }
//
// Rate limit: none in v1. Endpoint is cheap (one Supabase query +
// one aggregate); if abuse appears, add IP-based caching at the
// Netlify edge.

const { supa, clanId } = require('./lib/supabase');
const { highestAwardedTitle, formatAddressForm } = require('./lib/sponsor-service');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',          // public endpoint
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    // Browsers can cache for 60s — pin map doesn't need to be
    // second-precise. Adjust upward when traffic justifies it.
    // Vary on Authorization so the gated public response doesn't
    // poison the member-area cache (and vice versa).
    'Cache-Control': 'public, max-age=60, s-maxage=60',
    'Vary': 'Authorization',
  };

  // ── Optional auth — venue specifics (name, address, URL) are gated.
  // Anyone can see THAT a gathering exists in London; only members
  // see WHICH pub. The conversion gate: the venue is the reveal
  // you get for joining. Pin coordinates still come through so the
  // map can render the marker — coords alone identify a city, not a
  // specific pub.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  let isMember = false;
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    try {
      const token = authHeader.slice(7).trim();
      const { data: userResp, error: authErr } = await supa().auth.getUser(token);
      if (!authErr && userResp?.user?.email) {
        // Validate the user is an active member, not just a logged-in
        // auth row. Inactive/cancelled members shouldn't get the venue
        // reveal either.
        const email = userResp.user.email.toLowerCase();
        const { data: m } = await supa()
          .from('members')
          .select('status')
          .eq('email', email)
          .maybeSingle();
        if (m && m.status === 'active') isMember = true;
      }
    } catch (_) { /* fall through as non-member */ }
  }

  // ── Year — default to current calendar year ─────────────────────────
  const q = event.queryStringParameters || {};
  let year = parseInt(q.year, 10);
  if (!Number.isInteger(year) || year < 2026 || year > 2099) {
    year = new Date().getUTCFullYear();
  }
  // St Patrick's Day. The schema supports any date, but for v1 the
  // map is locked to March 17. Easily changed if we layer in other
  // annual gatherings later.
  const gatheringDate = `${year}-03-17`;

  try {
    const clan_id = await clanId();

    // ── Fetch published gatherings for this date ──────────────────────
    const { data: gatherings, error: gErr } = await supa()
      .from('gatherings')
      .select(`
        id,
        host_member_id,
        host_display_name,
        host_avatar_url,
        message,
        venue_name,
        venue_address,
        venue_city,
        venue_country,
        venue_lat,
        venue_lng,
        venue_url,
        starts_local_time
      `)
      .eq('clan_id', clan_id)
      .eq('gathering_date', gatheringDate)
      .eq('status', 'published')
      .order('venue_country', { ascending: true })
      .order('venue_city', { ascending: true });

    if (gErr) throw gErr;

    // ── Aggregate RSVP counts in a single query ───────────────────────
    const ids = (gatherings || []).map(g => g.id);
    const rsvpsByGathering = {};
    if (ids.length > 0) {
      const { data: rsvps, error: rErr } = await supa()
        .from('gathering_rsvps')
        .select('gathering_id, guest_count')
        .in('gathering_id', ids);
      if (rErr) throw rErr;
      for (const r of rsvps || []) {
        const bucket = rsvpsByGathering[r.gathering_id] || { rows: 0, attending: 0 };
        bucket.rows += 1;
        bucket.attending += (r.guest_count || 1);
        rsvpsByGathering[r.gathering_id] = bucket;
      }
    }

    // ── Fetch host dignities for the title-bearing display name ───────
    // The map's "Hosted by" line should carry the host's dignity if
    // they hold one — 'Hosted by Cara Antóin' rather than just
    // 'Hosted by Antóin'. We batch-fetch the sponsor_titles_awarded
    // for every distinct host member, compute each one's highest
    // dignity, and build the speech-form address ('Cara Antóin',
    // 'Onóir James', or bare 'Antóin' if untitled) via the same
    // formatAddressForm helper the email salutations use. This keeps
    // the map consistent with how the household addresses titled
    // members everywhere else.
    const hostMemberIds = [...new Set(
      (gatherings || []).map(g => g.host_member_id).filter(Boolean)
    )];
    const dignityByMemberId = {};
    if (hostMemberIds.length > 0) {
      const { data: hostMembers, error: hmErr } = await supa()
        .from('members')
        .select('id, name, sponsor_titles_awarded')
        .in('id', hostMemberIds);
      if (hmErr) throw hmErr;
      for (const m of hostMembers || []) {
        const title = highestAwardedTitle(m.sponsor_titles_awarded);
        dignityByMemberId[m.id] = {
          name: m.name,
          title, // null if untitled
        };
      }
    }

    // ── Decorate output rows ──────────────────────────────────────────
    const out = (gatherings || []).map(g => {
      const r = rsvpsByGathering[g.id] || { rows: 0, attending: 0 };

      // Compute the title-bearing address form for the "Hosted by"
      // line. Prefer the host member's registered name + dignity
      // (so a raised Cara always shows the title even if their pin's
      // stored host_display_name predates the raising). Fall back to
      // the stored host_display_name (a bare first name) if there's
      // no member link or the member lookup found nothing.
      let hostDisplay = g.host_display_name || null;
      const dignityInfo = g.host_member_id ? dignityByMemberId[g.host_member_id] : null;
      if (dignityInfo && dignityInfo.name) {
        // formatAddressForm extracts the first name from the full
        // registered name and prefixes the dignity if present.
        // 'Cara Antóin' / 'Onóir James' / bare 'Antóin'.
        hostDisplay = formatAddressForm({ name: dignityInfo.name }, dignityInfo.title);
      } else if (hostDisplay) {
        // No member link, but we have a stored display name — if it
        // happens to be a multi-word string, keep only the first
        // word to stay consistent with the first-name-only policy.
        hostDisplay = String(hostDisplay).trim().split(/\s+/)[0];
      }

      return {
        id:                g.id,
        host_display_name: hostDisplay,
        host_avatar_url:   g.host_avatar_url || null,
        message:           g.message || null,
        // Venue specifics — only revealed to active members. Public
        // callers see the city/country (those are visible on the map
        // anyway from the pin position) but not which pub. Drives
        // the "join to see where" conversion mechanic on the public
        // popup.
        venue_name:        isMember ? g.venue_name    : null,
        venue_address:     isMember ? g.venue_address : null,
        venue_url:         isMember ? (g.venue_url || null) : null,
        venue_city:        g.venue_city,
        venue_country:     g.venue_country,
        venue_lat:         Number(g.venue_lat),
        venue_lng:         Number(g.venue_lng),
        starts_local_time: g.starts_local_time,
        rsvp_count:        r.rows,
        total_attending:   r.attending,
      };
    });

    // ── Aggregate stats for the page header ──────────────────────────
    // For 'GB' we subdivide into the constituent countries (Scotland,
    // England, Wales, Northern Ireland) because culturally — and in
    // the way a Celtic-rooted clan thinks about its diaspora — those
    // are separate countries even though they share an ISO code. A
    // lat/lng heuristic is enough for the obvious cases: every major
    // Scottish city is north of ~54.6°, every Welsh city west of
    // ~-2.6° below ~53.5°, Northern Ireland in its own corner.
    function countryKey(g) {
      if (g.venue_country !== 'GB') return g.venue_country;
      const lat = Number(g.venue_lat);
      const lng = Number(g.venue_lng);
      // Northern Ireland — bounded box covers the six counties
      if (lat >= 54.0 && lat <= 55.3 && lng >= -8.2 && lng <= -5.4) return 'GB-NIR';
      // Scotland — anything north of the border (roughly 54.6° at the
      // Solway, sloping up to ~55.8° at the Tweed; we use 54.6° as a
      // safe floor since Berwick is the only nuance and it's English)
      if (lat >= 54.6) return 'GB-SCT';
      // Wales — west of about -2.6° and below ~53.5° catches the
      // whole principality without grabbing Bristol or Liverpool
      if (lng <= -2.6 && lat <= 53.5) return 'GB-WLS';
      // Everything else in GB is England
      return 'GB-ENG';
    }
    const countries = new Set(out.map(countryKey));
    const cities    = new Set(out.map(g => `${g.venue_city}|${g.venue_country}`));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        year,
        gathering_date: gatheringDate,
        gatherings: out,
        stats: {
          gatherings: out.length,
          countries:  countries.size,
          cities:     cities.size,
        },
      }),
    };
  } catch (err) {
    console.error('gathering-list failed:', err && err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Could not load gatherings — please try again shortly.' }),
    };
  }
};
