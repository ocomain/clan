-- Migration 019: sign_in_tokens
--
-- Backs the one-click sign-in URLs embedded in member emails
-- (post-purchase welcome, cert publication reminder, abandoned-
-- checkout reminder for existing members, etc).
--
-- The pattern: when an email is being composed for an existing
-- member, the sender first calls issueSignInToken(memberId, purpose)
-- which writes a row here and returns a URL. The URL points at
-- /api/signin?token=<uuid>. When the recipient clicks, the endpoint
-- looks up the token, marks it used, generates a fresh Supabase
-- magic-link via admin API, and 302s the browser there — landing
-- the recipient signed in to /members/.
--
-- Why a separate table rather than reusing pending_founder_gifts /
-- gifts.claim_token: those tables represent gift state. A sign-in
-- token is a separate concept — it can be issued for ANY existing
-- member for ANY email touchpoint (cert reminder, welcome, etc).
-- Keeping the concerns separate avoids overloading the gift flow.
--
-- Why long TTL (30 days default): short Supabase magiclink expiry
-- (~1 hour) creates "your link expired" friction. The recipient
-- might open the email at 9am and not click until 6pm, or might
-- find the email in their inbox a week later. 30 days covers the
-- realistic engagement window for transactional clan emails. The
-- single-use guard (used_at) compensates for the long TTL by
-- ensuring a leaked URL can only be used once.
--
-- Why single-use (used_at): if a recipient forwards their cert
-- reminder email to a family member ('look what I got!'), and the
-- family member clicks first, that uses up the token. The original
-- recipient on second click gets the friendly fallback ('your
-- session needs refreshing — please request a sign-in link to
-- your inbox'). Slightly user-hostile in that one specific edge
-- case, but the alternative (multi-use) means anyone with the URL
-- can repeatedly sign in indefinitely. Single-use is the right
-- safety/usability balance for transactional emails.
--
-- Why an audit trail of issued + used tokens: helps diagnose
-- "I clicked the link and it didn't work" reports. The endpoint
-- logs the lookup result, and the row preserves used_at +
-- created_at so we can reconstruct what happened.

CREATE TABLE IF NOT EXISTS public.sign_in_tokens (
  -- Token itself. UUIDv4 = 122 bits of entropy. The URL-safe
  -- representation in emails is just the standard hyphenated form.
  token         uuid primary key default gen_random_uuid(),

  -- Which member this token signs in. FK with cascade-delete: if
  -- the member is hard-deleted, their pending tokens vanish too.
  member_id     uuid not null references public.members(id) on delete cascade,

  -- Categorical label for analytics + diagnostics. Not enforced
  -- — any string accepted — but the issueSignInToken helper
  -- documents the conventional values: 'welcome_self', 'welcome_gift',
  -- 'cert_reminder', 'abandoned_reminder', etc.
  purpose       text not null,

  -- When the token was issued. Used for analytics + cron cleanup.
  created_at    timestamptz not null default now(),

  -- When the token expires. Default = created_at + 30 days. Issuer
  -- can override for shorter-lived contexts.
  expires_at    timestamptz not null default (now() + interval '30 days'),

  -- When the token was used (NULL = unused). Single-use semantics
  -- enforced in the /api/signin endpoint by checking this is null
  -- before proceeding.
  used_at       timestamptz,

  -- The user-agent of the click that used the token. Stored for
  -- diagnostics — if a user reports 'I clicked twice and it
  -- worked the second time but not the first', this helps see
  -- whether mail-scanner pre-fetches were involved (some
  -- corporate mail filters fetch URLs to preview them, which
  -- would consume a single-use token before the user clicks).
  used_user_agent text
);

-- Lookup index: every /api/signin request queries by token.
-- Implicit (PK), but named for EXPLAIN clarity.
CREATE INDEX IF NOT EXISTS sign_in_tokens_token_idx
  ON public.sign_in_tokens (token);

-- Cleanup index: a Phase 4 cron (not yet implemented) could sweep
-- used + expired tokens older than 90 days to keep the table small.
CREATE INDEX IF NOT EXISTS sign_in_tokens_expires_idx
  ON public.sign_in_tokens (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE public.sign_in_tokens ENABLE ROW LEVEL SECURITY;

-- No RLS policies added — only the service role (via Netlify
-- Functions) writes/reads this table. RLS-enabled but no
-- policies = nothing readable from the frontend, which is what
-- we want.

COMMENT ON TABLE public.sign_in_tokens IS
  'One-click sign-in tokens for transactional member emails. Single-use, 30-day TTL by default. /api/signin endpoint consumes these. Issued by lib/signin-token.js helper.';
COMMENT ON COLUMN public.sign_in_tokens.purpose IS
  'Categorical label: welcome_self | welcome_gift | cert_reminder | abandoned_reminder | etc. For analytics + diagnostics; not enforced.';
COMMENT ON COLUMN public.sign_in_tokens.used_at IS
  'NULL = unused. Set on first /api/signin click. Single-use prevents forwarded-email session hijacks.';
