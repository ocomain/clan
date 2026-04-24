-- Migration 007: Family member details + Public Register consent
--
-- Adds the columns needed to support Family-tier memberships properly:
--
-- 1. FAMILY DETAILS — captured POST-PAYMENT on the welcome page (so we don't
--    introduce friction before the conversion happens). All optional. Empty
--    family details just means the member has chosen not to record them yet.
--
--    partner_name             — text, nullable. Spouse / partner name.
--    children_first_names     — text[] array, nullable. First names ONLY for
--                               privacy reasons (children may be minors).
--    display_name_on_register — text, nullable. Computed at write time by
--                               submit-family-details based on what was
--                               provided ("John Cummins & Family" vs
--                               "John & Mary Cummins" vs "Mary Cummins").
--    family_details_completed_at — timestamptz. When the welcome-page form
--                                  was submitted (or family details otherwise
--                                  completed via the dashboard).
--
-- 2. PUBLIC REGISTER OPT-IN — explicit consent, default OFF. GDPR-clean:
--    members are processed for membership purposes by default, but public
--    display is a SEPARATE processing purpose requiring explicit opt-in.
--
--    public_register_visible       — boolean, default FALSE. The member
--                                    appears on /register only when TRUE.
--    children_visible_on_register  — boolean, default FALSE. Even if the
--                                    membership is publicly visible, the
--                                    children's first names are HIDDEN unless
--                                    this is also TRUE. Two-layer consent
--                                    because children's privacy deserves the
--                                    extra care.
--    public_register_opted_in_at   — timestamptz, nullable. Stamped the first
--                                    time public_register_visible flips to
--                                    TRUE. Provides a consent-timing audit
--                                    trail.
--    public_register_settings_updated_at — timestamptz, nullable. Stamped on
--                                          ANY change to either visibility
--                                          flag, so changes-of-mind are
--                                          tracked over time.
--
-- 3. CERT VERSION — supports cert regeneration when family details are added
--    or changed. Avoids the existing cert cache returning a stale primary-
--    only cert after a member adds their family.
--
--    cert_version  — integer, default 1. Incremented when the cert is
--                    regenerated. The cert filename in storage embeds the
--                    version, so old versions are cleanly superseded.

alter table public.members
  add column if not exists partner_name text,
  add column if not exists children_first_names text[],
  add column if not exists display_name_on_register text,
  add column if not exists family_details_completed_at timestamptz,
  add column if not exists public_register_visible boolean not null default false,
  add column if not exists children_visible_on_register boolean not null default false,
  add column if not exists public_register_opted_in_at timestamptz,
  add column if not exists public_register_settings_updated_at timestamptz,
  add column if not exists cert_version integer not null default 1;

-- Partial index supporting the future /register public page query.
-- Small, fast, only contains rows that are actually publishable.
create index if not exists members_public_register_idx
  on public.members (clan_id, joined_at)
  where public_register_visible = true and status = 'active';
