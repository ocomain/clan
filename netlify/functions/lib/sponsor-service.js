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
    // The narrative beat used in the Herald letter. Keep short —
    // each is one sentence that fits inside an italic paragraph.
    narrative: 'You have brought another to the clan, and so the clan has gained one more place at the hearth through you.',
  },
  {
    slug: 'onoir',
    threshold: 5,
    irish: 'Onóir',
    english: 'One held in honour',
    pronunciation: 'UH-nor',
    narrative: 'You have brought five to the Register at Newhall. A clan is built by the few who do this — without naming themselves, without asking for it.',
  },
  {
    slug: 'ardchara',
    threshold: 15,
    irish: 'Ardchara',
    english: 'Friend of high standing',
    pronunciation: 'ARD-khar-uh',
    narrative: 'Fifteen souls have come to Clan Ó Comáin through your welcome. There are very few in any generation who do this, and the Chief is the better for knowing it.',
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
