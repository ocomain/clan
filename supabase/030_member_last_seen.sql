-- Migration 030: Member last_seen_at heartbeat
--
-- Adds a single timestamptz column to public.members. Populated by
-- a fire-and-forget UPDATE inside member-info (the dashboard's
-- load-time API call) every time a signed-in member loads /members/.
--
-- Purpose: low-cost engagement signal for the operator dashboard at
-- /members/admin/members.html. "Active in the last week" is a far
-- more useful filter than "auth_user_id IS NOT NULL" — that latter
-- only tells you they signed in once, ever. last_seen_at tells you
-- they came back.
--
-- WHAT THIS IS NOT:
-- This is NOT per-page tracking, browsing history, or behavioural
-- analytics. It records ONE timestamp per member: the most recent
-- time they loaded the members area dashboard. Single row update,
-- last-write-wins, no log of prior visits beyond what's already in
-- the events table.
--
-- WHY THIS IS THE RIGHT SHAPE:
-- We considered fuller engagement tracking (page-by-page, dwell
-- time, etc.) and explicitly rejected it on privacy grounds.
-- Members signed up for a heritage clan, not a surveillance
-- product. A single "last seen" timestamp is enough to detect
-- lapsed engagement and is something most members would consent
-- to without thinking — it's the same signal a forum profile
-- would expose.
--
-- BACKFILL:
-- Existing members get NULL until their next dashboard load. That
-- naturally categorises them as "no recent activity" until they
-- come back, which is the correct semantic — we don't have data
-- about their activity prior to this migration.

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Optional index. Anticipated query is "members where last_seen_at >
-- now() - interval '7 days'" for activity filters on the admin
-- dashboard. At ~50 members the index is overkill; included for when
-- the count grows past a few hundred and the sort/filter cost matters.
CREATE INDEX IF NOT EXISTS members_last_seen_at_idx
  ON public.members (last_seen_at DESC NULLS LAST);

COMMENT ON COLUMN public.members.last_seen_at IS
  'Most recent time the member loaded the members-area dashboard. '
  'Stamped fire-and-forget by netlify/functions/member-info.js. '
  'Single timestamp per member, NOT a page-view history.';
