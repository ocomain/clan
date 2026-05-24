-- =====================================================================
-- 036 — member.avatar_url
-- ---------------------------------------------------------------------
-- Adds a persistent profile-level avatar URL on the members table so a
-- headshot uploaded once (e.g. when hosting a gathering) can be re-used
-- in future flows without forcing the member to re-upload.
--
-- The gatherings.host_avatar_url column from migration 034 stays as the
-- per-gathering value (a host can override "Patrick's Day me" for a
-- given year), but in practice the most-recent upload now also flows
-- through to members.avatar_url and becomes the default elsewhere.
--
-- Nullable on purpose — most members in year one have no avatar; new
-- ones populate as members host gatherings or future flows let them
-- upload directly.
-- =====================================================================

alter table public.members
  add column if not exists avatar_url text;

comment on column public.members.avatar_url is
  'Public URL of the member''s profile headshot (in the gathering-avatars Storage bucket). Populated when a host uploads an avatar on the host-gathering form; intended for cross-feature re-use so the member never has to re-upload.';
