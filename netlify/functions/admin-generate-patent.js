// netlify/functions/admin-generate-patent.js
//
// Manually trigger patent generation for a specific member + dignity.
// Used to backfill members who are already past both preconditions
// (raised + cert sealed) but whose patents weren't auto-generated
// because the new trigger logic only fires at FUTURE moments.
//
// Primary use case at time of writing: Antoin holds Cara and has
// (presumably) sealed his cert, but his patent doesn't exist yet
// because all the trigger callsites added in commit 4e777fd fire on
// state-changing events that have already happened for him.
//
// USAGE (from terminal):
//
//   curl -X POST 'https://www.ocomain.org/.netlify/functions/admin-generate-patent' \
//     -H 'Content-Type: application/json' \
//     -d '{"email":"antoin@example.com","dignitySlug":"cara"}'
//
// PARAMETERS (JSON body):
//
//   email          (required)  member's email address (case-insensitive)
//   dignitySlug    (required)  'cara' | 'ardchara' | 'onoir'
//
// SAFETY NOTES:
//   - This calls ensurePatent which is idempotent. If a patent
//     already exists for the (member, dignitySlug) pair, the
//     existing entry is returned without regeneration. Safe to
//     re-run — won't double-issue.
//
//   - It WILL NOT generate a patent if either precondition fails
//     (member not raised to that dignity, OR cert not sealed). The
//     response will tell you which precondition failed via the
//     'reason' field. This is the correct behaviour: if the
//     preconditions aren't met, the patent shouldn't exist.
//
//   - No authentication. Same security model as the other
//     test-* endpoints — the URL itself is not public knowledge,
//     and the worst case is generating a patent for a member who
//     would have got one anyway via the cert-seal cron at day 30.
//     Not safe to expose this to the public internet long-term;
//     should be retired or auth-gated once Antoin's backfill is
//     done and any other operational use cases have been handled.
//
// RESPONSE: JSON describing what happened. The fields mirror the
// ensurePatent return shape:
//   { wasGenerated: true,                 → freshly created
//     skipped: false,
//     reason: null,
//     path: 'cara/<member-id>.pdf',
//     issuedAt: '2026-...',
//     issuedName: 'Antoin Commane',
//     memberId: '<uuid>' }
//
//   { wasGenerated: false,                → already existed
//     skipped: false, ...path/issuedAt populated from existing entry }
//
//   { wasGenerated: false,                → preconditions unmet
//     skipped: true,
//     reason: 'cert_not_sealed' | 'not_raised_to_dignity' | ... }

const { supa, clanId } = require('./lib/supabase');
const { ensurePatent } = require('./lib/patent-service');
const { HONOURS } = require('./lib/generate-patent');

console.log('[admin-generate-patent] module load start');

exports.handler = async (event) => {
  console.log('[admin-generate-patent] handler invoked');

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'method_not_allowed', message: 'POST only' }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_json', message: 'Body is not valid JSON' }),
    };
  }

  const email = (body.email || '').toString().toLowerCase().trim();
  const dignitySlug = body.dignitySlug;

  if (!email) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_email', message: 'email is required' }),
    };
  }
  if (!dignitySlug || !HONOURS[dignitySlug]) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'invalid_dignitySlug',
        message: `dignitySlug must be 'cara', 'ardchara', or 'onoir'; got ${JSON.stringify(dignitySlug)}`,
      }),
    };
  }

  try {
    const clan_id = await clanId();

    // Fetch member with all the columns ensurePatent needs.
    const { data: member, error: fetchErr } = await supa()
      .from('members')
      .select('id, email, name, sponsor_titles_awarded, cert_published_at, cert_locked_at, patent_urls, joined_at')
      .eq('clan_id', clan_id)
      .eq('email', email)
      .maybeSingle();

    if (fetchErr) {
      throw new Error(`Member lookup failed: ${fetchErr.message}`);
    }
    if (!member) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'member_not_found', email }),
      };
    }

    console.log(`[admin-generate-patent] calling ensurePatent for member=${member.id} email=${email} dignity=${dignitySlug} force=${!!body.force}`);
    const result = await ensurePatent(member, dignitySlug, clan_id, {
      force: !!body.force,
    });
    console.log(`[admin-generate-patent] result:`, JSON.stringify(result));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...result,
        memberId: member.id,
        memberEmail: member.email,
        memberName: member.name,
        dignitySlug,
      }),
    };
  } catch (err) {
    console.error('[admin-generate-patent] crashed:', err.message);
    console.error(err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'generation_failed',
        message: err.message,
        stack: err.stack,
      }),
    };
  }
};
