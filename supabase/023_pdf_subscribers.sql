-- Migration 023: PDF lead-magnet subscriber lifecycle
--
-- Captures email subscribers from the /roots landing page and tracks
-- their progress through the five-email lead-magnet lifecycle dispatched
-- by daily-pdf-lead-sweep.js.
--
-- LIFECYCLE:
--   visitor enters email at /roots
--     ↓
--   row inserted with confirmed_at = NULL
--     ↓
--   confirmation email sent (double opt-in for ePrivacy / CAN-SPAM compliance)
--     ↓
--   recipient clicks confirm link
--     ↓
--   confirmed_at set + Email 1 (PDF delivery) fired immediately
--     ↓
--   daily cron dispatches Emails 2/3/4/5 at +3/+10/+21/+35 days
--     ↓
--   if subscriber becomes a paying member (matched by email):
--     - the lead-magnet sequence is silently halted
--     - the standard post-signup lifecycle takes over
--   else:
--     - sequence ends cleanly at +35
--     - subscriber rolls into the standing Chronicle list
--
-- WHY A NEW TABLE rather than reusing members:
--   PDF subscribers are not (yet) members. They are gated behind a
--   double-opt-in flow, may never convert, and follow a distinct
--   email lifecycle. Mixing them with members would muddy every
--   downstream query, the public Register, the Chronicle dispatch,
--   the founder cohort, and the post-signup tracking columns.
--   When a subscriber DOES become a member, we don't migrate the
--   row — we simply leave it as a historical opt-in record.

create table if not exists public.pdf_subscribers (
  id              uuid primary key default gen_random_uuid(),
  clan_id         uuid not null references public.clans(id) on delete cascade,

  -- Identity & consent
  email           citext not null,
  first_name      text,                          -- captured optionally on the form for personalisation
  source          text default 'roots',          -- where they came from (room for future magnets)

  -- Double opt-in
  confirm_token   text not null unique,          -- random token in the confirmation email link
  subscribed_at   timestamptz not null default now(),
  confirmed_at    timestamptz,                   -- NULL until they click the confirm link

  -- Email lifecycle tracking — one column per lifecycle email, anchored on confirmed_at
  -- Email 1 (+0) is fired synchronously on confirmation, not by the cron, so no tracking
  -- column needed for it (presence of confirmed_at IS its tracking).
  pdf_lead_email_3_sent_at   timestamptz,        -- Email 2 — standing of the clan
  pdf_lead_email_10_sent_at  timestamptz,        -- Email 3 — certificate & tiers
  pdf_lead_email_21_sent_at  timestamptz,        -- Email 4 — direct invitation
  pdf_lead_email_35_sent_at  timestamptz,        -- Email 5 — final invitation

  -- Member-conversion exit flag — set by the cron the first time it sees
  -- a row in members table matching this subscriber's email. Once true,
  -- no further lead-magnet emails will be dispatched.
  converted_to_member_at  timestamptz,

  -- Unsubscribe (the universal early-exit)
  unsubscribed_at  timestamptz,
  unsubscribe_token text not null default encode(gen_random_bytes(16), 'hex'),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One subscriber per email per clan. If someone signs up twice we update,
-- not duplicate.
create unique index if not exists pdf_subscribers_clan_email_uq
  on public.pdf_subscribers (clan_id, lower(email));

-- Cron sweep predicates — partial indexes scope each per-email query so
-- the daily fan-out is bounded as the table grows.
create index if not exists pdf_subscribers_e3_pending_idx
  on public.pdf_subscribers (confirmed_at)
  where confirmed_at is not null
    and pdf_lead_email_3_sent_at is null
    and converted_to_member_at is null
    and unsubscribed_at is null;

create index if not exists pdf_subscribers_e10_pending_idx
  on public.pdf_subscribers (confirmed_at)
  where confirmed_at is not null
    and pdf_lead_email_10_sent_at is null
    and converted_to_member_at is null
    and unsubscribed_at is null;

create index if not exists pdf_subscribers_e21_pending_idx
  on public.pdf_subscribers (confirmed_at)
  where confirmed_at is not null
    and pdf_lead_email_21_sent_at is null
    and converted_to_member_at is null
    and unsubscribed_at is null;

create index if not exists pdf_subscribers_e35_pending_idx
  on public.pdf_subscribers (confirmed_at)
  where confirmed_at is not null
    and pdf_lead_email_35_sent_at is null
    and converted_to_member_at is null
    and unsubscribed_at is null;

-- Confirm-token lookup (used by the confirm endpoint)
create unique index if not exists pdf_subscribers_confirm_token_uq
  on public.pdf_subscribers (confirm_token);

-- Unsubscribe-token lookup
create unique index if not exists pdf_subscribers_unsubscribe_token_uq
  on public.pdf_subscribers (unsubscribe_token);

-- Updated-at trigger (matching the convention used elsewhere in the schema)
create or replace function public.touch_pdf_subscribers_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pdf_subscribers_touch_updated_at on public.pdf_subscribers;
create trigger pdf_subscribers_touch_updated_at
  before update on public.pdf_subscribers
  for each row execute function public.touch_pdf_subscribers_updated_at();
