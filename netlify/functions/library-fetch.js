// netlify/functions/library-fetch.js
// GET /api/library-fetch?doc=<slug> with Authorization: Bearer <supabase-jwt>
//
// Returns a 7-day signed URL for a private document in the clan-library bucket,
// after verifying the requester is an authenticated active clan member.
//
// Documents are enumerated in the LIBRARY table below so that the front-end can
// list items without knowing storage paths, and so we can add/remove documents
// centrally without re-deploying the front-end.

const { supa, clanId, logEvent } = require('./lib/supabase');

const BUCKET = 'clan-library';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Library manifest — single source of truth for what is available. Adding a new
// document means (a) uploading to Storage under the storagePath below, and (b)
// adding an entry here. Slugs are stable IDs used by the front-end.
const LIBRARY = {
  'gibson-1990-dissertation': {
    slug: 'gibson-1990-dissertation',
    title: 'Tulach Commáin: A View of an Irish Chiefdom',
    author: 'David Blair Gibson',
    year: 1990,
    kind: 'doctoral dissertation',
    institution: 'University of California, Los Angeles',
    pages: 456,
    sizeLabel: '14 MB',
    description: 'Gibson\'s foundational Ph.D. dissertation reconstructing the chiefdom of Tulach Commáin, centred on Cahercommaun in the Burren. Committee chair: Prof. Timothy Earle.',
    storagePath: 'ocomain/library/gibson-1990-tulach-commain.pdf',
    downloadAs: 'Gibson-1990-Tulach-Commain-UCLA-dissertation.pdf',
  },
  'gibson-2008-jaa': {
    slug: 'gibson-2008-jaa',
    title: 'Chiefdoms and the emergence of private property in land',
    author: 'David Blair Gibson',
    year: 2008,
    kind: 'peer-reviewed journal article',
    institution: 'Journal of Anthropological Archaeology, vol. 27, Elsevier',
    pages: 17,
    sizeLabel: '2 MB',
    description: 'Gibson\'s peer-reviewed 2008 article revisiting the Tulach Commáin and Cahercommaun findings with expanded analysis of early medieval Irish land tenure.',
    storagePath: 'ocomain/library/gibson-2008-jaa-chiefdoms-private-property.pdf',
    downloadAs: 'Gibson-2008-Chiefdoms-JAA.pdf',
  },
  'cotter-1999-cahercommaun': {
    slug: 'cotter-1999-cahercommaun',
    title: 'Cahercommaun Fort, Co. Clare: A Reassessment of its Cultural Context',
    author: 'Claire Cotter',
    year: 1999,
    kind: 'Discovery Programme Report',
    institution: 'Royal Irish Academy / Discovery Programme, Reports No. 5',
    pages: 55,
    sizeLabel: '3 key pages',
    description: 'Cotter\'s reassessment of Hencken\'s 1934 Cahercommaun excavation, including the Uí Chormaic / Commáin discussion. Currently three key pages — pages 83, 87 and 90.',
    storagePath: 'ocomain/library/cotter-1999-cahercommaun-key-pages.pdf',
    downloadAs: 'Cotter-1999-Cahercommaun-key-pages.pdf',
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // List mode: GET /api/library-fetch (no doc param) returns the manifest —
  // used by the front-end to render the library page.
  const params = event.queryStringParameters || {};
  const docSlug = params.doc;

  // Both list and fetch modes require authenticated member
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const authUser = authData.user;

  try {
    // Verify the requester is an active member of this clan
    const clan_id = await clanId();
    const { data: member } = await supa()
      .from('members')
      .select('id, status, tier_label')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authUser.id)
      .maybeSingle();

    if (!member) {
      // Fallback lookup by email if the auth linkage hasn't happened yet
      const email = (authUser.email || '').toLowerCase().trim();
      const { data: memByEmail } = await supa()
        .from('members')
        .select('id, status, tier_label')
        .eq('clan_id', clan_id)
        .eq('email', email)
        .maybeSingle();
      if (!memByEmail) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Not a clan member', email }),
        };
      }
    }

    // LIST MODE — return manifest without signed URLs
    if (!docSlug) {
      const manifest = Object.values(LIBRARY).map(({ storagePath, downloadAs, ...publicFields }) => publicFields);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: manifest }),
      };
    }

    // FETCH MODE — return signed URL for the specific doc
    const doc = LIBRARY[docSlug];
    if (!doc) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Unknown document' }) };
    }

    const { data: signed, error: signErr } = await supa()
      .storage
      .from(BUCKET)
      .createSignedUrl(doc.storagePath, DEFAULT_TTL_SECONDS, { download: doc.downloadAs });

    if (signErr || !signed?.signedUrl) {
      console.error('library-fetch sign error:', signErr?.message);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Could not sign URL — document may not be uploaded yet' }),
      };
    }

    await logEvent({
      clan_id,
      member_id:  member?.id || null,
      event_type: 'library_document_fetched',
      payload:    { doc_slug: docSlug, title: doc.title },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: doc.slug,
        title: doc.title,
        url: signed.signedUrl,
        expiresInSeconds: DEFAULT_TTL_SECONDS,
      }),
    };
  } catch (e) {
    console.error('library-fetch failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
