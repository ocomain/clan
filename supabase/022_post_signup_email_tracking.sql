-- Migration 022: post-signup email lifecycle tracking
--
-- Adds six timestamp columns to the members table, one per email in the
-- post-signup lifecycle sequence. Each column is set to now() at the
-- moment the corresponding email is sent by daily-post-signup-sweep.js,
-- providing per-member idempotency.
--
-- The cron sweep runs daily and finds members whose age-since-signup
-- (computed from members.created_at) falls within the appropriate
-- bucket AND whose tracking column is still NULL. Once stamped, the
-- email is never re-sent for that member.
--
-- Why named after the day-offset rather than the email name? Two
-- reasons:
--   1. The day-offsets are stable across iterations of the copy. The
--      "Email 3" name might change as we iterate, but the +18-day
--      slot is the slot.
--   2. Reading members rows in the dashboard, "post_signup_email_18_
--      sent_at" is immediately legible as "the +18 day mail".
--
-- Email 1 (Herald, register acknowledgment) has three variants but
-- only one tracking column — exactly one of {1A, 1B, 1C} fires per
-- member based on tier and public_register_visible flag.
--
-- Email 4 (gift-angle nudge) is conditional — fires only when
-- countSponsoredBy(member.id) === 0 at the moment the cron runs.
-- Members who have already converted at least one invitation or
-- given at least one redeemed gift skip this email entirely; their
-- tracking column is stamped with a sentinel value so the cron does
-- not retry. (See post_signup_email_28_skipped column.)

alter table public.members
  add column if not exists post_signup_email_3_sent_at   timestamptz,
  add column if not exists post_signup_email_9_sent_at   timestamptz,
  add column if not exists post_signup_email_18_sent_at  timestamptz,
  add column if not exists post_signup_email_28_sent_at  timestamptz,
  add column if not exists post_signup_email_28_skipped  boolean      default false,
  add column if not exists post_signup_email_60_sent_at  timestamptz,
  add column if not exists post_signup_email_90_sent_at  timestamptz;

-- Partial indexes for the cron sweep. Each index covers the "needs
-- this email" predicate so the daily query is bounded and fast even
-- when the members table grows large. The cron filters by
-- created_at + N days, so an index on created_at among unsent rows
-- is exactly what speeds up the sweep.
create index if not exists members_post_signup_e3_pending_idx
  on public.members (created_at)
  where post_signup_email_3_sent_at is null and status = 'active';

create index if not exists members_post_signup_e9_pending_idx
  on public.members (created_at)
  where post_signup_email_9_sent_at is null and status = 'active';

create index if not exists members_post_signup_e18_pending_idx
  on public.members (created_at)
  where post_signup_email_18_sent_at is null and status = 'active';

create index if not exists members_post_signup_e28_pending_idx
  on public.members (created_at)
  where post_signup_email_28_sent_at is null and post_signup_email_28_skipped = false and status = 'active';

create index if not exists members_post_signup_e60_pending_idx
  on public.members (created_at)
  where post_signup_email_60_sent_at is null and status = 'active';

create index if not exists members_post_signup_e90_pending_idx
  on public.members (created_at)
  where post_signup_email_90_sent_at is null and status = 'active';
