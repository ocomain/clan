// netlify/functions/generate-certificate.js
// POST /api/generate-certificate — authenticated member cert download.
//
// Flow: verify JWT → look up member → if cert already generated in Storage,
// return a fresh signed URL → otherwise generate PDF with generate-cert.js,
// upload to Supabase Storage bucket `certificates`, record in certificates
// table, return signed URL.
//
// Idempotent: calling multiple times doesn't regenerate the PDF, it just
// re-signs the existing stored file.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { generateCertificate } = require('./lib/generate-cert');
const fs = require('fs');
const path = require('path');

const BUCKET = 'certificates';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'POST' && method !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Auth
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const email = (authData.user.email || '').toLowerCase().trim();

  try {
    const clan_id = await clanId();

    // Look up member by auth_user_id then by email
    let { data: member } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, status, joined_at')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();

    if (!member) {
      ({ data: member } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, status, joined_at')
        .eq('clan_id', clan_id)
        .eq('email', email)
        .maybeSingle());
    }

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Not a member' }) };
    }

    // Is there already a cert stored for this member?
    const { data: existingCert } = await supa()
      .from('certificates')
      .select('id, storage_path, issued_at')
      .eq('clan_id', clan_id)
      .eq('member_id', member.id)
      .order('issued_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let storagePath;
    let issuedAt;
    let certNumber;

    if (existingCert?.storage_path) {
      // Reuse
      storagePath = existingCert.storage_path;
      issuedAt = existingCert.issued_at;
    } else {
      // Generate a new cert PDF
      certNumber = shortCertNumber(member.id, member.joined_at);
      const shieldPng = fs.readFileSync(path.join(__dirname, 'assets', 'coat_of_arms.png'));

      const pdfBytes = await generateCertificate({
        name: member.name || email,
        tierLabel: member.tier_label || 'Clan Member',
        joinedAt: member.joined_at,
        certNumber,
        shieldPng,
      });

      // Upload to Supabase Storage bucket `certificates`
      storagePath = `ocomain/members/${member.id}/${certNumber}.pdf`;
      const { error: uploadErr } = await supa()
        .storage
        .from(BUCKET)
        .upload(storagePath, Buffer.from(pdfBytes), {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

      // Record in certificates table
      issuedAt = new Date().toISOString();
      const { error: insertErr } = await supa()
        .from('certificates')
        .insert({
          clan_id,
          member_id: member.id,
          recipient_name: member.name,
          issued_at: issuedAt,
          storage_path: storagePath,
          metadata: { tier: member.tier, tier_label: member.tier_label, cert_number: certNumber },
        });
      if (insertErr) console.error('certificates insert warning:', insertErr.message);

      await logEvent({ clan_id, member_id: member.id, event_type: 'certificate_generated', payload: { storage_path: storagePath, cert_number: certNumber } });
    }

    // Create a fresh signed URL (valid 24 hours). Since the bucket is private,
    // the browser can't access the file without this URL.
    const { data: signed, error: signErr } = await supa()
      .storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, {
        download: `Clan-O-Comain-Certificate-${sanitizeFilename(member.name || email)}.pdf`,
      });
    if (signErr) throw new Error(`Sign URL failed: ${signErr.message}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: signed.signedUrl,
        expires_at: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
        issued_at: issuedAt,
        member_name: member.name,
      }),
    };
  } catch (e) {
    console.error('generate-certificate failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// Short stable cert number derived from member UUID + year.
// e.g. OC-2026-a3f7b2
function shortCertNumber(memberId, joinedAt) {
  const year = new Date(joinedAt).getFullYear();
  const shortId = memberId.replace(/-/g, '').slice(0, 6);
  return `OC-${year}-${shortId}`;
}

function sanitizeFilename(s) {
  return (s || 'member')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    || 'member';
}
