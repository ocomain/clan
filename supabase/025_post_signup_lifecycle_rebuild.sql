-- Migration 025: post-signup lifecycle rebuild — new tracking columns
--
-- The post-signup lifecycle has been rewritten from 8 emails over 90
-- days to 10 emails over 330 days. The new cadence is:
--
--   +3    Email 1A/B/C  Herald, register acknowledgment (3 variants)
--   +9    Email 2       Fergus, Chief's letter (Kensington-letterhead PNG)
--   +21   Email 3       Antoin (Cara), how I became Cara
--   +35   Email 4       Linda, bringing the kindred (CONDITIONAL)
--   +60   Email 5       Herald, three titles of dignity
--   +90   Email 6       Michael (Marshall), clan crest in your home
--   +180  Email 7       Paddy (Seanchaí lite), standing of the line
--   +240  Email 8       Jessica-Lily, gathering at Newhall
--   +300  Email 9       Paddy (Seanchaí full), royal house and saint
--   +330  Email 10      Linda, renewal mechanics (CONDITIONAL)
--
-- COLUMN STRATEGY:
--
-- Some columns from migration 022 are reused as-is — same day-offset,
-- different content underneath. The cron and lib are rebuilt; the
-- columns just track "did the day-N email go out for this member."
-- That's a clean reuse:
--   _3_sent_at, _9_sent_at, _60_sent_at, _90_sent_at  (day matches)
--
-- Three columns from migration 022 are now ORPHANED — the days they
-- represented (+18, +28) are no longer in the cadence. We do NOT drop
-- them. They still record historical sends from the old sequence for
-- members who joined before this rebuild. Dropping would lose audit
-- history. Future cron does not query them; they sit as historical
-- record.
--   _18_sent_at        (was: Linda kindred ask)
--   _28_sent_at        (was: Linda gift nudge)
--   _28_skipped        (was: gift-nudge skip flag)
--
-- New columns added by this migration for the new buckets:
--   _21_sent_at        Antoin "how I became Cara"
--   _35_sent_at        Linda "bringing the kindred"  (conditional)
--   _35_skipped        flag for already-converted members at +35
--   _180_sent_at       Paddy lite
--   _240_sent_at       Jessica gathering
--   _300_sent_at       Paddy full
--   _330_sent_at       Linda renewal                 (conditional)
--   _330_skipped       flag for Life-tier members at +330
--
-- CONDITIONAL EMAILS:
--
-- Email 4 (+35, Linda kindred-ask) — fires only when the member has
-- zero successful sponsorships at the moment the cron runs. Members
-- who have already brought one or more into the Register skip
-- entirely; their _35_skipped column is stamped true. Same pattern as
-- the old Email 4 (+28).
--
-- Email 10 (+330, Linda renewal) — fires only for non-Life-tier
-- members. Life Members never renew (their tier is one-and-done).
-- Life Members get _330_skipped stamped true.
--
-- GATING (deferred sends):
--
-- Some new emails come from senders whose DNS forwarding is not yet
-- in place (herald@, antoin@, michael@, jessica@), and Email 2
-- depends on a calligrapher-written PNG that doesn't yet exist. The
-- cron applies a runtime gating check (see daily-post-signup-sweep.js)
-- and defers sends for which prerequisites are unmet. Members in
-- those buckets stay un-stamped, so when the prerequisite arrives,
-- the next bucket-day fires the email naturally. The downside is
-- that members who passed through a bucket-day during the gating
-- window have already aged past it and will never receive that email
-- — accepted tradeoff for not silently sending broken mail.
--
-- The gating check runs in the cron, not the database, so this
-- migration does not encode it. The cron file is the single source
-- of truth for which buckets are currently live.

alter table public.members
  add column if not exists post_signup_email_21_sent_at   timestamptz,
  add column if not exists post_signup_email_35_sent_at   timestamptz,
  add column if not exists post_signup_email_35_skipped   boolean      default false,
  add column if not exists post_signup_email_180_sent_at  timestamptz,
  add column if not exists post_signup_email_240_sent_at  timestamptz,
  add column if not exists post_signup_email_300_sent_at  timestamptz,
  add column if not exists post_signup_email_330_sent_at  timestamptz,
  add column if not exists post_signup_email_330_skipped  boolean      default false;

-- Partial indexes — one per email's "still pending" predicate, to
-- keep the daily cron queries bounded as the members table grows.
-- Same pattern as migration 022.

create index if not exists members_post_signup_e21_pending_idx
  on public.members (created_at)
  where post_signup_email_21_sent_at is null and status = 'active';

create index if not exists members_post_signup_e35_pending_idx
  on public.members (created_at)
  where post_signup_email_35_sent_at is null
    and post_signup_email_35_skipped = false
    and status = 'active';

create index if not exists members_post_signup_e180_pending_idx
  on public.members (created_at)
  where post_signup_email_180_sent_at is null and status = 'active';

create index if not exists members_post_signup_e240_pending_idx
  on public.members (created_at)
  where post_signup_email_240_sent_at is null and status = 'active';

create index if not exists members_post_signup_e300_pending_idx
  on public.members (created_at)
  where post_signup_email_300_sent_at is null and status = 'active';

create index if not exists members_post_signup_e330_pending_idx
  on public.members (created_at)
  where post_signup_email_330_sent_at is null
    and post_signup_email_330_skipped = false
    and status = 'active';
