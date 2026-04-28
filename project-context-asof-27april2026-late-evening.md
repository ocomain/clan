# Clan Ó Comáin — Project Context (late evening, 27 April 2026)

This document is the working handover for the next session. It supersedes the 19 April version. The build has moved fast and lots of new architecture has landed — this captures the locked design decisions, the live state, and the remaining queue.

Live site: https://www.ocomain.org
Repo: github.com/ocomain/clan, branch main
Local clone: /home/claude/clan (git remote uses an embedded PAT — pending revoke)
Stack: Netlify functions + Supabase + Stripe (LIVE) + Resend
Chief: Fergus Commane (NEVER "an Comaineach"). Clan seat: Newhall House, Co. Clare.

---

## Critical operational state

### Credentials
- GitHub PAT: stored in the local clone's git remote URL only — NOT committed to the repo. Pending revoke after build settles. (Remove with `git remote set-url origin https://github.com/ocomain/clan.git` once the PAT is revoked and rotated.)
- Embedded in git remote URL on this clone
- Supabase project ref: `nlrlxoplpjamttwbmgtx`
- ANON key in `members/auth.js` (public, safe)
- Stripe LIVE keys are in Netlify env (sk_live_, NOT mk_)
- Supabase URL configuration: Site URL = https://www.ocomain.org, Redirect URLs = https://www.ocomain.org/**

### Migrations
- 001 through 015 ALL APPLIED in production
- Partial index `idx_invitations_inviter_converted` ALSO applied (future-scaling for sponsor count queries)
- Migration 015 (`sponsor_titles_awarded jsonb DEFAULT '{}'`) is the one that bootstraps the sponsorship system

### Founder admin
- Email allowlist: `clan@ocomain.org` (in `lib/supabase.js` FOUNDER_ADMIN_ALLOWLIST)
- Admin tools at `/members/admin/founders.html`
- When clan@ocomain.org signs in, `members/index.html` auto-redirects to admin/founders.html

---

## SPONSORSHIP ARCHITECTURE — COMPLETE

This is the major addition since 19 April. Members who bring others to the clan earn graded honours.

### The three titles

Path B locked: 1/5/15 thresholds.

| Slug | Irish | Pronunciation | English | Threshold | Register |
|---|---|---|---|---|---|
| `cara` | Cara | KAR-uh | Friend | 1 | Recognition (warm) |
| `onoir` | Onóir | UH-nor | One held in honour | 5 | Distinction (formal) |
| `ardchara` | Ardchara | ARD-khar-uh | Friend of high standing | 15 | Full chivalric warrant |

All three are **gender-neutral**. The dignity attaches to the named primary grantee regardless of gender. Wife/husband/partner/children receive courtesy implications socially but no formal title — same as a knight's spouse is "Lady" by courtesy not by their own knighthood.

Locked design: this matches Gaelic tradition (Cara, Onóir, Ardchara are grammatically masculine in Irish but applied to any person, like *taoiseach*, *file*, *saoi*).

### Locked principles

1. **Raising-and-replacement model** (chivalry-order, not peerage-accretion). When a member crosses a higher threshold, the lower title is "laid by"; only the highest displays publicly. The `sponsor_titles_awarded` JSONB preserves all timestamps as audit trail.

2. **Leapfrog rule**: if a member crosses two thresholds in one event (e.g. 4 → 6 conversions in one publish), they receive ONE title-award letter for the highest title. The lower threshold is silently stamped to the audit log. No awkward double-letter on a single raising.

3. **Bestowal letter greets by NEW title.** "Dia dhuit, Cara James — God be with you." on the letter conferring Cara. "Dia dhuit, Onóir James" on the letter raising James to Onóir. The body of the letter still names both ("raised from Cara to Onóir"); the prior-title context lives in body, not greeting. Earlier draft had this greeting by prior title — simplified per user direction.

4. **Sponsor's Letter and Renewal Email greet by CURRENTLY-HELD title** using the "Title FirstName" form (mirrors "Sir John" chivalric salutation). For untitled members, falls back to first name only.

5. **Title attaches to the INDIVIDUAL primary grantee, NEVER to the family unit.** For family-tier display, always use `member.name` (NOT `display_name_on_register`). The dashboard's *Held in Honour* row, the canonical title-bearing format string, and any future title-aware rendering must use `member.name`. Helper `formatTitledName(member, titleIrish)` enforces this — returns "John Smith, Cara of Ó Comáin" using `member.name`, never the family-display string.

6. **`Le toil an Taoisigh`** (by the will of the Chief) Irish flourish printed above the Herald's sign-off in title-bestowal letters. Not in Sponsor's Letter (different register).

7. **Cert NEVER carries a sponsorship title.** Reading B locked: cert is the founding warrant; titles are post-cert recognition. Public Register is currently un-decorated for sponsor titles (deferred — "maybe later").

8. **Gifts count toward honours.** Both invitations and gifts are acts of bringing-in. Distinguishing them as "this counts, that doesn't" would be arbitrary. **Precedence: gift wins over invitation** (paying for someone is a stronger act than sending them a link).

### Sponsorship code paths

`netlify/functions/lib/sponsor-service.js`:
- `SPONSOR_TITLES` array — per-title language as functions of `priorTitleIrish`. Subject lines, eyebrow, headline, bodyOpening, bestowalIntro, closingNarrative, replacementSentence all switch on first-raising vs raising-from-prior.
- `recordConversion(member, clan_id)` — checks **gifts FIRST** (gift-wins precedence), then invitations. Returns the sponsor's member row if found, null otherwise. Idempotent (stamps `invitations.converted_member_id` on first call). Gift-path lookup uses `gifts.member_id` to find the gift, then `gifts.buyer_email` to find the buyer-as-sponsor in members table. Both paths defensive — gift errors fall through to invitation path rather than aborting.
- `countSponsoredBy(memberId)` — unions invitations and gifts as DISTINCT recipients. JS-side Set union (cheap at the volumes involved). Same recipient invited AND gifted by the same sponsor counts as ONE conversion.
- `evaluateSponsorTitles(member, count)` — returns `{ allNewlyEarned, highestNewlyEarned, previousTitleIrish }`. Caller stamps EVERY entry from `allNewlyEarned` into `sponsor_titles_awarded` (full audit trail), but sends a letter for ONLY `highestNewlyEarned` (leapfrog rule).
- `highestAwardedTitle(awardedJson)` — given the JSONB, returns the current highest-tier title definition or null.
- `formatTitledName(member, titleIrish)` — canonical format. Always uses `member.name`, never `display_name_on_register`.

`netlify/functions/lib/sponsor-email.js`:
- `sendSponsorLetter(sponsor, newMember, sponsorTitle)` — short Herald-voiced acknowledgement, sent on every conversion. Title-aware greeting using sponsor's CURRENT title.
- `sendTitleAwardLetter(sponsor, title, priorTitleIrish, totalCount)` — chivalric-register bestowal letter. Greets by NEW title. Per-title language (Cara warm, Onóir distinction, Ardchara full chivalric with "place and standing belonging to that rank" privileges-clause).

### Hooks in publish flow

Both `submit-family-details.js` and `update-family-details.js` call (inside the publish-now branch):
1. `recordConversion(updated, clan_id)` — finds the sponsor (gift OR invite path)
2. If sponsor found:
   - `sendSponsorLetter(inviter, updated, highestAwardedTitle(inviter.sponsor_titles_awarded))` with title-aware greeting
   - `evaluateSponsorTitles(inviter, newCount)` — checks for newly-earned titles
   - For each `allNewlyEarned`, stamp into JSONB
   - For `highestNewlyEarned`, send the title-bestowal letter with `priorTitleIrish` for raising-from language

Renewal email (`daily-expiry-sweep.js`) also fetches `sponsor_titles_awarded` and passes the highest title to `sendGiftRenewalReminder`, which uses Title-FirstName greeting.

### Dashboard surfaces

`members/index.html`:
- **Held in Honour** row in the mstatus panel (only renders if `member.sponsorTitle` is set). Uses `member.name` only (not `display_name_on_register`). Renders "James Comyn, Cara of Ó Comáin".
- **Sponsor count line** in the invite section: "You have stood as sponsor to N members of the clan." (only when N > 0).
- **Read the order of honours →** link below the count, routes to `/members/honours.html`.

`members/honours.html`:
- Three title cards. Each carries: heading, pronunciation, English meaning, threshold-conferred badge, etymology paragraph, raising-narrative paragraph, **address-formula closing paragraph**, and a centred **address-block** with the formatted name example.
- Address-formula scaling: Cara plain, Onóir lifted ("express command", "shall hereafter acknowledge", "in the dignity now conferred"), Ardchara full chivalric ("sovereign command", "with the place and standing belonging to that rank").
- Drawn structurally from a real Patent of Nobility (Georgian Royal House, 2023) — the privileges-clause that names which circles will refer to the bearer. Three circles named: Privy Council (inner court), Office of the Private Secretary (Chief's official channel), kindred of Ó Comáin "both within and without the boundaries of the clan's historic seat at Newhall" (mirrors the Patent's "within and without the boundaries of Our historic dominions").
- Sovereign-language deliberately scaled DOWN. "Our Sovereign Authority" → "the Chief's command". The clan Chief is not a sovereign; he heads a kindred. Same line that kept us off Tiarna and "cousin to the Chief".
- Ardchara card includes the **Champion-of-welcome** line: "From this raising, the bearer stands in the kindred's keeping as the Chief's named champion of welcome — the member through whom the clan most reaches outward." The qualifier "of welcome" matters — Ardchara isn't a generic champion-of-arms; it's specifically the champion of the act that earns the title.
- Page top-left has a prominent back-to-dashboard button (`.mhdr-back`) — discoverable on every members sub-page now (see Navigation section below).

### Multi-name detection on cert publish

Concern: someone types "John & Mary Smith" or "John and Mary Smith" into the single primary-name field. The cert names ONE primary grantee — multiple names corrupt the cert AND any future title record.

Solution: **soft warning + confirmation pattern**, NOT hard block.

`looksLikeMultipleNames(name)` in `lib/name-format.js` — shared helper, mirrored client-side in `members/index.html`. Triggers on:
- `&`, `+`, `/` as direct connectors
- Word "and" between two capital-letter words (word-boundary regex, both halves must start with capital)

Does NOT trigger on:
- Multiple words alone (middle names: "John Patrick Anthony Smith")
- Hyphenated names ("Anne-Marie Smith", "Smith-Jones")
- Apostrophes ("Mary O'Connor")
- Mac/Mc surnames ("MacDonald")
- Multi-word particle surnames ("van der Berg")
- "Ferdinand Anders" — substring "and" inside a single name doesn't false-positive
- **Comma** — explicitly NOT a trigger. Post-nominals like "John Smith, OBE", "James Smith, PhD", "Mary O'Connor, FRCS" are legitimate single-person constructs

Client side: confirm() dialog with tier-aware guidance (family tier suggests partner/children fields; individual tier mentions Family-tier upgrade) plus escape-valve hint pointing to clan@ocomain.org for genuine edge cases.

Server side: logs `multi_name_in_cert_submit` event for admin review, doesn't block (no security exploit; only the user's own cert affected; admin can fix). Both publish endpoints call this.

19-case smoke test passes cleanly. Verified all the trigger and non-trigger cases including post-nominals.

---

## Recent commits (newest first, late April session)

```
ebc541b — Multi-name detection: drop comma trigger; add clan@ contact escape

8edd696 — Three refinements: bestowal greeting simplified (greet by NEW title not prior),
          gender-neutral titles confirmed in design, multi-name detection on cert publish
          (looksLikeMultipleNames helper in lib/name-format.js, client-side warning +
          server-side event log, 19-case smoke-tested)

84175c5 — Title-aware addressing in emails + dashboard. CRITICAL: primary-grantee extraction
          for family-tier — only the named member earns the dignity, not wife/husband/children.
          Helper formatTitledName(member, titleIrish) uses member.name (not display_name_on_register).
          Dashboard Held in Honour row uses member.name only. Sponsor's Letter, Title-Bestowal
          Letter, Renewal Email all gain title-aware salutations using "Title FirstName" form
          (like "Sir John"). Renewal candidate query updated to include sponsor_titles_awarded.

c089b4c — Onóir address-formula lifted in honours.html ("Chief's express command", "shall
          hereafter acknowledge", "in the dignity now conferred"); Champion-of-welcome line
          added to Ardchara closingNarrative + honours page card body.

410cef6 — Gifts count toward honours (recordConversion now checks gifts table FIRST with
          gift-wins-over-invitation precedence; countSponsoredBy unions gifts and invitations
          as distinct recipients; no schema change). Back-to-dashboard button (.mhdr-back)
          added to all 6 members sub-pages: honours/library/contact/your-line/year/pedigree.
          Mobile-responsive (label hides <520px).

8dac733 — Honours page address-formula closing block on each title card. Drawn from Georgian
          Patent of Nobility reference. Three circles named: Privy Council, Office of the
          Private Secretary, kindred of Ó Comáin (within and without boundaries of historic
          seat at Newhall). Per-title verb scaling (acknowledge/address). Example name
          "James Comyn, [Title] of Ó Comáin" centred block beneath each card.

77d81be — Sign-in lockout fix when migration 015 not yet run + welcome.html footer normalised.
          Critical bug: previous code had sponsor_titles_awarded in main SELECT lists which
          broke sign-in if column missing. Now fetched separately in best-effort sponsor-
          enrichment block. Plus member-info.js now surfaces real Postgres errors as 500
          with diagnostic detail rather than silent 404s. welcome.html footer changed from
          Newhall-address to standard 2-line chrome.

6cdea8e — Copy edits: 3 phrase removals on /join (two "for over a thousand years", one
          "sacred seat in County Clare"); footer chrome normalised across 20 files (drop
          trailing "· www.ocomain.org" from footer-copy on 10 files; prepend "Approved by
          the Chief of Ó Comáin · " to footer-rec on 20 files). Both UTF-8 and HTML-entity
          variants matched.

3974207 — Dashboard: gift CTA section between invite and action grid (full-width card
          linking /gift.html with gold accent + wrapped-gift SVG icon); 6 action cards
          refactored with unique gold-stroke SVG icons (book, quill+scroll, branching tree,
          ribbon-scroll, vertical pedigree spine, heraldic shield) + 3px gold top accent +
          flex column layout.

6844bab — Title bestowal letters chivalric warrant register, per-title language as
          functions of priorTitleIrish.

4b1a67d — Sponsorship architecture base: migration 015, lib/sponsor-service.js,
          lib/sponsor-email.js, hooks in both publish paths, dashboard count + title
          display, member-info.js enrichment.
```

---

## Navigation pattern on members sub-pages

All six members sub-pages (`honours.html`, `library.html`, `contact.html`, `your-line.html`, `year.html`, `pedigree.html`) carry the SAME header chrome with three children:

```
[← Back to dashboard]   [coat-of-arms · Clan Ó Comáin]   [nav links]
```

- `.mhdr-back` is the new far-left button. Gold-bordered, transparent, ← arrow + label.
- The brand still links to `/members/` — secondary path for users who know the logo is clickable.
- Mobile (<520px): the label hides, only the ← arrow shows. Padding tightens too.
- Hover: text and border deepen to gold.

NOT on `members/index.html` (already at destination), `members/login.html` (no back path), `admin/founders.html` (mentioned but never explicitly added — could be follow-up).

---

## DESIGN PRINCIPLES (LOCKED ACROSS PROJECT)

These have been iterated on through the build and now form the operating constitution:

### Voice and tone
- **Restraint with Gaelic** — touches not full mirror translation. "Dia dhuit", "Go raibh míle maith agat", italic pull-quotes. Not the whole site translated.
- **Restraint with ornament** — single wax seal at top of cert; single triquetra at bottom. Not multiple flourishes.
- **Exclusive-club register communicated by understatement** — "by design, a quiet thing", "the small number they would wish".
- **Don't make promises you can't keep** — physical relics, named correspondence with the Chief at scale, etc.
- **The Herald is one consistent character across surfaces** — same voice, same sign-off ("— Clan Herald at Newhall"), Gaelic warrant convention (Chief sends, Herald composes).

### Naming conventions
- NEVER "an Comaineach". "The Commane" only ceremonially.
- Sign-off: "— Clan Herald at Newhall" (single line).
- Fergus signs From-field but Herald signs body.
- Dignity titles always use English "of": "Cara of Ó Comáin", not "Cara de Ó Comáin". Mixing English address structure with Irish "of" would jar.

### Lapse policy
- **Option A**: lapsed → off Public Register; renewal restores. Life Members never lapse.
- Magic phrase **"in current standing"** carries this — used on Public Register, privacy panel, renewal email. One phrase that names the policy without overshooting it.

### Public Register
- Guardian/Steward/Life only. Clan tier NEVER public.
- Children appear only if member ticks `children_visible_on_register` AND is on public register at all.
- Dedication appears only if member ticks `dedication_visible_on_register` (default OFF, per migration 013).
- **Privacy gating principle**: separate "what the member sees of their own record" from "what strangers see publicly". Gate ONLY the public path. Dashboard credit-line shows full sealed record always; privacy gates ONLY the public render path.
- Sponsor titles NOT yet decorated on the public register ("maybe later").

### Family tier
- Under-18 children only. Trust-based, no DOBs.
- Wife/husband/partner: optional `partner_name` field.
- Display formats: "John Smith", "John & Jane Smith" (couple same surname), "John Smith & Jane Doe" (couple diff surname), "John Smith & Family" (with children).
- Single source of truth via `lib/generate-cert.js` helpers: `computeFamilyDisplay`, `computeRegisterDisplay`. Used by cert PDF generator AND by submit/update-family-details.js.

### Email design
- Length must respect mobile reading reality.
- Welcoming but ceremonial — never transactional.
- Standard chrome: small Newhall-address eyebrow, single decorative element max, body in Georgia serif.
- Sign-off in Herald voice.

### What we have explicitly REFUSED
- **Tiarna** — overshoot. Tiarna implies sovereign/territorial nobility we don't have.
- **"Cousin to the Chief"** privilege — overshoot. Public-facing claim of kinship with the Chief draws ridicule from clan-circles readers.
- **Public referral codes / leaderboards / point counters / badges / NEW stickers / time-limited promotions** — not the voice.
- **Nag reminders** — restraint over engagement.
- **Patron** — saints have it. Not the right word for clan members.
- **Dinner invitations** — don't scale.
- **Per-event manual work** — every system has to scale to N members without admin intervention per case.
- **Aire / Ardaire** — two reasons: phonetic echo with Onóir (-or / -ar), AND specific Brehon-law class meaning we'd be misusing.
- **Curadh** — too phonetically and visually similar to Cara.
- **Tánaiste** — Privy Council role + political-Ireland echo.
- **Path 1 (single conferral) over Path 2 (raisings throughout)** — Path 2 was selected.
- **Reading A (cert carries title) over Reading B (cert never carries title)** — Reading B was selected.

---

## KEY FILES — ANNOTATED MAP

### Public surfaces (top-level HTML)
- `index.html`, `register.html`, `welcome.html`, `founder-welcome.html` — entry points
- `membership.html`, `gift.html`, `gift-form.html`, `gift-confirmed.html` — purchase paths
- `join.html`, `patrons.html`, `pedigree.html`, `privy-council.html` — substance pages
- `timeline.html`, `surname-variants.html`, `relics.html`, `coat-of-arms.html`, `heartlands.html` — clan info
- `celtic-heritage-clan.html`, `coman-heritage.html`, `commins-ireland.html`, `commons-ireland.html`, `cummins-heritage.html`, `hurley-o-comain.html`, `irish-diaspora-clan.html` — surname-variant SEO
- `coat_of_arms.png` — site-wide

### Member surfaces
- `members/index.html` — dashboard. Has: founder welcome band, mstatus panel (with Held in Honour row), cert section, family-edit modal, postal-address modal, invite section + count + honours link, **gift CTA section**, action grid (6 cards with icons)
- `members/login.html` — magic-link sign-in. `auth.js` does sendMagicLink with same-origin nextUrl
- `members/honours.html` — order-of-honours explainer (3 title cards with address-formula blocks)
- `members/library.html` — clan library access
- `members/contact.html` — Council correspondence
- `members/your-line.html` — submit your line of descent
- `members/year.html` — annual chronicle
- `members/pedigree.html` — full clan pedigree
- `members/admin/founders.html` — founder admin tool
- `members/gaelic-name-converter.js` — module for Gaelic name lookups

### Backend (Netlify functions)

**Shared libs** (`netlify/functions/lib/`):
- `supabase.js` — supa() client, clanId() helper, logEvent helper, FOUNDER_ADMIN_ALLOWLIST, canAppearOnPublicRegister
- `email.js` — Resend wrapper
- `cert-service.js` — `ensureCertificate` with half-publish recovery
- `generate-cert.js` — PDF generator + `computeFamilyDisplay` + `computeRegisterDisplay`
- `name-format.js` — `autoFixName` (Mc/Mac/O' caps) + `looksLikeMultipleNames` (multi-name detection)
- `sponsor-service.js` — SPONSOR_TITLES, recordConversion, countSponsoredBy, evaluateSponsorTitles, highestAwardedTitle, formatTitledName
- `sponsor-email.js` — sendSponsorLetter, sendTitleAwardLetter
- `invitation-email.js` — sendInvitation
- `publication-email.js` — sendPublicationConfirmation, sendGiftBuyerCertKeepsake
- `founder-email.js` — founder welcome
- `notify-giver-activated.js` — UNUSED, can be removed (carry-forward)

**Functions** (`netlify/functions/`):
- `register.js` — fetch public register
- `member-info.js` — dashboard data; gracefully degrades if migration 015 missing; surfaces real Postgres errors as 500 with diagnostic detail
- `submit-family-details.js` — first-publish path
- `update-family-details.js` — re-edit path; both call sponsor flow + multi-name backstop logging
- `generate-certificate.js` — PDF rendering API
- `daily-expiry-sweep.js` — cron job; renewal email with title-aware greeting; "in current standing" magic phrase
- `send-invitation.js` — invite endpoint
- `invitation-unsubscribe.js` — unsub endpoint
- `send-founder-gift.js`, `list-founder-gifts.js` — admin gift tool
- `stripe-webhook.js` — purchase → member creation
- `welcome-signin.js` — post-purchase magic-link

### Schema
- `supabase/001_init.sql` through `015_sponsor_titles.sql` — all applied
- Plus partial index `idx_invitations_inviter_converted` applied separately (future-scaling)

---

## CURRENT WORK — ALL COMMITTED AND PUSHED

Nothing in flight. Latest commit `ebc541b`. The Netlify deploy will be triggered automatically on push.

---

## OUTSTANDING QUEUE

| Item | Status |
|---|---|
| Test sign-in fix + sponsor flow end-to-end (invite path) | After deploy |
| Test sponsor flow (gift path) | After deploy |
| Test honours page (Onóir + Ardchara new lines, address-formula blocks) | After deploy |
| Test new gift CTA + action card icons | After deploy |
| Test welcome.html new footer | After deploy |
| Test family-tier Held in Honour row (when family member earns title) | After someone earns one |
| Test multi-name detection client warning + server log | Try by typing "John & Mary" |
| Test back-button on sub-pages | Visit each sub-page |
| Test title-aware salutation in real emails | After someone earns a title |
| Public Register decoration for sponsor titles | Deferred ("maybe later") |
| Public footer link to /register | Pending (after founders seeded by Fergus) |
| Revoke and rotate the GitHub PAT | Pending (after build settles) |
| Cert PDF orphans manual cleanup in Supabase Storage | Pending |
| Remove unused `notify-giver-activated.js` | HOLD pending OK |
| Remove dead STRIPE constant in gift-form.html lines 350-362 | HOLD pending OK |
| Add back-button to admin/founders.html | Optional follow-up |

### Wipe-all SQL when ready for real founders
```sql
DELETE FROM certificates;
DELETE FROM gifts;
DELETE FROM applications;
DELETE FROM events;
DELETE FROM members;
```
Plus Supabase Dashboard → Authentication → Users → delete (NOT via SQL).
Plus Storage bucket cleanup via Dashboard.

---

## OPERATING NOTES FOR THE NEXT SESSION

1. **Migration 015 is applied** — sponsor flow works end-to-end. The graceful degradation in member-info.js is now a defensive measure rather than a workaround.

2. **The sponsor flow has been built but not yet end-to-end tested with real users.** Linda (user) hasn't yet had a real friend invite-and-publish to test the full chain. Once that happens, all these surfaces become observably real:
   - Sponsor's Letter arriving with title-aware greeting
   - Title-bestowal letter with chivalric register
   - Held in Honour row appearing on dashboard
   - Sponsor count line ticking up
   - Multi-letter handling on threshold-crossing publishes

3. **Critical line about family-tier title display**: ALWAYS use `member.name`, NEVER `display_name_on_register`. The title attaches to the individual primary grantee, not the family unit. `formatTitledName(member, titleIrish)` enforces this. If you write any new code that surfaces a sponsorship title, route through this helper.

4. **The bestowal greeting now uses NEW title (not prior title).** This was simplified after first-pass implementation. Reading consistently across all three titles whether first-raising or raising-from-prior.

5. **Multi-name detection is opt-out on the client (confirm dialog), best-effort log on the server.** No hard block. Comma is allowed (post-nominals).

6. **Honours page address-formula structure is drawn from a real Patent of Nobility** (Georgian Royal House, Duke of Gardabani, 2023). The architecture is lifted but the sovereign-language was scaled DOWN — "Our Sovereign Authority" → "the Chief's command", "Our nobles, officials" → "the Privy Council, the Office of the Private Secretary", "those who owe allegiance to Our Crown" → "the kindred of Ó Comáin". Same line that kept us off Tiarna. The clan Chief is not a sovereign; he heads a kindred.

7. **The "Champion of welcome" framing is specific to Ardchara.** The qualifier "of welcome" is what keeps it from overshooting into generic-champion-of-arms. Worth preserving exactly as written.

8. **Footer chrome is now standardised** across 20+ pages with the two-line pattern:
   - © 2025–2026 Tigh Uí Chomáin · House of Ó Comáin · All rights reserved
   - Approved by the Chief of Ó Comáin · Recognised by Clans of Ireland · Patronage of the President of Ireland

9. **Most member sub-pages have a `.mhdr-back` button** in the top-left of their header. The dashboard itself doesn't (already at destination). Login doesn't (no back path).

10. **Future-scaling index `idx_invitations_inviter_converted`** is already applied — partial index on `invitations(inviter_member_id)` where `converted_member_id IS NOT NULL`. Cheap on disk, instant lookup for sponsor counts at scale.

---

## DESIGN PHILOSOPHY (CONTINUITY)

Captured here so it doesn't drift.

- "In current standing" magic phrase carries lapse policy
- Restraint with Gaelic — touches not full mirror translation
- Restraint with ornament — single wax seal, single triquetra
- Don't make promises you can't keep
- Herald is one consistent character across surfaces
- Single source of truth for family display
- Email length must respect mobile reading reality
- Fergus signs From-field but Herald signs body
- Exclusive-club register communicated by understatement
- Dashboard credit-line shows full sealed record always; privacy gates ONLY on public render path
- Half-publish recovery: never trust cert_locked_at alone
- When refactoring container identification, grep for ALL selectors
- Cert is founding warrant; titles are post-cert recognition (Reading B)
- Chivalry-order replacement model not peerage accretion: lower titles laid by
- No awkward double-letter on same-day raising (leapfrog rule)
- Title attaches to INDIVIDUAL primary grantee, never family unit
- Don't claim sovereign authority — Chief commands within the kindred, not over a polity
- Don't compare titles to Knight/Earl/Archduke on user-facing pages — let them stand on their own
- Comma is legitimate punctuation (post-nominals); '&', '+', '/', ' and ' are the multi-name signals
- Champion-of-welcome qualifier matters — Ardchara is specifically the champion of bringing-in, not generic
- Address-formula on honours.html: three circles (Privy Council, Office of the Private Secretary, kindred of Ó Comáin within and without the boundaries of the historic seat at Newhall)

---

## CLAN PEDIGREE / CONTENT ACCURACY

Earlier sessions (March-April) settled most of the pedigree corrections per Gibson, Cotter, and Try sources. Key recent commits in this area:
- `728ab5f` — Pedigree geographic precision: Cahercommane as Déisi-Muman sept seat (correcting earlier framing)
- `334f806` — Corrected Corcu Mruad geography per Gibson Fig 11.1
- `8772733` — Pedigree fn18: refined Ferchess sourcing after reading Try (2020) thesis Appendix B
- `152a68b` — Pedigree fn18: Ferchess mac Commáin sourced properly

The pedigree surfaces (`pedigree.html`, `members/pedigree.html`) are now verified against primary sources. If you touch this content, the source files in `/mnt/project/` are the ones to consult.

---

## END OF HANDOVER

This document captures everything from the late-April session. The build is in a strong state — sponsorship architecture complete and verified by smoke tests, design principles locked, navigation improved, footer chrome normalised, copy edits done.

Next session priorities (in suggested order):
1. **Test the sponsor flow end-to-end** with a real second account (invite + publish + verify all letters arrive correctly)
2. **Verify the multi-name detection** by trying to publish with various test inputs
3. **Walk every page on mobile** to verify the new back-button + footer rendering
4. **Decide on Public Register decoration** for sponsor titles (deferred)
5. **Decide on public footer link to /register** (after founders seeded)
6. **Revoke and rotate the GitHub PAT**
7. **Manual cleanup of orphaned cert PDFs** in Supabase Storage

Live site: https://www.ocomain.org
Latest commit: `ebc541b`
