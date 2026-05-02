-- Migration 021: invitation tokens for bulletproof attribution
--
-- Backs the token-based attribution flow for invitation conversions.
-- Each invitation now carries a UUID token that flows through the
-- conversion path:
--
--   1. send-invitation.js writes the row + Postgres assigns a token
--      from the column DEFAULT
--   2. invitation-email.js builds the URL with ?invite=<token>
--   3. /membership.html reads the token, persists to sessionStorage,
--      pre-fills + locks the email field with the invitation's
--      recipient_email
--   4. The token follows through tier-selection → join-chat →
--      /api/create-checkout, which carries it as Stripe session
--      metadata (invite_token=<uuid>)
--   5. Stripe webhook on checkout.session.completed reads
--      metadata.invite_token, looks up the invitation by token,
--      stamps converted_member_id with the new member's id
--
-- Why a token rather than relying on email match?
--
-- The previous system did a recordConversion() lookup by ilike-
-- matching the new member's email against invitations.recipient_email.
-- This silently breaks when the invitee pays at Stripe with a
-- different email than they were invited at — different domain
-- (work vs personal), different alias, different card-on-file. The
-- gift was attributed to no one; the inviter never got dignity
-- credit; nobody knew the credit was lost.
--
-- A token in the URL → sessionStorage → Stripe metadata pipeline
-- carries the link from invitation to conversion regardless of
-- what email the invitee uses at checkout. Same defensive pattern
-- already in place for founder gifts (claim_token) and paid gifts
-- (gifts.claim_token).
--
-- The OLD email-match path is preserved as a fallback in
-- recordConversion (sponsor-service.js) for legacy invitations
-- sent before this migration applied — they have no token so the
-- lookup falls through to email-match. Defensive against half-
-- migrated state.

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS invite_token uuid UNIQUE DEFAULT gen_random_uuid();

-- Backfill any pre-existing rows that don't have a token.
-- (DEFAULT only fires on NEW inserts. Existing rows from before
-- this migration get NULL otherwise.)
UPDATE public.invitations
   SET invite_token = gen_random_uuid()
 WHERE invite_token IS NULL;

-- Index for the lookup that fires on every Stripe webhook
-- checkout.session.completed when metadata.invite_token is present.
CREATE INDEX IF NOT EXISTS idx_invitations_invite_token
  ON public.invitations (invite_token)
  WHERE invite_token IS NOT NULL;

COMMENT ON COLUMN public.invitations.invite_token IS
  'UUID embedded in the invitation email URL as ?invite=<uuid>. Survives the membership.html → join-chat → Stripe metadata pipeline so attribution lands on the right inviter regardless of what email the invitee uses at checkout.';
