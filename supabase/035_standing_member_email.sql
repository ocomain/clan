-- ─────────────────────────────────────────────────────────────────────
-- 035 — Standing Member transition email
--
-- A new step in the post-signup lifecycle: at +366 days (a year and
-- a day after the member's created_at), Linda writes again to confirm
-- the threshold has been crossed and the member is now a Standing
-- Member of Clan Ó Comáin — with voting rights at the AGM. This is
-- the practical embodiment of the Brehon "year and a day" framing
-- that Email 10 (+330) introduces.
--
-- Tracking column follows the post_signup_email_{N}_sent_at convention
-- established by migrations 022/025. Partial index keeps the per-day
-- bucket query bounded as the member base grows.
--
-- Unlike Email 10, this email is NOT skipped for any tier — Life
-- members also become Standing Members at year + 1, even though they
-- have no renewal event. The transition is a function of time-on-
-- the-Register, not subscription status.
-- ─────────────────────────────────────────────────────────────────────

alter table public.members
  add column if not exists post_signup_email_366_sent_at timestamptz;

-- Partial index — only rows where the email is still pending. Matches
-- the existing pattern from 022/025 so the daily sweep can find
-- candidates without a full table scan as the member base grows.
create index if not exists idx_members_post_signup_e366_pending
  on public.members (created_at)
  where post_signup_email_366_sent_at is null
    and status = 'active';
