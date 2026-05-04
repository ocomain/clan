-- Migration 024: cart re-engagement sequence
--
-- Adds tracking columns to applications for the four-email
-- re-engagement sequence dispatched by daily-cart-reengage-sweep.js,
-- and a resume_token used by the /resume endpoint to let abandoned
-- applicants click straight back into checkout without re-entering
-- the herald form.
--
-- LIFECYCLE (anchored on applications.reminder_sent_at — the existing
-- 24h reminder):
--
--   Day 0   24h reminder sent (existing daily-abandoned-sweep)
--   +10     RE-1 — Linda — practical re-extension
--   +25     RE-2 — Paddy — legitimacy
--   +50     RE-3 — Antoin — civic value
--   +90     RE-4 — Linda — graceful close
--
-- LEGAL POSTURE — legitimate interest under GDPR Article 6(1)(f) /
-- soft opt-in under PECR. Every email in the sequence stays anchored
-- to the unfinished application the user themselves initiated. The
-- cadence tapers exponentially (10 / 15 / 25 / 40 day gaps) toward
-- a definite stop at +90, which is the legal protection.
--
-- IDEMPOTENCY — each email has its own tracking column. Once stamped,
-- it never re-sends. reengage_complete_at is the terminal stamp,
-- set either at +90 after RE-4 or earlier if the application status
-- changes (paid / cancelled / etc.) — short-circuiting the cron.

alter table public.applications
  add column if not exists resume_token              text unique,
  add column if not exists reengage_1_sent_at        timestamptz,
  add column if not exists reengage_2_sent_at        timestamptz,
  add column if not exists reengage_3_sent_at        timestamptz,
  add column if not exists reengage_4_sent_at        timestamptz,
  add column if not exists reengage_complete_at      timestamptz;

-- Backfill resume_token on existing rows so historic abandoned
-- applications can also receive the new sequence (only the ones
-- with status='pending' will actually qualify for the cron).
update public.applications
   set resume_token = encode(gen_random_bytes(16), 'hex')
 where resume_token is null;

-- Future inserts get a default value generated at insert time.
alter table public.applications
  alter column resume_token set default encode(gen_random_bytes(16), 'hex');

-- Cron sweep predicate — partial indexes scope each per-bucket
-- query so the daily fan-out is bounded as the table grows.
create index if not exists applications_reengage_1_pending_idx
  on public.applications (reminder_sent_at)
  where status = 'pending'
    and reminder_sent_at is not null
    and reengage_1_sent_at is null
    and reengage_complete_at is null;

create index if not exists applications_reengage_2_pending_idx
  on public.applications (reminder_sent_at)
  where status = 'pending'
    and reminder_sent_at is not null
    and reengage_2_sent_at is null
    and reengage_complete_at is null;

create index if not exists applications_reengage_3_pending_idx
  on public.applications (reminder_sent_at)
  where status = 'pending'
    and reminder_sent_at is not null
    and reengage_3_sent_at is null
    and reengage_complete_at is null;

create index if not exists applications_reengage_4_pending_idx
  on public.applications (reminder_sent_at)
  where status = 'pending'
    and reminder_sent_at is not null
    and reengage_4_sent_at is null
    and reengage_complete_at is null;

-- Resume token lookup
create unique index if not exists applications_resume_token_uq
  on public.applications (resume_token);
