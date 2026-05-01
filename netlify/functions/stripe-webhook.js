// netlify/functions/stripe-webhook.js
// Triggered by Stripe when a payment completes
// Sends welcome email via Resend, records member in Supabase.

const { supa, clanId, normaliseTier, logEvent } = require('./lib/supabase');
const { buildSignInUrl } = require('./lib/signin-token');
const { ensureCertificate, signCertUrl, ensureAuthUser, sanitizeFilename } = require('./lib/cert-service');
const { sendEmail } = require('./lib/email');
const { evaluateSponsorTitles, recordConversion, highestAwardedTitle } = require('./lib/sponsor-service');
const { sendTitleAwardLetter, sendSponsorLetter } = require('./lib/sponsor-email');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CLAN_EMAIL = 'clan@ocomain.org';

const TIER_NAMES = {
  'Clan Member Individual':     { name: 'Clan Member',            benefits: ['Digital membership certificate', 'Chief-approved crest use', 'Member-only access to clan festivals (member rates apply)', 'Clan newsletter', 'Place in the Register of Members'] },
  'Clan Member Family':         { name: 'Clan Member (Family)',   benefits: ['Digital family certificate', 'Chief-approved crest use', 'Member-only access to clan festivals (member rates apply)', 'Clan newsletter', 'Both names in the Register'] },
  'Guardian Individual':        { name: 'Guardian of the Clan',  benefits: ['Physical certificate signed by the Chief — posted to you', 'Personal letter of welcome from the Chief', 'Listed on the Guardians page', 'Place at the annual Guardians dinner at Newhall House (members contribute to the evening)', 'Member-only access to clan festivals (member rates apply)', 'Priority on Privy Council openings'] },
  'Guardian Family':            { name: 'Guardian of the Clan (Family)', benefits: ['Physical family certificate signed by the Chief', 'Both seated at the annual Guardians dinner at Newhall House (members contribute to the evening)', 'Family listed on Guardians page', 'Member-only access to clan festivals (member rates apply)'] },
  'Steward Individual':         { name: 'Steward of the Clan',   benefits: ['Everything in Guardian', 'Place at the annual dinner at Newhall House with the Chief (members contribute to the evening)', 'Name on Clan Roll of Honour at Newhall', 'Dedicated website acknowledgement', 'Private call with the Chief'] },
  'Steward Family':             { name: 'Steward of the Clan (Family)', benefits: ['Everything in Guardian Family', 'Both seated at the annual dinner at Newhall (members contribute to the evening)', 'Family on Clan Roll of Honour'] },
  'Life Member Individual':     { name: 'Life Member',           benefits: ['Guardian benefits for life', 'Name engraved on Roll of Honour at Newhall House', 'Clan heirloom keepsake pack', 'Your name in the Register forever'] },
  'Life Member Family':         { name: 'Life Member (Family)',  benefits: ['Guardian Family benefits for life', 'Family on Roll of Honour at Newhall', 'Family heirloom keepsake pack'] },
};

// Match the Stripe product name to a tier, with fuzzy matching that survives
// any reasonable variation in Stripe product naming.
function matchTier(productName) {
  const p = (productName || '').toLowerCase();
  const isFamily = p.includes('family');
  const suffix = isFamily ? ' Family' : ' Individual';

  if (p.includes('life'))                              return TIER_NAMES['Life Member' + suffix];
  if (p.includes('steward') || p.includes('patron'))   return TIER_NAMES['Steward' + suffix];
  if (p.includes('guardian'))                          return TIER_NAMES['Guardian' + suffix];
  if (p.includes('clan member'))                       return TIER_NAMES['Clan Member' + suffix];
  // Sensible fallback so we never send a blank benefits list.
  return TIER_NAMES[isFamily ? 'Clan Member Family' : 'Clan Member Individual'];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const customerEmail = session.customer_details?.email;
    const customerName = session.customer_details?.name;
    // preferredName is the name we use in email greetings ('Dear X').
    // Defaults to Stripe billing name, but gets overridden by the
    // Herald-captured name in BOTH branches below — the gift branch
    // pulls it from session.metadata.buyer_name, the non-gift branch
    // resolves through metadata.herald_name -> applications table ->
    // customerName fallback. The email send sites further down use
    // this variable, NOT customerName, so the buyer is greeted by
    // what they typed in the Herald rather than what's on their card.
    let preferredName = customerName;

    // Get the product name. Prefer metadata (if ever set), then fall back to
    // fetching the actual line item description from Stripe.
    let productName = session.metadata?.product_name;
    if (!productName) {
      try {
        const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1, expand: ['data.price.product'] });
        productName = items.data?.[0]?.description
                   || items.data?.[0]?.price?.product?.name
                   || 'Clan Membership';
      } catch (e) {
        console.error('listLineItems failed:', e.message);
        productName = 'Clan Membership';
      }
    }

    const amount = (session.amount_total / 100).toFixed(2);
    const currency = session.currency.toUpperCase();
    const isGift = session.metadata?.is_gift === 'true' || /gift/i.test(productName);

    // ── Record in Supabase ──────────────────────────────────────────────────
    // Upsert a member row (or a gift row), close the matching application,
    // log the event. Failures here are logged but don't prevent the welcome
    // email being sent — the DB is a parallel source of truth, not a gate.
    let certDownloadUrl = null;
    // Recipient context (populated when isGift) — used for emails and DB links.
    let giftContext = null;
    try {
      const clan_id = await clanId();
      // Tier resolution priority (most → least reliable):
      //   1. session.metadata.tier — set explicitly by create-checkout /
      //      create-gift-checkout endpoints. The deterministic source of
      //      truth, used for all live purchases going forward.
      //   2. amount-based detection in normaliseTier — fallback for
      //      legacy plink purchases (pre-create-checkout) and any oddity.
      //   3. product-name parsing in normaliseTier — last-ditch fallback.
      const TIER_BY_SLUG_LOCAL = {
        'clan-ind':     { tier: 'clan-ind',     label: 'Clan Member',                       tier_family: false },
        'clan-fam':     { tier: 'clan-fam',     label: 'Clan Member (Family)',              tier_family: true  },
        'guardian-ind': { tier: 'guardian-ind', label: 'Guardian of the Clan',              tier_family: false },
        'guardian-fam': { tier: 'guardian-fam', label: 'Guardian of the Clan (Family)',     tier_family: true  },
        'steward-ind':  { tier: 'steward-ind',  label: 'Steward of the Clan',               tier_family: false },
        'steward-fam':  { tier: 'steward-fam',  label: 'Steward of the Clan (Family)',      tier_family: true  },
        'life-ind':     { tier: 'life-ind',     label: 'Life Member',                       tier_family: false },
        'life-fam':     { tier: 'life-fam',     label: 'Life Member (Family)',              tier_family: true  },
      };
      const tierFromMeta = session.metadata?.tier;
      const tierInfo = (tierFromMeta && TIER_BY_SLUG_LOCAL[tierFromMeta])
        ? TIER_BY_SLUG_LOCAL[tierFromMeta]
        : normaliseTier(productName, session.amount_total);
      const isLife = tierInfo.tier.startsWith('life');

      if (isGift) {
        // ── GIFT PATH ──────────────────────────────────────────────────────
        // The payer (customerEmail) is the BUYER. The actual clan member is
        // the RECIPIENT — that's who we create the member row for, generate
        // the cert for, and send the welcome email to.
        const md = session.metadata || {};
        const recipientEmail = (md.recipient_email || '').toLowerCase().trim();
        const recipientName  = md.recipient_name || null;
        const buyerEmail     = (md.buyer_email || customerEmail || '').toLowerCase().trim();
        const buyerName      = md.buyer_name || customerName || null;
        // The buyer is who Stripe receipts and our gift confirmations greet.
        // Update outer-scope preferredName so notifyClan + the legacy
        // fallback path use the Herald-collected name, not Stripe billing.
        preferredName = buyerName || preferredName;
        const personalMsg    = md.personal_message || null;
        const giftId         = md.gift_id || null;

        if (!recipientEmail) {
          // Legacy Payment Link fell through with no metadata — all we can do
          // is record the gift and notify the clan inbox manually. This branch
          // is a safety net; normal flow always has metadata.
          console.warn('Gift session missing recipient_email metadata — fallback recording only:', session.id);
          await supa().from('gifts').insert({
            clan_id,
            buyer_email: buyerEmail,
            buyer_name: buyerName,
            tier: tierInfo.tier,
            tier_label: tierInfo.label,
            tier_family: tierInfo.tier_family,
            gift_mode: 'onetime',
            stripe_session_id: session.id,
            status: 'paid_no_recipient',
          });
          await logEvent({ clan_id, event_type: 'gift_paid_no_recipient', payload: { session_id: session.id, buyer_email: buyerEmail } });
        } else {
          // 1. Create or update the MEMBER row for the recipient. Two cases:
          //    (a) Brand new recipient — INSERT with joined_at = now
          //    (b) Existing member receiving a gift (e.g. someone upgrades
          //        them from Clan to Guardian via a gift) — UPDATE, preserve
          //        original joined_at so their 'Member since' and any
          //        Founder seal on their original cert stay true.
          const now = new Date();
          const expiresAt = isLife ? null : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

          const { data: existingRecipient } = await supa()
            .from('members')
            .select('id, joined_at, tier, tier_label')
            .eq('clan_id', clan_id)
            .eq('email', recipientEmail)
            .maybeSingle();

          // Phase 2 (2026-04-30) — DEFERRED ACCEPTANCE for paid gifts.
          // Splits the recipient handling into two paths:
          //
          //   A. Existing-recipient gift (tier upgrade): the recipient
          //      is already a clan member. They've already opted in
          //      to the clan, so no further acceptance is needed —
          //      we update their member row immediately to reflect
          //      the new tier. Same as the pre-Phase-2 behaviour for
          //      this case.
          //
          //   B. New-recipient gift: the recipient is NOT yet a
          //      member. Phase 2 defers member creation to the
          //      claim-click moment. We don't INSERT a member row
          //      here; we leave member=null. The gift row UPDATE
          //      below will write status='paid' + member_id=null
          //      (rather than 'claimed' + member_id=X). The
          //      recipient must press 'Claim my place' on the
          //      welcome page (gift-welcome.html) to materialise
          //      the member row via /api/claim-paid-gift.
          //
          // Why split: gifting to an existing member is a tier
          // change, not a clan introduction. Forcing them to
          // re-accept would be confusing ('I'm already a member,
          // what is this?'). Gifting to a new person IS a clan
          // introduction; consent matters.
          let member = null;
          let upsertErr = null;

          if (existingRecipient) {
            // PATH A: existing member → UPDATE tier in place. No
            // acceptance needed — they're already in the clan.
            const updateRes = await supa()
              .from('members')
              .update({
                name:                   recipientName || undefined,
                tier:                   tierInfo.tier,
                tier_label:             tierInfo.label,
                tier_family:            tierInfo.tier_family,
                // stripe_* stay null on the member row for gifts
                status:                 'active',
                renewed_at:             now.toISOString(),
                expires_at:             expiresAt ? expiresAt.toISOString() : null,
                updated_at:             now.toISOString(),
                metadata:               { gift: true, buyer_name: buyerName, buyer_email: buyerEmail },
                // joined_at OMITTED — preserves original year
              })
              .eq('id', existingRecipient.id)
              .select('id, email, name, tier, tier_label, tier_family, joined_at')
              .single();
            member = updateRes.data;
            upsertErr = updateRes.error;

            if (!upsertErr && existingRecipient.tier !== tierInfo.tier) {
              await logEvent({
                clan_id,
                member_id: member.id,
                event_type: 'tier_changed_via_gift',
                payload: {
                  from_tier: existingRecipient.tier,
                  to_tier: tierInfo.tier,
                  buyer_email: buyerEmail,
                  session_id: session.id,
                },
              });
            }
          } else {
            // PATH B: brand-new recipient → DEFER. No member row yet.
            // The gift row update below stores recipient details +
            // claim_token; member is materialised on /api/claim-paid-gift.
            console.log(`[gift Phase 2] deferring member creation for new recipient ${recipientEmail} until claim`);
          }

          if (upsertErr) {
            console.error('gift member insert/update failed:', upsertErr.message);
          } else {
            // 2. Update/insert the gift row.
            //
            // Phase 2 (2026-04-30): for NEW recipients, member.id is
            // null (deferred). The gift row stores recipient details
            // + status='paid' + member_id=null + a claim_token. The
            // welcome page resolves the token and the recipient
            // claims via /api/claim-paid-gift, which materialises
            // the member row and links via member_id.
            //
            // For EXISTING recipients (tier upgrade), member.id is
            // set immediately — we mark the gift as 'claimed' since
            // there's no acceptance step (they're already a member).
            //
            // We capture the gift row's claim_token after write so
            // we can pass it to sendGiftRecipientWelcome below.
            const isDeferred = !member;
            const giftRowStatus = isDeferred ? 'paid' : 'claimed';
            const giftMemberId = member ? member.id : null;
            const giftClaimedAt = isDeferred ? null : now.toISOString();
            const giftExpiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

            let giftRow;
            if (giftId) {
              console.log(`[gift] UPDATE existing gift row ${giftId} → status=${giftRowStatus}, member_id=${giftMemberId || 'null (deferred)'}`);
              const updRes = await supa()
                .from('gifts')
                .update({
                  status: giftRowStatus,
                  stripe_session_id: session.id,
                  member_id: giftMemberId,
                  sent_to_recipient_at: now.toISOString(),
                  claimed_at: giftClaimedAt,
                  // expires_at — only set if not already set (don't
                  // overwrite a pre-existing value from gift insert
                  // at checkout time).
                })
                .eq('id', giftId)
                .select('id, claim_token, expires_at, buyer_email')
                .single();
              if (updRes.error) {
                console.error(`[gift] UPDATE FAILED for gift ${giftId}:`, updRes.error.message, updRes.error.details);
              } else {
                console.log(`[gift] UPDATE OK: id=${updRes.data.id}, claim_token=${updRes.data.claim_token}, buyer_email='${updRes.data.buyer_email}'`);
              }
              giftRow = updRes.data;
              // Backfill expires_at if missing (safety for legacy rows).
              if (giftRow && !giftRow.expires_at) {
                await supa()
                  .from('gifts')
                  .update({ expires_at: giftExpiresAt })
                  .eq('id', giftId);
                giftRow.expires_at = giftExpiresAt;
              }
            } else {
              console.log(`[gift] INSERT fresh gift row → buyer_email='${buyerEmail}', status=${giftRowStatus}, member_id=${giftMemberId || 'null (deferred)'}`);
              const insRes = await supa().from('gifts').insert({
                clan_id,
                buyer_email: buyerEmail,
                buyer_name: buyerName,
                recipient_email: recipientEmail,
                recipient_name: recipientName,
                tier: tierInfo.tier,
                tier_label: tierInfo.label,
                tier_family: tierInfo.tier_family,
                gift_mode: md.gift_mode === 'recurring' ? 'recurring' : 'onetime',
                personal_message: personalMsg,
                stripe_session_id: session.id,
                member_id: giftMemberId,
                sent_to_recipient_at: now.toISOString(),
                claimed_at: giftClaimedAt,
                expires_at: giftExpiresAt,
                status: giftRowStatus,
                // claim_token: defaults to gen_random_uuid() in DB
              }).select('id, claim_token, expires_at, buyer_email').single();
              if (insRes.error) {
                console.error(`[gift] INSERT FAILED:`, insRes.error.message, insRes.error.details);
              } else {
                console.log(`[gift] INSERT OK: id=${insRes.data.id}, claim_token=${insRes.data.claim_token}, buyer_email='${insRes.data.buyer_email}'`);
              }
              giftRow = insRes.data;
            }
            // Capture for downstream email send. Falls back to null
            // if the row write didn't return data — sendGiftRecipientWelcome
            // handles a missing token gracefully (renders without
            // claim CTA).
            const giftClaimToken = giftRow ? giftRow.claim_token : null;
            const giftRowId = giftRow ? giftRow.id : giftId;

            // Event log — uses giftRowId since member.id may be null
            // for deferred new-recipient gifts.
            await logEvent({
              clan_id,
              member_id: giftMemberId,
              event_type: isDeferred ? 'gift_paid_pending_acceptance' : 'gift_paid',
              payload: {
                tier: tierInfo.tier,
                amount,
                recipient_email: recipientEmail,
                buyer_email: buyerEmail,
                gift_id: giftRowId,
              },
            });

            // ── BUYER-AS-SPONSOR TITLE AWARD ─────────────────────────
            // Phase 2: title award fires on PAYMENT regardless of
            // whether the recipient ever claims the gift. The buyer
            // has done their act of bringing-in by paying — sponsor
            // credit attaches to that, not to the recipient's later
            // engagement. countSponsoredBy() now counts gifts by
            // status='paid'/'claimed', not just by member_id presence.
            //
            // Only runs if the buyer is themselves a clan member.
            // Non-member gift buyers earn no title.
            // have different surrounding context (clan_id + supa
            // closure, error handling, etc.); a helper extraction is a
            // good refactor but not blocking for this fix.
            //
            // Only runs if the buyer is themselves a clan member.
            // Non-member gift buyers (giftors who haven't joined the
            // clan) earn no title — they never appear in the honours
            // ladder.
            try {
              console.log(`[gift title-award] looking up buyer member by email='${buyerEmail}'`);
              const { data: buyer, error: buyerLookupErr } = await supa()
                .from('members')
                .select('id, email, name, sponsor_titles_awarded')
                .eq('clan_id', clan_id)
                .ilike('email', buyerEmail)
                .maybeSingle();
              if (buyerLookupErr) {
                console.error('[gift title-award] buyer lookup ERROR:', buyerLookupErr.message);
              }
              if (!buyer) {
                console.log(`[gift title-award] no member row matches buyer email '${buyerEmail}' — buyer is not yet a clan member, no dignity to confer. Skipping.`);
              } else {
                console.log(`[gift title-award] buyer member found: id=${buyer.id} email='${buyer.email}' existingTitles=${JSON.stringify(buyer.sponsor_titles_awarded || {})}`);
                const { count: sponsorCount, allNewlyEarned, highestNewlyEarned, previousTitleIrish } =
                  await evaluateSponsorTitles(buyer);
                console.log(`[gift title-award] sponsorCount=${sponsorCount}, newlyEarned=[${allNewlyEarned.map(t=>t.slug).join(',')}], highest=${highestNewlyEarned ? highestNewlyEarned.slug : 'none'}, previousTitleIrish='${previousTitleIrish}'`);
                if (allNewlyEarned.length > 0) {
                  const stampedAwarded = { ...(buyer.sponsor_titles_awarded || {}) };
                  const nowIso = new Date().toISOString();
                  let letterSent = false;
                  if (highestNewlyEarned) {
                    try {
                      await sendTitleAwardLetter(buyer, highestNewlyEarned, previousTitleIrish, sponsorCount);
                      console.log(`[gift title-award] LETTER SENT to ${buyer.email}, title=${highestNewlyEarned.slug}`);
                      await logEvent({
                        clan_id,
                        member_id: buyer.id,
                        event_type: 'sponsor_title_awarded',
                        payload: {
                          title_slug: highestNewlyEarned.slug,
                          previous_title: previousTitleIrish,
                          count: sponsorCount,
                          source: 'gift_paid',
                          recipient_member_id: member ? member.id : null,
                          gift_id: giftRowId,
                        },
                      });
                      letterSent = true;
                    } catch (titleErr) {
                      console.error(`[gift title-award] letter send FAILED for '${highestNewlyEarned.slug}':`, titleErr.message, titleErr.stack);
                    }
                  }
                  if (letterSent || !highestNewlyEarned) {
                    for (const t of allNewlyEarned) stampedAwarded[t.slug] = nowIso;
                    if (Object.keys(stampedAwarded).length > Object.keys(buyer.sponsor_titles_awarded || {}).length) {
                      await supa()
                        .from('members')
                        .update({ sponsor_titles_awarded: stampedAwarded })
                        .eq('id', buyer.id);
                      console.log(`[gift title-award] stamped sponsor_titles_awarded with: ${JSON.stringify(stampedAwarded)}`);
                    }
                  }
                } else {
                  console.log(`[gift title-award] no NEW titles earned at count=${sponsorCount} (existing stamps: ${JSON.stringify(buyer.sponsor_titles_awarded || {})}). Sponsor count updates on dashboard but no letter fires.`);
                }
              }
            } catch (giftSponsorErr) {
              console.error('[gift title-award] block threw:', giftSponsorErr.message, giftSponsorErr.stack);
            }
            // ─────────────────────────────────────────────────────────

            // 3. Pre-create auth user for the recipient — only if the
            //    member row exists (i.e., existing-recipient tier
            //    upgrade). For Phase 2 deferred new-recipient gifts,
            //    we create the auth user at claim time (in
            //    claim-paid-gift.js), since we want to avoid creating
            //    Supabase auth shells for people who may never claim.
            if (member) {
              await ensureAuthUser(recipientEmail, recipientName);
            }

            // 4. CERT GENERATION DELIBERATELY OMITTED.
            // Per the publication model, recipients must explicitly
            // publish their cert via the members area. For Phase 2
            // new-recipient gifts, no member exists yet — cert flow
            // begins after they claim. For existing-recipient
            // upgrades, the cert flow continues from their prior
            // member state.

            giftContext = {
              recipientEmail, recipientName,
              buyerEmail, buyerName,
              personalMsg,
              tierLabel: tierInfo.label,
              certDownloadUrl: null,  // recipient publishes themselves
              // Phase 2 fields:
              claimToken: giftClaimToken,        // null only if gift row write failed
              isDeferred: !member,                // true = recipient must claim
              expiresAt: giftRow ? giftRow.expires_at : null,
            };
          }
        }
      } else {
        // Regular self-purchase path. A member may already exist — this
        // happens on tier upgrades (member joins as Clan Member, later goes
        // through /membership to pick Guardian). In that case we must NOT
        // overwrite joined_at, otherwise the member's 'Member since YYYY'
        // identity (and any Founder-year seal on their cert) gets lost.
        //
        // Strategy: fetch first to see if a row already exists, then either
        // INSERT (new member) or UPDATE (tier change / renewal), each with
        // the correct set of fields.
        const now = new Date();
        const normEmail = (customerEmail || '').toLowerCase().trim();
        const expiresAt = isLife ? null : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

        // ── Resolve preferred name ─────────────────────────────────────────
        // The Herald chat captures the name the buyer chose for clan purposes
        // BEFORE Stripe takes the cardholder name. Cardholder name is often
        // Resolve the member's preferred name. Three sources, highest
        // priority first:
        //
        //   1. session.metadata.herald_name — set by create-checkout from
        //      the URL when the buyer came through the Herald flow. This
        //      is DETERMINISTIC: it travels into the webhook with the
        //      session itself, no DB race possible. Also robust to the
        //      buyer choosing a different card name on Stripe (married
        //      surname, gift purchase from another account, etc.).
        //   2. applications table lookup — fallback for buyers who hit
        //      Stripe directly (skipping Herald) or for legacy sessions
        //      from before metadata.herald_name existed. Protected by
        //      keepalive on the herald POST.
        //   3. session.customer_details.name — Stripe billing name. Last
        //      resort. Often miscapitalised or a card-name initial like
        //      'J Smith'.
        // (preferredName is declared at outer scope, defaulting to
        //  customerName — we just override it with herald_name or the
        //  applications-table value below if either is found.)
        const heraldNameFromMeta = (session.metadata?.herald_name || '').trim();
        if (heraldNameFromMeta) {
          preferredName = heraldNameFromMeta;
        } else {
          try {
            const { data: app } = await supa()
              .from('applications')
              .select('name, created_at')
              .eq('clan_id', clan_id)
              .eq('email', normEmail)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (app?.name && app.name.trim()) {
              preferredName = app.name.trim();
            }
          } catch (lookupErr) {
            // Non-fatal - fall through to customerName
            console.error('Herald name lookup failed (non-fatal):', lookupErr.message);
          }
        }

        const { data: existing } = await supa()
          .from('members')
          .select('id, joined_at, tier, tier_label, stripe_subscription_id, name')
          .eq('clan_id', clan_id)
          .eq('email', normEmail)
          .maybeSingle();

        let member, upsertErr;
        if (existing) {
          // UPGRADE / RENEWAL path — preserve joined_at (original year),
          // update everything else. stripe_customer_id may legitimately
          // change if Stripe creates a new customer; keep the newer one.
          // If the previous subscription still exists (they're now on Life,
          // or upgraded from one annual tier to another), the old sub
          // should be cancelled at Stripe, which we don't do automatically
          // here — that's an operational step (see comment below).
          const updatePayload = {
            // name handling: preserve existing name if user has confirmed it
            // (could've been edited on welcome page). Only update if existing
            // name is null/empty - in which case use preferredName.
            // Skip the field entirely otherwise so previous edits stick.
            tier:                   tierInfo.tier,
            tier_label:             tierInfo.label,
            tier_family:            tierInfo.tier_family,
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription || null,
            status:                 'active',
            renewed_at:             now.toISOString(),
            expires_at:             expiresAt ? expiresAt.toISOString() : null,
            updated_at:             now.toISOString(),
            // joined_at DELIBERATELY OMITTED — preserves original year,
            // which is what the Founder seal and 'Member since' hook
            // depend on
            // gift_renewal_reminded_at DELIBERATELY NOT RESET — if a gift
            // recipient upgrades to self-paying, their previous reminder
            // flag stays stamped (they already got the reminder that
            // triggered this upgrade). The next year's reminder will
            // reset appropriately via future renewal logic.
          };
          // Name handling on the UPGRADE path:
          //   - If the herald name comes from session metadata (highest-
          //     trust source — buyer just confirmed it minutes ago via
          //     the Herald flow on this same purchase), update the row.
          //     This corrects any prior bad value (e.g. earlier test
          //     purchases that landed a Stripe billing name like '1111').
          //   - Otherwise, preserve the existing name. The buyer may have
          //     edited it via the welcome page or members' area since the
          //     last write — we shouldn't clobber that with a DB-fallback
          //     or Stripe-billing fallback that may be stale.
          if (heraldNameFromMeta) {
            updatePayload.name = heraldNameFromMeta;
          } else if (!existing.name || !existing.name.trim()) {
            updatePayload.name = preferredName || undefined;
          }

          const updateRes = await supa()
            .from('members')
            .update(updatePayload)
            .eq('id', existing.id)
            .select('id, email, name, tier, tier_label, tier_family, joined_at')
            .single();
          member = updateRes.data;
          upsertErr = updateRes.error;

          if (!upsertErr && existing.tier !== tierInfo.tier) {
            // Note a tier change for observability. If the previous tier
            // was a recurring subscription and they've now moved to a
            // different annual tier or to Life, the OLD Stripe subscription
            // needs to be cancelled manually in the Stripe Dashboard (or
            // we can automate later). Logging it here makes that queue
            // visible.
            await logEvent({
              clan_id,
              member_id: member.id,
              event_type: 'tier_changed',
              payload: {
                from_tier: existing.tier,
                to_tier: tierInfo.tier,
                previous_subscription_id: existing.stripe_subscription_id,
                new_subscription_id: session.subscription || null,
                session_id: session.id,
              },
            });
          }
        } else {
          // Genuine new member — INSERT with joined_at = now.
          const insertRes = await supa()
            .from('members')
            .insert({
              clan_id,
              email:                  normEmail,
              name:                   preferredName,
              tier:                   tierInfo.tier,
              tier_label:             tierInfo.label,
              tier_family:            tierInfo.tier_family,
              stripe_customer_id:     session.customer,
              stripe_subscription_id: session.subscription || null,
              status:                 'active',
              joined_at:              now.toISOString(),
              renewed_at:             now.toISOString(),
              expires_at:             expiresAt ? expiresAt.toISOString() : null,
              // Public Register opt-in by default (2026-04-30): same
              // policy applied to gift claims (claim-founder-gift +
              // claim-paid-gift). Self-purchasing members appear on
              // the public Register automatically; they can untick
              // the opt-in box in the members area to opt out.
              // Tier filter applied at /register render-time.
              public_register_visible:    true,
              public_register_opted_in_at: now.toISOString(),
              children_visible_on_register: tierInfo.tier_family,
            })
            .select('id, email, name, tier, tier_label, tier_family, joined_at')
            .single();
          member = insertRes.data;
          upsertErr = insertRes.error;
        }
        if (upsertErr) {
          console.error('member insert/update failed:', upsertErr.message);
        } else {
          await logEvent({ clan_id, member_id: member.id, event_type: 'member_paid', payload: { tier: tierInfo.tier, amount, session_id: session.id, was_upgrade: !!existing } });

          // Close any matching pending application for this email.
          await supa()
            .from('applications')
            .update({ status: 'paid', member_id: member.id, stripe_session_id: session.id })
            .eq('clan_id', clan_id)
            .eq('email', normEmail)
            .eq('status', 'pending');

          // Pre-create Supabase auth user so first login is magic-link (not
          // confirm-signup). Best-effort — doesn't block payment flow.
          await ensureAuthUser(customerEmail, customerName);

          // ── INVITATION-AS-SPONSOR TITLE AWARD ────────────────────
          // Mirror of the gift-buyer chain (line ~280). If this new
          // member came through an invitation from an existing clan
          // member, that inviter is the sponsor — credit them NOW
          // (on payment), not later when the invitee happens to
          // publish their cert from the dashboard. The previous
          // architecture wired the chain to update-family-details.js
          // (publish-time), which left the sponsor uncredited and
          // un-emailed for as long as the invitee delayed publishing
          // — possibly indefinitely.
          //
          // Pre-check: skip if invitations.converted_member_id is
          // already set (idempotency — webhook can be redelivered;
          // also defends against the rare case of a member who paid
          // before this fix shipped and is being re-processed).
          //
          // recordConversion does both the lookup AND the stamping
          // of invitations.converted_member_id, so calling it inside
          // the !already-converted gate gives us the inviter while
          // closing the door against double-fire.
          //
          // Intentionally placed AFTER the application-row update
          // and ensureAuthUser so the auth user exists by the time
          // any post-process surfaces (sponsor letter, member link)
          // are generated.
          try {
            const memberEmailLower = String(member.email || '').toLowerCase().trim();
            if (memberEmailLower) {
              const { data: priorInv } = await supa()
                .from('invitations')
                .select('id, converted_member_id')
                .eq('clan_id', clan_id)
                .ilike('recipient_email', memberEmailLower)
                .order('sent_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (priorInv && !priorInv.converted_member_id) {
                const inviter = await recordConversion(member, clan_id);
                if (inviter) {
                  // Sponsor letter — short Herald-voiced note to the
                  // inviter naming the new member. Title-aware
                  // greeting ('Dia dhuit, Cara James' if inviter
                  // already holds a dignity).
                  const inviterCurrentTitle = highestAwardedTitle(inviter.sponsor_titles_awarded);
                  try {
                    await sendSponsorLetter(inviter, member, inviterCurrentTitle);
                    await logEvent({
                      clan_id,
                      member_id: inviter.id,
                      event_type: 'sponsor_letter_sent',
                      payload: { converted_member_id: member.id, source: 'invitation_paid' },
                    });
                  } catch (letterErr) {
                    console.error('invitation sponsor letter send failed (non-fatal):', letterErr.message);
                  }

                  // Title evaluation + award — same pattern as the
                  // gift branch above and as submit/update-family-
                  // details. Stamp ALL newly earned slugs in one
                  // sweep (so the audit trail captures titles
                  // crossed in a single conversion, e.g. someone who
                  // jumps from 4 to 6 conversions in a day).
                  try {
                    const { count: sponsorCount, allNewlyEarned, highestNewlyEarned, previousTitleIrish } =
                      await evaluateSponsorTitles(inviter);
                    if (allNewlyEarned.length > 0) {
                      const stampedAwarded = { ...(inviter.sponsor_titles_awarded || {}) };
                      const nowIso = new Date().toISOString();
                      let letterSent = false;
                      if (highestNewlyEarned) {
                        try {
                          await sendTitleAwardLetter(inviter, highestNewlyEarned, previousTitleIrish, sponsorCount);
                          await logEvent({
                            clan_id,
                            member_id: inviter.id,
                            event_type: 'sponsor_title_awarded',
                            payload: {
                              title_slug: highestNewlyEarned.slug,
                              previous_title: previousTitleIrish,
                              count: sponsorCount,
                              source: 'invitation_paid',
                              invitee_member_id: member.id,
                            },
                          });
                          letterSent = true;
                        } catch (titleErr) {
                          console.error(`invitation title-award letter '${highestNewlyEarned.slug}' send failed (non-fatal):`, titleErr.message);
                        }
                      }
                      if (letterSent || !highestNewlyEarned) {
                        for (const t of allNewlyEarned) stampedAwarded[t.slug] = nowIso;
                        if (Object.keys(stampedAwarded).length > Object.keys(inviter.sponsor_titles_awarded || {}).length) {
                          await supa()
                            .from('members')
                            .update({ sponsor_titles_awarded: stampedAwarded })
                            .eq('id', inviter.id);
                        }
                      }
                    }
                  } catch (titleEvalErr) {
                    console.error('invitation title evaluation failed (non-fatal):', titleEvalErr.message);
                  }
                }
              }
            }
          } catch (invSponsorErr) {
            console.error('invitation sponsor chain failed (non-fatal):', invSponsorErr.message);
          }
          // ─────────────────────────────────────────────────────────

          // CERT GENERATION DELIBERATELY OMITTED HERE.
          // Per the publication model (migration 011), the cert is a
          // draft until the member explicitly publishes it via the
          // welcome flow / members area. No PDF is generated at payment
          // time. The welcome email (sendMemberWelcome) routes the buyer
          // to /members/login.html where they confirm details and click
          // 'Publish my certificate'.
          // If they never publish, the daily sweep auto-publishes at
          // day 30 with the Herald-captured name (auto-fixed for caps).
        }
      }
    } catch (e) {
      console.error('Supabase write in stripe-webhook (non-fatal):', e.message);
    }

    if (isGift) {
      // Each email send is wrapped in its own try/catch so a failure
      // in one doesn't take down the other. Previously the awaits ran
      // sequentially without isolation — if sendGiftRecipientWelcome
      // threw, sendGiftBuyerConfirmation never fired, and the buyer
      // got nothing while the function appeared to "succeed" from
      // Stripe's perspective. Logging is now explicit per-email so the
      // Netlify function logs show clearly which sends fired and
      // which didn't.
      if (giftContext && giftContext.recipientEmail) {
        try {
          await sendGiftRecipientWelcome(giftContext);
          console.log(`[gift] recipient welcome sent to ${giftContext.recipientEmail}`);
        } catch (e) {
          console.error(`[gift] recipient welcome FAILED for ${giftContext.recipientEmail}:`, e.message, e.stack);
        }
        try {
          await sendGiftBuyerConfirmation(giftContext, productName, amount, currency);
          console.log(`[gift] buyer confirmation sent to ${giftContext.buyerEmail}`);
        } catch (e) {
          console.error(`[gift] buyer confirmation FAILED for ${giftContext.buyerEmail}:`, e.message, e.stack);
        }
      } else {
        // Fallback: legacy buyer-only confirmation. This branch fires
        // when the gift-recipient member creation failed (giftContext
        // never got set), but the buyer still paid and deserves a
        // confirmation. preferredName has already been set to the
        // Herald-collected buyer name.
        try {
          await sendGiftConfirmations(session, customerEmail, preferredName, productName, amount, currency);
          console.log(`[gift fallback] buyer confirmation sent to ${customerEmail}`);
        } catch (e) {
          console.error(`[gift fallback] buyer confirmation FAILED for ${customerEmail}:`, e.message, e.stack);
        }
      }
    } else {
      // certDownloadUrl is now always null — email no longer uses it
      // anyway (Commit 2 of last session refactored to "Confirm cert
      // details →" routing). Param retained for signature compatibility.
      // preferredName is the Herald-resolved name (metadata > apps table
      // > customerName fallback) — see resolution block above.
      await sendMemberWelcome(customerEmail, preferredName, productName, amount, currency, null);
    }

    // Always notify the clan. preferredName is correctly resolved for
    // both gift (= buyer) and non-gift (= member) flows above.
    await notifyClan(customerEmail, preferredName, productName, amount, currency, isGift, session);
  }

  // ── ABANDONED CHECKOUT ──
  // Stripe fires this event when a Checkout Session expires without being paid
  // (default expiry: 24 hours). This is how we catch visitors who reached the
  // payment page but abandoned before completing.
  //
  // DEDUPE (added 2026-04-30): the daily-abandoned-sweep cron also
  // sends this same email if the application is still pending after
  // 24 hours. Without a shared gate, an abandoned applicant can
  // receive two reminders within hours of each other (one from this
  // event, one from the next cron tick). We share the same
  // applications.reminder_sent_at column the cron uses: check it
  // first, only send if NULL, then stamp it. The cron's query also
  // filters on reminder_sent_at IS NULL so it'll skip whichever
  // path didn't fire first.
  if (stripeEvent.type === 'checkout.session.expired') {
    const session = stripeEvent.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;

    // Only send if we got an email. If the visitor never reached the card-entry
    // step, Stripe won't have their email, and we can't recover them via this channel.
    if (customerEmail) {
      const customerName = session.customer_details?.name;
      let productName = session.metadata?.product_name;
      if (!productName) {
        try {
          const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1, expand: ['data.price.product'] });
          productName = items.data?.[0]?.description
                     || items.data?.[0]?.price?.product?.name
                     || 'Clan Membership';
        } catch (e) { productName = 'Clan Membership'; }
      }
      const tier = matchTier(productName);

      // Look up the application row by email. If found and a reminder
      // has already been sent, skip — we're crossing a path with the
      // cron that already handled it. If found and reminder is null,
      // stamp it AFTER successful send. If no application row exists
      // (shouldn't normally happen — applications are written before
      // checkout — but Stripe sessions can be created via gift flow
      // or future paths that bypass applications), still send (the
      // dedup target doesn't exist, so no duplicate is possible).
      let appRow = null;
      try {
        const cid = await clanId();
        const appLookup = await supa()
          .from('applications')
          .select('id, reminder_sent_at')
          .eq('clan_id', cid)
          .ilike('email', customerEmail)
          .order('submitted_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        appRow = appLookup.data;
      } catch (e) {
        console.warn('abandoned reminder: application lookup failed (non-fatal — sending anyway):', e.message);
      }

      if (appRow && appRow.reminder_sent_at) {
        console.log(`[abandoned] skipping — reminder already sent at ${appRow.reminder_sent_at} for ${customerEmail}`);
      } else {
        try {
          await sendAbandonedReminder(customerEmail, customerName, tier.name);
          if (appRow) {
            await supa()
              .from('applications')
              .update({ reminder_sent_at: new Date().toISOString() })
              .eq('id', appRow.id);
          }
          console.log(`[abandoned] reminder sent to ${customerEmail} via stripe session.expired`);
        } catch (e) {
          console.error('[abandoned] reminder send failed:', e.message);
        }
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function sendMemberWelcome(email, name, productName, amount, currency, certDownloadUrl) {
  const tier = matchTier(productName);
  const firstName = name ? name.split(' ')[0] : 'friend';

  const benefitsList = tier.benefits.map(b => `<li style="margin-bottom:8px;font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6">${b}</li>`).join('');

  // ── ONE-CLICK SIGN-IN URL ────────────────────────────────────────
  // Look up the member row to get its id, then issue a one-click
  // sign-in token. The returned URL goes in both CTA buttons below
  // (cert details + Members' Area). On click, the recipient is
  // signed in directly and lands in /members/. If anything fails
  // (member not found, token issuance fails), buildSignInUrl
  // falls back to the standard email-prefilled login form URL —
  // recipients always get a working button.
  let signInUrl;
  try {
    const cid = await clanId();
    const { data: memberRow } = await supa()
      .from('members')
      .select('id')
      .eq('clan_id', cid)
      .ilike('email', email)
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (memberRow) {
      signInUrl = await buildSignInUrl({
        memberId: memberRow.id,
        email,
        purpose: 'welcome_self',
      });
    } else {
      // No member row found — race condition (webhook still
      // processing) or unusual state. Fallback URL.
      signInUrl = `https://www.ocomain.org/members/login.html?email=${encodeURIComponent(email)}`;
    }
  } catch (e) {
    console.error('[sendMemberWelcome] signin URL build failed (using fallback):', e.message);
    signInUrl = `https://www.ocomain.org/members/login.html?email=${encodeURIComponent(email)}`;
  }

  // Certificate block — prominent CTA if cert was successfully generated.
  // The cert block now ALWAYS appears (whether or not certDownloadUrl was
  // generated, the buyer has a member row to claim). Direct cert download
  // removed in favour of routing to the welcome flow / members area where
  // the buyer first confirms their name + ancestor + family details before
  // their cert is sealed. This is correct heraldic practice: the cert is a
  // one-time instrument and the buyer should personalise it before sealing.
  const certBlock = `
    <!-- Certificate claim CTA — routes to members area to confirm details first -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:28px 26px;margin:0 0 24px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Certificate of Membership</p>
      <p style="font-family:'Georgia',serif;font-size:22px;font-weight:400;color:#0C1A0C;margin:0 0 6px;line-height:1.2">Awaiting your confirmation</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0 0 22px;line-height:1.6">Your certificate is a one-time heraldic instrument. Confirm a few details — how your name should appear, an optional ancestor dedication — and it will be sealed in your name.</p>
      <a href="${signInUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Confirm certificate details →</a>
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">One click signs you in. You have 30 days to refine your certificate details before it is sealed.</p>
    </div>
  `;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:40px 40px 32px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="96" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:0.22em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:96px">Ó COMÁIN</p>
    <h1 style="font-family:'Georgia',serif;font-size:36px;font-weight:400;color:#D4B87A;margin:0;line-height:1.1">Céad míle fáilte</h1>
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#D4B483;margin:8px 0 0">A hundred thousand welcomes</p>
  </div>

  <!-- Body -->
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;line-height:1.75;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">On behalf of Fergus Kinfauns, The Commane — Chief of Ó Comáin — and the assembled derbhfine of Clan Ó Comáin, it is my honour to welcome you as a <strong>${tier.name}</strong> of one of Ireland's oldest and most thoroughly documented Gaelic lineages.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 32px">Your name is now entered in the Register of Clan Ó Comáin Members, held at Newhall House, County Clare, Ireland.</p>

    ${certBlock}

    <!-- Divider -->
    <div style="border-top:1px solid rgba(184,151,90,.3);margin:0 0 28px"></div>

    <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">Your membership includes</p>
    <ul style="margin:0 0 32px;padding-left:20px">
      ${benefitsList}
    </ul>

    <div style="border-top:1px solid rgba(184,151,90,.3);margin:0 0 28px"></div>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">The Chief will write to you personally in the coming weeks. In the meantime, all correspondence with the clan should be directed to this office at <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — it will be brought to the Chief's attention as appropriate.</p>

    <!-- Members' Area sign-in CTA — secondary to the cert action above.
         Members will reference this email later for ongoing access (the
         cert action becomes irrelevant once published), so a clear
         button here makes future sign-ins obvious. Outline style keeps
         the cert action above as the primary post-purchase CTA. -->
    <div style="text-align:center;padding:22px 0;border-top:1px solid rgba(184,151,90,.2);border-bottom:1px solid rgba(184,151,90,.2);margin:0 0 28px">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Your Members' Area</p>
      <p style="font-family:'Georgia',serif;font-size:14.5px;font-style:italic;color:#6C5A4A;line-height:1.6;margin:0 0 16px">The home of your membership — view details, download your certificate, and access members-only content any time.</p>
      <a href="${signInUrl}" style="display:inline-block;background:transparent;color:#B8975A;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border:1px solid #B8975A;border-radius:1px">Sign in to Members' Area →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 28px">Go raibh míle maith agat — a thousand thanks for joining the revival of Ó Comáin.</p>

    <!-- Signatory block with round portrait -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:90px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="76" height="76" alt="Linda Commane Cryan" style="display:block;width:76px;height:76px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:17px;color:#0C1A0C;line-height:1.3;margin:0 0 5px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:14px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:13px;color:#6C5A4A;line-height:1.5;margin:7px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 32px;border-radius:1px">Visit the clan website</a>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#0C1A0C;padding:24px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: email,
    subject: `Welcome to Clan O'Comain (membership area login)`,
    html,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Gift recipient welcome — this is the email the RECIPIENT (new member) gets
// when a gift membership has been paid. Structurally similar to the regular
// member welcome but opens with a "gift from [buyer]" panel and optionally
// quotes the giver's personal message. Carries the cert download link and
// the members' area sign-in CTA (both for the recipient, not the buyer).
// ──────────────────────────────────────────────────────────────────────────
async function sendGiftRecipientWelcome(ctx) {
  const { recipientEmail, recipientName, buyerName, buyerEmail, personalMsg, tierLabel, certDownloadUrl, claimToken, isDeferred } = ctx;
  const tier = matchTier(tierLabel) || { name: tierLabel || 'Clan Membership', benefits: [] };
  const firstName = recipientName ? recipientName.split(' ')[0] : 'friend';
  const giverName = buyerName || buyerEmail || 'a friend';

  // ── ONE-CLICK SIGN-IN URL (existing-recipient branch only) ──────
  // For the !claimToken branch below (where the recipient is
  // already a clan member and this gift is a tier upgrade), we
  // need a sign-in URL that takes them straight into the members
  // area. The claimToken branch uses /api/claim-and-enter-paid
  // which already does one-click. This is for the OTHER branch.
  // Best-effort: if member lookup or token issuance fails,
  // buildSignInUrl returns the standard login.html?email URL.
  let recipientSignInUrl;
  if (!claimToken) {
    try {
      const cid = await clanId();
      const { data: memberRow } = await supa()
        .from('members')
        .select('id')
        .eq('clan_id', cid)
        .ilike('email', recipientEmail)
        .order('joined_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (memberRow) {
        recipientSignInUrl = await buildSignInUrl({
          memberId: memberRow.id,
          email: recipientEmail,
          purpose: 'welcome_gift_existing',
        });
      } else {
        recipientSignInUrl = `https://www.ocomain.org/members/login.html?email=${encodeURIComponent(recipientEmail)}`;
      }
    } catch (e) {
      console.error('[sendGiftRecipientWelcome] signin URL build failed (using fallback):', e.message);
      recipientSignInUrl = `https://www.ocomain.org/members/login.html?email=${encodeURIComponent(recipientEmail)}`;
    }
  }

  // Personal message block — only shows if the giver wrote one.
  const msgBlock = personalMsg ? `
    <!-- Personal message from the giver -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">A personal message from ${escapeHtml(giverName)}</p>
      <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0;white-space:pre-wrap">${escapeHtml(personalMsg)}</p>
    </div>
  ` : '';

  // Acceptance/cert CTA — Phase 2 (2026-04-30) bifurcation:
  //
  //   1. If claimToken is set (new recipient via Phase 2 deferred-
  //      acceptance flow): the recipient must press 'Claim my place'
  //      on /gift-welcome.html?token=X to materialise their member
  //      row. Until then no membership exists in their name, no
  //      certificate is generated, and they don't appear on the
  //      public Register. The CTA is the SINGLE action they need.
  //
  //   2. Otherwise (existing-recipient tier upgrade, or legacy
  //      pre-Phase-2 path): they are already a member. The CTA
  //      routes them to the cert publication flow as before, with
  //      the 30-day auto-publication window.
  const certBlock = claimToken
    ? `
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:28px 26px;margin:0 0 24px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Place in the Clan</p>
      <p style="font-family:'Georgia',serif;font-size:22px;font-weight:400;color:#0C1A0C;margin:0 0 6px;line-height:1.2">Awaiting your acceptance</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0 0 22px;line-height:1.6">A gift, freely given. Press the seal below to take up your place — your name will be entered into the clan's keeping at Newhall, and a sign-in link will be sent to your inbox.</p>
      <a href="https://www.ocomain.org/api/claim-and-enter-paid?token=${encodeURIComponent(claimToken)}" style="display:inline-block;background:#6B1F1F;color:#F7F4ED;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px;border:1px solid #4A1010">Claim my place →</a>
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">A gift is held open for one year from the day it is offered. Until then, no membership exists in your name — the choice to take your place is yours.</p>
    </div>
  `
    : `
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:28px 26px;margin:0 0 24px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Certificate of Membership</p>
      <p style="font-family:'Georgia',serif;font-size:22px;font-weight:400;color:#0C1A0C;margin:0 0 6px;line-height:1.2">Awaiting your confirmation</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0 0 22px;line-height:1.6">Your certificate is a one-time heraldic instrument. Confirm a few details — how your name should appear, an optional ancestor dedication — and it will be sealed in your name.</p>
      <a href="${recipientSignInUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Confirm certificate details →</a>
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">One click signs you in. You have 30 days to refine your certificate details before it is sealed.</p>
    </div>
  `;

  const benefitsList = (tier.benefits || []).map(b => `<li style="margin-bottom:8px;font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6">${b}</li>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:40px 40px 32px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="96" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:0.22em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:96px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">A gift to you</p>
    <h1 style="font-family:'Georgia',serif;font-size:36px;font-weight:400;color:#D4B87A;margin:0;line-height:1.1">Céad míle fáilte</h1>
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#D4B483;margin:8px 0 0">A hundred thousand welcomes</p>
  </div>

  <!-- Body -->
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;line-height:1.75;margin:0 0 20px">Dear ${escapeHtml(firstName)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px"><strong>${escapeHtml(giverName)}</strong> has gifted you a <strong>${escapeHtml(tier.name)}</strong> membership of <strong>Irish Clan Ó Comáin</strong> — an ancient Gaelic royal house, officially recognised by Clans of Ireland under the patronage of the President of Ireland, and recently restored after eight centuries of silence.</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">Your name is now entered in the <strong>Register of Clan Members</strong>, kept at Newhall House, County Clare. The Chief — <strong>Fergus Kinfauns, The Commane</strong> — will write to you personally in the weeks that follow.</p>

    ${msgBlock}

    ${certBlock}

    <!-- Divider -->
    <div style="border-top:1px solid rgba(184,151,90,.3);margin:0 0 28px"></div>

    <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">Your membership includes</p>
    <ul style="margin:0 0 32px;padding-left:20px">
      ${benefitsList}
    </ul>

    <div style="border-top:1px solid rgba(184,151,90,.3);margin:0 0 28px"></div>

    <!-- Members' Area sign-in CTA — same pattern as member welcome.
         Recipient will reference this email later for ongoing access
         and to find the giver's personal gift message; clear button
         makes future sign-ins obvious. Outline style keeps the cert
         action above as the primary post-purchase CTA. -->
    <div style="text-align:center;padding:22px 0;border-top:1px solid rgba(184,151,90,.2);border-bottom:1px solid rgba(184,151,90,.2);margin:0 0 28px">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Your Members' Area</p>
      <p style="font-family:'Georgia',serif;font-size:14.5px;font-style:italic;color:#6C5A4A;line-height:1.6;margin:0 0 16px">The home of your membership — sign in any time to view details, find ${escapeHtml(giverName)}'s gift message, download your certificate, and access members-only content.</p>
      <a href="${claimToken ? `https://www.ocomain.org/api/claim-and-enter-paid?token=${encodeURIComponent(claimToken)}` : recipientSignInUrl}" style="display:inline-block;background:transparent;color:#B8975A;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border:1px solid #B8975A;border-radius:1px">Sign in to Members' Area →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Any correspondence with the clan should be sent to this office at <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a>, and will be brought to the Chief's attention.</p>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 28px">Go raibh míle maith agat — welcome to the clan.</p>

    <!-- Signatory block -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:90px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="76" height="76" alt="Linda Commane Cryan" style="display:block;width:76px;height:76px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:17px;color:#0C1A0C;line-height:1.3;margin:0 0 5px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:14px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:13px;color:#6C5A4A;line-height:1.5;margin:7px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>

    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 32px;border-radius:1px">Visit the clan website</a>
    </div>
  </div>

  <div style="background:#0C1A0C;padding:24px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: recipientEmail,
    subject: `A gift to you from ${giverName} — welcome to Clan Ó Comáin`,
    html,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Gift BUYER confirmation — the payer gets this after paying. NO certificate,
// NO members area link (the buyer is not the member). Just acknowledgement
// that the gift has been sent, and an invitation to gift another.
// ──────────────────────────────────────────────────────────────────────────
async function sendGiftBuyerConfirmation(ctx, productName, amount, currency) {
  const { recipientEmail, recipientName, buyerEmail, buyerName, tierLabel, isDeferred } = ctx;
  const firstName = buyerName ? buyerName.split(' ')[0] : 'friend';
  const recipientDisplay = recipientName || recipientEmail;
  const recipientFirst = (recipientDisplay.split(' ')[0] || 'your recipient');
  const tier = matchTier(tierLabel) || { name: tierLabel || 'Clan Membership' };

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0">Your gift is on its way</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(firstName)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your gift of a <strong>${escapeHtml(tier.name)}</strong> membership of Clan Ó Comáin has been received and confirmed. ${isDeferred
      ? `A welcome email has just been sent to <strong>${escapeHtml(recipientDisplay)}</strong> at ${escapeHtml(recipientEmail)} — inviting them to take up the place you've offered them.`
      : `A welcome email has just been sent to <strong>${escapeHtml(recipientDisplay)}</strong> at ${escapeHtml(recipientEmail)} — inviting them to confirm their certificate details and take their place in the Register.`}</p>

    ${isDeferred ? `
    <!-- "What happens next" — Phase 2 deferred-acceptance flow.
         The recipient must press 'Claim my place' on the welcome
         page; until then no membership exists in their name. The
         buyer's sponsorship credit (Cara/Onóir/Ardchara) is
         awarded immediately on payment regardless. -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 28px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">What happens next</p>
      <ol style="margin:0;padding-left:20px">
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px"><strong>${escapeHtml(recipientDisplay)}</strong> receives a welcome email with your personal message and a single button — <em>Claim my place</em>.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">When they press it, their place in the clan is confirmed. They will be invited to confirm their certificate details — their name, an optional ancestor dedication — and the certificate is sealed in their name and entered in the Register at Newhall House.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">We send you a copy of the published certificate as a keepsake of the gift you've given.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:0">The Chief — Fergus Commane — writes to them personally in the weeks that follow.</li>
      </ol>
    </div>

    <!-- Phase 2 quiet word — sets correct expectations:
         (1) the gift is held open for one year, not 30 days
         (2) acceptance is the recipient's act, not auto -->
    <div style="background:rgba(12,26,12,.04);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:18px 22px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 8px">A quiet word</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0">If you can, tell ${escapeHtml(recipientFirst)} the email is on its way — sometimes our messages land in a quiet folder. Once they accept, they will have <strong>30 days</strong> to refine their certificate details before it is sealed and entered in the Register in their name as it stands.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We'll write to you again when ${escapeHtml(recipientFirst)} accepts and publishes their certificate, with their published copy as a keepsake.</p>
    ` : `
    <!-- Existing-recipient (tier upgrade) path — pre-Phase-2 wording.
         The recipient is already a clan member; this gift updates
         their tier. No 'claim my place' step. They have 30 days
         to refine their cert if newly issued, or it's already
         sealed if this is a tier upgrade for an existing member. -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 28px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">What happens next</p>
      <ol style="margin:0;padding-left:20px">
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px"><strong>${escapeHtml(recipientDisplay)}</strong> receives a welcome email from this office with your personal message and a single-click link to their Members' Area.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">There they confirm their certificate details — their name, an optional ancestor dedication — and publish it. The certificate is sealed, in their name, entered in the Register at Newhall House.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">We send you a copy of the published certificate as a keepsake of the gift you've given.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:0">The Chief — Fergus Commane — writes to them personally in the weeks that follow.</li>
      </ol>
    </div>

    <div style="background:rgba(12,26,12,.04);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:18px 22px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 8px">A quiet word</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0">If you can, tell ${escapeHtml(recipientFirst)} the email is on its way — sometimes our messages land in a quiet folder.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We'll write to you again when ${escapeHtml(recipientFirst)} publishes their certificate, with their published copy as a keepsake.</p>
    `}
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">If you have any questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and I will respond on behalf of the Chief.</p>

    <!-- Another gift CTA -->
    <div style="background:rgba(184,151,90,.08);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:22px 24px;margin:0 0 28px;border-radius:0 2px 2px 0;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Another in the family?</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 16px">A gift of heritage has a way of being given more than once. If there's someone else in the family who would love this, you can send another.</p>
      <a href="https://www.ocomain.org/gift.html" style="display:inline-block;background:transparent;color:#B8975A;border:1px solid #B8975A;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border-radius:1px">Send another gift →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 24px">Go raibh míle maith agat.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: buyerEmail,
    subject: `Your gift to ${recipientDisplay} — Clan Ó Comáin`,
    html,
  });
}

// Simple HTML-escape for user-provided strings being dropped into email HTML.
// Emails can't run JS so this is strictly about preventing broken markup and
// cross-tenant injection via a personal message containing < > & etc.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendGiftConfirmations(session, buyerEmail, buyerName, productName, amount, currency) {
  const tier = TIER_NAMES[productName] || { name: productName, benefits: [] };
  // Notify buyer their gift is being arranged
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC">
<div style="max-width:580px;margin:0 auto">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0">Gift confirmed</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${buyerName ? buyerName.split(' ')[0] : 'friend'},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">On behalf of Fergus Kinfauns, The Commane — Chief of Ó Comáin — your gift of a <strong>${tier.name}</strong> membership has been received and confirmed. This office will be in touch with your recipient shortly, and the Chief will write to them personally in the weeks that follow.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">If you have any questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and I will respond on behalf of the Chief.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 24px">Go raibh míle maith agat.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body></html>`;

  await sendEmail({ to: buyerEmail, subject: 'Your gift membership of Clan Ó Comáin — confirmed', html });
}

async function sendAbandonedReminder(email, name, tierName) {
  const firstName = name ? name.split(' ')[0] : 'friend';
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:80px">Ó COMÁIN</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your application to Clan Ó Comáin was received — but your membership was not completed.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 14px">A place is still held for you in the Register of Clan Members${tierName ? ` as <strong>${tierName}</strong>` : ''}. When you are ready, the door remains open.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 32px;padding:14px 18px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">This is the <strong>first year of the revival</strong>. Those who join now are inscribed as <strong>Founding Members</strong> of Clan Ó Comáin — a designation that carries no price in any later year. From the second year onward, members join as members; this distinction will not be offered again.</p>
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Complete your membership</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If something went wrong with your payment or you have questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — we will be happy to help.</p>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Caithfidh an stair a bheith i réim</p>
  </div>
</div>
</body></html>`;
  await sendEmail({ to: email, subject: 'Your place in Clan Ó Comáin is still open', html });
}

async function notifyClan(email, name, product, amount, currency, isGift, session) {
  const html = `<div style="font-family:sans-serif;max-width:480px">
    <h2 style="color:#0C1A0C">New ${isGift ? 'GIFT ' : ''}membership — Clan Ó Comáin</h2>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:8px;border:1px solid #ddd;color:#666">Name</td><td style="padding:8px;border:1px solid #ddd"><strong>${name || 'Not provided'}</strong></td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;color:#666">Email</td><td style="padding:8px;border:1px solid #ddd">${email}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;color:#666">Tier</td><td style="padding:8px;border:1px solid #ddd">${product}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;color:#666">Amount</td><td style="padding:8px;border:1px solid #ddd"><strong>${currency} ${amount}</strong></td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;color:#666">Gift?</td><td style="padding:8px;border:1px solid #ddd">${isGift ? 'YES — check gift form data' : 'No'}</td></tr>
    </table>
  </div>`;

  await sendEmail({ to: CLAN_EMAIL, subject: `New member: ${name} — ${product} (${currency}${amount})`, html });
}
