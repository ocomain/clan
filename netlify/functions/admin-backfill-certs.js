// netlify/functions/admin-backfill-certs.js
//
// ONE-SHOT BACKFILL — regenerate certificate PDFs for members who are
// marked published (cert_published_at IS NOT NULL) but have no
// certificate row / stored PDF.
//
// WHY THIS EXISTS (2026-06-01):
// The site-wide image reorg repointed cert-service.js at nested
// bundle-asset paths (assets/images/brand/coat_of_arms.png) that
// didn't exist in the function bundle — the bundled copies are flat
// (assets/coat_of_arms.png). So ensureCertificate() threw ENOENT and
// was caught non-fatally by the auto-publish / checkout paths. Those
// paths stamp cert_published_at BEFORE generating the PDF, so members
// ended up flagged published with no cert generated and no
// certificates-table row. The auto-publish sweep won't re-process
// them (it only looks for cert_published_at IS NULL), so they need an
// explicit regeneration pass. cert-service.js asset paths are now
// fixed (commit 8886ebb); this endpoint regenerates the backlog.
//
// AUTH: founder-admin only (isFounderAdmin allowlist), Bearer token.
//
// USAGE:
//   Dry run (preview, no writes):
//     POST { "dryRun": true }
//   Execute (regenerate, optionally cap the batch):
//     POST { "dryRun": false, "limit": 25 }
//   Optionally also send the publication-confirmation email to each
//   regenerated member (default false — usually you do NOT want to
//   re-email people who were published weeks ago):
//     POST { "dryRun": false, "sendEmail": false }
//
// IDEMPOTENT: members who already have a certificates row are skipped,
// so re-running is safe. Process in capped batches to stay within the
// function timeout (cert generation + storage upload is ~1-3s each).

const { supa, clanId, logEvent, isFounderAdmin } = require('./lib/supabase');
const { ensureCertificate } = require('./lib/cert-service');
const { sendPublicationConfirmation } = require('./lib/publication-email');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ── 1. AUTH (founder-admin only) ────────────────────────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse(401, { error: 'Missing Authorization header' });

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return jsonResponse(401, { error: 'Invalid or expired token' });
  }
  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    return jsonResponse(403, { error: 'Not permitted' });
  }

  // ── 2. PARSE BODY ───────────────────────────────────────────────────
  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const dryRun = body.dryRun !== false; // defaults TRUE — safety first
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 1), 50);
  const alsoEmail = body.sendEmail === true; // defaults FALSE

  const cid = await clanId();

  // ── 3. FIND PUBLISHED-BUT-CERTLESS MEMBERS ──────────────────────────
  // Published (cert_published_at not null), active, and no row in the
  // certificates table. We fetch published members then filter by
  // absence of a certificates row (left-join semantics done in two
  // queries since supabase-js can't express the anti-join directly).
  const { data: publishedMembers, error: pmErr } = await supa()
    .from('members')
    .select('id, email, name, tier, tier_label, tier_family, status, joined_at, cert_published_at, cert_locked_at, cert_version, partner_name, children_first_names, ancestor_dedication')
    .eq('clan_id', cid)
    .eq('status', 'active')
    .not('cert_published_at', 'is', null)
    .order('joined_at', { ascending: true });

  if (pmErr) return jsonResponse(500, { error: 'members query failed', detail: pmErr.message });

  // Which of these already have a certificate row?
  const memberIds = (publishedMembers || []).map(m => m.id);
  const haveCert = new Set();
  if (memberIds.length) {
    const { data: certRows, error: cErr } = await supa()
      .from('certificates')
      .select('member_id, storage_path')
      .eq('clan_id', cid)
      .in('member_id', memberIds);
    if (cErr) return jsonResponse(500, { error: 'certificates query failed', detail: cErr.message });
    for (const r of certRows || []) {
      if (r.storage_path) haveCert.add(r.member_id);
    }
  }

  const needCert = (publishedMembers || []).filter(m => !haveCert.has(m.id));

  // ── 4. DRY RUN — just report who would be processed ─────────────────
  if (dryRun) {
    return jsonResponse(200, {
      dryRun: true,
      published_total: publishedMembers ? publishedMembers.length : 0,
      already_have_cert: haveCert.size,
      need_cert: needCert.length,
      would_process_this_batch: Math.min(needCert.length, limit),
      sample: needCert.slice(0, limit).map(m => ({ name: m.name, email: m.email, tier: m.tier, published: m.cert_published_at })),
      note: 'No changes made. Re-POST with {"dryRun": false, "limit": N} to regenerate.',
    });
  }

  // ── 5. EXECUTE — regenerate certs (capped batch) ────────────────────
  const batch = needCert.slice(0, limit);
  let generated = 0;
  let failed = 0;
  const results = [];

  for (const m of batch) {
    try {
      const certResult = await ensureCertificate(m, cid, { forceRegenerate: true });
      if (certResult && certResult.storagePath) {
        generated++;
        results.push({ email: m.email, ok: true, storagePath: certResult.storagePath });
        await logEvent({
          clan_id: cid,
          member_id: m.id,
          event_type: 'certificate_backfilled',
          payload: { storage_path: certResult.storagePath, operator: operatorEmail },
        });
        if (alsoEmail) {
          try { await sendPublicationConfirmation(m, certResult, { autoPublished: true }); }
          catch (e) { /* email is best-effort on a backfill */ }
        }
      } else {
        failed++;
        results.push({ email: m.email, ok: false, reason: 'no storagePath returned' });
      }
    } catch (e) {
      failed++;
      results.push({ email: m.email, ok: false, reason: e.message });
      console.error(`[admin-backfill-certs] failed for ${m.email}:`, e.message);
    }
  }

  return jsonResponse(200, {
    dryRun: false,
    processed: batch.length,
    generated,
    failed,
    remaining_after_batch: needCert.length - batch.length,
    results,
    note: needCert.length > batch.length
      ? `${needCert.length - batch.length} still need certs — re-run to continue.`
      : 'All published members now have certificates.',
  });
};
