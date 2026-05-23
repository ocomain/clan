-- ─────────────────────────────────────────────────────────────────────
-- 034 — gathering host avatar
--
-- Adds an optional host_avatar_url to the gatherings table so the map
-- popup can show a small portrait of the host alongside the venue
-- details. The Office can paint avatars onto seed pins (e.g. Antóin
-- at Waxy O'Connor's London) by setting this column directly; when
-- the host-form UI grows an avatar-upload field, the same column will
-- be populated through gathering-host-upsert.js.
--
-- Nullable on purpose: most hosts won't supply an avatar in year one,
-- and the popup gracefully falls back to a name-only layout. We do NOT
-- denormalise from members.avatar_url; the gathering carries its own
-- value so a host can choose a different photo for "Patrick's Day me"
-- vs their default member profile picture if they want to.
-- ─────────────────────────────────────────────────────────────────────

alter table public.gatherings
  add column if not exists host_avatar_url text;
