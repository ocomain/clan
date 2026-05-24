-- ─────────────────────────────────────────────────────────────────────
-- 035 — Oath of Standing
--
-- The Oath of Standing is a one-time ceremonial transaction available
-- to members from a year and a day on the Register (created_at + 366
-- days). The act and date of swearing are recorded on members.oath_sworn_at.
--
-- Server-side gate enforces the +366 threshold; the page UI mirrors
-- the gate, but the function is the source of truth.
--
-- Idempotent: once oath_sworn_at is set, subsequent calls to the swear
-- endpoint reject (the act cannot be undone or re-sworn).
-- ─────────────────────────────────────────────────────────────────────

alter table public.members
  add column if not exists oath_sworn_at timestamptz;

-- Partial index for any future "members who have sworn" lookups
-- (e.g. members area "Honour Roll of Standing"). Same pattern as
-- the post-signup email tracking indices.
create index if not exists idx_members_oath_sworn
  on public.members (oath_sworn_at)
  where oath_sworn_at is not null;
