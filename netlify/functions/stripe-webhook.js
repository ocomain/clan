// netlify/functions/stripe-webhook.js
// Triggered by Stripe when a payment completes
// Sends welcome email via Resend, records member in Supabase.

const { supa, clanId, normaliseTier, logEvent } = require('./lib/supabase');

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
    try {
      const clan_id = await clanId();
      const tierInfo = normaliseTier(productName);
      const isLife = tierInfo.tier.startsWith('life');

      if (isGift) {
        // Flip the matching gift record (if we have one) to paid.
        const { data: existingGift } = await supa()
          .from('gifts')
          .select('id')
          .eq('clan_id', clan_id)
          .eq('buyer_email', (customerEmail || '').toLowerCase().trim())
          .in('status', ['pending_payment'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingGift) {
          await supa().from('gifts').update({ status: 'paid', stripe_session_id: session.id }).eq('id', existingGift.id);
        } else {
          // Gift came through without a pre-form submission — record it anyway.
          await supa().from('gifts').insert({
            clan_id,
            buyer_email: (customerEmail || '').toLowerCase().trim(),
            buyer_name: customerName,
            tier: tierInfo.tier,
            tier_label: tierInfo.label,
            tier_family: tierInfo.tier_family,
            gift_mode: 'onetime',
            stripe_session_id: session.id,
            status: 'paid',
          });
        }
        await logEvent({ clan_id, event_type: 'gift_paid', payload: { email: customerEmail, tier: tierInfo.tier, amount } });
      } else {
        // Regular self-purchase: upsert member (unique on clan_id + lower(email)).
        const now = new Date();
        const expiresAt = isLife ? null : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        const { data: member, error: upsertErr } = await supa()
          .from('members')
          .upsert({
            clan_id,
            email:                  (customerEmail || '').toLowerCase().trim(),
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
          }, { onConflict: 'clan_id,email' })
          .select('id')
          .single();
        if (upsertErr) {
          console.error('member upsert failed:', upsertErr.message);
        } else {
          await logEvent({ clan_id, member_id: member.id, event_type: 'member_paid', payload: { tier: tierInfo.tier, amount, session_id: session.id } });

          // Close any matching pending application for this email.
          await supa()
            .from('applications')
            .update({ status: 'paid', member_id: member.id, stripe_session_id: session.id })
            .eq('clan_id', clan_id)
            .eq('email', (customerEmail || '').toLowerCase().trim())
            .eq('status', 'pending');
        }
      }
    } catch (e) {
      console.error('Supabase write in stripe-webhook (non-fatal):', e.message);
    }

    if (isGift) {
      await sendGiftConfirmations(session, customerEmail, customerName, productName, amount, currency);
    } else {
      await sendMemberWelcome(customerEmail, customerName, productName, amount, currency);
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

async function sendMemberWelcome(email, name, productName, amount, currency) {
  const tier = matchTier(productName);
  const firstName = name ? name.split(' ')[0] : 'friend';

  const benefitsList = tier.benefits.map(b => `<li style="margin-bottom:8px;font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6">${b}</li>`).join('');

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
      <p style="font-family:'Georgia',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Your Members' Area · now open</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 18px">Sign in to view your membership details, tier, and renewal date. Your digital certificate will be available there shortly.</p>
      <a href="https://www.ocomain.org/members/login.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border-radius:1px">Sign in to your Members' Area →</a>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:12px 0 0">A one-time access link will be sent to this email address. No password required.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 32px">Go raibh míle maith agat — a thousand thanks for joining the revival of Ó Comáin.</p>

    <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.6;margin:0 0 4px">— <strong>The Office of the Private Secretary to The Commane</strong></p>
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;line-height:1.6;margin:0 0 32px">Rúnaí Príobháideach an Taoisigh · Newhall House, County Clare</p>

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
    subject: `Céad míle fáilte — Welcome to Clan Ó Comáin`,
    html,
  });
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
    <p style="font-family:'Georgia',serif;font-size:14px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">— <strong>The Office of the Private Secretary to The Commane</strong></p>
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, County Clare</p>
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
