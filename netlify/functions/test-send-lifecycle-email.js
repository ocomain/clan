// netlify/functions/test-send-lifecycle-email.js
//
// Manually dispatches a single post-signup lifecycle email to any
// address, for visual review in real mail clients. Bypasses the
// cron's day-bucket logic and tracking-column updates entirely —
// this is for inspection, not for production sends.
//
// USAGE (from terminal):
//
//   curl -X POST 'https://www.ocomain.org/.netlify/functions/test-send-lifecycle-email' \
//     -H 'Content-Type: application/json' \
//     -d '{"email":"you@example.com","name":"Aoife","emailKey":"2"}'
//
// PARAMETERS (JSON body):
//
//   email      (required)  recipient address
//   name       (optional)  used for "Dear [Firstname]," — defaults
//                          to the recipient's local-part if omitted
//   emailKey   (required)  one of: 1A, 1B, 1C, 2, 3, 4, 5, 6, 7, 8, 9, 10
//   title      (optional)  simulate a titled member: 'cara', 'ardchara',
//                          or 'onoir'. If set, the salutation will use
//                          the title-bearing form ('Dear Cara Aoife,').
//                          Useful for previewing how lifecycle emails
//                          look for members raised to a dignity.
//                          Omit for first-name-only address.
//
// SAFETY:
//   - Does NOT update any database tracking columns. Sending a test
//     to a real member does NOT mark their lifecycle as having
//     received this email. The cron will still send it on the
//     scheduled day. (So testing on yourself is fine; testing on
//     a real member would mean they get it twice, which is why this
//     is intended for personal/team addresses only.)
//
//   - No authentication on this endpoint. Anyone who guesses the URL
//     can send themselves a test. The risk is bounded: they'd send
//     test mail to their own inbox, paying our Resend usage. If
//     this becomes a concern, add a shared-secret query param check.
//
// RESPONSE: JSON {"sent":true,"to":"...","emailKey":"..."} on success,
// {"error":"..."} on failure.

const {
  sendRegisterAck_ClanTier,
  sendRegisterAck_GuardianPlusDefault,
  sendRegisterAck_GuardianPlusOptedOut,
  sendChiefPersonalLetter,
  sendAntoinHowIBecameCara,
  sendAntoinForgotToAttach,
  sendLindaBringingKindred,
  sendHeraldThreeDignities,
  sendMichaelClanCrest,
  sendPaddyStandingOfTheLine,
  sendJessicaGathering,
  sendPaddyRoyalHouseAndSaint,
  sendLindaRenewal,
} = require('./lib/post-signup-email');

// Map emailKey -> sender function. Keys match the cadence document
// numbering exactly (1A/B/C are the three Herald variants of the +3
// send; 2-10 are sequential; 3B is the same-day Antoin follow-up to 3
// that attaches the actual letters patent PDF).
const SENDERS = {
  '1A': sendRegisterAck_ClanTier,
  '1B': sendRegisterAck_GuardianPlusDefault,
  '1C': sendRegisterAck_GuardianPlusOptedOut,
  '2':  sendChiefPersonalLetter,
  '3':  sendAntoinHowIBecameCara,
  '3B': sendAntoinForgotToAttach,
  '4':  sendLindaBringingKindred,
  '5':  sendHeraldThreeDignities,
  '6':  sendMichaelClanCrest,
  '7':  sendPaddyStandingOfTheLine,
  '8':  sendJessicaGathering,
  '9':  sendPaddyRoyalHouseAndSaint,
  '10': sendLindaRenewal,
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function firstNameFromEmail(email) {
  // 'aoife.example@ocomain.org' -> 'Aoife'
  const local = String(email || '').split('@')[0] || 'friend';
  const first = local.split(/[._-]/)[0] || 'friend';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

exports.handler = async (event) => {
  // Parse JSON body. Tolerate malformed input with a clean error.
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { email, name, emailKey, title } = payload;

  if (!email) {
    return jsonResponse(400, { error: 'Missing required field: email' });
  }
  if (!emailKey || !SENDERS[emailKey]) {
    return jsonResponse(400, {
      error: `Missing or invalid emailKey. Valid keys: ${Object.keys(SENDERS).join(', ')}`,
    });
  }

  // Optional title — simulates a member who has been raised to one
  // of the three sponsor titles of dignity. Reads as the same JSONB
  // shape as migration 015 stores in production. The salutation
  // logic in addressFormOf reads this and produces 'Dear Cara Aoife'
  // (etc.) rather than 'Dear Aoife'. 'higher is taken up' is
  // automatic — pass 'onoir' and that's what's used, even if you
  // also pass other entries.
  const VALID_TITLES = { cara: true, ardchara: true, onoir: true };
  let sponsor_titles_awarded;
  if (title) {
    const lower = String(title).toLowerCase();
    if (!VALID_TITLES[lower]) {
      return jsonResponse(400, {
        error: `Invalid title. Valid: cara, ardchara, onoir. (Received: ${title})`,
      });
    }
    sponsor_titles_awarded = { [lower]: new Date().toISOString() };
  }

  // Build the mock member object. Tier and public_register_visible
  // only matter for 1A/B/C (the Herald branches in the cron); the
  // sender functions don't read them, so we set sensible defaults
  // and the chosen sender function dictates which variant fires.
  const mockMember = {
    id: 'test-send-' + Date.now(),
    email: email,
    name: name || firstNameFromEmail(email),
    tier: 'guardian-ind',
    public_register_visible: true,
    sponsor_titles_awarded,
    created_at: new Date().toISOString(),
  };

  try {
    const ok = await SENDERS[emailKey](mockMember);
    if (ok) {
      console.log(`test-send-lifecycle-email: sent ${emailKey} to ${email}`);
      return jsonResponse(200, {
        sent: true,
        to: email,
        emailKey: emailKey,
        firstName: mockMember.name,
      });
    } else {
      return jsonResponse(500, {
        error: 'Sender function returned falsy — check Netlify function logs for details',
        emailKey: emailKey,
      });
    }
  } catch (err) {
    console.error('test-send-lifecycle-email: send failed:', err.message, err.stack);
    return jsonResponse(500, {
      error: err.message,
      emailKey: emailKey,
    });
  }
};
