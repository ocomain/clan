// netlify/functions/stripe-webhook.js
// Triggered by Stripe when a payment completes
// Sends welcome email via Resend, records member in Supabase.

const { supa, clanId, normaliseTier, logEvent } = require('./lib/supabase');
const { ensureCertificate, signCertUrl, ensureAuthUser, sanitizeFilename } = require('./lib/cert-service');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
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
      const tierInfo = normaliseTier(productName);
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

          let member, upsertErr;
          if (existingRecipient) {
            // Gift upgrade on an existing member — preserve original join date.
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
            // Brand new gift recipient — INSERT.
            const insertRes = await supa()
              .from('members')
              .insert({
                clan_id,
                email:                  recipientEmail,
                name:                   recipientName,
                tier:                   tierInfo.tier,
                tier_label:             tierInfo.label,
                tier_family:            tierInfo.tier_family,
                // Stripe customer/subscription belong to the BUYER, not the
                // member — keep them null on the member row so the recipient
                // doesn't get Stripe renewal receipts. Buyer's subscription
                // is tracked on the gift row.
                stripe_customer_id:     null,
                stripe_subscription_id: null,
                status:                 'active',
                joined_at:              now.toISOString(),
                renewed_at:             now.toISOString(),
                expires_at:             expiresAt ? expiresAt.toISOString() : null,
                metadata:               { gift: true, buyer_name: buyerName, buyer_email: buyerEmail },
              })
              .select('id, email, name, tier, tier_label, tier_family, joined_at')
              .single();
            member = insertRes.data;
            upsertErr = insertRes.error;
          }

          if (upsertErr) {
            console.error('gift member insert/update failed:', upsertErr.message);
          } else {
            // 2. Update/insert the gift row, linking it to the created member.
            if (giftId) {
              await supa()
                .from('gifts')
                .update({
                  status: 'paid',
                  stripe_session_id: session.id,
                  member_id: member.id,
                  sent_to_recipient_at: now.toISOString(),
                })
                .eq('id', giftId);
            } else {
              // Metadata had recipient info but no gift_id — insert a fresh gift row.
              await supa().from('gifts').insert({
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
                member_id: member.id,
                sent_to_recipient_at: now.toISOString(),
                status: 'paid',
              });
            }
            await logEvent({ clan_id, member_id: member.id, event_type: 'gift_paid', payload: { tier: tierInfo.tier, amount, recipient_email: recipientEmail, buyer_email: buyerEmail } });

            // 3. Pre-create auth user for the recipient so first login is magic-link.
            await ensureAuthUser(recipientEmail, recipientName);

            // 4. Generate cert for the RECIPIENT (not the buyer).
            try {
              const { storagePath } = await ensureCertificate(member, clan_id);
              certDownloadUrl = await signCertUrl(storagePath, {
                ttlSeconds: 60 * 60 * 24 * 7,
                downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(member.name || recipientEmail)}.pdf`,
              });
            } catch (certErr) {
              console.error('gift cert generation (non-fatal):', certErr.message);
            }

            giftContext = {
              recipientEmail, recipientName,
              buyerEmail, buyerName,
              personalMsg,
              tierLabel: tierInfo.label,
              certDownloadUrl,
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

        const { data: existing } = await supa()
          .from('members')
          .select('id, joined_at, tier, tier_label, stripe_subscription_id')
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
            name:                   customerName || undefined,
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
              name:                   customerName,
              tier:                   tierInfo.tier,
              tier_label:             tierInfo.label,
              tier_family:            tierInfo.tier_family,
              stripe_customer_id:     session.customer,
              stripe_subscription_id: session.subscription || null,
              status:                 'active',
              joined_at:              now.toISOString(),
              renewed_at:             now.toISOString(),
              expires_at:             expiresAt ? expiresAt.toISOString() : null,
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

          // Generate + store cert immediately so it's ready when the welcome
          // email arrives. Catch separately — if cert generation fails, the
          // email still sends (without the download link), and the cert can
          // be generated on-demand via the dashboard.
          try {
            const { storagePath } = await ensureCertificate(member, clan_id);
            certDownloadUrl = await signCertUrl(storagePath, {
              ttlSeconds: 60 * 60 * 24 * 7, // 7 days — gives members time to click from email
              downloadAs: `Clan-O-Comain-Certificate-${sanitizeFilename(member.name || customerEmail)}.pdf`,
            });
          } catch (certErr) {
            console.error('cert generation in webhook (non-fatal):', certErr.message);
          }
        }
      }
    } catch (e) {
      console.error('Supabase write in stripe-webhook (non-fatal):', e.message);
    }

    if (isGift) {
      if (giftContext && giftContext.recipientEmail) {
        // Send welcome to the RECIPIENT (the actual member), with cert + gift context
        await sendGiftRecipientWelcome(giftContext);
        // Send confirmation to the BUYER (the payer)
        await sendGiftBuyerConfirmation(giftContext, productName, amount, currency);
      } else {
        // Fallback: legacy buyer-only confirmation
        await sendGiftConfirmations(session, customerEmail, customerName, productName, amount, currency);
      }
    } else {
      await sendMemberWelcome(customerEmail, customerName, productName, amount, currency, certDownloadUrl);
    }

    // Always notify the clan
    await notifyClan(customerEmail, customerName, productName, amount, currency, isGift, session);
  }

  // ── ABANDONED CHECKOUT ──
  // Stripe fires this event when a Checkout Session expires without being paid
  // (default expiry: 24 hours). This is how we catch visitors who reached the
  // payment page but abandoned before completing.
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
      await sendAbandonedReminder(customerEmail, customerName, tier.name);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function sendMemberWelcome(email, name, productName, amount, currency, certDownloadUrl) {
  const tier = matchTier(productName);
  const firstName = name ? name.split(' ')[0] : 'friend';

  const benefitsList = tier.benefits.map(b => `<li style="margin-bottom:8px;font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6">${b}</li>`).join('');

  // Certificate block — prominent CTA if cert was successfully generated.
  // If generation failed, we silently omit this block and direct them to the
  // Members' Area, where they can generate on-demand.
  const certBlock = certDownloadUrl ? `
    <!-- Certificate download CTA — emotional payoff -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:28px 26px;margin:0 0 24px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Certificate of Membership</p>
      <p style="font-family:'Georgia',serif;font-size:22px;font-weight:400;color:#0C1A0C;margin:0 0 6px;line-height:1.2">Ready to download</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0 0 22px;line-height:1.6">Bearing the Chief's signature, issued in your name, entered in the Register at Newhall House.</p>
      <a href="${certDownloadUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Download your certificate (PDF) →</a>
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">This link is valid for seven days. Your certificate is also always available from your Members' Area, below.</p>
    </div>
  ` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:40px 40px 32px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="96" alt="Ó Comáin" style="display:block;margin:0 auto 14px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">Ó Comáin</p>
    <h1 style="font-family:'Georgia',serif;font-size:36px;font-weight:400;color:#D4B87A;margin:0;line-height:1.1">Céad míle fáilte</h1>
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:rgba(184,151,90,.7);margin:8px 0 0">A hundred thousand welcomes</p>
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

    <!-- Members area CTA -->
    <div style="background:rgba(184,151,90,.08);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:22px 24px;margin:0 0 24px;border-radius:0 2px 2px 0;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Your Members' Area</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 18px">Sign in any time to view your membership details, re-download your certificate, and access members-only content.</p>
      <a href="https://www.ocomain.org/members/login.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Sign in to your Members' Area →</a>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:12px 0 0">A one-time access link will be sent to this email address. No password required.</p>
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
          <p style="font-family:'Georgia',serif;font-size:14px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, Co. Clare</p>
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
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:rgba(184,151,90,.6);margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:rgba(184,151,90,.4);margin:0;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: email,
    subject: `Spirit, mind, body, bloodline — your place in Clan Ó Comáin`,
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
  const { recipientEmail, recipientName, buyerName, buyerEmail, personalMsg, tierLabel, certDownloadUrl } = ctx;
  const tier = matchTier(tierLabel) || { name: tierLabel || 'Clan Membership', benefits: [] };
  const firstName = recipientName ? recipientName.split(' ')[0] : 'friend';
  const giverName = buyerName || buyerEmail || 'a friend';

  // Personal message block — only shows if the giver wrote one.
  const msgBlock = personalMsg ? `
    <!-- Personal message from the giver -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">A personal message from ${escapeHtml(giverName)}</p>
      <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0;white-space:pre-wrap">${escapeHtml(personalMsg)}</p>
    </div>
  ` : '';

  const certBlock = certDownloadUrl ? `
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:28px 26px;margin:0 0 24px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Certificate of Membership</p>
      <p style="font-family:'Georgia',serif;font-size:22px;font-weight:400;color:#0C1A0C;margin:0 0 6px;line-height:1.2">Ready to download</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0 0 22px;line-height:1.6">Bearing the Chief's signature, issued in your name, entered in the Register at Newhall House.</p>
      <a href="${certDownloadUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Download your certificate (PDF) →</a>
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">This link is valid for seven days. Your certificate is also always available from your Members' Area, below.</p>
    </div>
  ` : '';

  const benefitsList = (tier.benefits || []).map(b => `<li style="margin-bottom:8px;font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6">${b}</li>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:40px 40px 32px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="96" alt="Ó Comáin" style="display:block;margin:0 auto 14px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">A gift to you · Clan Ó Comáin</p>
    <h1 style="font-family:'Georgia',serif;font-size:36px;font-weight:400;color:#D4B87A;margin:0;line-height:1.1">Céad míle fáilte</h1>
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:rgba(184,151,90,.7);margin:8px 0 0">A hundred thousand welcomes</p>
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

    <!-- Members area CTA — for the recipient, not the giver -->
    <div style="background:rgba(184,151,90,.08);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:22px 24px;margin:0 0 24px;border-radius:0 2px 2px 0;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Your Members' Area</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 18px">Sign in to view your membership, re-download your certificate, read the clan pedigree, and find ${escapeHtml(giverName)}'s gift message — always available there.</p>
      <a href="https://www.ocomain.org/members/login.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Sign in to your Members' Area →</a>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:12px 0 0">A one-time access link will be sent to this email (${escapeHtml(recipientEmail)}). No password required.</p>
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
          <p style="font-family:'Georgia',serif;font-size:14px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, Co. Clare</p>
        </td>
      </tr>
    </table>

    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 32px;border-radius:1px">Visit the clan website</a>
    </div>
  </div>

  <div style="background:#0C1A0C;padding:24px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:rgba(184,151,90,.6);margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:rgba(184,151,90,.4);margin:0;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
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
  const { recipientEmail, recipientName, buyerEmail, buyerName, tierLabel } = ctx;
  const firstName = buyerName ? buyerName.split(' ')[0] : 'friend';
  const recipientDisplay = recipientName || recipientEmail;
  const tier = matchTier(tierLabel) || { name: tierLabel || 'Clan Membership' };

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Ó Comáin</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0">Your gift is on its way</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(firstName)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your gift of a <strong>${escapeHtml(tier.name)}</strong> membership of Clan Ó Comáin has been received and confirmed. A welcome email has just been sent to <strong>${escapeHtml(recipientDisplay)}</strong> at ${escapeHtml(recipientEmail)}, carrying their certificate, their place in the Register, and your personal message.</p>

    <!-- "What happens next" box — sets the buyer's expectations clearly -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 28px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">What happens next</p>
      <ol style="margin:0;padding-left:20px">
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px"><strong>${escapeHtml(recipientDisplay)}</strong> receives a welcome email from this office with their certificate, their members' area access, and your personal message.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">We'd suggest giving them a nudge to check their inbox — our email may land in a quiet folder.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:0">The Chief — Fergus Kinfauns, The Commane — will write to them personally in the weeks that follow.</li>
      </ol>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We'll let you know when ${escapeHtml(recipientDisplay.split(' ')[0] || 'your recipient')} activates their membership and is welcomed into the clan.</p>

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
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, Co. Clare</p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:rgba(184,151,90,.6);margin:0">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
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
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Ó Comáin</p>
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
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, Co. Clare</p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:rgba(184,151,90,.6);margin:0">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
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
    <img src="https://www.ocomain.org/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0">Ó Comáin</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your application to Clan Ó Comáin was received — but your membership was not completed.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 32px">A place is still held for you in the Register of Clan Members${tierName ? ` as <strong>${tierName}</strong>` : ''}. When you are ready, the door remains open.</p>
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Complete your membership</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If something went wrong with your payment or you have questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — we will be happy to help.</p>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:rgba(184,151,90,.6);margin:0">Caithfidh an stair a bheith i réim</p>
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

async function sendEmail({ to, subject, html }) {
  // Sender convention: 'Clan Ó Comáin <clan@ocomain.org>' while the Private
  // Secretary position is vacant. When Linda Cryan (or the appointed officer)
  // takes up the role, change the display name to e.g.
  // 'Linda Cryan, Private Secretary to The Commane <clan@ocomain.org>'
  // — all member-facing email will then carry the officer's name.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'Clan Ó Comáin <clan@ocomain.org>', to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
  }
}
