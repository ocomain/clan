-- Migration 008: Ancestor dedication + name-on-cert confirmation
--
-- Extends the members table to support two additional cert personalisations
-- that came out of the post-payment welcome-page design:
--
-- 1. ANCESTOR DEDICATION
--    Free-text field the member can fill in to honour a named ancestor
--    (living or late) on the cert. Renders as a small italic line above
--    the signature. Example: "In memory of my grandfather Patrick Cummins
--    of Ennistymon, 1908-1984". Optional and opt-in - members who skip it
--    get the cert without any dedication line.
--
-- 2. NAME-ON-CERT CONFIRMATION
--    The Herald chat captures names as free text. This sometimes results
--    in inconsistent capitalisation ("fergus commane"), wrong casing on
--    Irish-prefix surnames ("O'brien" -> needs to be "O'Brien"), or typos
--    that a member notices only after paying. The welcome-page workflow
--    now shows the name-as-captured and lets the member confirm or correct
--    how it will appear on their cert before the PDF is generated.
--
--    name_confirmed_on_cert flag tracks whether the member has seen and
--    confirmed (or corrected) this. Members whose flag is false still
--    have their certs rendered from the raw member.name, but the dashboard
--    will prompt them to confirm next time they log in.

alter table public.members
  add column if not exists ancestor_dedication text,
  add column if not exists name_confirmed_on_cert boolean not null default false;
