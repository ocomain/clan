// netlify/functions/update-family-details.js
//
// POST /api/update-family-details with Authorization: Bearer <supabase-jwt>
//
// Authenticated endpoint for dashboard-initiated family and privacy updates.
// Unlike submit-family-details (post-Stripe, unauthenticated), this endpoint
// requires a signed-in member session because the caller is editing their
// OWN record from within the members area.
//
// Two request modes:
//
//   1. FULL UPDATE (family + privacy together)
//      Payload: { partnerName, childrenFirstNames, publicRegisterVisible?, childrenVisibleOnRegister? }
//      Updates family fields, regenerates cert if family changed, updates
//      privacy flags if provided.
//
//   2. PRIVACY-ONLY
//      Payload: { privacyOnly: true, publicRegisterVisible, childrenVisibleOnRegister }
//      Updates ONLY the visibility flags. Used by the dashboard privacy
//      checkboxes which auto-save on change. No cert regeneration since
//      family details aren't changing.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, sanitizeFilename } = require('./lib/cert-service');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify the Supabase JWT
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    partnerName,
    childrenFirstNames,
    publicRegisterVisible,
    childrenVisibleOnRegister,
    privacyOnly,
  } = body;

  try {
    const clan_id = await clanId();

    // Resolve member by the authenticated user's ID / email
    const email = (authUser.email || '').toLowerCase().trim();
    const { data: member } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, cert_version, public_register_visible, public_register_opted_in_at')
      .eq('clan_id', clan_id)
      .eq('email', email)
      .maybeSingle();

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member record not found' }) };
    }

    const now = new Date();
    const update = {};
    let familyChanged = false;

    // ── Family details (only if not privacy-only) ────────────────────────
    if (!privacyOnly) {
      const cleanPartner = (partnerName || '').trim() || null;
      const cleanChildren = Array.isArray(childrenFirstNames)
        ? childrenFirstNames.map(s => (s || '').trim()).filter(Boolean)
        : [];

      familyChanged = (
        (member.partner_name || null) !== cleanPartner ||
        JSON.stringify(member.children_first_names || []) !== JSON.stringify(cleanChildren)
      );

      if (familyChanged) {
        // Recompute display name from composition
        const hasPartner = !!cleanPartner;
        const hasChildren = cleanChildren.length > 0;
        let displayName;
        if (hasPartner && hasChildren) {
          displayName = `${member.name} & Family`;
        } else if (hasPartner && !hasChildren) {
          displayName = combineCoupleNames(member.name, cleanPartner);
        } else if (!hasPartner && hasChildren) {
          displayName = `${member.name} & Family`;
        } else {
          displayName = member.name;
        }

        update.partner_name = cleanPartner;
        update.children_first_names = cleanChildren.length > 0 ? cleanChildren : null;
        update.display_name_on_register = displayName;
        update.family_details_completed_at = now.toISOString();
        update.cert_version = (member.cert_version || 1) + 1;
      }
    }

    // ── Privacy flags (always applied if provided) ───────────────────────
    if (publicRegisterVisible !== undefined) {
      const wantsPublic = !!publicRegisterVisible;
      const wantsChildrenPublic = !!childrenVisibleOnRegister && wantsPublic;
      update.public_register_visible = wantsPublic;
      update.children_visible_on_register = wantsChildrenPublic;
      // Stamp opted_in_at the first time public_register_visible flips true
      if (wantsPublic && !member.public_register_opted_in_at) {
        update.public_register_opted_in_at = now.toISOString();
      }
      update.public_register_settings_updated_at = now.toISOString();
    }

    if (Object.keys(update).length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, noChange: true }) };
    }

    update.updated_at = now.toISOString();

    const { data: updated, error: updateErr } = await supa()
      .from('members')
      .update(update)
      .eq('id', member.id)
      .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, cert_version')
      .single();

    if (updateErr) {
      console.error('member update failed:', updateErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save' }) };
    }

    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: privacyOnly ? 'privacy_settings_updated' : 'family_details_updated',
      payload: {
        family_changed: familyChanged,
        public_register: update.public_register_visible,
        children_visible: update.children_visible_on_register,
      },
    });

    // Regenerate cert if family changed (privacy-only changes don't regen)
    let certUrl = null;
    if (familyChanged) {
      try {
        const { storagePath } = await ensureCertificate(updated, clan_id, { forceRegenerate: true });
        certUrl = await signCertUrl(storagePath, {
          ttlSeconds: 60 * 60 * 24 * 7,
          downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(updated.name || updated.email)}.pdf`,
        });
      } catch (certErr) {
        console.error('cert regeneration after family update (non-fatal):', certErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, certUrl, familyChanged }),
    };
  } catch (e) {
    console.error('update-family-details crashed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

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
