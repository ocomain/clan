-- Migration 031: Council broadcasts — admin-composed one-time emails sent
-- by named Council members (Maria, Antoin, Jessica, Herald) to the
-- active membership.
--
-- ───────────────────────────────────────────────────────────────────────
-- DESIGN
-- ───────────────────────────────────────────────────────────────────────
-- Two tables:
--
--   broadcasts                 The composed broadcast itself —
--                              one row per broadcast Maria/Antoin/etc
--                              send. Composed in admin, scheduled,
--                              then sent in two waves.
--
--   member_broadcast_sends     One row per (broadcast, member) pair.
--                              Driven by a 15-minute cron that
--                              releases queued sends whose release_at
--                              has passed.
--
-- Stewards/Life Members get their copy at start_at (the immediate
-- batch). Everyone else gets their copy at start_at + 24h (the
-- delayed batch). The same cron sweep handles both — it just looks
-- at release_at on each row.
--
-- Idempotency is enforced via the claim_token pattern from the
-- post-signup sweep: each row stamps a claim_token before sending,
-- and only the row that successfully claims the slot is allowed to
-- send. Concurrent crons + manual reruns can't double-send.
--
-- ───────────────────────────────────────────────────────────────────────
-- COLUMN NOTES
-- ───────────────────────────────────────────────────────────────────────
-- broadcasts.start_at — when the immediate (Steward/Life) batch
--   should release. Members who are not Steward/Life get release_at
--   set to start_at + 24h.
--
-- broadcasts.status — the lifecycle stamp on the broadcast as a
--   whole. 'scheduled' = composed and start_at is in the future;
--   'sending' = start_at has passed and the sweep is processing
--   sends; 'sent' = all sends terminal (sent or failed);
--   'cancelled' = admin cancelled before start_at.
--
-- broadcasts.sender_voice — drives which from address, signature,
--   eyebrow text is used at render time. See
--   netlify/functions/lib/broadcast-email.js.
--
-- member_broadcast_sends.status — per-row lifecycle. 'queued'
--   awaiting release_at. 'sent' = Resend accepted the email.
--   'failed' = Resend or template rendering threw an error;
--   error_message preserved for retry triage.
--
-- member_broadcast_sends.is_immediate_batch — at-write-time flag
--   so retry logic and reporting know which footer variant was
--   intended (and to make admin reporting trivial — "X stewards
--   received it today, Y other members will receive it tomorrow").
--
-- ───────────────────────────────────────────────────────────────────────
-- ALSO ADDED: members.email_unsubscribed_at
-- ───────────────────────────────────────────────────────────────────────
-- Active broadcasts filter to (status='active' AND cert_published_at
-- IS NOT NULL AND email_unsubscribed_at IS NULL). The third column
-- is added by this migration since it didn't previously exist on
-- members. Default null = subscribed. Unsubscribe endpoint stamps
-- the column with now() — never deletes the member, never deletes
-- their email; just suppresses future broadcasts to them.

-- ───────────────────────────────────────────────────────────────────────
-- Add unsubscribe column to members
-- ───────────────────────────────────────────────────────────────────────
alter table public.members
  add column if not exists email_unsubscribed_at timestamptz;

-- Index — broadcast sweeps filter on this every 15min; a partial
-- index (only rows where the value is null = still subscribed)
-- keeps the index small as the unsubscribe list grows.
create index if not exists idx_members_subscribed
  on public.members(clan_id, status)
  where email_unsubscribed_at is null;

-- ───────────────────────────────────────────────────────────────────────
-- broadcasts table
-- ───────────────────────────────────────────────────────────────────────
create table if not exists public.broadcasts (
  id                  uuid primary key default gen_random_uuid(),
  clan_id             uuid not null references public.clans(id) on delete cascade,
  created_by          text not null,                    -- admin email
  created_at          timestamptz not null default now(),

  -- Composed content
  sender_voice        text not null,                    -- 'maria'|'antoin'|'jessica'|'herald'
  subject             text not null,
  body_md             text not null,
  cta_label           text,                             -- optional CTA button
  cta_url             text,

  -- Scheduling
  start_at            timestamptz not null,             -- when immediate batch releases
  status              text not null default 'scheduled',
                                                        -- scheduled|sending|sent|cancelled

  -- Reporting counts (denormalised; updated as sends terminal)
  immediate_count     integer not null default 0,       -- Stewards + Life targeted
  delayed_count       integer not null default 0,       -- everyone else targeted
  sent_count          integer not null default 0,
  failed_count        integer not null default 0,

  constraint broadcasts_sender_voice_check
    check (sender_voice in ('maria','antoin','jessica','herald','fergus','linda')),
  constraint broadcasts_status_check
    check (status in ('scheduled','sending','sent','cancelled'))
);

-- Cron sweep needs to find broadcasts that have entered their
-- start_at window. Index covers the (status, start_at) lookup.
create index if not exists idx_broadcasts_scheduled
  on public.broadcasts(status, start_at)
  where status in ('scheduled','sending');

-- Admin history list — most recent first.
create index if not exists idx_broadcasts_clan_recent
  on public.broadcasts(clan_id, created_at desc);

alter table public.broadcasts enable row level security;

-- ───────────────────────────────────────────────────────────────────────
-- member_broadcast_sends table — one row per (broadcast, member)
-- ───────────────────────────────────────────────────────────────────────
create table if not exists public.member_broadcast_sends (
  id                  uuid primary key default gen_random_uuid(),
  broadcast_id        uuid not null references public.broadcasts(id) on delete cascade,
  member_id           uuid not null references public.members(id) on delete cascade,

  -- Per-row lifecycle
  status              text not null default 'queued',   -- queued|sent|failed
  release_at          timestamptz not null,             -- = broadcast.start_at OR +24h
  is_immediate_batch  boolean not null,                 -- T = Steward/Life footer
  sent_at             timestamptz,
  error_message       text,

  -- Idempotency claim pattern (same as daily-post-signup-sweep)
  claim_token         uuid,
  claimed_at          timestamptz,

  created_at          timestamptz not null default now(),

  constraint mbs_status_check
    check (status in ('queued','sent','failed')),
  unique (broadcast_id, member_id)
);

-- The hot path: cron sweep finds queued sends whose release_at has
-- passed. Partial index keeps it tight as sent rows accumulate.
create index if not exists idx_mbs_release
  on public.member_broadcast_sends(release_at)
  where status = 'queued';

-- Reporting: counts by broadcast — admin history shows per-broadcast
-- totals.
create index if not exists idx_mbs_broadcast
  on public.member_broadcast_sends(broadcast_id, status);

alter table public.member_broadcast_sends enable row level security;

-- ───────────────────────────────────────────────────────────────────────
-- RLS — admin-only access. No policies = service role only (the
-- broadcast endpoints all use the service role; no member-facing
-- access to either table).
-- ───────────────────────────────────────────────────────────────────────
-- (Intentionally no GRANT statements — service role bypasses RLS.)
