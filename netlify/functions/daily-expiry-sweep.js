// netlify/functions/daily-expiry-sweep.js
//
// Runs once per day on a schedule (see netlify.toml). Finds gift-recipient
// members whose one-time gift membership is about to expire, and sends them
// a warm "your year with the clan is ending" email with a CTA to continue
// as a self-paying member.
//
// TARGET POPULATION:
// - Members whose record was created via the gift flow (detected by the
//   presence of a paid gifts row linking to member_id)
// - expires_at is between 28 and 32 days from today (5-day window rather
//   than exactly 30 so we don't miss anyone if a day's sweep fails or the
//   schedule drifts a few hours)
// - gift_renewal_reminded_at is NULL (not already reminded)
// - status = 'active'
//
// We deliberately EXCLUDE:
// - Life members (expires_at is NULL, so the partial index doesn't surface
//   them — belt and braces check below too)
// - Regular annual subscribers (not a gift, different renewal flow — theirs
//   is auto-charge by Stripe, different email copy, different workflow)
// - Already-lapsed or cancelled members (status filter)
//
// SAFETY:
// - Stamps gift_renewal_reminded_at BEFORE sending the email, so a retry
//   or parallel invocation can't double-send (at the cost of: if Resend
//   fails, that member's reminder is lost forever. Acceptable trade-off —
//   duplicate emails are worse than a lost one).
// - 50-member batch cap per run so a backlog can't melt the function timeout.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const windowStart = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000).toISOString();

    // Step 1: find candidate members (gift reminder not yet sent, in the T-30
    // window, active, expires_at set). The partial index from migration 006
    // makes this lookup cheap.
    const { data: candidates, error: candidatesErr } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, expires_at')
      .eq('clan_id', clan_id)
      .eq('status', 'active')
      .is('gift_renewal_reminded_at', null)
      .not('expires_at', 'is', null)
      .gte('expires_at', windowStart)
      .lte('expires_at', windowEnd)
      .limit(50);

    if (candidatesErr) {
      console.error('expiry-sweep candidate query failed:', candidatesErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: candidatesErr.message }) };
    }

    if (!candidates || candidates.length === 0) {
      console.log('expiry-sweep: no T-30 candidates today');
      return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };
    }

    // Step 2: filter to GIFT RECIPIENTS only. A candidate is a gift recipient
    // if there's a paid gifts row with member_id = this member's id. Regular
    // self-paying members have no such row and are skipped — their eventual
    // T-30 flow will live under a different column + email template.
    const memberIds = candidates.map(m => m.id);
    const { data: gifts, error: giftsErr } = await supa()
      .from('gifts')
      .select('member_id, buyer_name, buyer_email, personal_message')
      .eq('clan_id', clan_id)
      .eq('status', 'paid')
      .in('member_id', memberIds);

    if (giftsErr) {
      console.error('expiry-sweep gifts lookup failed:', giftsErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: giftsErr.message }) };
    }

    const giftsByMember = new Map();
    for (const g of (gifts || [])) giftsByMember.set(g.member_id, g);

    const giftRecipients = candidates.filter(m => giftsByMember.has(m.id));
    if (giftRecipients.length === 0) {
      console.log(`expiry-sweep: ${candidates.length} candidate(s) but none are gift recipients`);
      return { statusCode: 200, body: JSON.stringify({ processed: 0, candidates: candidates.length }) };
    }

    let processed = 0;
    let failed = 0;

    for (const member of giftRecipients) {
      const gift = giftsByMember.get(member.id);

      // Stamp FIRST — commit-before-send prevents duplicate reminders on
      // retry or parallel execution. If the email send below fails, the
      // member loses this reminder — but they'd rather miss one email than
      // receive several.
      const { error: stampErr } = await supa()
        .from('members')
        .update({ gift_renewal_reminded_at: now.toISOString() })
        .eq('id', member.id)
        .is('gift_renewal_reminded_at', null); // condition guards against race

      if (stampErr) {
        console.error(`expiry-sweep stamp failed for ${member.email}:`, stampErr.message);
        failed++;
        continue;
      }

      try {
        await sendGiftRenewalReminder({
          recipientEmail: member.email,
          recipientName: member.name,
          buyerName: gift.buyer_name,
          tierLabel: member.tier_label,
          expiresAt: member.expires_at,
        });
        await logEvent({
          clan_id,
          member_id: member.id,
          event_type: 'gift_renewal_reminder_sent',
          payload: { email: member.email, expires_at: member.expires_at, gift_from: gift.buyer_email },
        });
        processed++;
      } catch (emailErr) {
        console.error(`expiry-sweep email send failed for ${member.email}:`, emailErr.message);
        failed++;
        // Don't un-stamp — the stamp prevents duplicate sends, and losing
        // one reminder is safer than risking multiple.
      }
    }

    console.log(`expiry-sweep: processed=${processed} failed=${failed} candidates=${candidates.length}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ processed, failed, candidates: candidates.length }),
    };
  } catch (e) {
    console.error('expiry-sweep crashed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// ──────────────────────────────────────────────────────────────────────────
// T-30 renewal reminder email for gift recipients.
//
// Tone: warm, not transactional. The recipient got this membership as a
// gift — we don't want the renewal to feel like a renewal pitch.
// Framing: "your year is ending", "the door remains open", offer to
// continue on their own terms. Mentions the original giver by name to
// anchor the emotional connection.
// ──────────────────────────────────────────────────────────────────────────
async function sendGiftRenewalReminder({ recipientEmail, recipientName, buyerName, tierLabel, expiresAt }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured — cannot send renewal reminder');
    return;
  }
  const firstName = recipientName ? recipientName.split(' ')[0] : 'friend';
  const giverName = buyerName || 'a friend';
  const tier = tierLabel || 'Clan Member';
  const expiresDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'next month';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">A note from Newhall</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.2">Your year with the clan</h1>
  </div>

  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dia dhuit, ${escapeHtml(firstName)} — God be with you.</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">It is almost a year since <strong>${escapeHtml(giverName)}</strong> set a place for you in Clan Ó Comáin. Your gift membership was a one-year ${escapeHtml(tier).toLowerCase()}, and it will quietly come to its end on <strong>${escapeHtml(expiresDate)}</strong> — at which point your name will move from active standing into the keeping of the clan archive.</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">We wanted to write in good time — so that, if you would like to remain in current standing on your own terms, there is space to decide without pressure.</p>

    <!-- Quiet pull-quote — the line that does the real work -->
    <div style="border-left:3px solid #B8975A;padding:4px 0 4px 20px;margin:0 0 28px;background:rgba(184,151,90,0.05)">
      <p style="font-family:'Georgia',serif;font-size:15px;font-style:italic;color:#3C2A1A;line-height:1.75;margin:0">A year is enough to learn what Ó Comáin feels like from the inside. What comes next is yours to shape.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 24px">If you would like to continue, the door remains open. You are welcome to take up any tier that fits — year by year, or for life. Continuing your membership keeps your name in current standing on the Register, and your founder distinction (carried by your 2026 certificate) alongside it.</p>

    <div style="text-align:center;margin:0 0 28px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:15px 32px;border-radius:1px">Continue your membership →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">And if now is not the time — that is also all right. Your certificate remains yours, and the clan keeps a record of every name it has called its own. You are welcome back at any point you wish to return to the Register in current standing. If you have any questions, write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and I will respond on behalf of the Chief.</p>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 28px">Go raibh míle maith agat for the year you have given the clan.</p>

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

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Clan Ó Comáin <clan@ocomain.org>',
      to: recipientEmail,
      subject: `Your year with Clan Ó Comáin — continuing your place`,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error (renewal reminder): ${err}`);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
