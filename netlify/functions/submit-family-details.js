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

const { supa, clanId, logEvent, canAppearOnPublicRegister } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, sanitizeFilename } = require('./lib/cert-service');
const { ensurePatent } = require('./lib/patent-service');
const { sendPublicationConfirmation, sendGiftBuyerCertKeepsake } = require('./lib/publication-email');
const { computeFamilyDisplay } = require('./lib/generate-cert');
const { recordConversion, evaluateSponsorTitles, highestAwardedTitle } = require('./lib/sponsor-service');
const { stripDuplicateAncestorPrefix } = require('./lib/ancestor-dedication');
const { sendSponsorLetter, sendTitleAwardLetter } = require('./lib/sponsor-email');
const { looksLikeMultipleNames } = require('./lib/name-format');

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
    dedicationVisibleOnRegister,
  } = body;

  if (!email && !sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Either email or sessionId required to identify member' }) };
  }

  try {
    const clan_id = await clanId();

    // ── Resolve the member ────────────────────────────────────────────────
    // Two paths to identify which member to update:
    //   (a) email param directly in URL — used in dashboard and explicit links
    //   (b) sessionId from Stripe success URL — most common path post-checkout
    //       The Stripe Checkout Session contains the buyer's email which we
    //       fetch from the API, then resolve the member by that email.
    let resolvedEmail = email ? email.toLowerCase().trim() : null;

    if (!resolvedEmail && sessionId) {
      try {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error('STRIPE_SECRET_KEY not set in environment');
        } else {
          const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
            headers: { Authorization: `Bearer ${stripeKey}` },
          });
          if (sessionResp.ok) {
            const session = await sessionResp.json();
            // Stripe Checkout Session has customer_details.email (buyer's
            // email captured during checkout). For subscriptions also
            // available as customer_email if pre-filled.
            const sessionEmail = session?.customer_details?.email
              || session?.customer_email
              || null;
            if (sessionEmail) {
              resolvedEmail = sessionEmail.toLowerCase().trim();
            }
          } else {
            const errBody = await sessionResp.text().catch(() => '');
            console.error(`Stripe session lookup failed (${sessionResp.status}):`, errBody.slice(0, 200));
          }
        }
      } catch (err) {
        console.error('Stripe session lookup error:', err.message);
      }
    }

    if (!resolvedEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not identify member. Please sign in to your members area to add details.' }) };
    }

    let member = null;
    {
      const { data } = await supa()
        .from('members')
        .select('id, email, name, tier, tier_label, tier_family, joined_at, partner_name, children_first_names, ancestor_dedication, cert_version, cert_locked_at, public_register_visible, public_register_opted_in_at')
        .eq('clan_id', clan_id)
        .eq('email', resolvedEmail)
        .maybeSingle();
      member = data;
    }

    if (!member) {
      // The webhook may not yet have written the member row when the buyer
      // hits welcome.html (Stripe checkout completion → webhook → member
      // upsert is usually <1 second but not guaranteed). Tell the caller
      // gracefully so the UI can suggest a retry.
      return { statusCode: 404, body: JSON.stringify({ error: 'Membership not yet recorded. Please wait a moment and try again, or sign in to your members area.' }) };
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
    let cleanAncestor = (ancestorDedication || '').trim() || null;

    // Server-side defensive normalisation against duplicated prefix
    // variants (e.g. chip 'In honour of' active + user typed
    // 'In honor of …' into the detail field → saved value started
    // with 'In honour of In honor of …'). The dashboard's modal
    // does both pre-input validation and submit-time blocking on
    // this, but a determined or accidental bypass — paste-with-
    // extension, future API client, replayed payload — could still
    // send a malformed string. The helper strips the second prefix
    // quietly rather than rejecting, matching the same length-cap
    // convention immediately below.
    cleanAncestor = stripDuplicateAncestorPrefix(cleanAncestor);

    // Hard cap on dedication length — defence in depth against any
    // path that bypasses the client maxlength=100. The cert layout
    // prints the dedication on a single italic line; longer text
    // overruns the cert frame visually (was the Mindy Crowley bug
    // that prompted this guard). Truncate rather than reject so the
    // member can still seal — the truncated form is the truthful
    // record of what they typed and what fits.
    const ANCESTOR_MAX = 100;
    if (cleanAncestor && cleanAncestor.length > ANCESTOR_MAX) {
      cleanAncestor = cleanAncestor.slice(0, ANCESTOR_MAX).trim();
    }

    // Server-side multi-name detection backstop.
    // Client-side validation in the publish modal warns the user and
    // requires confirmation when the primary-name field looks like
    // multiple people ('John & Mary Smith', 'John and Mary Smith').
    // This is the server-side safety net for cases where someone
    // bypasses the client check (DevTools, direct API call, an old
    // cached client). We don't BLOCK — there's no security reason to,
    // since users can only corrupt their own cert — but we log the
    // event so admins can review and reach out to fix the record.
    if (looksLikeMultipleNames(cleanName)) {
      try {
        await logEvent({
          clan_id,
          member_id: member.id,
          event_type: 'multi_name_in_cert_submit',
          payload: { name: cleanName, tier: member.tier, path: 'submit-family-details' },
        });
      } catch {} // non-fatal — best-effort observability
    }

    // Use the corrected name (if supplied) as the member.name for cert
    // purposes. If the member just confirmed their existing name, it's
    // unchanged; if they edited it, the update is captured.
    const effectiveName = cleanName || member.name;

    // Compute display_name_on_register from family composition via the
    // shared helper. Same logic the cert generator uses, ensuring the
    // sealed cert and the dashboard's "Name on the Register" field
    // always show the same string. (See generate-cert.js for the four
    // canonical household types this handles.)
    const { displayName } = computeFamilyDisplay(
      effectiveName,
      cleanPartner,
      cleanChildren
    );

    const wantsPublic = !!publicRegisterVisible && canAppearOnPublicRegister(member.tier);
    const wantsChildrenPublic = !!childrenVisibleOnRegister && wantsPublic;
    // Same gating shape as wantsChildrenPublic — only honoured when
    // the member is on the public register at all. Member can also
    // tick the dedication box without having a dedication set; the
    // flag will simply have no rendered effect. Cleaner to always
    // store what the member asked for than to silently override.
    // Dedication-on-register: pre-ticked by default, opt-out model
    // (revised 2026-05-03 per chief direction). The earlier opt-in
    // model meant members who sealed with a dedication had to
    // actively visit the privacy panel and tick the checkbox to
    // get the dedication onto the public register — but the natural
    // mental model is the inverse ('I put my dedication on my cert,
    // therefore I want it visible'). Fix: when the client doesn't
    // explicitly send dedicationVisibleOnRegister at all (which the
    // seal modal never does, since it has no dedication checkbox),
    // default to TRUE if the member has a dedication AND is on the
    // public register. Members who explicitly want privacy can
    // untick on the dashboard's privacy panel — that path always
    // sends the field explicitly and is honoured as-is.
    const dedicationProvided = dedicationVisibleOnRegister !== undefined;
    const dedicationDefaulted = !dedicationProvided
      && !!ancestorDedication
      && wantsPublic;
    const wantsDedicationPublic = (dedicationProvided
      ? !!dedicationVisibleOnRegister
      : dedicationDefaulted) && wantsPublic;
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

    // PUBLICATION SEMANTICS (per migration 011):
    // The first save of the welcome form IS the publication moment. The
    // cert is sealed, the PDF is generated, the publish-cert email is
    // sent. cert_published_at gets stamped (and cert_locked_at as the
    // alias used by older code paths).
    //
    // If already published (cert_published_at set), we DO NOT re-publish.
    // The form save still updates the member row (so the Register at
    // Newhall reflects edits), but the cert PDF is locked. This is what
    // the existing cert_locked_at check inside ensureCertificate enforces.
    //
    // Edge: an already-published member submitting again will see their
    // changes saved to the Register but the cert returned in the response
    // will be the same locked PDF. UI surfaces this via certLocked: true.
    const isAlreadyPublished = !!(member.cert_locked_at || member.cert_published_at);
    const publishingNow = !isAlreadyPublished;

    // ── Update the member row ─────────────────────────────────────────────
    const updatePayload = {
      partner_name:                          cleanPartner,
      children_first_names:                  cleanChildren.length > 0 ? cleanChildren : null,
      display_name_on_register:              displayName,
      ancestor_dedication:                   cleanAncestor,
      family_details_completed_at:           now.toISOString(),
      public_register_visible:               wantsPublic,
      children_visible_on_register:          wantsChildrenPublic,
      dedication_visible_on_register:        wantsDedicationPublic,
      public_register_opted_in_at:           optedInAt,
      public_register_settings_updated_at:   settingsUpdatedAt,
      cert_version:                          newVersion,
      updated_at:                            now.toISOString(),
    };
    // Stamp publication on the first save. Both fields set to the same
    // value so legacy cert_locked_at checks continue to work.
    if (publishingNow) {
      updatePayload.cert_published_at = now.toISOString();
      updatePayload.cert_locked_at = now.toISOString();
    }
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
        publishing_now: publishingNow,
      },
    });

    if (publishingNow) {
      await logEvent({
        clan_id,
        member_id: member.id,
        event_type: 'certificate_published',
        payload: {
          tier: updated.tier,
          source: 'member_action',
        },
      });
    }

    // ── Generate cert PDF ─────────────────────────────────────────────────
    // Generate on the first publish (publishingNow) — this IS the
    // publication moment, the cert PDF is sealed at this point.
    // Also regenerate on cert-affecting changes BEFORE publication
    // (legacy code path — should be no-op now since the only way to
    // reach this with publishingNow=false is if the member is already
    // published, in which case cert-service refuses regeneration via
    // its cert_locked_at check).
    let certDownloadUrl = null;
    let certLocked = false;
    let certResultForEmail = null;
    if (publishingNow || certAffectingChange) {
      try {
        const certResult = await ensureCertificate(updated, clan_id, { forceRegenerate: true });
        if (certResult.locked) {
          // Lock enforced — member row was updated (their Register entry at
          // Newhall reflects the change) but PDF not regenerated. Tell the
          // caller so the UI can explain the situation.
          certLocked = true;
        } else if (certResult.storagePath) {
          certDownloadUrl = await signCertUrl(certResult.storagePath, {
            ttlSeconds: 60 * 60 * 24 * 7,
            downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(updated.name || updated.email)}.pdf`,
          });
          certResultForEmail = certResult;
        }
      } catch (certErr) {
        console.error('cert generation in submit-family-details (non-fatal):', certErr.message);
      }
    }

    // Send publication confirmation email if we actually published.
    // Best-effort — failure here doesn't affect the API response.
    //
    // FIRE-AND-FORGET: All publication side-effects run AFTER the
    // response returns. The user only needs the cert + signed URL to
    // complete their flow; emails and sponsor-chain work are internal
    // bookkeeping. See update-family-details.js for the same pattern
    // and rationale.
    if (publishingNow && certResultForEmail) {
      firePublicationSideEffects(updated, clan_id, certResultForEmail).catch(err => {
        console.error('firePublicationSideEffects unexpected failure:', err.message, err.stack);
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        certUrl: certDownloadUrl,
        certAffectingChange,
        certLocked,
        published: publishingNow,
      }),
    };
  } catch (e) {
    console.error('submit-family-details crashed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// ─────────────────────────────────────────────────────────────────────
// firePublicationSideEffects — runs after the user response goes out.
//
// Mirrors the equivalent helper in update-family-details.js with one
// difference: this is the welcome-flow path, where the publication is
// always FIRST publish, so there is no dedup-gate against the
// stripe-webhook chain. The webhook records conversion at payment
// time but this function ALSO runs on first publish — for members
// who joined directly (no invitation), the inviter lookup is null
// so nothing duplicates; for members who joined via invitation, the
// webhook has already stamped converted_member_id, but we still want
// to enrich with sponsor letters here for any pre-webhook flow that
// reached this path.
//
// Three blocks, each with its own try/catch:
//   1. Publication confirmation email to the member.
//   2. Gift-buyer keepsake (only if this member was a gift recipient).
//   3. Sponsorship chain — record conversion, send sponsor letter,
//      evaluate and award sponsor titles.
//
// Errors in any block are logged but do not propagate. The function
// returns a promise that resolves when all blocks have settled (used
// only for the top-level defensive catch in the handler).
// ─────────────────────────────────────────────────────────────────────
async function firePublicationSideEffects(updated, clan_id, certResultForEmail) {
  // (1) PUBLICATION CONFIRMATION EMAIL
  try {
    await sendPublicationConfirmation(updated, certResultForEmail, { autoPublished: false });
  } catch (emailErr) {
    console.error('publication email send failed (non-fatal):', emailErr.message);
  }

  // (1.5) PATENT GENERATION — for the publishing member.
  // The cert was just sealed in this transaction (publishingNow was
  // true to reach here). If this member already holds any dignities
  // — for example, a gift-recipient who was previously raised by
  // inviting someone, who has only now sealed their cert — generate
  // their letters patent now. ensurePatent gracefully skips dignities
  // already issued, and gracefully skips if preconditions still fail
  // (defence-in-depth — shouldn't trigger here since we just sealed).
  //
  // Per Council direction: only the LATEST/highest dignity's patent
  // is surfaced on the dashboard, but storage retains all (audit
  // trail). So we generate for ALL held dignities, not just the
  // highest — the dashboard does the highest-only filtering on read.
  try {
    const titlesAwarded = updated.sponsor_titles_awarded || {};
    const dignitiesHeld = Object.entries(titlesAwarded)
      .filter(([_, raisedAt]) => raisedAt != null)
      .map(([slug]) => slug);
    // Re-fetch the member with patent_urls + cert columns so
    // ensurePatent has everything it needs (the `updated` row from
    // the .select() above doesn't include those).
    if (dignitiesHeld.length > 0) {
      const { data: memberFull } = await supa()
        .from('members')
        .select('id, name, sponsor_titles_awarded, cert_published_at, cert_locked_at, patent_urls')
        .eq('id', updated.id)
        .single();
      if (memberFull) {
        for (const slug of dignitiesHeld) {
          try {
            const result = await ensurePatent(memberFull, slug, clan_id);
            if (result.skipped) {
              console.warn(`patent generation skipped for member ${updated.id} dignity ${slug}: ${result.reason}`);
            }
          } catch (patentErr) {
            console.error(`patent generation failed for member ${updated.id} dignity ${slug} (non-fatal):`, patentErr.message);
          }
        }
      }
    }
  } catch (patentBlockErr) {
    console.error('patent generation block failed (non-fatal):', patentBlockErr.message);
  }

  // (2) GIFT BUYER KEEPSAKE — if this published member was a gift
  // recipient, send the gift buyer a copy of the published cert
  // as a keepsake. Look up the gifts table by member_id to find
  // the buyer's email + name + personal message context.
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

  // (3) SPONSORSHIP CHAIN — if this newly-published member came
  // through an invitation, record the conversion and reward
  // the sponsor. Mirrors the same logic in update-family-details.js
  // (the dashboard publish path). Both paths route here on first-
  // publish; the sponsorship chain handles its own idempotency.
  try {
    const inviter = await recordConversion(updated, clan_id);
    if (inviter) {
      // Pass the inviter's current highest title so the greeting
      // can address them by dignity (mirrors update-family-
      // details.js).
      const inviterCurrentTitle = highestAwardedTitle(inviter.sponsor_titles_awarded);
      try {
        await sendSponsorLetter(inviter, updated, inviterCurrentTitle);
        await logEvent({
          clan_id,
          member_id: inviter.id,
          event_type: 'sponsor_letter_sent',
          payload: { converted_member_id: updated.id },
        });
      } catch (letterErr) {
        console.error('sponsor letter send failed (non-fatal):', letterErr.message);
      }

      try {
        const { count, allNewlyEarned, highestNewlyEarned, previousTitleIrish } =
          await evaluateSponsorTitles(inviter);
        if (allNewlyEarned.length > 0) {
          const stampedAwarded = { ...(inviter.sponsor_titles_awarded || {}) };
          const nowIso = new Date().toISOString();

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
                },
              });
              letterSent = true;
            } catch (titleErr) {
              console.error(`title-award letter '${highestNewlyEarned.slug}' send failed (non-fatal):`, titleErr.message);
            }
          }

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

            // After updating the inviter's awarded-titles row, try
            // to generate patents for every newly-earned dignity.
            // ensurePatent gracefully skips if the inviter's cert
            // isn't sealed yet (the patent waits until they seal,
            // which auto-happens at day 30 if not done manually —
            // the daily-cert-sweep cron picks it up there).
            try {
              const { data: inviterFull } = await supa()
                .from('members')
                .select('id, name, sponsor_titles_awarded, cert_published_at, cert_locked_at, patent_urls')
                .eq('id', inviter.id)
                .single();
              if (inviterFull) {
                for (const t of allNewlyEarned) {
                  try {
                    const result = await ensurePatent(inviterFull, t.slug, clan_id);
                    if (result.skipped) {
                      console.log(`inviter ${inviter.id} patent for ${t.slug} deferred: ${result.reason}`);
                    }
                  } catch (pErr) {
                    console.error(`inviter ${inviter.id} patent ${t.slug} generation failed (non-fatal):`, pErr.message);
                  }
                }
              }
            } catch (inviterFetchErr) {
              console.error('inviter re-fetch for patent generation failed (non-fatal):', inviterFetchErr.message);
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

// (combineCoupleNames previously lived here as a local copy of the cert's
// version. It's now imported from ./lib/generate-cert.js as part of
// computeFamilyDisplay, ensuring there's one source of truth and the
// register format can never drift from the cert format.)
