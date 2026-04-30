-- Migration 018: gifts_claim_token
--
-- Extends the existing public.gifts table with the columns needed
-- for the deferred-acceptance flow shipped in Phase 2 (paid Stripe
-- gifts now require recipient to press 'Claim my place' before a
-- members row is created).
--
-- Phase 1 (founder gifts) used a brand-new pending_founder_gifts
-- table because there was no existing artefact for founder comps.
-- Paid gifts already have the gifts table from migration 001 with
-- nullable member_id, so we extend it in place rather than create a
-- parallel table.
--
-- COLUMN ROLES
--
--   claim_token — random UUID embedded in the gift email's URL.
--     Same pattern as pending_founder_gifts.claim_token: 122 random
--     bits, sent only via email to the recipient. Single-use in
--     spirit (claim endpoint refuses non-pending status), permanent
--     in storage so the URL keeps resolving for the welcome page
--     after claim.
--
--   expires_at — when the gift lapses if unclaimed. Default is
--     created_at + 1 year, mirroring founder-gifts. Phase 3 cron
--     will sweep this column to flip status to 'lapsed'. The
--     claim endpoint also defensively checks this directly, so
--     a click after expiry is refused even if the cron is late.
--
--   reminder_sent_at — for the Phase 3 cron — set when the 30-day
--     reminder email is sent so it doesn't fire twice.
--
--   claimed_at — when the recipient pressed 'Claim my place'.
--     NULL until status flips to 'claimed'. Distinct from
--     sent_to_recipient_at (which records when the welcome email
--     was dispatched, the original moment of "gift sent").
--
-- STATUS TAXONOMY (gifts.status, expanded)
--
--   pending_delivery       (default from migration 001) — Stripe
--                           webhook hasn't seen this gift yet
--   paid                   (set by webhook) — payment confirmed,
--                           buyer notified, recipient emailed
--   pending_acceptance     (NEW, Phase 2) — same as 'paid' but
--                           explicit about awaiting recipient action.
--                           Synonym in practice; we'll write 'paid'
--                           and use status='paid' AND member_id
--                           IS NULL as the test for "awaiting claim"
--   claimed                (NEW, Phase 2) — recipient pressed claim,
--                           members row exists, member_id set
--   lapsed                 (NEW, Phase 2) — 1 year passed without
--                           claim. Terminal. No member ever created.
--                           Buyer keeps any sponsor credit awarded
--                           at payment time.
--
-- We don't add a CHECK constraint on status because the existing
-- table allows free-text status values (pre-existing rows may have
-- been written with values not in our new taxonomy — better to
-- preserve them than drop a constraint that breaks them).

ALTER TABLE public.gifts
  ADD COLUMN IF NOT EXISTS claim_token uuid DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Backfill expires_at for any new rows where it wasn't set —
-- created_at + 1 year. Existing rows pre-Phase 2 don't get
-- backfilled (they were already processed under the old flow
-- where lapse didn't apply; their member rows already exist).
-- This is just a safety net for any row created in the gap
-- between the migration running and the new code deploying.
UPDATE public.gifts
  SET expires_at = created_at + interval '1 year'
  WHERE expires_at IS NULL
    AND status IN ('paid', 'pending_acceptance')
    AND member_id IS NULL;

-- Token lookup index — claim-paid-gift.js and lookup-pending-gift.js
-- both query by claim_token. Already implicitly indexed by the
-- UNIQUE constraint above, but we name it for EXPLAIN clarity.
CREATE INDEX IF NOT EXISTS gifts_claim_token_idx
  ON public.gifts (claim_token);

-- Phase 3 cron predicate index — finds pending paid gifts approaching
-- the 30-day reminder window or the 1-year lapse window.
CREATE INDEX IF NOT EXISTS gifts_pending_expires_idx
  ON public.gifts (expires_at)
  WHERE status IN ('paid', 'pending_acceptance') AND member_id IS NULL;

COMMENT ON COLUMN public.gifts.claim_token IS
  'URL-safe random token in the gift email button. UUIDv4 = 122 bits of entropy. Single-use in spirit (claim endpoint refuses non-pending), permanent in storage.';
COMMENT ON COLUMN public.gifts.expires_at IS
  'When the unclaimed gift lapses. Defaults to created_at + 1 year. Phase 3 cron sweeps this to flip status to lapsed.';
COMMENT ON COLUMN public.gifts.reminder_sent_at IS
  'Set when the 30-day reminder email is sent (Phase 3 cron). Prevents double-fire.';
COMMENT ON COLUMN public.gifts.claimed_at IS
  'When the recipient pressed Claim my place. NULL until claimed.';
