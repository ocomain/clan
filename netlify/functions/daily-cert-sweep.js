// netlify/functions/daily-cert-sweep.js
//
// Runs daily on a schedule (see netlify.toml). Handles two cases:
//
//  (A) DAY-29 REMINDER — members joined ~29 days ago who haven't yet
//      published their cert. Sends a "publishing in 24 hours" email
//      with their current draft details so they have a final
//      opportunity to refine before auto-publish.
//
//  (B) DAY-30 AUTO-PUBLISH — members joined 30+ days ago who never
//      published. Apply name auto-fix to their Herald-captured name,
//      generate the cert PDF, set cert_published_at + cert_locked_at,
//      send the publication-confirmation email (autoPublished: true).
//
// Both cases find members via the members_cert_unpublished_idx
// (cert_published_at IS NULL AND status = 'active'). The age-since-
// joined determines which bucket they're in.
//
// Idempotency:
//   - day-29 reminder: gated on cert_publish_reminder_sent_at IS NULL
//     so we only send once per member
//   - day-30 auto-publish: gated on cert_published_at IS NULL so once
//     published, never auto-publishes again

const { supa, clanId, logEvent } = require('./lib/supabase');
const { ensureCertificate } = require('./lib/cert-service');
const { autoFixName } = require('./lib/name-format');
const { sendEmail } = require('./lib/email');
const { sendPublicationConfirmation } = require('./lib/publication-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_DAY = 29; // send reminder when joined_at was this many days ago
const AUTO_PUBLISH_DAY = 30; // auto-publish when joined_at was this many days ago

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    let remindersSent = 0;
    let autoPublished = 0;
    let failed = 0;

    // ── (A) Day-29 reminder ──────────────────────────────────────────
    // joined between (now - 30 days) and (now - 29 days), reminder not sent.
    const reminderEarliest = new Date(now.getTime() - AUTO_PUBLISH_DAY * DAY_MS).toISOString();
    const reminderLatest   = new Date(now.getTime() - REMINDER_DAY * DAY_MS).toISOString();

    const { data: reminderTargets, error: reminderErr } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, partner_name, children_first_names, ancestor_dedication, joined_at')
      .eq('clan_id', clan_id)
      .eq('status', 'active')
      .is('cert_published_at', null)
      .is('cert_publish_reminder_sent_at', null)
      .gte('joined_at', reminderEarliest)
      .lt('joined_at', reminderLatest)
      .limit(50);

    if (reminderErr) {
      console.error('day-29 reminder query failed:', reminderErr.message);
    } else if (reminderTargets) {
      for (const m of reminderTargets) {
        try {
          const fixedName = autoFixName(m.name) || m.name || '—';
          const sent = await sendDay29Reminder(m, fixedName);
          if (sent) {
            await supa()
              .from('members')
              .update({ cert_publish_reminder_sent_at: now.toISOString() })
              .eq('id', m.id);
            await logEvent({
              clan_id,
              member_id: m.id,
              event_type: 'cert_publish_reminder_sent',
              payload: { hours_until_auto_publish: 24 },
            });
            remindersSent++;
          }
        } catch (e) {
          console.error(`day-29 reminder failed for member ${m.id}:`, e.message);
          failed++;
        }
      }
    }

    // ── (B) Day-30 auto-publish ──────────────────────────────────────
    // joined ≥ 30 days ago, still unpublished.
    const autoPublishCutoff = new Date(now.getTime() - AUTO_PUBLISH_DAY * DAY_MS).toISOString();

    const { data: publishTargets, error: publishErr } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, partner_name, children_first_names, ancestor_dedication, joined_at, cert_version, public_register_visible')
      .eq('clan_id', clan_id)
      .eq('status', 'active')
      .is('cert_published_at', null)
      .lt('joined_at', autoPublishCutoff)
      .limit(50);

    if (publishErr) {
      console.error('day-30 auto-publish query failed:', publishErr.message);
    } else if (publishTargets) {
      for (const m of publishTargets) {
        try {
          // Apply name auto-fix BEFORE publishing. Update member row first
          // so the cert generation uses the fixed name.
          const fixedName = autoFixName(m.name);
          if (fixedName && fixedName !== m.name) {
            await supa()
              .from('members')
              .update({ name: fixedName, updated_at: now.toISOString() })
              .eq('id', m.id);
            m.name = fixedName;
          }

          // Stamp publication BEFORE generation so concurrent webhooks
          // (unlikely but possible) see consistent state. cert_locked_at
          // also set as the legacy alias.
          const publishedAt = now.toISOString();
          const newVersion = (m.cert_version || 1);
          await supa()
            .from('members')
            .update({
              cert_published_at: publishedAt,
              cert_locked_at: publishedAt,
              cert_version: newVersion,
              updated_at: publishedAt,
            })
            .eq('id', m.id);

          // Generate the PDF.
          const updated = { ...m, cert_version: newVersion };
          const certResult = await ensureCertificate(updated, clan_id, { forceRegenerate: true });

          await logEvent({
            clan_id,
            member_id: m.id,
            event_type: 'certificate_published',
            payload: {
              tier: m.tier,
              source: 'auto_publish',
              days_after_join: AUTO_PUBLISH_DAY,
              name_auto_fixed: fixedName !== m.name ? false : (autoFixName(m.name) !== m.name),
            },
          });

          if (certResult.storagePath) {
            await sendPublicationConfirmation(updated, certResult, { autoPublished: true });
          }
          autoPublished++;
        } catch (e) {
          console.error(`auto-publish failed for member ${m.id}:`, e.message);
          failed++;
        }
      }
    }

    console.log(`cert sweep: reminders=${remindersSent} auto_published=${autoPublished} failed=${failed}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ remindersSent, autoPublished, failed }),
    };
  } catch (err) {
    console.error('daily-cert-sweep crashed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Day-29 reminder: shows the member their current draft details so they
// have a final 24-hour opportunity to refine before auto-publish.
async function sendDay29Reminder(member, suggestedName) {
  const firstName = (member.name || '').split(' ')[0] || 'friend';
  const familyDetails = member.tier_family && (member.partner_name || (member.children_first_names && member.children_first_names.length))
    ? `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Family on certificate:</strong> ${escapeHtml(member.partner_name || '—')}${member.children_first_names && member.children_first_names.length ? ' and ' + escapeHtml(member.children_first_names.join(', ')) : ''}</p>`
    : '';
  const ancestor = member.ancestor_dedication
    ? `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Ancestor dedication:</strong> ${escapeHtml(member.ancestor_dedication)}</p>`
    : `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Ancestor dedication:</strong> <em>(none — your certificate will not include a dedication)</em></p>`;

  const nameWillFix = suggestedName !== member.name;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px 28px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="76" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Final 24 hours</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.2">Your certificate publishes tomorrow</h1>
  </div>

  <div style="padding:36px 40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 18px">Dear ${escapeHtml(firstName)},</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 22px">Your 30-day window to publish your certificate closes in 24 hours. After that, it will be auto-published in your name as it stands on your record. This is your final opportunity to refine the details.</p>

    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:22px 24px;margin:0 0 24px;border-radius:2px">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">Your certificate will read</p>
      <p style="font-family:'Georgia',serif;font-size:13.5px;color:#3C2A1A;line-height:1.75;margin:0 0 4px"><strong style="color:#0C1A0C">Name on certificate:</strong> ${escapeHtml(suggestedName)}${nameWillFix ? ` <em style="color:#8C7A64">(auto-corrected from "${escapeHtml(member.name || '')}")</em>` : ''}</p>
      <p style="font-family:'Georgia',serif;font-size:13.5px;color:#3C2A1A;line-height:1.75;margin:0 0 4px"><strong style="color:#0C1A0C">Tier:</strong> ${escapeHtml(member.tier_label || 'Member')}</p>
      ${familyDetails}
      ${ancestor}
    </div>

    <div style="text-align:center;margin:0 0 28px">
      <a href="https://www.ocomain.org/members/login.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:1px">Refine and publish now →</a>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;margin:12px 0 0;line-height:1.5">A one-time sign-in link will be sent to this email.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:14.5px;font-style:italic;color:#6C5A4A;line-height:1.7;margin:0 0 24px">If the details above are how you'd like your certificate to read, no action is needed — it will publish automatically tomorrow.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0">Office of the Private Secretary to Chief of Ó Comáin</p>
        </td>
      </tr>
    </table>
  </div>

  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:rgba(184,151,90,.6);margin:0">Caithfidh an stair a bheith i réim — History must prevail</p>
  </div>
</div>
</body>
</html>`;

  return await sendEmail({
    to: member.email,
    subject: 'Your certificate publishes in 24 hours — refine now if needed',
    html,
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
