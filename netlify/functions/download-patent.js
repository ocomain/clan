// netlify/functions/download-patent.js
//
// GET /api/download-patent with Authorization: Bearer <supabase-jwt>
//
// Generates a fresh short-lived Supabase signed URL for the
// authenticated member's letters patent and 302-redirects to it.
//
// Per Council direction: only the LATEST/highest dignity's patent is
// served. Lower-rank patents (Cara when a member now holds Ardchara,
// for example) remain in storage for audit trail but are never
// downloadable from the dashboard. If a caller crafts a request for a
// lower rank, the endpoint silently serves the highest. There is no
// `slug` query param — the highest is always the answer.
//
// Auth model mirrors member-info.js: Supabase JWT verified server-
// side, email looked up in members table. Members can only download
// their own patent — there is no admin/cross-member access via this
// endpoint.

const { supa, clanId } = require('./lib/supabase');
const { highestAwardedTitle } = require('./lib/sponsor-service');
const { getPatentSignedUrl } = require('./lib/patent-service');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  // Verify Supabase JWT
  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const authUser = authData.user;

  try {
    const clan_id = await clanId();

    // Fetch member with the columns we need: identity + dignities +
    // patent paths. Try auth_user_id first (faster), fall back to
    // email like member-info does.
    let { data: member } = await supa()
      .from('members')
      .select('id, email, name, sponsor_titles_awarded, patent_urls')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authUser.id)
      .maybeSingle();

    if (!member) {
      const email = (authUser.email || '').toLowerCase().trim();
      if (email) {
        const fallback = await supa()
          .from('members')
          .select('id, email, name, sponsor_titles_awarded, patent_urls')
          .eq('clan_id', clan_id)
          .eq('email', email)
          .maybeSingle();
        member = fallback.data;
      }
    }

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member not found' }) };
    }

    // Highest dignity — same primitive used by the dashboard.
    const highestTitle = highestAwardedTitle(member.sponsor_titles_awarded);
    if (!highestTitle || !highestTitle.slug) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No dignity held — no patent to download' }) };
    }

    // Patent path — must be populated for the highest dignity. If it
    // isn't, the patent generation hasn't happened yet (cert not
    // sealed, or the cron hasn't yet fired the generation). Return
    // a 404 with an informative reason; the dashboard already shows
    // 'Patent in preparation' in this state so the user shouldn't
    // see this directly.
    const patentEntry = (member.patent_urls || {})[highestTitle.slug];
    if (!patentEntry || !patentEntry.path) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Patent not yet issued',
          dignity: highestTitle.slug,
        }),
      };
    }

    // Filename hint for the browser save dialog. Uses the issued_name
    // (frozen at issuance) rather than current member.name, so the
    // downloaded file matches the document inside even if they later
    // change their member name.
    const issuedName = patentEntry.issued_name || member.name || 'Patent';
    const downloadFilename = `Letters Patent — ${issuedName}, ${capitalise(highestTitle.slug)} of \u00d3 Com\u00e1in.pdf`;

    // Fresh short-lived signed URL. 1-hour TTL is generous for the
    // single click → save flow, short enough to limit damage if the
    // URL is shared/leaked.
    const signedUrl = await getPatentSignedUrl(patentEntry.path, {
      ttlSeconds: 60 * 60,
      downloadAs: sanitizeFilename(downloadFilename),
    });

    // Return JSON {url} — same pattern as /api/generate-certificate.
    // The dashboard JS does `window.location.href = url` to trigger
    // the actual download. Cannot 302-redirect here because the
    // dashboard fetch carries Authorization headers that wouldn't
    // survive a redirect navigation.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        url: signedUrl,
        dignity: highestTitle.slug,
        issued_name: issuedName,
      }),
    };
  } catch (err) {
    console.error('download-patent crashed:', err.message, err.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not produce download URL', message: err.message }),
    };
  }
};

function capitalise(s) {
  if (!s) return '';
  // Special-case Onóir for the accented Ó
  if (s === 'onoir') return 'On\u00f3ir';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Strip characters disallowed in HTTP header values (commas etc cause
// problems in Content-Disposition). Same logic as the cert service's
// helper but inlined to avoid a cross-module dep.
function sanitizeFilename(s) {
  return String(s).replace(/[^\w\s.\-\u00C0-\u024F]/g, '_');
}
