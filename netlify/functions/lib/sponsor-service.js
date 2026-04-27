// netlify/functions/lib/sponsor-service.js
//
// All sponsorship-related logic in one module. Three responsibilities:
//
//   1. recordConversion(member, clan_id) — when an invitee publishes
//      their cert, find the most recent invitation row that brought
//      them in (if any) and stamp it with converted_member_id.
//      Idempotent — safe to call repeatedly. Returns the inviter's
//      member row if a conversion was recorded, or null if the
//      member didn't come via an invitation.
//
//   2. countSponsoredBy(memberId) — returns the number of
//      conversions credited to this member (i.e. invitations where
//      inviter_member_id = memberId AND converted_member_id IS NOT
//      NULL). This is what the dashboard 'quiet count' reads, and
//      what the title-awarding logic gates on.
//
//   3. evaluateSponsorTitles(member, clan_id) — checks the
//      sponsor's current count against the title thresholds, and
//      returns an array of titles newly earned that haven't yet
//      been awarded. The CALLER is responsible for sending the
//      Herald letter and stamping sponsor_titles_awarded — this
//      function only computes what's owed.
//
// The titles, in order:
//   { slug: 'cara',     threshold: 1,  irish: 'Cara',     english: 'Friend',
//     pronunciation: 'KAR-uh' }
//   { slug: 'onoir',    threshold: 5,  irish: 'Onóir',    english: 'One held in honour',
//     pronunciation: 'UH-nor' }
//   { slug: 'ardchara', threshold: 15, irish: 'Ardchara', english: 'Friend of high standing',
//     pronunciation: 'ARD-khar-uh' }
//
// THRESHOLDS — edit here, the rest of the architecture follows.

const { supa } = require('./supabase');

const SPONSOR_TITLES = [
  {
    slug: 'cara',
    threshold: 1,
    irish: 'Cara',
    english: 'Friend',
    pronunciation: 'KAR-uh',
    // Per-title language for the title-award letter. Each title is
    // a distinct moment in the member's journey, and the register
    // shifts as the gravity grows:
    //   Cara     — RECOGNITION (warm, brief)
    //   Onóir    — DISTINCTION (slightly more formal)
    //   Ardchara — ELEVATION   (full chivalric register: 'raised
    //                           within the clan', 'dignity',
    //                           'henceforth')
    // Same Chief-as-actor convention throughout (Gaelic warrant
    // tradition: Fergus bestows, Herald composes and signs).
    subjectLine: 'By the Chief\u2019s hand \u2014 a name in your keeping',
    eyebrow: 'By the Chief\u2019s hand',
    headline: 'It pleases the Chief',
    bestowalIntro: 'It pleases the Chief to know you as',
    // Opening paragraph — narrates the Chief's action, sets up the
    // bestowal block. Names the count in plain language.
    bodyOpening: 'You have lately brought another to the Register at Newhall \u2014 and on this account, the Chief has been pleased to recognise you among the kindred by name.',
    // Closing narrative beat — single sentence about what this
    // recognition means. Sits between the bestowal block and the
    // Herald sign-off.
    closingNarrative: 'To bring even one to the clan is no small thing \u2014 it is the act on which all kinship is built.',
  },
  {
    slug: 'onoir',
    threshold: 5,
    irish: 'Onóir',
    english: 'One held in honour',
    pronunciation: 'UH-nor',
    subjectLine: 'By the Chief\u2019s hand \u2014 you are marked Onóir',
    eyebrow: 'By the Chief\u2019s hand',
    headline: 'The Chief takes notice',
    bestowalIntro: 'The Chief has been pleased to mark you with the name',
    bodyOpening: 'Five souls have come to Clan Ó Comáin through your welcome. The Chief has marked this, and has been pleased to confer upon you a name held with weight in the clan\u2019s keeping.',
    closingNarrative: 'To bring five is the work of a member who has made the clan their own. The Chief is the better for knowing it.',
  },
  {
    slug: 'ardchara',
    threshold: 15,
    irish: 'Ardchara',
    english: 'Friend of high standing',
    pronunciation: 'ARD-khar-uh',
    subjectLine: 'By the Chief\u2019s hand \u2014 you are raised to Ardchara',
    eyebrow: 'By the Chief\u2019s hand \u00b7 A raising in rank',
    headline: 'You are elevated within the clan',
    // Chivalric register — 'It hath pleased', 'raise', 'dignity',
    // 'henceforth'. Reads as a proper warrant of advancement.
    bestowalIntro: 'It hath pleased the Chief to raise you within the clan to the dignity of',
    // The body opening for Ardchara names the count AND introduces
    // the elevation framing. The 'henceforth' clause names what
    // the new rank carries — kept generic enough to be honest
    // (we don't promise tangible privileges we can't keep), formal
    // enough to feel real.
    bodyOpening: 'Fifteen souls have come to the Register at Newhall through your hand. The Chief has long taken an interest in those who carry the welcome of Clan Ó Comáin to others, and on this account he has been pleased to raise you within the clan, recorded under his seal and entered in the clan\u2019s books. By this raising you henceforth bear the name set out below, with the place and standing belonging to that rank in the clan\u2019s keeping.',
    closingNarrative: 'There are very few in any generation who carry fifteen to the Register at Newhall. You are now among them, and the Chief takes a particular interest in such members.',
  },
];

/**
 * Find the inviter for a freshly-converted member, if any. Stamps
 * the invitations row with converted_member_id so the link is
 * recorded.
 *
 * Idempotency: if the row is already stamped (converted_member_id
 * already set), this is a no-op and the existing inviter row is
 * still returned. Safe to call from the publish flow on every
 * publish, including re-publishes.
 *
 * @param {object} member  — the freshly-published member row, must
 *                           have { id, email, clan_id }
 * @param {string} clan_id
 * @returns {Promise<object|null>} inviter member row if a
 *   conversion was found/recorded, or null if the member didn't
 *   come through an invitation.
 */
async function recordConversion(member, clan_id) {
  if (!member || !member.email) return null;
  const memberEmail = String(member.email).toLowerCase().trim();

  // Find the most recent invitation sent to this email address that
  // hasn't yet been converted — most recent because if multiple
  // people invited them, we credit whoever got them across the line
  // (which is most likely the most recent inviter, by simple
  // recency heuristic. If we wanted, we could try to detect the
  // exact inviting link they clicked — but recency is good enough
  // for v1 and avoids storing click-attribution).
  const { data: invitation, error: lookupErr } = await supa()
    .from('invitations')
    .select('id, inviter_member_id, converted_member_id, sent_at')
    .eq('clan_id', clan_id)
    .ilike('recipient_email', memberEmail)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    console.warn('recordConversion: invitation lookup failed:', lookupErr.message);
    return null;
  }
  if (!invitation) return null;

  // Already stamped? Just return the inviter (idempotency).
  if (invitation.converted_member_id) {
    const { data: inviter } = await supa()
      .from('members')
      .select('id, email, name, sponsor_titles_awarded')
      .eq('id', invitation.inviter_member_id)
      .maybeSingle();
    return inviter || null;
  }

  // Stamp the conversion. Status moves from 'sent' to 'accepted'.
  const { error: stampErr } = await supa()
    .from('invitations')
    .update({
      converted_member_id: member.id,
      status: 'accepted',
      responded_at: new Date().toISOString(),
    })
    .eq('id', invitation.id);

  if (stampErr) {
    console.warn('recordConversion: stamp failed:', stampErr.message);
    // Continue — we still want to surface the inviter to the
    // caller so they can send the Sponsor's Letter (the stamp
    // miss is non-fatal, can be backfilled later).
  }

  // Fetch and return the inviter
  const { data: inviter } = await supa()
    .from('members')
    .select('id, email, name, sponsor_titles_awarded')
    .eq('id', invitation.inviter_member_id)
    .maybeSingle();

  return inviter || null;
}

/**
 * Count converted invitations credited to this sponsor.
 *
 * @param {string} memberId — the sponsor's id
 * @returns {Promise<number>}
 */
async function countSponsoredBy(memberId) {
  if (!memberId) return 0;
  const { count, error } = await supa()
    .from('invitations')
    .select('id', { count: 'exact', head: true })
    .eq('inviter_member_id', memberId)
    .not('converted_member_id', 'is', null);

  if (error) {
    console.warn('countSponsoredBy failed:', error.message);
    return 0;
  }
  return count || 0;
}

/**
 * Evaluate which titles a sponsor has newly earned and not yet
 * been notified about. Returns an array of title definitions
 * (subset of SPONSOR_TITLES) that the caller should award.
 *
 * The caller is responsible for:
 *   - Sending the Herald letter for each newly-earned title
 *   - Stamping sponsor_titles_awarded with the timestamp(s)
 * This function only COMPUTES — it doesn't mutate state.
 *
 * @param {object} member — must have { id, sponsor_titles_awarded }
 *                          where sponsor_titles_awarded is the
 *                          JSONB column from the members table
 * @returns {Promise<{ count: number, newlyEarned: Array }>}
 */
async function evaluateSponsorTitles(member) {
  const count = await countSponsoredBy(member.id);
  const awarded = member.sponsor_titles_awarded || {};
  const newlyEarned = SPONSOR_TITLES.filter(
    (t) => count >= t.threshold && !awarded[t.slug]
  );
  return { count, newlyEarned };
}

/**
 * Helper: returns the highest-tier title currently held by a
 * member, given their awarded JSONB. Returns null if no title.
 * Used by the dashboard to render the title display.
 */
function highestAwardedTitle(awardedJson) {
  const awarded = awardedJson || {};
  // Iterate from highest threshold down so the first match wins.
  for (let i = SPONSOR_TITLES.length - 1; i >= 0; i--) {
    const t = SPONSOR_TITLES[i];
    if (awarded[t.slug]) return t;
  }
  return null;
}

module.exports = {
  SPONSOR_TITLES,
  recordConversion,
  countSponsoredBy,
  evaluateSponsorTitles,
  highestAwardedTitle,
};
