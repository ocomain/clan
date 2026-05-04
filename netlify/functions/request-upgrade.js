// netlify/functions/request-upgrade.js
//
// Member-initiated upgrade request. The members-area dashboard surfaces
// upgrade cards for the next tier up (Clan→Guardian, Guardian→Steward,
// Steward→Life). Tapping the CTA on any of those cards posts here.
//
// We don't have a self-serve in-app upgrade flow yet — by design, while
// the focus is acquisition rather than upsell automation. So this
// function simply emails clan@ocomain.org with the request context, and
// the Chief / Office of the Private Secretary handles the change-of-tier
// manually (Stripe customer portal swap, or a manual proration). When
// upgrades become a meaningful share of revenue, this can be replaced
// with a Stripe-driven self-serve flow.
//
// Authenticated — requires a valid Supabase session bearer token.

const { supa, clanId, logEvent, TIER_BY_SLUG } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

const ALLOWED_TARGETS = ['guardian', 'steward', 'life'];

const TARGET_LABELS = {
  guardian: 'Guardian of the Clan',
  steward:  'Steward of the Clan',
  life:     'Life Member',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // ── Verify bearer token → member identity ───────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let memberEmail = null;
  let memberRow = null;
  try {
    const { data: userResp, error: userErr } = await supa().auth.getUser(token);
    if (userErr || !userResp?.user?.email) throw new Error('Invalid session');
    memberEmail = userResp.user.email.toLowerCase();

    const { data: m } = await supa()
      .from('members')
      .select('id, name, email, tier, tier_label, tier_family, joined_at, status')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    }
    memberRow = m;
  } catch (e) {
    console.error('auth check failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // ── Parse and validate payload ──────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const targetTier = String(data.targetTier || '').toLowerCase();
  if (!ALLOWED_TARGETS.includes(targetTier)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown target tier' }) };
  }

  // Optional free-text note from the member. Trim and cap defensively.
  const note = String(data.note || '').trim().slice(0, 2000);

  const currentTierLabel = memberRow.tier_label || (TIER_BY_SLUG[memberRow.tier]?.label) || memberRow.tier || '—';
  const targetTierLabel = TARGET_LABELS[targetTier];
  const isFamily = !!memberRow.tier_family;

  // ── Build the email ─────────────────────────────────────────────────────
  const subject = `Upgrade request — ${memberRow.name || memberEmail} · ${currentTierLabel} → ${targetTierLabel}`;

  const noteBlock = note
    ? `<h3 style="color:#0C1A0C;font-size:16px;margin:22px 0 10px">Their note</h3>
       <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(note)}</div>`
    : `<p style="margin:22px 0 0;font-size:13px;color:#8F7A5E;font-style:italic">No note left with the request.</p>`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Upgrade request — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A member has tapped the upgrade prompt on their dashboard.<br><strong>Action:</strong> reach out, agree the next step, and process the change-of-tier in Stripe (customer portal swap or manual proration).</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:6px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Member</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.name || '—')}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(memberEmail)}" style="color:#B8975A">${esc(memberEmail)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member status</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.status || '—')}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Current tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(currentTierLabel)}</strong>${isFamily ? ' · family' : ''}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Requested tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong style="color:#0C1A0C">${esc(targetTierLabel)}</strong>${isFamily ? ' · family rate likely' : ''}</td></tr>
    </table>
    ${noteBlock}
    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area upgrade prompt. Reply directly to the member's email above.</p>
  </div>`;

  // ── Send the email ──────────────────────────────────────────────────────
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: CLAN_EMAIL,
        reply_to: memberEmail,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('Resend failed:', resp.status, body);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Mail delivery failed — please try again or write to clan@ocomain.org' }) };
    }
  } catch (err) {
    console.error('Email send error:', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Mail service unreachable — please try again shortly' }) };
  }

  // Log the event for the audit trail. Non-blocking.
  try {
    const clan_id = await clanId();
    await logEvent({
      clan_id,
      member_id:  memberRow.id,
      event_type: 'upgrade_requested',
      payload:    { from_tier: memberRow.tier, to_tier: targetTier, has_note: !!note },
    });
  } catch (e) {
    console.warn('event log failed (non-blocking):', e.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}
