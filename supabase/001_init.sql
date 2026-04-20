-- ============================================================================
-- THE SEPT — MULTI-TENANT PLATFORM SCHEMA
-- ============================================================================
-- Designed from day one for N clan brands running on one Stripe account,
-- one Supabase project, one codebase. Every row carries clan_id so a clan
-- only ever sees their own data via Row Level Security.
--
-- To apply: paste this into Supabase SQL Editor and run. Safe to re-run —
-- uses "create if not exists" and "drop policy if exists" throughout.
-- ============================================================================

-- ── 1. CLANS (the tenant table) ────────────────────────────────────────────
create table if not exists public.clans (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,             -- e.g. 'ocomain', 'mccarthy'
  name                  text not null,                    -- e.g. 'Clan Ó Comáin'
  chief_name            text,                             -- e.g. 'Fergus Kinfauns, The Commane'
  chief_email           text,
  domain                text,                             -- e.g. 'www.ocomain.org'
  stripe_product_ids    jsonb default '{}'::jsonb,        -- { "clan-ind": "prod_xxx", ... }
  brand_colors          jsonb default '{}'::jsonb,        -- { "gold": "#B8975A", "ink": "#0C1A0C" }
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists clans_slug_idx   on public.clans (slug);
create index if not exists clans_domain_idx on public.clans (domain);

-- ── 2. MEMBERS (joined paying members) ─────────────────────────────────────
create table if not exists public.members (
  id                      uuid primary key default gen_random_uuid(),
  clan_id                 uuid not null references public.clans(id) on delete cascade,
  email                   text not null,
  name                    text,
  tier                    text,                           -- 'clan-ind', 'guardian-fam', etc.
  tier_label              text,                           -- 'Clan Member (Family)' (display)
  tier_family             boolean default false,
  stripe_customer_id      text,
  stripe_subscription_id  text,                           -- null for Life tier (one-time)
  status                  text not null default 'active', -- active, cancelled, lapsed, refunded
  joined_at               timestamptz not null default now(),
  renewed_at              timestamptz,
  expires_at              timestamptz,                    -- null for Life members
  auth_user_id            uuid references auth.users(id) on delete set null,
  metadata                jsonb default '{}'::jsonb,      -- country, connection, source, etc.
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists members_clan_idx        on public.members (clan_id);
create index if not exists members_email_idx       on public.members (clan_id, email);
create index if not exists members_stripe_cust_idx on public.members (stripe_customer_id);
create index if not exists members_auth_user_idx   on public.members (auth_user_id);
create unique index if not exists members_clan_email_uniq on public.members (clan_id, lower(email));

-- ── 3. GIFTS (gift memberships) ────────────────────────────────────────────
create table if not exists public.gifts (
  id                     uuid primary key default gen_random_uuid(),
  clan_id                uuid not null references public.clans(id) on delete cascade,
  -- Giver
  buyer_email            text not null,
  buyer_name             text,
  -- Recipient
  recipient_email        text,
  recipient_name         text,
  recipient_address      text,                            -- for physical certificate delivery
  -- Gift details
  tier                   text,
  tier_label             text,
  tier_family            boolean default false,
  gift_mode              text default 'onetime',          -- 'onetime' or 'recurring'
  personal_message       text,
  -- Fulfilment
  stripe_session_id      text,
  member_id              uuid references public.members(id) on delete set null,  -- the member created when recipient redeems
  sent_to_recipient_at   timestamptz,
  status                 text not null default 'pending_delivery',
  created_at             timestamptz not null default now()
);

create index if not exists gifts_clan_idx      on public.gifts (clan_id);
create index if not exists gifts_buyer_idx     on public.gifts (clan_id, buyer_email);
create index if not exists gifts_recipient_idx on public.gifts (clan_id, recipient_email);

-- ── 4. APPLICATIONS (herald submissions awaiting payment) ──────────────────
-- This is the table that unlocks *proper* abandoned-checkout emails —
-- captures the email at herald form submission, not only at Stripe.
create table if not exists public.applications (
  id                      uuid primary key default gen_random_uuid(),
  clan_id                 uuid not null references public.clans(id) on delete cascade,
  email                   text not null,
  name                    text,
  tier                    text,
  country                 text,
  connection              text,
  source                  text,
  status                  text not null default 'pending', -- pending, paid, abandoned, expired
  stripe_session_id       text,
  reminder_sent_at        timestamptz,
  member_id               uuid references public.members(id) on delete set null,
  submitted_at            timestamptz not null default now()
);

create index if not exists applications_clan_idx   on public.applications (clan_id);
create index if not exists applications_status_idx on public.applications (clan_id, status, submitted_at);
create index if not exists applications_email_idx  on public.applications (clan_id, lower(email));

-- ── 5. EVENTS (audit log — useful for debugging and future analytics) ──────
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  clan_id     uuid references public.clans(id) on delete cascade,
  member_id   uuid references public.members(id) on delete set null,
  event_type  text not null,
  payload     jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists events_clan_idx   on public.events (clan_id, created_at desc);
create index if not exists events_member_idx on public.events (member_id, created_at desc);
create index if not exists events_type_idx   on public.events (event_type, created_at desc);

-- ── 6. CERTIFICATES (issued certificates — track versions for re-issue) ────
create table if not exists public.certificates (
  id            uuid primary key default gen_random_uuid(),
  clan_id       uuid not null references public.clans(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  version       int not null default 1,
  storage_path  text,                                     -- path inside Supabase Storage
  issued_at     timestamptz not null default now()
);

create index if not exists certs_member_idx on public.certificates (member_id, version desc);

-- ── 7. ROW LEVEL SECURITY ──────────────────────────────────────────────────
-- Enable RLS on every table. Default = deny. Then add specific policies.
alter table public.clans          enable row level security;
alter table public.members        enable row level security;
alter table public.gifts          enable row level security;
alter table public.applications   enable row level security;
alter table public.events         enable row level security;
alter table public.certificates   enable row level security;

-- The service_role key bypasses RLS by design — used by Netlify functions.
-- For now the frontend also reads via functions (not direct supabase-js),
-- so RLS is a belt-and-braces safety net. Specific member-facing policies
-- will be added when the /members area ships.

-- Members reading their own row (for the members' area login flow)
drop policy if exists "members_self_read" on public.members;
create policy "members_self_read" on public.members
  for select using (auth.uid() = auth_user_id);

-- Members reading their own certificates
drop policy if exists "certificates_self_read" on public.certificates;
create policy "certificates_self_read" on public.certificates
  for select using (exists (
    select 1 from public.members m where m.id = certificates.member_id and m.auth_user_id = auth.uid()
  ));

-- Clans table: public read of display fields (name, domain, brand_colors)
-- — needed by the frontend to render correctly on each clan's domain.
drop policy if exists "clans_public_read" on public.clans;
create policy "clans_public_read" on public.clans
  for select using (true);

-- ── 8. UPDATED_AT TRIGGER (keep updated_at fresh on modifications) ─────────
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clans_updated_at   on public.clans;
drop trigger if exists members_updated_at on public.members;
create trigger clans_updated_at   before update on public.clans   for each row execute function public.tg_set_updated_at();
create trigger members_updated_at before update on public.members for each row execute function public.tg_set_updated_at();

-- ── 9. SEED THE FIRST TENANT — CLAN Ó COMÁIN ───────────────────────────────
-- Skip if already inserted (idempotent).
insert into public.clans (slug, name, chief_name, chief_email, domain, stripe_product_ids, brand_colors)
values (
  'ocomain',
  'Clan Ó Comáin',
  'Fergus Kinfauns, The Commane',
  'clan@ocomain.org',
  'www.ocomain.org',
  jsonb_build_object(
    'clan-ind',      'plink_1TNp9tGfSdEqTqSZr7hu4V0j',
    'clan-fam',      'plink_1TNp9tGfSdEqTqSZqqQraXd6',
    'guardian-ind',  'plink_1TNp9uGfSdEqTqSZ56qxyyBz',
    'guardian-fam',  'plink_1TNp9uGfSdEqTqSZWpKnRUck',
    'steward-ind',   'plink_1TNp9vGfSdEqTqSZL0ZGPEat',
    'steward-fam',   'plink_1TNp9wGfSdEqTqSZHDiwy0tK',
    'life-ind',      'plink_1TNp9wGfSdEqTqSZwC9v3qGX',
    'life-fam',      'plink_1TNp9xGfSdEqTqSZviDapJEZ'
  ),
  jsonb_build_object(
    'gold',      '#B8975A',
    'gold_pale', '#D4B87A',
    'ink',       '#0C1A0C',
    'ink_mid',   '#142514',
    'cream',     '#F8F4EC'
  )
) on conflict (slug) do nothing;

-- ============================================================================
-- SCHEMA CREATED.
-- Next: copy the Project URL, anon key, and the service_role (sb_secret_) key
-- into Netlify → Site settings → Environment variables:
--   SUPABASE_URL           = https://nlrlxoplpjamttwbmgtx.supabase.co
--   SUPABASE_ANON_KEY      = sb_publishable_...
--   SUPABASE_SERVICE_KEY   = sb_secret_...
-- ============================================================================
