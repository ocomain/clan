-- Migration 016: founder_comped_columns
--
-- Documents the founder-comped columns that the codebase references
-- across send-founder-gift.js, list-founder-gifts.js, member-info.js,
-- and members/index.html (the 'Founding Member by warrant of the
-- Chief' italic line).
--
-- These columns appear to already exist in production — they were
-- added directly via Supabase SQL editor at some earlier point but
-- the migration file was never committed to the repo. This file
-- closes the gap so that any fresh environment (preview branch,
-- new staging clan, dev replica) gets a schema that matches what
-- the code expects.
--
-- IF NOT EXISTS guards make this safe to run against production —
-- if the columns are already present (which they should be), the
-- migration is a no-op.
--
-- Columns:
--
--   comped_by_chief  boolean  DEFAULT FALSE
--     TRUE iff the member's row was created via the founder admin
--     tool (members/admin/founders.html → send-founder-gift.js).
--     Read by:
--       - members/index.html → renders the 'Founding Member by
--         warrant of the Chief' italic line under the founder band
--         (line ~396).
--       - list-founder-gifts.js → primary filter (.eq('comped_by_chief', true))
--         that powers the admin panel's status table.
--
--   comped_at  timestamptz
--     The moment the row was created via the founder admin tool.
--     Distinct from joined_at (which on a comped row equals
--     comped_at by construction, but is also set on every other
--     member row including paid and gifted). Used by
--     list-founder-gifts.js for sort order and by the admin panel
--     for the 'sent on' date column.
--
--   comped_note  text
--     The optional one-line personal note from Fergus that
--     prepends the founder welcome email body. Captured from the
--     admin form's 'A word from the Chief' field, truncated to
--     200 chars before insert. Surfaced in the admin panel's
--     'Note' column so the operator can see what was said for
--     each gift.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS comped_by_chief boolean DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS comped_at timestamptz,
  ADD COLUMN IF NOT EXISTS comped_note text;

-- Index on comped_by_chief — list-founder-gifts.js filters on this
-- as its primary predicate. Partial index on TRUE only since the
-- vast majority of rows are FALSE (regular paid + gifted members)
-- and we never query for FALSE explicitly.
CREATE INDEX IF NOT EXISTS members_comped_by_chief_idx
  ON members (comped_at DESC)
  WHERE comped_by_chief = TRUE;

COMMENT ON COLUMN members.comped_by_chief IS
  'TRUE iff this member was created via the founder admin tool (send-founder-gift.js). Used by the dashboard to render the Founding Member by warrant of the Chief line, and by list-founder-gifts.js as the primary filter for the admin panel status table.';
COMMENT ON COLUMN members.comped_at IS
  'When this member was created via the founder admin tool. NULL for non-comped members. Distinct from joined_at (which is set on every member row regardless of how they joined).';
COMMENT ON COLUMN members.comped_note IS
  'The optional one-line personal note from the Chief that prepends the founder welcome email. Captured from the admin form, truncated to 200 chars at insert time.';
