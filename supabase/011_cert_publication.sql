-- Migration 011: Cert publication model
--
-- Refactors the cert lifecycle from "auto-generated at payment, regenerated
-- on edits, locked after 30 days" to "draft until member publishes, with
-- 30-day publication deadline, locked once published."
--
-- New canonical field: cert_published_at
-- - NULL: cert is in draft state. No PDF exists. Member can edit cert
--   details freely and preview their cert as live HTML in the browser.
-- - SET: cert is published. PDF generated, sealed, sent by email.
--   Further edits to cert-affecting fields are blocked.
--
-- The existing cert_locked_at field (added in migration 009) is now
-- semantically equivalent to cert_published_at — both mean "no further
-- PDF regeneration." We set both to the same value at publish time,
-- so any code still checking cert_locked_at continues to work.
--
-- Auto-publication: the daily sweep finds members with cert_published_at
-- IS NULL AND joined_at < now() - 30 days, applies name auto-fix to the
-- Herald-captured name, publishes the cert, and emails it. This guarantees
-- every paid member eventually receives their cert even if they never
-- engage with the welcome flow.
--
-- A "reminder sent at day 29" tracker lets the sweep know whether the
-- 24-hour-warning email has been sent for this member, so we don't spam
-- them.

alter table public.members
  add column if not exists cert_published_at timestamptz,
  add column if not exists cert_publish_reminder_sent_at timestamptz;

-- Index supports the daily sweep query: find members past their grace
-- window who still haven't published. Partial index keeps it tiny.
create index if not exists members_cert_unpublished_idx
  on public.members (joined_at)
  where cert_published_at is null
    and status = 'active';
