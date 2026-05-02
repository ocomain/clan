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
// The titles, in order (revised 2026-05-01):
//   { slug: 'cara',     threshold: 1,  irish: 'Cara',     english: 'Friend',
//     pronunciation: 'KAR-uh' }
//   { slug: 'ardchara', threshold: 5,  irish: 'Ardchara', english: 'Friend of high standing',
//     pronunciation: 'ARD-khar-uh' }
//   { slug: 'onoir',    threshold: 15, irish: 'Onóir',    english: 'One held in honour',
//     pronunciation: 'UH-nor' }
//
// THRESHOLDS — edit here, the rest of the architecture follows.

const { supa } = require('./supabase');

// SPONSOR_TITLES — three-tier ladder for members who bring others
// to the Register.
//
// LADDER (revised 2026-05-01):
//   Cara     (1 sponsorship)  — Friend; first raising into honour
//   Ardchara (5 sponsorships) — High Friend; the friendship-tier
//                               deepening, morphologically built on
//                               'cara' (ard- + cara = high friend)
//   Onóir    (15 sponsorships) — Honour; the apex, qualitatively
//                               distinct (not a deeper friendship —
//                               a transcendence into pure dignity)
//
// Why this order rather than Cara → Onóir → Ardchara: the new
// arrangement creates a coherent linguistic + conceptual ladder.
// Cara → Ardchara is a morphological progression (the second
// title contains the first); Ardchara → Onóir is a register
// shift (relational warmth → ceremonial weight). Apex by
// transcendence reads better than apex by intensification —
// Onóir as 'the highest honour' carries more gravity than
// Ardchara would as 'the highest friend'.
//
// At each raising, the prior dignity is laid by — only the
// current dignity is held. Modelled on chivalry-order
// conventions (KBE → CBE → MBE etc.), not on peerage where
// titles accrete.
//
// The TEMPLATE FUNCTIONS take the previous-title's irish form
// (or null for first-raising) and produce per-title copy. This
// way the email can say 'raised from Ardchara to the dignity
// of Onóir' or, for a first raising, 'raised to the dignity of
// Cara' without an awkward 'from null' clause.
const SPONSOR_TITLES = [
  {
    slug: 'cara',
    threshold: 1,
    irish: 'Cara',
    english: 'Friend',
    pronunciation: 'KAR-uh',
    // First raising — no prior dignity to mention. Constants for
    // header pieces; functions for body copy that depends on prior
    // (defensively handled even though Cara is always the first
    // raising in the canonical ladder).

    // Subject line.
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Cara`
        : 'By the Chief\u2019s hand \u2014 you are raised to Cara',

    eyebrow: 'By the Chief\u2019s hand',
    headline: 'You are raised in the clan',

    bodyOpening: (priorIrish) =>
      priorIrish
        // Defensive: in normal operation a member never reaches Cara
        // having already held a title. But if some future ladder
        // revision changes that, the language handles it cleanly.
        ? `You have lately brought another to the Register at Newhall \u2014 and on this account, the Chief has been pleased to raise you from the dignity of ${priorIrish} to that of Cara, the first of the honours conferred within Clan Ó Comáin.`
        : 'You have lately brought another to the Register at Newhall \u2014 and on this account, the Chief has been pleased to raise you within the clan to the first of its honours.',

    bestowalIntro: (priorIrish) =>
      priorIrish
        ? `It pleases the Chief to raise you from ${priorIrish} to the dignity of`
        : 'It pleases the Chief to raise you to the dignity of',

    closingNarrative: 'To bring even one to the clan is no small thing \u2014 it is the act on which all kinship is built.',

    replacementSentence: (priorIrish) => null,
  },
  {
    slug: 'ardchara',
    threshold: 5,
    irish: 'Ardchara',
    english: 'Friend of high standing',
    pronunciation: 'ARD-khar-uh',

    // Ardchara at the middle rank — the natural extension of Cara.
    // Where Cara names the friend, Ardchara names the high friend.
    // Tone: a measured raising-in-rank, warmer than Onóir at apex.
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Ardchara`
        : 'By the Chief\u2019s hand \u2014 you are raised to Ardchara',

    eyebrow: 'By the Chief\u2019s hand \u00b7 A raising in rank',
    headline: 'You are raised to Ardchara',

    bodyOpening: (priorIrish) =>
      priorIrish
        ? `Five souls have come to Clan Ó Comáin through your welcome. The Chief has marked this, and has been pleased to raise you from the dignity of ${priorIrish} to that of Ardchara — the second honour in the keeping of the clan. Where Cara names the friend, Ardchara names the high friend — the clan\u2019s recognition that you carry the work of welcome with particular grace.`
        // Defensive — leapfrog from no-title direct to Ardchara
        // (e.g. 5 conversions in the same publish event). The
        // Cara stamp will still be recorded in the audit trail
        // but the email speaks only of Ardchara.
        : 'Five souls have come to Clan Ó Comáin through your welcome. The Chief has marked this, and has been pleased to raise you within the clan to the dignity of Ardchara — the second honour in the keeping of the clan. Where Cara names the friend, Ardchara names the high friend — the clan\u2019s recognition that you carry the work of welcome with particular grace.',

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
        ? `The dignity of ${priorIrish}, lately held, is laid by; the dignity of Ardchara is taken up in its place.`
        : null,
  },
  {
    slug: 'onoir',
    threshold: 15,
    irish: 'Onóir',
    english: 'One held in honour',
    pronunciation: 'UH-nor',

    // Onóir at the apex — the highest honour. Full chivalric
    // register: 'It hath pleased', 'henceforth bear', 'place and
    // standing belonging to that rank'. Onóir names the dignity
    // itself (Honour) — qualitatively distinct from the friendship-
    // tier ladder of Cara/Ardchara, and so the apex.
    subjectLine: (priorIrish) =>
      priorIrish
        ? `By the Chief\u2019s hand \u2014 raised from ${priorIrish} to Onóir`
        : 'By the Chief\u2019s hand \u2014 you are raised to Onóir',

    eyebrow: 'By the Chief\u2019s hand \u00b7 A raising to the highest rank',
    headline: 'You are raised to Onóir',

    bodyOpening: (priorIrish) =>
      priorIrish
        ? `Fifteen souls have come to the Register at Newhall through your hand. It hath pleased the Chief to raise you from the dignity of ${priorIrish} to that of Onóir, the highest of the honours conferred within Clan Ó Comáin. By this raising you henceforth bear the title set out below, with the place and standing belonging to that rank in the clan\u2019s keeping.`
        : 'Fifteen souls have come to the Register at Newhall through your hand. It hath pleased the Chief to raise you within the clan to the dignity of Onóir, the highest of the honours conferred within Clan Ó Comáin. By this raising you henceforth bear the title set out below, with the place and standing belonging to that rank in the clan\u2019s keeping.',

    bestowalIntro: (priorIrish) =>
      priorIrish
        ? `It hath pleased the Chief to raise you from ${priorIrish} to the dignity of`
        : 'It hath pleased the Chief to raise you to the dignity of',

    // Apex closing — preserves the rarity-of-rank language and the
    // 'Chief takes a particular interest' line. The 'champion of
    // welcome' framing migrates here from the old Ardchara apex
    // because the underlying meaning ('the member through whom
    // the clan most reaches outward') is about the apex role,
    // not specifically tied to the ardchara word.
    closingNarrative: 'There are very few in any generation who carry fifteen to the Register at Newhall. You are now among them, and the Chief takes a particular interest in such members. From this raising, you stand in the kindred\u2019s keeping among those most honoured by Clan Ó Comáin — the members through whom the work of welcome most prevails.',

    replacementSentence: (priorIrish) =>
      priorIrish
        ? `The dignity of ${priorIrish}, lately held, is laid by; the dignity of Onóir is taken up in its place.`
        : null,
  },
];

/**
 * Find the sponsor for a freshly-published member, if any.
 *
 * Two paths: a gift, or an invitation. Gift takes precedence because
 * it's a stronger act (the giver paid for the membership, not just
 * sent a link). If a member came through both — invited by friend A,
 * then later gifted by friend B — friend B is credited.
 *
 * For the gift path, no extra stamping is needed: the
 * gifts.member_id link is set at redemption time and never changes,
 * so the conversion is durably recorded by the existing schema.
 *
 * For the invitation path, the function stamps invitations.
 * converted_member_id (and status='accepted') so that the conversion
 * is recorded once and won't double-count if the publish flow runs
 * again.
 *
 * Idempotent: safe to call from the publish flow on every publish,
 * including re-publishes. Already-stamped invitations are a no-op.
 *
 * @param {object} member  — the freshly-published member row, must
 *                           have { id, email, clan_id }
 * @param {string} clan_id
 * @returns {Promise<object|null>} sponsor's member row if a
 *   conversion was found/recorded, or null if the member came in
 *   via self-purchase / a non-member gift-giver / no invitation.
 */
async function recordConversion(member, clan_id) {
  if (!member || !member.email) return null;
  const memberEmail = String(member.email).toLowerCase().trim();

  // ── PATH 1 — gift recipient ──
  // Was this member created through a gift? Look up the gifts row by
  // member_id (set at redemption time) and find the buyer's email.
  // If the buyer is themselves a clan member, they are this member's
  // sponsor. Gift wins over invitation by precedence.
  try {
    const { data: gift } = await supa()
      .from('gifts')
      .select('id, buyer_email')
      .eq('member_id', member.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (gift?.buyer_email) {
      const buyerEmail = String(gift.buyer_email).toLowerCase().trim();
      const { data: sponsor } = await supa()
        .from('members')
        .select('id, email, name, sponsor_titles_awarded')
        .eq('clan_id', clan_id)
        .ilike('email', buyerEmail)
        .maybeSingle();
      if (sponsor) {
        // Gift sponsorship recorded. Return the sponsor — the publish
        // flow will send them the Sponsor's Letter and evaluate
        // titles. No state to stamp; the gifts.member_id link IS the
        // conversion record.
        return sponsor;
      }
      // Buyer isn't a clan member — gift still happened, but no
      // sponsor to credit. Fall through to the invitation path
      // (defensive: maybe an inviter ALSO invited them and that
      // sponsor IS a member).
    }
  } catch (giftErr) {
    console.warn('recordConversion: gift lookup failed (non-fatal):', giftErr.message);
    // Fall through to invitation path
  }

  // ── PATH 2 — invitation recipient ──
  // Find the most recent invitation sent to this email address that
  // hasn't yet been converted. Most recent because if multiple people
  // invited them, we credit whoever got them across the line —
  // recency is a defensible heuristic and avoids storing click
  // attribution.
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
 * Count distinct recipients sponsored by this member, across BOTH
 * paths (gifts and invitations). 'Distinct' matters because the
 * same recipient could conceivably be both invited and gifted by
 * the same sponsor — that should count as one act of bringing-in,
 * not two.
 *
 * Implementation: union the two member_id sets in JS rather than a
 * SQL UNION, because the gifts and invitations tables don't share
 * a common shape and we'd need a UNION ALL with column aliasing.
 * For the volumes involved (a sponsor has at most a few dozen
 * conversions), the JS-side union is trivial.
 *
 * @param {string} memberId — the sponsor's id
 * @returns {Promise<number>}
 */
async function countSponsoredBy(memberId) {
  if (!memberId) return 0;

  // Gather both sets of recipient member_ids in parallel.
  const [invQuery, giftQuery] = await Promise.all([
    // Invitations credited to this sponsor (converted only)
    supa()
      .from('invitations')
      .select('converted_member_id')
      .eq('inviter_member_id', memberId)
      .not('converted_member_id', 'is', null),
    // Gifts credited to this sponsor (recipient must have redeemed
    // and be linked via member_id; pending/abandoned gifts don't
    // count). Lookup is by buyer_email matching the sponsor's email.
    // We need the sponsor's email first — fetch it once.
    supa()
      .from('members')
      .select('email')
      .eq('id', memberId)
      .maybeSingle(),
  ]);

  if (invQuery.error) {
    console.warn('countSponsoredBy: invitations lookup failed:', invQuery.error.message);
  }
  const invertedIds = new Set(
    (invQuery.data || [])
      .map((r) => r.converted_member_id)
      .filter(Boolean)
  );

  // Now fetch gifts by buyer_email — we need the sponsor's email.
  let giftDedupIds = [];
  if (giftQuery.data?.email) {
    const sponsorEmail = String(giftQuery.data.email).toLowerCase().trim();
    // Phase 2 (2026-04-30) — count paid gifts toward the sponsor's
    // tally regardless of whether the recipient has claimed yet.
    // Previously we only counted gifts where member_id IS NOT NULL,
    // which meant the buyer's Cara/Ardchara/Onóir dignity didn't
    // attach until the recipient happened to claim. Phase 2 design
    // says: 'sponsor credit on payment, regardless of acceptance.'
    //
    // Status filter: 'paid' covers the new flow's pending-acceptance
    // state; 'pending_acceptance' is a synonym we may write in some
    // paths; 'claimed' covers post-acceptance and pre-Phase-2 rows.
    // Excludes: 'lapsed' (gift expired unclaimed) and 'paid_no_recipient'
    // (legacy fallback row with no actual recipient).
    //
    // Dedup strategy: when member_id is set, we use it (to dedup
    // against invitations to the same person). When NULL (deferred),
    // we use 'gift:' + gift.id as a synthetic dedup key — distinct
    // from any member UUID, so it counts as one act-of-bringing-in
    // without false-collapsing with anything else.
    const { data: gifts, error: giftsErr } = await supa()
      .from('gifts')
      .select('id, member_id, status')
      .ilike('buyer_email', sponsorEmail)
      .in('status', ['paid', 'pending_acceptance', 'claimed']);
    if (giftsErr) {
      console.warn('countSponsoredBy: gifts lookup failed:', giftsErr.message);
    } else {
      giftDedupIds = (gifts || []).map((r) => r.member_id || ('gift:' + r.id));
    }
  }

  // Union the two sets — distinct recipient identifiers (member_id
  // for claimed rows, synthetic 'gift:<id>' for unclaimed Phase 2
  // gifts). The Set naturally dedupes invite+gift to the same
  // person (both resolve to the same member_id).
  for (const id of giftDedupIds) {
    invertedIds.add(id);
  }

  return invertedIds.size;
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

/**
 * Format the title-bearing name of a member for display in the
 * dashboard's Held in Honour row, in email salutations to titled
 * members, and anywhere else the member is addressed by dignity.
 *
 * CRITICAL: uses member.name (the primary grantee's individual name)
 * NOT member.display_name_on_register (which is the family-display
 * string like 'John Smith & Family' or 'John & Jane Smith'). The
 * sponsorship title attaches to the INDIVIDUAL who did the inviting,
 * not to their family unit. The wife/husband and children do not
 * earn the dignity through the family membership — only the member
 * who holds the account.
 *
 * Examples:
 *   formatTitledName({name: 'John Smith'}, 'Cara')
 *     → 'John Smith, Cara of Ó Comáin'
 *   formatTitledName({name: 'John Smith', display_name_on_register: 'John Smith & Family'}, 'Onóir')
 *     → 'John Smith, Onóir of Ó Comáin'
 *     (NOT 'John Smith & Family, Onóir of Ó Comáin')
 *   formatTitledName({name: 'John Smith'}, null)
 *     → 'John Smith'
 *
 * @param {object} member       — must have { name }
 * @param {string|null} titleIrish — the Irish title form, or null
 * @returns {string}
 */
function formatTitledName(member, titleIrish) {
  if (!member?.name) return '';
  const name = String(member.name).trim();
  if (!titleIrish) return name;
  return `${name}, ${titleIrish} of Ó Comáin`;
}

module.exports = {
  SPONSOR_TITLES,
  recordConversion,
  countSponsoredBy,
  evaluateSponsorTitles,
  highestAwardedTitle,
  formatTitledName,
};
