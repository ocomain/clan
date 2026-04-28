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
    // ── Per-title language for the title-award letter ──
    //
    // EVERY title is a RAISING (Path 2 design): Cara is the first
    // raising into honour from no-title; Onóir is a raising from
    // Cara; Ardchara is a raising from Onóir to the highest rank.
    // The lower title is laid by ('replaced'); only the current
    // title is held. Modelled on chivalry-order conventions
    // (KBE → CBE → MBE etc., where each step replaces the prior),
    // not on peerage where titles accrete.
    //
    // The TEMPLATE FUNCTIONS below take the previous-title's irish
    // form (or null for first-raising) and produce the per-title
    // copy. This way the email can say 'raised from Onóir to the
    // dignity of Ardchara' or, for a first raising, 'raised to the
    // dignity of Cara' without an awkward 'from null' clause.
    //
    // Subject and headline parts that don't depend on prior title
    // are constants. Body opening, bestowal intro, and an optional
    // 'replacement' sentence are functions of priorTitleIrish.

    // Subject line — depends on prior title for raisings beyond
    // the first. First raising (priorIrish=null): no 'from' clause.
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Cara`
        : 'By the Chief\u2019s hand \u2014 you are raised to Cara',

    // Constant header pieces.
    eyebrow: 'By the Chief\u2019s hand',
    headline: 'You are raised in the clan',

    // The opening body paragraph — narrates the Chief's act, names
    // the count, and (for non-first raisings) names the previous
    // dignity being laid by. For Cara — the FIRST raising — there
    // is no prior dignity; the language is simply 'raised within
    // the clan to the first of its honours'.
    bodyOpening: (priorIrish) =>
      priorIrish
        // Defensive: in normal operation a member never reaches Cara
        // having already held a title (Cara IS the first title). But
        // if some future ladder revision changes that, the language
        // handles it cleanly.
        ? `You have lately brought another to the Register at Newhall \u2014 and on this account, the Chief has been pleased to raise you from the dignity of ${priorIrish} to that of Cara, the first of the honours conferred within Clan Ó Comáin.`
        : 'You have lately brought another to the Register at Newhall \u2014 and on this account, the Chief has been pleased to raise you within the clan to the first of its honours.',

    // The small-caps line above the title in the bestowal block.
    bestowalIntro: (priorIrish) =>
      priorIrish
        ? `It pleases the Chief to raise you from ${priorIrish} to the dignity of`
        : 'It pleases the Chief to raise you to the dignity of',

    // Closing narrative beat — what this dignity means.
    closingNarrative: 'To bring even one to the clan is no small thing \u2014 it is the act on which all kinship is built.',

    // For Cara, no 'replacement' sentence (there's nothing to lay
    // by). Onóir and Ardchara include one — see those entries below.
    replacementSentence: (priorIrish) => null,
  },
  {
    slug: 'onoir',
    threshold: 5,
    irish: 'Onóir',
    english: 'One held in honour',
    pronunciation: 'UH-nor',
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Onóir`
        : 'By the Chief\u2019s hand \u2014 you are raised to Onóir',

    eyebrow: 'By the Chief\u2019s hand \u00b7 A raising in rank',
    headline: 'You are raised to Onóir',

    bodyOpening: (priorIrish) =>
      priorIrish
        ? `Five souls have come to Clan Ó Comáin through your welcome. The Chief has marked this, and has been pleased to raise you from the dignity of ${priorIrish} to that of Onóir \u2014 the second honour in the keeping of the clan.`
        // Defensive — leapfrog from no-title direct to Onóir
        // (e.g. 5 conversions in the same publish event). The
        // Cara stamp will still be recorded in the audit trail
        // but the email speaks only of Onóir.
        : 'Five souls have come to Clan Ó Comáin through your welcome. The Chief has marked this, and has been pleased to raise you within the clan to the dignity of Onóir \u2014 the second honour in the keeping of the clan.',

    bestowalIntro: (priorIrish) =>
      priorIrish
        ? `It pleases the Chief to raise you from ${priorIrish} to the dignity of`
        : 'It pleases the Chief to raise you to the dignity of',

    closingNarrative: 'To bring five is the work of a member who has made the clan their own. The Chief is the better for knowing it.',

    // The 'laid by / taken up in its place' line — chivalry-order
    // replacement model. Names what's happening: the prior dignity
    // is set down, the new dignity is taken up.
    replacementSentence: (priorIrish) =>
      priorIrish
        ? `The dignity of ${priorIrish}, lately held, is laid by; the dignity of Onóir is taken up in its place.`
        : null,
  },
  {
    slug: 'ardchara',
    threshold: 15,
    irish: 'Ardchara',
    english: 'Friend of high standing',
    pronunciation: 'ARD-khar-uh',
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Ardchara`
        : 'By the Chief\u2019s hand \u2014 you are raised to Ardchara',

    eyebrow: 'By the Chief\u2019s hand \u00b7 A raising to the highest rank',
    headline: 'You are raised to Ardchara',

    // Full chivalric register at the top tier — 'It hath pleased',
    // 'henceforth bear', 'place and standing belonging to that rank'.
    bodyOpening: (priorIrish) =>
      priorIrish
        ? `Fifteen souls have come to the Register at Newhall through your hand. It hath pleased the Chief to raise you from the dignity of ${priorIrish} to that of Ardchara, the highest of the honours conferred within Clan Ó Comáin. By this raising you henceforth bear the title set out below, with the place and standing belonging to that rank in the clan\u2019s keeping.`
        : 'Fifteen souls have come to the Register at Newhall through your hand. It hath pleased the Chief to raise you within the clan to the dignity of Ardchara, the highest of the honours conferred within Clan Ó Comáin. By this raising you henceforth bear the title set out below, with the place and standing belonging to that rank in the clan\u2019s keeping.',

    bestowalIntro: (priorIrish) =>
      priorIrish
        ? `It hath pleased the Chief to raise you from ${priorIrish} to the dignity of`
        : 'It hath pleased the Chief to raise you to the dignity of',

    closingNarrative: 'There are very few in any generation who carry fifteen to the Register at Newhall. You are now among them, and the Chief takes a particular interest in such members.',

    replacementSentence: (priorIrish) =>
      priorIrish
        ? `The dignity of ${priorIrish}, lately held, is laid by; the dignity of Ardchara is taken up in its place.`
        : null,
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
 * been notified about. Returns:
 *   - count: current converted-invite count
 *   - allNewlyEarned: ALL titles whose threshold has been crossed
 *     and which haven't yet been awarded. Caller stamps every
 *     entry's slug into sponsor_titles_awarded so the audit trail
 *     records each milestone, even on a leapfrog.
 *   - highestNewlyEarned: the single highest of those (or null if
 *     none). Caller sends the title-award letter for ONLY this
 *     one — never the lower titles in the same batch. This is the
 *     'no awkward double-letter on a single raising day' rule:
 *     if a member goes from 4 → 6 conversions in one publish event
 *     (crossing both Cara and Onóir thresholds), they receive ONE
 *     letter for Onóir; Cara is silently stamped to the audit log
 *     without an email.
 *   - previousTitleIrish: the Irish form of the highest title the
 *     member ALREADY HELD before this raising (or null if they
 *     held none). The email letter uses this to say
 *     'raised from Onóir to the dignity of Ardchara' — without it,
 *     the letter would have to omit the from-clause entirely.
 *
 * The caller is responsible for:
 *   - Sending the Herald letter for highestNewlyEarned only
 *   - Stamping sponsor_titles_awarded with timestamps for each
 *     entry in allNewlyEarned
 * This function only COMPUTES — it doesn't mutate state.
 *
 * @param {object} member — must have { id, sponsor_titles_awarded }
 *                          where sponsor_titles_awarded is the
 *                          JSONB column from the members table
 * @returns {Promise<{
 *   count: number,
 *   allNewlyEarned: Array,
 *   highestNewlyEarned: object|null,
 *   previousTitleIrish: string|null
 * }>}
 */
async function evaluateSponsorTitles(member) {
  const count = await countSponsoredBy(member.id);
  const awarded = member.sponsor_titles_awarded || {};

  // What did this member already hold? We need this so the email
  // can say 'raised FROM {previous} TO {new}'. Call the existing
  // helper which iterates from highest → lowest and returns the
  // first match. Result: the prior-highest title definition (or
  // null if they held none).
  const priorHighest = highestAwardedTitle(awarded);
  const previousTitleIrish = priorHighest ? priorHighest.irish : null;

  // All titles whose threshold has been crossed but not yet
  // awarded (their slug isn't in the awarded JSONB). Sorted
  // ascending by threshold (the SPONSOR_TITLES array is already
  // in that order).
  const allNewlyEarned = SPONSOR_TITLES.filter(
    (t) => count >= t.threshold && !awarded[t.slug]
  );

  // Highest of those (last in the ascending array, or null if
  // empty). Caller emails this one only.
  const highestNewlyEarned = allNewlyEarned.length > 0
    ? allNewlyEarned[allNewlyEarned.length - 1]
    : null;

  return {
    count,
    allNewlyEarned,
    highestNewlyEarned,
    previousTitleIrish,
  };
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
