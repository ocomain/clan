// netlify/functions/lib/cert-service.js
// Shared certificate generation + storage + signing service.
// Called by both the HTTP endpoint (/api/generate-certificate) and the
// Stripe webhook (auto-generate on payment).

const { supa, logEvent } = require('./supabase');
const { generateCertificate } = require('./generate-cert');
const fs = require('fs');
const path = require('path');

const BUCKET = 'certificates';

/**
 * Idempotently generate + store a cert for a member. If one exists at the
 * member's current cert_version, returns that path. If not (or if
 * forceRegenerate is true), generates a new PDF, uploads, records.
 *
 * Family-aware: if the member row carries partner_name and/or
 * children_first_names, those are passed through to the cert generator
 * which renders the heraldic letters-patent format (primary grantee in
 * main body + smaller credit line below).
 *
 * Cert versioning: each member row has cert_version (default 1). The cert
 * filename embeds the version. When family details change post-payment,
 * the calling code increments cert_version and calls ensureCertificate
 * with forceRegenerate=true, producing a new file. Old files are kept
 * in storage for audit but are no longer surfaced to the member.
 *
 * @param {Object} member — full row from members table (id, name, tier_label, joined_at, partner_name?, children_first_names?, cert_version?)
 * @param {string} clan_id
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRegenerate=false] — bypass the cache and produce a fresh cert at the current version
 * @returns {Promise<{ storagePath: string, issuedAt: string, certNumber: string, wasGenerated: boolean }>}
 */
async function ensureCertificate(member, clan_id, opts = {}) {
  const forceRegenerate = !!opts.forceRegenerate;
  const version = member.cert_version || 1;

  // ── CERT LOCK ENFORCEMENT ────────────────────────────────────────────
  // A cert is a one-time heraldic instrument. Members get a 30-day grace
  // window from the FIRST time a cert was issued during which they can
  // make edits that regenerate the PDF freely. After that window, the
  // cert is locked: edits still update the member row (and the clan's
  // Register at Newhall) but this function will NOT regenerate the PDF.
  //
  // The lock is computed on-demand from cert_locked_at: if it's set AND
  // forceRegenerate is true, we refuse and return a structured response
  // so callers can tell the member their cert is locked.
  //
  // The lock is set lazily - here, when we're about to regenerate - if
  // the original cert was issued 30+ days ago. This self-heals rows that
  // were written before the lock mechanism existed.
  const GRACE_DAYS = 30;
  const now = new Date();
  if (forceRegenerate && member.cert_locked_at) {
    // Cert is supposedly locked. Before we refuse, verify that a
    // cert ACTUALLY exists for this member — because a known
    // half-publish failure mode is: cert_locked_at gets stamped on
    // the member row but the cert PDF never makes it to storage
    // (e.g. due to a downstream error on the original publish
    // attempt). The member is then stuck — they have a 'locked'
    // row but no PDF to download, and forceRegenerate=true would
    // be exactly what they need to recover.
    //
    // So: only honour the lock if at least one cert row exists for
    // this member. Otherwise treat it as a half-publish and allow
    // regeneration to fix the state.
    const { data: anyExistingCert } = await supa()
      .from('certificates')
      .select('id')
      .eq('clan_id', clan_id)
      .eq('member_id', member.id)
      .limit(1)
      .maybeSingle();

    if (anyExistingCert) {
      // Real lock — there IS a cert in the DB, and the member is
      // past the grace window. Refuse regen.
      return {
        storagePath: null,
        issuedAt: null,
        certNumber: null,
        wasGenerated: false,
        locked: true,
        lockedAt: member.cert_locked_at,
      };
    }
    // No cert exists — this is a half-publish. Fall through and
    // generate the PDF. The cert_locked_at stamp is preserved
    // (it correctly records when the publish was first attempted)
    // but the PDF generation goes ahead so the member isn't stuck.
    console.warn('half-publish recovery: cert_locked_at set but no cert exists for member', member.id, '— regenerating');
  }

  // Look for an existing cert AT THE CURRENT VERSION first (unless forcing).
  if (!forceRegenerate) {
    const { data: existing } = await supa()
      .from('certificates')
      .select('id, storage_path, issued_at, metadata')
      .eq('clan_id', clan_id)
      .eq('member_id', member.id)
      .eq('metadata->>version', String(version))
      .order('issued_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.storage_path) {
      return {
        storagePath: existing.storage_path,
        issuedAt:    existing.issued_at,
        certNumber:  existing.metadata?.cert_number || 'OC-UNKNOWN',
        wasGenerated: false,
      };
    }
  }

  // If we get here, we're generating a new cert (first issuance OR
  // regeneration within the grace window). Check if this is the first
  // issuance or a regeneration - the member's first ever issued cert
  // sets the start of the grace window.
  const { data: priorCert } = await supa()
    .from('certificates')
    .select('issued_at')
    .eq('clan_id', clan_id)
    .eq('member_id', member.id)
    .order('issued_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  // Determine whether to set cert_locked_at. If this is NOT the first
  // cert AND the first cert was issued 30+ days ago, set the lock NOW -
  // this is the last edit allowed within grace, and future forceRegen
  // calls will bounce. Also handles legacy members (no cert_locked_at
  // but first cert was issued > 30 days ago) by locking them on this
  // regeneration.
  let shouldSetLock = false;
  if (priorCert?.issued_at) {
    const firstIssuedAt = new Date(priorCert.issued_at);
    const daysSinceFirst = (now - firstIssuedAt) / (1000 * 60 * 60 * 24);
    if (daysSinceFirst >= GRACE_DAYS && !member.cert_locked_at) {
      shouldSetLock = true;
    }
  }

  // Generate fresh
  const certNumber = shortCertNumber(member.id, member.joined_at);
  const shieldPng    = fs.readFileSync(path.join(__dirname, '..', 'assets', 'coat_of_arms.png'));
  const signaturePng = fs.readFileSync(path.join(__dirname, '..', 'assets', 'the_commane_signature.png'));

  const pdfBytes = await generateCertificate({
    name:                 member.name || member.email,
    tierLabel:            member.tier_label || 'Clan Member',
    joinedAt:             member.joined_at,
    certNumber,
    shieldPng,
    signaturePng,
    // Family-format extension — undefined/null/empty is fine, generator
    // falls back to single-name rendering in that case.
    partnerName:          member.partner_name || null,
    childrenFirstNames:   member.children_first_names || null,
    // Optional ancestor dedication line — member-entered free text
    ancestorDedication:   member.ancestor_dedication || null,
  });

  // Versioned storage path so multiple cert versions can coexist for audit.
  const versionSuffix = version > 1 ? `-v${version}` : '';
  const storagePath = `ocomain/members/${member.id}/${certNumber}${versionSuffix}.pdf`;
  const { error: uploadErr } = await supa()
    .storage
    .from(BUCKET)
    .upload(storagePath, Buffer.from(pdfBytes), {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

  const issuedAt = new Date().toISOString();
  const { error: insertErr } = await supa()
    .from('certificates')
    .insert({
      clan_id,
      member_id:      member.id,
      recipient_name: member.name,
      issued_at:      issuedAt,
      storage_path:   storagePath,
      metadata:       {
        tier:        member.tier,
        tier_label:  member.tier_label,
        cert_number: certNumber,
        version,
        has_family:  !!(member.partner_name || (Array.isArray(member.children_first_names) && member.children_first_names.length > 0)),
      },
    });
  if (insertErr) console.error('certificates insert warning:', insertErr.message);

  await logEvent({
    clan_id,
    member_id:  member.id,
    event_type: forceRegenerate ? 'certificate_regenerated' : 'certificate_generated',
    payload:    { storage_path: storagePath, cert_number: certNumber, version },
  });

  // If this regeneration happens on the boundary of the grace window,
  // stamp cert_locked_at so the next forceRegenerate call refuses. This
  // makes the grace window self-enforcing - no background job needed.
  if (shouldSetLock) {
    await supa()
      .from('members')
      .update({ cert_locked_at: now.toISOString() })
      .eq('id', member.id);
    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: 'certificate_locked',
      payload: { days_after_first_issue: Math.floor((now - new Date(priorCert.issued_at)) / (1000*60*60*24)) },
    });
  }

  return { storagePath, issuedAt, certNumber, wasGenerated: true, pdfBytes };
}

/**
 * Produce a fresh signed URL for a stored cert. Bucket is private so signed
 * URLs are how members actually download.
 * @param {string} storagePath
 * @param {Object} opts
 * @param {number} opts.ttlSeconds   — how long the URL is valid (default 7 days)
 * @param {string} opts.downloadAs   — filename hint the browser uses on save
 */
async function signCertUrl(storagePath, { ttlSeconds = 60 * 60 * 24 * 7, downloadAs } = {}) {
  const { data: signed, error } = await supa()
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds, downloadAs ? { download: downloadAs } : undefined);
  if (error) throw new Error(`Sign URL failed: ${error.message}`);
  return signed.signedUrl;
}

/**
 * Pre-create the Supabase auth user so their first magic-link login is a
 * clean "sign in" flow rather than a "confirm signup" flow. Best-effort:
 * if it fails (e.g. user already exists), we swallow the error — the
 * welcome email still goes out, members area still works, they just get
 * the confirm-signup flow on first login.
 * @param {string} email
 * @param {string} name
 */
async function ensureAuthUser(email, name) {
  if (!email) return;
  try {
    const { error } = await supa().auth.admin.createUser({
      email:         email.toLowerCase().trim(),
      email_confirm: true,   // pre-confirmed — magic link works immediately
      user_metadata: { name, created_via: 'stripe_payment' },
    });
    // "already registered" is fine and expected for repeat purchasers.
    if (error && !/already|exists|registered/i.test(error.message)) {
      console.error('auth user pre-create failed:', error.message);
    }
  } catch (e) {
    console.error('auth user pre-create threw:', e.message);
  }
}

// Short stable cert number derived from member UUID + year. e.g. OC-2026-a3f7b2
function shortCertNumber(memberId, joinedAt) {
  const year = new Date(joinedAt).getFullYear();
  const shortId = (memberId || '').replace(/-/g, '').slice(0, 6);
  return `OC-${year}-${shortId}`;
}

function sanitizeFilename(s) {
  return (s || 'member')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    || 'member';
}

module.exports = { ensureCertificate, signCertUrl, ensureAuthUser, sanitizeFilename };
