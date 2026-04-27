-- Migration 015: Sponsor-title tracking on members
--
-- Supports the sponsorship/referral architecture:
--   - The Sponsor's Letter (Herald-voiced email when an invitee
--     converts) — sent every time, no state needed beyond the
--     invitations table that already tracks converted_member_id.
--   - Quiet sponsor-count line on the dashboard — computed on
--     read from invitations (no schema change needed for this).
--   - Gaelic honorific titles awarded at 1 / 5 / 15 conversions:
--       Cara      (Friend) at 1
--       Onóir     (One held in honour) at 5
--       Ardchara  (Friend of high standing) at 15
--     Each title triggers a one-time Herald letter to the sponsor.
--     We must NOT re-send these on every save — hence this
--     migration adds a tracking column.
--
-- WHY ON members RATHER THAN A SEPARATE TABLE
-- The state is small (a few booleans-ish flags per member) and
-- always read alongside other member data. A separate table would
-- mean an extra query on every dashboard render. Compact JSONB on
-- the members row keeps it cheap.
--
-- WHY JSONB RATHER THAN THREE BOOLEAN COLUMNS
-- Forward compatibility. If we later add a fourth title or remove
-- one, no schema migration needed — we just adjust the keys we
-- read/write. Also keeps the members table from accruing
-- title-specific columns that future readers have to interpret.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS sponsor_titles_awarded jsonb NOT NULL DEFAULT '{}';

-- Shape of the JSONB:
--   {
--     "cara":      "2026-04-27T20:13:00Z",   -- ISO timestamp when awarded
--     "onoir":     "2026-06-01T14:22:00Z",
--     "ardchara":  null                       -- not yet earned
--   }
-- Missing keys = not yet awarded. Null values are equivalent to
-- missing. Once a key has a non-null timestamp, the title-awarder
-- skips that title on subsequent runs (idempotency).

COMMENT ON COLUMN members.sponsor_titles_awarded IS
  'Tracks which sponsor titles (Cara/Onóir/Ardchara) have been awarded to this member and when. JSONB shape: {"cara":"<iso>","onoir":"<iso>","ardchara":"<iso>"}. Used by the title-awarding logic to ensure each Herald letter fires exactly once per threshold crossing.';
