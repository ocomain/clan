-- Migration 006: Gift-recipient T-30 renewal reminder tracking
--
-- Adds gift_renewal_reminded_at to the members table. Stamped by the
-- daily-expiry-sweep function when a T-30 "your year with the clan is
-- ending" email is sent to a gift recipient. Used as a once-only guard so
-- re-runs of the daily sweep don't send duplicate reminders.
--
-- Scoped deliberately: this column is specifically for the GIFT-RECIPIENT
-- one-time-purchase case. Regular annual-subscriber renewals (where Stripe
-- auto-charges) will get their own tracking columns in a later migration
-- when that workflow is built.
--
-- Partial index speeds up the daily sweep's target query:
-- "find members whose gift membership ends between 28-32 days out and
--  haven't been reminded yet".

alter table public.members
  add column if not exists gift_renewal_reminded_at timestamptz;

-- Partial index over just the population the sweep cares about:
-- members with an expires_at set (excludes Life members), no reminder
-- sent yet, and an active status. Small index, fast lookup.
create index if not exists members_gift_renewal_pending_idx
  on public.members (clan_id, expires_at)
  where gift_renewal_reminded_at is null
    and expires_at is not null
    and status = 'active';
