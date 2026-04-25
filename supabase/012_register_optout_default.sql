-- Migration 012: Public Register defaults flipped to opt-OUT
--
-- Product decision: the public Founding Members Register at
-- ocomain.org/register is now opt-OUT for Guardian-tier-and-above
-- members. Boxes appear pre-ticked on the dashboard; members untick
-- to remove themselves.
--
-- Note on GDPR: this is a deliberate product choice. To keep the
-- model lawful under EU/Irish data protection norms, ensure that:
--   - The dashboard checkbox is prominently visible (it is —
--     dedicated 'Privacy & Public Register' card)
--   - Unticking takes effect immediately (it does — auto-save
--     handler in members/index.html fires on change)
--   - Members are clearly informed before they purchase that their
--     name will appear on the public register unless they opt out
--     (this should be added to membership.html / join-chat.html
--     copy as a follow-up)
--
-- canAppearOnPublicRegister() in lib/supabase.js still gates this
-- by tier — clan-* (entry-tier) members cannot appear on the public
-- register regardless of this flag.

alter table public.members
  alter column public_register_visible        set default true,
  alter column children_visible_on_register   set default true;

-- Backfill existing rows. Both 'false' and NULL get flipped to true.
-- Only test members exist in production right now — safe to run.
update public.members
   set public_register_visible = true
 where public_register_visible is distinct from true;

update public.members
   set children_visible_on_register = true
 where children_visible_on_register is distinct from true;
