-- Migration 013: dedication_visible_on_register
--
-- Adds a privacy gate for the ancestor dedication on the public Register.
-- Until now, dedications stored in members.ancestor_dedication were
-- ALWAYS rendered on the public Register if the member was opted in
-- to register visibility — there was no way to keep the dedication
-- private from the public view while still having it printed on the
-- cert PDF (which is the member's private keepsake).
--
-- New column:
--
--   dedication_visible_on_register  boolean  DEFAULT FALSE  NOT NULL
--
-- Behaviour:
--   - DEFAULT FALSE (opt-in, like children_visible_on_register).
--     Dedications are personal — most members will be fine with the
--     cert showing it but not necessarily the public Register.
--   - When TRUE: register.js will include ancestor_dedication in the
--     payload to register.html for that row.
--   - When FALSE: register.js sets ancestor_dedication to null for
--     that row, hiding it from the public view.
--   - Independent of public_register_visible: a member who isn't on
--     the public register at all has this flag set but irrelevant.
--   - Independent of children_visible_on_register: dedication and
--     children visibility are separate decisions.
--
-- BACKFILL NOTE: setting DEFAULT FALSE means existing members who
-- already have a dedication AND are on the public Register will
-- have their dedications HIDDEN from the public Register starting
-- on this migration's deploy. This is intentional — the previous
-- exposure was unintentional (no privacy gate existed). Members can
-- opt their dedication back into the public view via the new
-- 'Show my dedication on the public Register' tickbox in the
-- members-area publish/edit modal.
--
-- The cert PDF is unchanged — dedications continue to print on the
-- private keepsake regardless of this flag's value.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS dedication_visible_on_register boolean DEFAULT FALSE NOT NULL;

-- Index unnecessary — this column is read alongside other register
-- visibility flags in the existing query path; no new index access
-- pattern is introduced.

COMMENT ON COLUMN members.dedication_visible_on_register IS
  'When TRUE, the member''s ancestor_dedication is included in the public Register render. When FALSE (default), the dedication remains on the cert PDF only. Independent of public_register_visible and children_visible_on_register.';
