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
 * Idempotently generate + store a cert for a member. If one exists, returns
 * the existing storage path. If not, generates a new PDF, uploads, records.
 * @param {Object} member — full row from members table (id, name, tier_label, joined_at…)
 * @param {string} clan_id
 * @returns {Promise<{ storagePath: string, issuedAt: string, certNumber: string, wasGenerated: boolean }>}
 */
async function ensureCertificate(member, clan_id) {
  // Look for an existing cert first
  const { data: existing } = await supa()
    .from('certificates')
    .select('id, storage_path, issued_at, metadata')
    .eq('clan_id', clan_id)
    .eq('member_id', member.id)
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

  // Generate fresh
  const certNumber = shortCertNumber(member.id, member.joined_at);
  const shieldPng = fs.readFileSync(path.join(__dirname, '..', 'assets', 'coat_of_arms.png'));

  const pdfBytes = await generateCertificate({
    name:       member.name || member.email,
    tierLabel:  member.tier_label || 'Clan Member',
    joinedAt:   member.joined_at,
    certNumber,
    shieldPng,
  });

  const storagePath = `ocomain/members/${member.id}/${certNumber}.pdf`;
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
      metadata:       { tier: member.tier, tier_label: member.tier_label, cert_number: certNumber },
    });
  if (insertErr) console.error('certificates insert warning:', insertErr.message);

  await logEvent({
    clan_id,
    member_id:  member.id,
    event_type: 'certificate_generated',
    payload:    { storage_path: storagePath, cert_number: certNumber },
  });

  return { storagePath, issuedAt, certNumber, wasGenerated: true };
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
