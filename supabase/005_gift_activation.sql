-- Migration 005: Gift activation tracking
--
-- Adds activated_notified_at to the gifts table. Set to a timestamp when the
-- "your gift was accepted" email is sent to the giver. Used as a once-only
-- guard so repeat sign-ins by the recipient don't spam the giver with
-- duplicate activation notices.
--
-- Why: the member-info function links auth_user_id on first-ever API call
-- after sign-in. That's a reliable first-activation signal. But because that
-- function is idempotent (it links once and reuses the link thereafter), we
-- need a separate column on gifts to track whether the giver has already been
-- notified. If the recipient signs out and signs back in weeks later, the
-- giver shouldn't get another "your gift was accepted" email.

alter table public.gifts
  add column if not exists activated_notified_at timestamptz;

-- Index for the notification batch worker (not needed by the webhook itself,
-- but a 'gifts waiting to be notified' lookup should be fast).
create index if not exists gifts_activation_pending_idx
  on public.gifts (clan_id, member_id)
  where activated_notified_at is null and member_id is not null;
