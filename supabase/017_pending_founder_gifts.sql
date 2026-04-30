-- Migration 017: pending_founder_gifts
--
-- Implements the deferred-acceptance pattern for founder gifts.
-- Before this migration, send-founder-gift.js created a `members`
-- row immediately on Fergus's submit, with status='active' and
-- joined_at=NOW(). This had the unintended consequence that a
-- recipient who never opened the email would still:
--   - Be auto-published to the public Register after 30 days
--   - Have a sponsor count credited (no relevance for founder gifts
--     today, but matters once the same pattern reaches paid gifts)
--   - Be visible in the clan's keeping without ever having said yes
--
-- New flow: Fergus's submit creates a row HERE (pending state). A
-- claim_token (URL-safe) is emailed to the recipient. When the
-- recipient clicks 'Claim my place' on the welcome page, the
-- backend creates the actual `members` row, links it via member_id,
-- and flips status to 'claimed'.
--
-- Lapse: 1 year from creation. After that, status flips to 'lapsed'
-- (handled by a daily cron in Phase 3 — for Phase 1, lapsed rows
-- never naturally appear because no time has passed). The
-- expires_at column is precomputed at insert so the cron's lookup
-- is index-friendly.
--
-- ROLES OF EACH COLUMN:
--   recipient_email/name — captured at submit, used for the welcome
--     email and the eventual `members` row creation
--   tier/tier_label/tier_family — captured at submit, fixed at the
--     moment of gifting (Fergus picks 'clan-ind' or 'plus-ind' etc).
--     Cannot change between gift and claim — same as paid gifts work.
--   personal_note — Fergus's optional one-line note that prepends
--     the welcome email. Only used by the email; no need to surface
--     it to the recipient on claim.
--   claim_token — random UUID embedded in the welcome-email URL.
--     Hard to enumerate (UUIDv4 is 122 random bits). Single use:
--     once status='claimed', the token still exists but the claim
--     endpoint refuses to act on a non-pending row.
--   status — 'pending' | 'claimed' | 'lapsed'. Pending is the only
--     state where the claim endpoint will act. Lapsed is set by
--     cron after 1 year. Claimed is set when the recipient clicks.
--   member_id — NULL while pending or lapsed. Set to the new
--     members.id when status flips to 'claimed'. The FK is set null
--     on member delete so a hard-deleted member doesn't break the
--     pending-gift history.
--   created_at — when Fergus submitted. Doubles as the start of
--     the lapse clock.
--   claimed_at — when the recipient pressed claim. NULL until
--     'claimed'.
--   reminder_sent_at — for the Phase 3 cron — set when the 30-day
--     reminder email is sent so it doesn't fire twice. Stored on
--     the pending row rather than a separate events table because
--     it's a per-pending-gift fact, not a clan-wide event.
--   expires_at — created_at + 1 year. Precomputed for index lookup
--     by the lapse cron in Phase 3. Default is the gen_random_uuid
--     trick where the default expression references now() via a
--     CHECK; here we just use a Postgres default expression.

CREATE TABLE IF NOT EXISTS public.pending_founder_gifts (
  id              uuid primary key default gen_random_uuid(),
  clan_id         uuid not null references public.clans(id) on delete cascade,
  recipient_email text not null,
  recipient_name  text not null,
  tier            text not null,
  tier_label      text,
  tier_family     boolean default false,
  personal_note   text,
  claim_token     uuid not null default gen_random_uuid() unique,
  status          text not null default 'pending',
  member_id       uuid references public.members(id) on delete set null,
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  reminder_sent_at timestamptz,
  expires_at      timestamptz not null default (now() + interval '1 year')
);

-- Tokens are looked up by claim_token on every welcome-page load
-- and every claim POST. Already unique (constraint above creates an
-- implicit index), but we name it for clarity in EXPLAIN output.
CREATE INDEX IF NOT EXISTS pending_founder_gifts_token_idx
  ON public.pending_founder_gifts (claim_token);

-- Admin panel lists by clan + status + sort by created_at desc.
CREATE INDEX IF NOT EXISTS pending_founder_gifts_clan_status_idx
  ON public.pending_founder_gifts (clan_id, status, created_at DESC);

-- Phase 3 reminder cron will scan: status='pending' AND created_at
-- between (now - 30d) and (now - 31d) AND reminder_sent_at IS NULL.
-- Same partial index satisfies the lapse cron (status='pending'
-- AND expires_at <= now()).
CREATE INDEX IF NOT EXISTS pending_founder_gifts_pending_expires_idx
  ON public.pending_founder_gifts (expires_at)
  WHERE status = 'pending';

-- Status check constraint — accept only the three valid values to
-- catch typos in code paths that update status.
ALTER TABLE public.pending_founder_gifts
  DROP CONSTRAINT IF EXISTS pending_founder_gifts_status_check;
ALTER TABLE public.pending_founder_gifts
  ADD CONSTRAINT pending_founder_gifts_status_check
  CHECK (status IN ('pending', 'claimed', 'lapsed'));

-- RLS — same defence-in-depth as other tables. Service role bypasses
-- this; the frontend never queries this table directly anyway (only
-- via Netlify functions).
ALTER TABLE public.pending_founder_gifts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pending_founder_gifts IS
  'Holds founder-gift state between Fergus''s admin-panel submit and the recipient''s claim-click. Member row in `members` is only created on claim. Lapses after 1 year. Phase 1 of the deferred-acceptance redesign — paid gifts will follow the same pattern in Phase 2 via additions to the `gifts` table.';
COMMENT ON COLUMN public.pending_founder_gifts.claim_token IS
  'URL-safe random token in the welcome-email button. Single-use in spirit (claim endpoint refuses non-pending status), permanent in storage so the URL keeps resolving for the welcome page even after claim.';
COMMENT ON COLUMN public.pending_founder_gifts.status IS
  'pending = awaiting recipient claim; claimed = members row exists, member_id set; lapsed = 1 year passed without claim, set by cron.';
