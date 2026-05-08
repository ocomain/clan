// netlify/functions/lib/patent-service.js
//
// Letters patent generation + storage + signing service. Mirrors
// the structure of cert-service.js but with two key architectural
// differences:
//
//   1. NO VERSIONING. The patent is a singular ceremonial issuance
//      with a specific name and date. If a member changes their name
//      after raising, the patent does NOT regenerate — they keep the
//      one issued under the name they sealed their certificate with.
//      Reissuance under a new name would be a paid Office action,
//      not a routine regeneration.
//
//   2. JSONB STORAGE METADATA, not a separate table. The cert
//      generator uses a 'certificates' table to track multiple cert
//      versions per member; we use members.patent_urls (JSONB)
//      because we never have more than one entry per dignity slug.
//      One source of truth: members.patent_urls[<slug>] = {
//        path, issued_at, issued_name
//      }
//      The 'path' is the Supabase storage object path — NEVER store
//      a signed URL because they expire. Generate signed URLs on
//      demand via getPatentSignedUrl().
//
// Two preconditions must both be met before a patent can be issued:
//
//   (a) Member has been raised to the dignity
//       (member.sponsor_titles_awarded[<slug>] is non-null)
//
//   (b) Member's certificate is sealed
//       (member.cert_published_at OR member.cert_locked_at is non-null)
//
// (b) matters because the patent's recipient name must match the
// name the member sealed their certificate with — the cert is the
// seal of name, the patent is the seal of honour, in that order.
// If a member is raised before their cert is sealed, their patent
// waits in 'in preparation' state on the dashboard until they seal.

const { supa, logEvent } = require('./supabase');
const { generatePatent, HONOURS } = require('./generate-patent');

const BUCKET = 'patents';

// Long-form date string for the date line on the patent. For real
// conferrals this should be the actual date of issuance (not the date
// of raising, since cert-seal can come later). Caller passes this in;
// helper at the bottom of this file formats a JS Date as the chivalric
// long-form.
function defaultDateString() {
  return formatChivalricDate(new Date());
}

/**
 * Idempotently generate + store a letters patent for a member at a
 * given dignity. Behaviour:
 *
 *   1. If member.patent_urls[slug] is already populated, returns that
 *      entry without regenerating. The patent is a singular issuance.
 *   2. Otherwise verifies both preconditions (raised + cert sealed).
 *      If either fails, returns { skipped: true, reason } without
 *      generating.
 *   3. Generates the PDF (with isSpecimen: false — never SPECIMEN
 *      for a real conferral), uploads to Supabase storage, updates
 *      members.patent_urls[slug] via JSONB merge.
 *
 * @param {Object} member — full row from members table. Must include
 *                           id, name, sponsor_titles_awarded,
 *                           cert_published_at OR cert_locked_at, and
 *                           patent_urls.
 * @param {string} dignitySlug — 'cara' | 'ardchara' | 'onoir'
 * @param {string} clan_id
 * @returns {Promise<{
 *   wasGenerated: boolean,         // true if we just generated a new one
 *   skipped: boolean,              // true if preconditions not met
 *   reason: string | null,         // populated when skipped=true
 *   path: string | null,           // storage path (set when wasGenerated OR
 *                                     idempotency hit on existing entry)
 *   issuedAt: string | null,       // ISO timestamp
 *   issuedName: string | null,     // the name on the patent (frozen)
 *   honourReference: string | null,// honour reference (OCH-YYYY-NNNNNN)
 *                                  // surfaces in patent reference stamp.
 *                                  // Same value across all of a member's
 *                                  // patents (Cara/Ardchara/Onóir).
 * }>}
 */
async function ensurePatent(member, dignitySlug, clan_id, opts = {}) {
  const { force = false } = opts;

  if (!HONOURS[dignitySlug]) {
    throw new Error(`ensurePatent: unknown dignitySlug "${dignitySlug}"`);
  }

  // ── 1. IDEMPOTENCY ──────────────────────────────────────────────
  // If we've already issued this patent, return the existing entry
  // without doing any further work. Singular issuance.
  //
  // Exception: when force=true, skip the early-return and proceed
  // to regenerate. This is the operational hatch for cases where
  // the template changed and we need the storage file refreshed
  // (e.g. the moment a copy change goes out). The honour_reference
  // is deterministic from member identity, so regen produces the
  // same reference automatically — no preservation logic needed.
  const existing = (member.patent_urls || {})[dignitySlug];
  if (existing && existing.path && !force) {
    return {
      wasGenerated: false,
      skipped: false,
      reason: null,
      path: existing.path,
      issuedAt: existing.issued_at || null,
      issuedName: existing.issued_name || null,
      honourReference: existing.honour_reference || null,
    };
  }

  // ── 2. PRECONDITION CHECKS ──────────────────────────────────────
  // Both must be true: member is raised AND cert is sealed.
  const titlesAwarded = member.sponsor_titles_awarded || {};
  const raisedAt = titlesAwarded[dignitySlug];
  if (!raisedAt) {
    return {
      wasGenerated: false,
      skipped: true,
      reason: 'not_raised_to_dignity',
      path: null, issuedAt: null, issuedName: null, honourReference: null,
    };
  }

  const certSealed = !!(member.cert_published_at || member.cert_locked_at);
  if (!certSealed) {
    return {
      wasGenerated: false,
      skipped: true,
      reason: 'cert_not_sealed',
      path: null, issuedAt: null, issuedName: null, honourReference: null,
    };
  }

  // ── 3. ISSUED NAME ──────────────────────────────────────────────
  // Use the name from the member row (the cert was sealed with this
  // name, so the patent will bear the same). Frozen here at issuance
  // — even if member.name changes later, this issued_name stays.
  const issuedName = (member.name || '').trim();
  if (!issuedName) {
    return {
      wasGenerated: false,
      skipped: true,
      reason: 'member_name_empty',
      path: null, issuedAt: null, issuedName: null, honourReference: null,
    };
  }

  // ── 4. COMPUTE HONOUR REFERENCE ────────────────────────────────
  // Deterministic identifier derived from member.id + joined_at —
  // mirrors the cert pattern (shortCertNumber → OC-YYYY-NNNNNN).
  // Patents prefix with OCH for "Ó Comáin Honours" to distinguish
  // from the membership cert.
  //
  // The reference is stable across all of a member's patents:
  // Cara, Ardchara, Onóir all share the same OCH-YYYY-NNNNNN. It's
  // the member's honour reference, not a per-patent number.
  //
  // Computed fresh each time (no sequence, no RPC, no race
  // conditions). When force=true on a regen, this just recomputes
  // to the same value — safe.
  const honourReference = shortHonourReference(member.id, member.joined_at);

  // ── 5. GENERATE THE PDF ─────────────────────────────────────────
  // isSpecimen=false ALWAYS for real conferrals. The SPECIMEN
  // watermark is only used for the Antoin-as-social-proof PDF in
  // Email 3B; never for member-issued patents. honourReference is
  // computed deterministically above and surfaces in the bottom-left
  // reference stamp.
  const pdfBytes = await generatePatent({
    honourSlug: dignitySlug,
    recipientName: issuedName,
    dateString: defaultDateString(),
    isSpecimen: false,
    honourReference,
  });

  // ── 6. UPLOAD TO SUPABASE STORAGE ───────────────────────────────
  // Path: patents/<slug>/<member-id>.pdf — flat, deterministic, one
  // file per member per dignity. upsert:true is defensive in case a
  // partial upload from a previous failed attempt left a stub.
  const storagePath = `${dignitySlug}/${member.id}.pdf`;
  const { error: uploadErr } = await supa()
    .storage
    .from(BUCKET)
    .upload(storagePath, Buffer.from(pdfBytes), {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (uploadErr) {
    throw new Error(`Patent storage upload failed: ${uploadErr.message}`);
  }

  // ── 7. RECORD ON MEMBER ROW ─────────────────────────────────────
  // JSONB merge: we read the current patent_urls, overlay our new
  // entry, write the whole object back. (Supabase JSONB doesn't have
  // a partial-update primitive.) Race-conditions: if two concurrent
  // ensurePatent calls land for the same member+slug, the loser
  // overwrites the winner — but since the path is deterministic and
  // the issued_name + honour_reference are deterministic too, the
  // resulting state is identical regardless of which write wins.
  const issuedAt = new Date().toISOString();
  const newPatentUrls = {
    ...(member.patent_urls || {}),
    [dignitySlug]: {
      path: storagePath,
      issued_at: issuedAt,
      issued_name: issuedName,
      honour_reference: honourReference,
    },
  };
  const { error: updateErr } = await supa()
    .from('members')
    .update({ patent_urls: newPatentUrls })
    .eq('id', member.id);
  if (updateErr) {
    // Storage write succeeded but DB write failed — leaves an orphan
    // file in storage but next ensurePatent call will overwrite it
    // (upsert:true) and the DB will catch up. Log and continue
    // throwing so the caller knows generation didn't complete.
    console.error('Patent DB update failed:', updateErr.message);
    throw new Error(`Patent DB update failed: ${updateErr.message}`);
  }

  // ── 8. AUDIT LOG ────────────────────────────────────────────────
  await logEvent({
    clan_id,
    member_id: member.id,
    event_type: 'patent_generated',
    payload: {
      dignity: dignitySlug,
      storage_path: storagePath,
      issued_name: issuedName,
      honour_reference: honourReference,
    },
  });

  return {
    wasGenerated: true,
    skipped: false,
    reason: null,
    path: storagePath,
    issuedAt,
    issuedName,
    honourReference,
  };
}

/**
 * Produce a fresh signed URL for a stored patent. Bucket is private
 * so signed URLs are how members actually download. Default TTL of
 * 1 hour is enough for an immediate download click but short enough
 * that URLs in old emails won't be hijackable.
 *
 * @param {string} storagePath  — from member.patent_urls[<slug>].path
 * @param {Object} opts
 * @param {number} opts.ttlSeconds — URL validity (default 1 hour)
 * @param {string} opts.downloadAs — filename hint browser uses on save
 * @returns {Promise<string>}
 */
async function getPatentSignedUrl(storagePath, { ttlSeconds = 60 * 60, downloadAs } = {}) {
  const { data: signed, error } = await supa()
    .storage
    .from(BUCKET)
    .createSignedUrl(
      storagePath,
      ttlSeconds,
      downloadAs ? { download: downloadAs } : undefined,
    );
  if (error) throw new Error(`Patent sign URL failed: ${error.message}`);
  return signed.signedUrl;
}

/**
 * Convenience: read the raw PDF bytes from storage. Used by the
 * bestowal email sender to attach the freshly-generated patent PDF
 * directly (avoiding the round-trip via signed URL when we already
 * know we just need the bytes).
 *
 * @param {string} storagePath
 * @returns {Promise<Buffer>}
 */
async function downloadPatentBytes(storagePath) {
  const { data, error } = await supa()
    .storage
    .from(BUCKET)
    .download(storagePath);
  if (error) throw new Error(`Patent download failed: ${error.message}`);
  // Supabase returns a Blob; convert to Buffer for nodemailer/Resend
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ──────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────

// Compute the unique honour reference for a member, mirroring the
// shortCertNumber pattern in cert-service.js. Format:
//   OCH-YYYY-NNNNNN
// where YYYY is the year the member joined and NNNNNN is the first
// 6 hex chars of their UUID. Stable per member — same across Cara,
// Ardchara, Onóir if they're raised through multiple dignities.
//
// Mirrors cert pattern (OC-YYYY-NNNNNN) with OCH prefix to
// distinguish honour reference from cert reference at a glance.
function shortHonourReference(memberId, joinedAt) {
  const year = new Date(joinedAt).getFullYear();
  const shortId = (memberId || '').replace(/-/g, '').slice(0, 6);
  return `OCH-${year}-${shortId}`;
}

// Convert a JS Date to the chivalric long-form date string used on
// the patent's date line. Example output:
//   "this third day of May, in the year of Our Lord two thousand and twenty-six"
function formatChivalricDate(date) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const day = date.getUTCDate();
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `this ${ordinalWord(day)} day of ${month}, in the year of Our Lord ${yearWords(year)}`;
}

function ordinalWord(n) {
  const words = [
    '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
    'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
    'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second',
    'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth',
    'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth',
    'thirty-first',
  ];
  return words[n] || `${n}th`;
}

function yearWords(year) {
  // Fixed for 2026: "two thousand and twenty-six". Generic conversion
  // is overkill for this use case — patents will be issued for years
  // we're alive to maintain. Update each year-end.
  const map = {
    2025: 'two thousand and twenty-five',
    2026: 'two thousand and twenty-six',
    2027: 'two thousand and twenty-seven',
    2028: 'two thousand and twenty-eight',
    2029: 'two thousand and twenty-nine',
    2030: 'two thousand and thirty',
  };
  return map[year] || String(year);
}

module.exports = {
  ensurePatent,
  getPatentSignedUrl,
  downloadPatentBytes,
  formatChivalricDate,  // exported for tests
};
