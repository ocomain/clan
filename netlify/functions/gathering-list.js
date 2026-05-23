// netlify/functions/gathering-list.js
//
// PUBLIC endpoint. No authentication required. Returns the published
// gatherings for the requested year, formatted for the map page.
//
// This is what feeds the /la-fheile-padraig page. It's deliberately
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',          // public endpoint
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Browsers can cache for 60s — pin map doesn't need to be
    // second-precise. Adjust upward when traffic justifies it.
    'Cache-Control': 'public, max-age=60, s-maxage=60',
  };

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
        host_display_name,
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

    // ── Decorate output rows ──────────────────────────────────────────
    const out = (gatherings || []).map(g => {
      const r = rsvpsByGathering[g.id] || { rows: 0, attending: 0 };
      return {
        id:                g.id,
        host_display_name: g.host_display_name || null,
        message:           g.message || null,
        venue_name:        g.venue_name,
        venue_address:     g.venue_address,
        venue_city:        g.venue_city,
        venue_country:     g.venue_country,
        venue_lat:         Number(g.venue_lat),
        venue_lng:         Number(g.venue_lng),
        venue_url:         g.venue_url || null,
        starts_local_time: g.starts_local_time,
        rsvp_count:        r.rows,
        total_attending:   r.attending,
      };
    });

    // ── Aggregate stats for the page header ──────────────────────────
    const countries = new Set(out.map(g => g.venue_country));
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
