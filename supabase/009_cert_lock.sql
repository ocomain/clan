-- Migration 009: Cert lock / 30-day grace window
--
-- A Family/Individual membership certificate is a one-time heraldic
-- instrument. But members need a grace period after payment to perfect it:
-- correct Herald-chat capitalisation, add family details, add an ancestor
-- dedication. The grace window balances both truths:
--
--   - Heraldic tradition: the cert is issued ONCE, not reissued casually
--   - Modern UX: members paying online deserve a chance to get it right
--
-- The lock works like this:
--
--   cert_locked_at  — timestamptz, nullable
--     NULL  → cert still in grace window, edits regenerate the PDF freely
--     SET   → cert is locked, edits update the member row + Register at
--             Newhall but DO NOT regenerate the PDF file. A "request a
--             new cert" workflow (manual, via Linda) handles exceptional
--             cases post-lock.
--
-- The timestamp is set 30 days after the cert is FIRST issued (not 30 days
-- after payment). This gives late-engaging members a fair window starting
-- from when they actually produced their cert.
--
-- Server-side enforcement only. The UI surfaces the lock status to members
-- honestly, but all enforcement lives in the submit/update functions that
-- gate cert regeneration.

alter table public.members
  add column if not exists cert_locked_at timestamptz;

-- Index supports any future admin queries by lock state.
create index if not exists members_cert_locked_idx
  on public.members (cert_locked_at)
  where cert_locked_at is not null;
