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

const { supa, clanId, logEvent, canAppearOnPublicRegister } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, sanitizeFilename } = require('./lib/cert-service');
const { sendPublicationConfirmation, sendGiftBuyerCertKeepsake } = require('./lib/publication-email');
const { computeFamilyDisplay } = require('./lib/generate-cert');
const { recordConversion, evaluateSponsorTitles } = require('./lib/sponsor-service');
const { sendSponsorLetter, sendTitleAwardLetter } = require('./lib/sponsor-email');

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
    nameOnCert,
    ancestorDedication,
    partnerName,
    childrenFirstNames,
    publicRegisterVisible,
    childrenVisibleOnRegister,
    dedicationVisibleOnRegister,
    privacyOnly,
  } = body;

  try {
    const clan_id = await clanId();

    // Resolve member by the authenticated user's ID / email
    const email = (authUser.email || '').toLowerCase().trim();
    const { data: member } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, ancestor_dedication, cert_version, cert_locked_at, cert_published_at, public_register_visible, public_register_opted_in_at')
      .eq('clan_id', clan_id)
      .eq('email', email)
      .maybeSingle();

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member record not found' }) };
    }

    const now = new Date();
    const update = {};
    let familyChanged = false;
    let nameChanged = false;
    let ancestorChanged = false;

    // PUBLICATION SEMANTICS (mirrors submit-family-details.js, per migration 011):
    // The first save from the dashboard's "Publish my certificate" modal IS
    // the publication moment. The cert is sealed, the PDF is generated,
    // the publish-cert email is sent. cert_published_at gets stamped (and
    // cert_locked_at as the alias used by older code paths).
    //
    // If already published (cert_published_at set), the modal still saves
    // changes to the member row — they appear in the Register at Newhall —
    // but the cert PDF is locked. ensureCertificate enforces this via
    // its cert_locked_at check.
    //
    // Privacy-only requests skip publication entirely: a privacy checkbox
    // toggle should never trigger cert publication.
    const isAlreadyPublished = !!(member.cert_locked_at || member.cert_published_at);
    const publishingNow = !privacyOnly && !isAlreadyPublished;

    // ── Family + name + ancestor (skipped for privacy-only requests) ─────
    if (!privacyOnly) {
      const cleanPartner = (partnerName || '').trim() || null;
      const cleanChildren = Array.isArray(childrenFirstNames)
        ? childrenFirstNames.map(s => (s || '').trim()).filter(Boolean)
        : [];
      const cleanName = (nameOnCert || '').trim();
      const cleanAncestor = ancestorDedication !== undefined
        ? ((ancestorDedication || '').trim() || null)
        : member.ancestor_dedication;  // undefined means "don't change"

      nameChanged = !!cleanName && cleanName !== member.name;
      ancestorChanged = (cleanAncestor || null) !== (member.ancestor_dedication || null);
      familyChanged = (
        (member.partner_name || null) !== cleanPartner ||
        JSON.stringify(member.children_first_names || []) !== JSON.stringify(cleanChildren)
      );

      const certAffectingChange = nameChanged || ancestorChanged || familyChanged;

      // Write family/name/ancestor fields whenever there's a cert-affecting
      // change OR we're publishing now (first publish needs the field write
      // even if the user didn't edit anything — that's the act of confirming
      // and sealing the record).
      if (certAffectingChange || publishingNow) {
        // Use the effective (possibly corrected) primary name when computing display_name.
        // Logic centralised in lib/generate-cert.js so the database value matches the
        // cert PDF and the public register entry — see computeFamilyDisplay() for the
        // four canonical household types.
        const effectiveName = cleanName || member.name;
        const { displayName } = computeFamilyDisplay(
          effectiveName,
          cleanPartner,
          cleanChildren
        );

        update.partner_name = cleanPartner;
        update.children_first_names = cleanChildren.length > 0 ? cleanChildren : null;
        update.display_name_on_register = displayName;
        update.ancestor_dedication = cleanAncestor;
        update.family_details_completed_at = now.toISOString();
        if (nameChanged) {
          update.name = cleanName;
        }
        if (cleanName) {
          update.name_confirmed_on_cert = true;
        }
        if (certAffectingChange) {
          update.cert_version = (member.cert_version || 1) + 1;
        }
      }

      // Stamp publication on first publish. Both fields set to the same
      // value so legacy cert_locked_at checks continue to work.
      if (publishingNow) {
        update.cert_published_at = now.toISOString();
        update.cert_locked_at = now.toISOString();
      }
    }

    // ── Privacy flags (always applied if provided) ───────────────────────
    if (publicRegisterVisible !== undefined) {
      // Server-side enforcement: public register is Guardian+ only. Clan Member
      // (entry tier) rows cannot have public_register_visible set to true.
      const eligible = canAppearOnPublicRegister(member.tier);
      const wantsPublic = !!publicRegisterVisible && eligible;
      const wantsChildrenPublic = !!childrenVisibleOnRegister && wantsPublic;
      // Dedication visibility — same gating shape as the children
      // visibility flag. Only meaningful when wantsPublic is true.
      const wantsDedicationPublic = !!dedicationVisibleOnRegister && wantsPublic;
      update.public_register_visible = wantsPublic;
      update.children_visible_on_register = wantsChildrenPublic;
      update.dedication_visible_on_register = wantsDedicationPublic;
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
      .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, ancestor_dedication, cert_version')
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
        publishing_now: publishingNow,
        public_register: update.public_register_visible,
        children_visible: update.children_visible_on_register,
      },
    });

    if (publishingNow) {
      await logEvent({
        clan_id,
        member_id: member.id,
        event_type: 'certificate_published',
        payload: {
          tier: updated.tier,
          source: 'dashboard_action',
        },
      });
    }

    // ── Generate cert PDF ─────────────────────────────────────────────────
    // Trigger cert generation when ANY of:
    //   - publishingNow (first publish via dashboard) — this IS the
    //     publication moment, the cert PDF is sealed at this point. Even
    //     if the user clicked Publish without changing any field, we still
    //     generate so they have a PDF.
    //   - certAffectingChange before publication — legacy code path,
    //     should be a no-op now since the only way to reach this with
    //     publishingNow=false is if the member is already published, in
    //     which case ensureCertificate refuses regeneration via its
    //     cert_locked_at check.
    //   - !privacyOnly  — covers the half-publish recovery path: a
    //     row may have cert_locked_at stamped from a previous attempt
    //     that didn't reach storage. ensureCertificate will detect
    //     'no cert exists for this member' and regenerate even though
    //     the lock is set, restoring the user from a stuck state.
    //     Privacy-only saves (the dashboard tickbox autosave) skip
    //     this so we don't run cert generation on every privacy
    //     toggle.
    const certAffectingChange = familyChanged || nameChanged || ancestorChanged;
    let certUrl = null;
    let certLocked = false;
    let certResultForEmail = null;
    if (publishingNow || certAffectingChange || !privacyOnly) {
      try {
        const certResult = await ensureCertificate(updated, clan_id, { forceRegenerate: true });
        if (certResult.locked) {
          certLocked = true;
        } else if (certResult.storagePath) {
          certUrl = await signCertUrl(certResult.storagePath, {
            ttlSeconds: 60 * 60 * 24 * 7,
            downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(updated.name || updated.email)}.pdf`,
          });
          certResultForEmail = certResult;
        }
      } catch (certErr) {
        console.error('cert regeneration after family update (non-fatal):', certErr.message);
      }
    }

    // Send publication confirmation email + gift-buyer keepsake on first
    // publish. Best-effort — failure here doesn't affect the API response.
    if (publishingNow && certResultForEmail) {
      try {
        await sendPublicationConfirmation(updated, certResultForEmail, { autoPublished: false });
      } catch (emailErr) {
        console.error('publication email send failed (non-fatal):', emailErr.message);
      }

      // GIFT BUYER KEEPSAKE — if this published member was a gift
      // recipient, send the gift buyer a copy of the published cert
      // as a keepsake.
      try {
        const { data: gift } = await supa()
          .from('gifts')
          .select('buyer_email, buyer_name, recipient_email, personal_message, gifted_at')
          .eq('member_id', updated.id)
          .maybeSingle();
        if (gift?.buyer_email) {
          await sendGiftBuyerCertKeepsake(updated, certResultForEmail, gift);
          await logEvent({
            clan_id,
            member_id: updated.id,
            event_type: 'gift_buyer_keepsake_sent',
            payload: { buyer_email: gift.buyer_email },
          });
        }
      } catch (keepsakeErr) {
        console.error('gift buyer keepsake send failed (non-fatal):', keepsakeErr.message);
      }

      // SPONSORSHIP CHAIN — if this newly-published member came
      // through an invitation, record the conversion and reward
      // the sponsor. Three steps, all best-effort:
      //
      //   1. recordConversion: stamp invitations.converted_member_id
      //      so the count is accurate. Returns the inviter's row if
      //      this member came through an invitation, null otherwise.
      //
      //   2. sendSponsorLetter: short Herald-voiced email to the
      //      sponsor naming the new member. Fires every conversion.
      //
      //   3. evaluateSponsorTitles + sendTitleAwardLetter: check
      //      whether the new conversion crossed any of the title
      //      thresholds (1/5/15) and, for each newly-earned title,
      //      send the title-award letter and stamp
      //      sponsor_titles_awarded so it doesn't fire again.
      try {
        const inviter = await recordConversion(updated, clan_id);
        if (inviter) {
          // Send the sponsor letter
          try {
            await sendSponsorLetter(inviter, updated);
            await logEvent({
              clan_id,
              member_id: inviter.id,
              event_type: 'sponsor_letter_sent',
              payload: { converted_member_id: updated.id },
            });
          } catch (letterErr) {
            console.error('sponsor letter send failed (non-fatal):', letterErr.message);
          }

          // Evaluate and award titles. The new evaluation returns:
          //   - count: current converted-invite count
          //   - allNewlyEarned: every title whose threshold was
          //     just crossed (1+ entries on a leapfrog from
          //     4 → 6+ in one event)
          //   - highestNewlyEarned: the single highest of those,
          //     or null if none. We email this one ONLY, even on
          //     a leapfrog — no awkward double-letter on the same
          //     raising day. Lower titles in the same batch are
          //     silently stamped to the audit trail.
          //   - previousTitleIrish: the Irish form of the title
          //     this member ALREADY HELD before the raising, or
          //     null if they held none. The email's bestowal
          //     language uses this for the 'raised from {prior}
          //     to the dignity of {new}' clause.
          try {
            const { count, allNewlyEarned, highestNewlyEarned, previousTitleIrish } =
              await evaluateSponsorTitles(inviter);
            if (allNewlyEarned.length > 0) {
              const stampedAwarded = { ...(inviter.sponsor_titles_awarded || {}) };
              const nowIso = new Date().toISOString();

              // Send the title-award letter ONLY for the highest
              // newly-earned title. Pass priorTitleIrish so the
              // letter can construct 'raised from {prior} to {new}'.
              let letterSent = false;
              if (highestNewlyEarned) {
                try {
                  await sendTitleAwardLetter(inviter, highestNewlyEarned, previousTitleIrish, count);
                  await logEvent({
                    clan_id,
                    member_id: inviter.id,
                    event_type: 'sponsor_title_awarded',
                    payload: {
                      title_slug: highestNewlyEarned.slug,
                      previous_title: previousTitleIrish,
                      count,
                      // Note: any leapfrogged titles are recorded
                      // in the audit-trail stamp below, not in this
                      // event's payload — the event is about the
                      // single email that was sent.
                    },
                  });
                  letterSent = true;
                } catch (titleErr) {
                  console.error(`title-award letter '${highestNewlyEarned.slug}' send failed (non-fatal):`, titleErr.message);
                }
              }

              // Stamp ALL newly-earned slugs into the JSONB so
              // the audit trail records every milestone, even
              // ones that were leapfrogged (no email but the
              // member did genuinely cross that threshold).
              // Only stamp if at least the headline letter sent
              // (or if there's no letter to send, which shouldn't
              // happen but defensive). If letter failed, retry
              // on next conversion — better than marking awarded
              // when nothing arrived.
              if (letterSent || !highestNewlyEarned) {
                for (const t of allNewlyEarned) {
                  stampedAwarded[t.slug] = nowIso;
                }
                if (Object.keys(stampedAwarded).length > Object.keys(inviter.sponsor_titles_awarded || {}).length) {
                  await supa()
                    .from('members')
                    .update({ sponsor_titles_awarded: stampedAwarded })
                    .eq('id', inviter.id);
                }
              }
            }
          } catch (titleEvalErr) {
            console.error('title evaluation failed (non-fatal):', titleEvalErr.message);
          }
        }
      } catch (sponsorErr) {
        console.error('sponsorship flow failed (non-fatal):', sponsorErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        certUrl,
        certAffectingChange,
        familyChanged,
        nameChanged,
        ancestorChanged,
        certLocked,
        published: publishingNow,
      }),
    };
  } catch (e) {
    console.error('update-family-details crashed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// (combineCoupleNames previously lived here as a local copy of the cert's
// version. Now imported via computeFamilyDisplay from ./lib/generate-cert.js
// — single source of truth for cert + register + dashboard.)
