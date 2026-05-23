-- Migration 033: Gatherings + RSVPs — the St Patrick's Day map.
--
-- ───────────────────────────────────────────────────────────────────────
-- DESIGN
-- ───────────────────────────────────────────────────────────────────────
-- The public-facing /la-fheile-padraig page renders a world map of clan
-- member-hosted St Patrick's Day pub gatherings. Members host (one pin
-- each per year), members RSVP. Walk-ins welcome for anyone — RSVPs are
-- a member-only mechanic.
--
-- Two tables, both clan_id-scoped (multi-tenant ready, same pattern as
-- members / broadcasts).
--
--   gatherings           One row per (member, gathering_date) — the
--                        pub, the time, the host's display name and
--                        message, the moderation status, and the
--                        geocoded lat/lng for the map pin.
--
--   gathering_rsvps      One row per (gathering, member) — who has
--                        digitally said they'll attend, with optional
--                        guest count + short note to the host.
--
-- The unique constraint on (clan_id, host_member_id, gathering_date)
-- means one member can host one pin per date — no accidental duplicates,
-- and edits are upserts on that key.
--
-- ───────────────────────────────────────────────────────────────────────
-- MODERATION
-- ───────────────────────────────────────────────────────────────────────
-- For the founding cycle (2027), gatherings auto-publish from active
-- members — no moderation queue. The Office is notified by email on
-- every new gathering (via the host-upsert function) and can flip
-- status to 'hidden' from the admin UI if abuse appears. The bar for
-- abuse is low: the audience is paid members of a Gaelic heritage
-- clan, not the open internet.
--
-- status values:
--   'published'  → visible on the public map and to RSVPers
--   'hidden'     → office removed it (still in DB for audit)
--   'cancelled'  → host cancelled it themselves
--
-- ───────────────────────────────────────────────────────────────────────
-- TIME ZONES
-- ───────────────────────────────────────────────────────────────────────
-- The starts_local_time is stored as a text string like "19:00" and
-- displayed verbatim. Time zone is implicit from venue_country / city.
-- We intentionally avoid UTC conversion — "7pm at the Crow's Nest in
-- Newmarket" is what the host means, and that's what cousins in
-- Newmarket should see. A traveller in another time zone reading the
-- map will understand "19:00" means local pub time, same as any
-- printed event listing.
--
-- ───────────────────────────────────────────────────────────────────────
-- GEO
-- ───────────────────────────────────────────────────────────────────────
-- venue_lat / venue_lng are populated via Nominatim (OpenStreetMap's
-- free geocoder, 1 req/sec) when the host enters the venue. The
-- client-side host form posts the resolved coordinates with the
-- create/update request. We don't re-geocode server-side — if a
-- coordinate looks suspicious (zero, out of range), reject the
-- submission and ask the host to re-pick.
--
-- numeric(9,6) gives ±6 decimal places of precision, which is roughly
-- 11cm — far more than needed but the standard PostGIS-compatible
-- shape. No PostGIS dependency for v1; lat/lng are read raw and
-- handed to Leaflet client-side.
--
-- ───────────────────────────────────────────────────────────────────────
-- RLS
-- ───────────────────────────────────────────────────────────────────────
-- Both tables have RLS enabled with no policies — service role bypass
-- only. All access is via Netlify functions which use the service
-- key (see lib/supabase.js). Public listing is via gathering-list.js
-- which is a public endpoint (no auth) and applies its own filter
-- (status='published', gathering_date in the requested year).
-- ───────────────────────────────────────────────────────────────────────

-- ── gatherings table ──────────────────────────────────────────────────
create table if not exists public.gatherings (
  id                  uuid primary key default gen_random_uuid(),
  clan_id             uuid not null references public.clans(id) on delete cascade,
  host_member_id      uuid not null references public.members(id) on delete cascade,

  -- Which day this pin is for. Always March 17 in practice but we
  -- store the actual date so the same table could carry other annual
  -- gatherings (Imbolc, Bealtaine, the autumn Homecoming) without
  -- schema changes.
  gathering_date      date not null,

  -- Public-facing host details. host_display_name is what shows on the
  -- map pin — the host may want "Sean from Newmarket" rather than
  -- their full registered name. Falls back to members.name when null.
  host_display_name   text,
  message             text,                              -- short note from host (rendered as-is, capped)

  -- Pub details — venue_name + address are required, the rest are
  -- denormalised conveniences so the public listing endpoint doesn't
  -- need to parse the address each request.
  venue_name          text not null,
  venue_address       text not null,
  venue_city          text not null,
  venue_country       text not null,                     -- ISO 3166-1 alpha-2 ('IE', 'US', 'CA', 'GB', 'AU' etc.)
  venue_lat           numeric(9,6) not null,
  venue_lng           numeric(9,6) not null,
  venue_url           text,                              -- optional Google Maps / pub website link

  -- Time on the gathering_date, in the venue's local time zone.
  -- Stored as text, rendered as text. See header comment.
  starts_local_time   text not null,                     -- e.g. "19:00", "20:30"

  -- Lifecycle
  status              text not null default 'published',
  hidden_reason       text,                              -- admin note when status='hidden'

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint gatherings_status_check
    check (status in ('published','hidden','cancelled')),
  constraint gatherings_lat_check  check (venue_lat  between -90  and 90),
  constraint gatherings_lng_check  check (venue_lng  between -180 and 180),
  constraint gatherings_country_check check (length(venue_country) = 2),

  -- One host = one pin per date per clan. Edits are upserts on this key.
  unique (clan_id, host_member_id, gathering_date)
);

-- Hot path: the public-listing endpoint filters published gatherings
-- for a given year. Partial index keeps it tight as cancelled/hidden
-- rows accumulate.
create index if not exists idx_gatherings_clan_date_published
  on public.gatherings (clan_id, gathering_date)
  where status = 'published';

-- Host-side lookup: "show me my gathering" — used by the dashboard
-- card and the host page.
create index if not exists idx_gatherings_host
  on public.gatherings (host_member_id, gathering_date desc);

-- Updated-at maintenance trigger — same pattern as the other tables
-- in the schema (members, gifts, etc. all have an updated_at column
-- that the application is expected to bump on write; we don't enforce
-- it via trigger anywhere else in this schema, so neither do we here).

alter table public.gatherings enable row level security;

-- ── gathering_rsvps table ─────────────────────────────────────────────
create table if not exists public.gathering_rsvps (
  id                  uuid primary key default gen_random_uuid(),
  gathering_id        uuid not null references public.gatherings(id) on delete cascade,
  member_id           uuid not null references public.members(id) on delete cascade,
  guest_count         integer not null default 1,        -- self + how many extras (1 = just me)
  note                text,                              -- short note to the host, optional
  created_at          timestamptz not null default now(),

  constraint rsvps_guest_count_check
    check (guest_count > 0 and guest_count <= 12),

  -- One RSVP per member per gathering. Update changes guest_count/note;
  -- delete = cancellation.
  unique (gathering_id, member_id)
);

-- Hot path: gathering detail card sums RSVPs by gathering_id.
create index if not exists idx_rsvps_gathering
  on public.gathering_rsvps (gathering_id);

-- Member view: "what have I RSVP'd to" — small index, used by the
-- dashboard.
create index if not exists idx_rsvps_member
  on public.gathering_rsvps (member_id);

alter table public.gathering_rsvps enable row level security;

-- ── No policies — service role bypass only ────────────────────────────
-- All reads and writes go via Netlify functions using the service key.
-- The public listing endpoint applies its own status filter; the
-- host/RSVP endpoints verify JWT → member.status='active' before write.
