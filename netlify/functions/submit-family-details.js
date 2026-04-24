// netlify/functions/submit-family-details.js
//
// POST /api/submit-family-details
//
// Called from the welcome page (welcome.html) AFTER a Family-tier purchase
// has completed. Saves the family details (partner name, children's first
// names) to the member row, increments cert_version, and forces a cert
// regeneration so the updated cert reflects the new family format.
//
// Also handles the public register opt-in flags. Both default OFF on the
// member row; this function flips them on only when explicit consent has
// been given via the form. GDPR-clean: tracks public_register_opted_in_at
// timestamp the first time the member opts in.
//
// AUTHORISATION MODEL:
//   This endpoint runs unauthenticated (no Supabase JWT required) because
//   it's called immediately after Stripe checkout, before the member has
//   signed in. We resolve "which member is this?" via either:
//     (a) `sessionId`     — Stripe checkout session id (most reliable)
//     (b) `email`         — recipient/buyer email from URL param
//
//   This is acceptable because:
//   - The data being saved is non-sensitive (family names + visibility flags)
//   - The endpoint is idempotent — re-submitting just overwrites with the
//     latest values, no destructive side effects
//   - The worst-case abuse scenario is someone setting another member's
//     family details to wrong values, which is a contained low-impact issue
//     compared to the alternative of forcing the member to sign in to the
//     members area before they can complete the welcome flow (significant
//     UX friction at the highest-warmth conversion moment)
//
//   The dashboard "Privacy & Public Register" card uses the auth-protected
//   /api/update-family-details endpoint instead — anything edited from the
//   members area requires signed-in session.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, sanitizeFilename } = require('./lib/cert-service');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    email,
    sessionId,
    nameOnCert,
    ancestorDedication,
    partnerName,
    childrenFirstNames,
    publicRegisterVisible,
    childrenVisibleOnRegister,
  } = body;

  if (!email && !sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Either email or sessionId required to identify member' }) };
  }

  try {
    const clan_id = await clanId();

    // ── Resolve the member ────────────────────────────────────────────────
    // Prefer sessionId lookup if provided (one row per checkout, unambiguous).
    // Falls back to email lookup if sessionId is not supplied.
    let member = null;
    if (sessionId) {
      // Look for a member whose stripe_session_id matches. Note that the
      // members table currently doesn't store session_id directly — Stripe
      // session id sits on the gifts table for gift flows. For regular
      // member purchases we'd need to add this; for now, fall through to
      // email lookup.
      // (Future enhancement: store session_id on members table at upsert
      // time so this lookup works directly.)
    }
    if (!member && email) {
      const { data } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, ancestor_dedication, cert_version, public_register_visible, public_register_opted_in_at')
        .eq('clan_id', clan_id)
        .eq('email', email.toLowerCase().trim())
        .maybeSingle();
      member = data;
    }

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member record not found. Sign in to your members area to add family details.' }) };
    }

    // Only Family-tier members should be hitting this endpoint, but we don't
    // hard-reject Individual members - if someone has a partner they want
    // recorded on their personal cert, that's fine and harmless.

    // ── Build the update payload ──────────────────────────────────────────
    const now = new Date();
    const cleanPartner = (partnerName || '').trim() || null;
    const cleanChildren = Array.isArray(childrenFirstNames)
      ? childrenFirstNames.map(s => (s || '').trim()).filter(Boolean)
      : [];
    const cleanName = (nameOnCert || '').trim();
    const cleanAncestor = (ancestorDedication || '').trim() || null;

    // Use the corrected name (if supplied) as the member.name for cert
    // purposes. If the member just confirmed their existing name, it's
    // unchanged; if they edited it, the update is captured.
    const effectiveName = cleanName || member.name;

    // Compute display_name_on_register from family composition, using
    // the effective (possibly corrected) primary name.
    const hasPartner = !!cleanPartner;
    const hasChildren = cleanChildren.length > 0;
    let displayName;
    if (hasPartner && hasChildren) {
      displayName = `${effectiveName} & Family`;
    } else if (hasPartner && !hasChildren) {
      displayName = combineCoupleNames(effectiveName, cleanPartner);
    } else if (!hasPartner && hasChildren) {
      displayName = `${effectiveName} & Family`;
    } else {
      displayName = effectiveName;
    }

    const wantsPublic = !!publicRegisterVisible;
    const wantsChildrenPublic = !!childrenVisibleOnRegister && wantsPublic;
    // Stamp opted_in_at the FIRST TIME public visibility is set true
    const optedInAt = wantsPublic && !member.public_register_opted_in_at
      ? now.toISOString()
      : member.public_register_opted_in_at;
    // Always stamp settings_updated_at on this call so changes-of-mind are tracked
    const settingsUpdatedAt = now.toISOString();

    // Anything that affects the cert's printed content requires regeneration:
    // - primary name (if corrected from Herald chat capture)
    // - partner name
    // - children names
    // - ancestor dedication
    // - tier (not updated here but checked separately elsewhere)
    const nameChanged = cleanName && cleanName !== member.name;
    const ancestorChanged = cleanAncestor !== (member.ancestor_dedication || null);
    const familyChanged = (
      (member.partner_name || null) !== cleanPartner ||
      JSON.stringify(member.children_first_names || []) !== JSON.stringify(cleanChildren)
    );
    const certAffectingChange = nameChanged || ancestorChanged || familyChanged;
    const newVersion = certAffectingChange ? (member.cert_version || 1) + 1 : (member.cert_version || 1);

    // ── Update the member row ─────────────────────────────────────────────
    const updatePayload = {
      partner_name:                          cleanPartner,
      children_first_names:                  cleanChildren.length > 0 ? cleanChildren : null,
      display_name_on_register:              displayName,
      ancestor_dedication:                   cleanAncestor,
      family_details_completed_at:           now.toISOString(),
      public_register_visible:               wantsPublic,
      children_visible_on_register:          wantsChildrenPublic,
      public_register_opted_in_at:           optedInAt,
      public_register_settings_updated_at:   settingsUpdatedAt,
      cert_version:                          newVersion,
      updated_at:                            now.toISOString(),
    };
    // Only update member.name if the cert-name confirmation actually differs
    // from the currently-stored value (member typed a correction). Skip
    // otherwise so we don't needlessly touch the canonical identity.
    if (nameChanged) {
      updatePayload.name = cleanName;
    }
    if (cleanName) {
      updatePayload.name_confirmed_on_cert = true;
    }

    const { data: updated, error: updateErr } = await supa()
      .from('members')
      .update(updatePayload)
      .eq('id', member.id)
      .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, ancestor_dedication, cert_version')
      .single();

    if (updateErr) {
      console.error('member update failed:', updateErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save family details' }) };
    }

    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: 'family_details_completed',
      payload: {
        has_partner: hasPartner,
        children_count: cleanChildren.length,
        has_ancestor: !!cleanAncestor,
        name_corrected: nameChanged,
        public_register: wantsPublic,
        children_visible: wantsChildrenPublic,
      },
    });

    // ── Regenerate cert on any cert-affecting change ──────────────────────
    let certDownloadUrl = null;
    if (certAffectingChange) {
      try {
        const { storagePath } = await ensureCertificate(updated, clan_id, { forceRegenerate: true });
        certDownloadUrl = await signCertUrl(storagePath, {
          ttlSeconds: 60 * 60 * 24 * 7,
          downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(updated.name || updated.email)}.pdf`,
        });
      } catch (certErr) {
        console.error('cert regeneration after family details (non-fatal):', certErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        certUrl: certDownloadUrl,
        certAffectingChange,
      }),
    };
  } catch (e) {
    console.error('submit-family-details crashed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// Helper: combine two adult names. Mirrors the same logic in generate-cert.js
// so the display_name_on_register stored in the DB matches what the cert
// renders. If both adults share a final-token surname, collapse to
// "First1 & First2 SharedSurname"; otherwise keep both full.
function combineCoupleNames(name1, name2) {
  const tokens1 = name1.trim().split(/\s+/);
  const tokens2 = name2.trim().split(/\s+/);
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    const surname1 = tokens1[tokens1.length - 1];
    const surname2 = tokens2[tokens2.length - 1];
    if (surname1.toLowerCase() === surname2.toLowerCase()) {
      const first1 = tokens1.slice(0, -1).join(' ');
      const first2 = tokens2.slice(0, -1).join(' ');
      return `${first1} & ${first2} ${surname1}`;
    }
  }
  return `${name1.trim()} & ${name2.trim()}`;
}
