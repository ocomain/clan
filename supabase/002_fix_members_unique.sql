-- MIGRATION 002: fix members unique constraint so ON CONFLICT works.
-- Run this once in Supabase SQL Editor.

-- Drop the functional unique index (can't be referenced by ON CONFLICT in Supabase upsert).
drop index if exists public.members_clan_email_uniq;

-- Replace with a regular unique CONSTRAINT on (clan_id, email).
-- Webhook already normalises email to lowercase before writing, so lower() in
-- the index was redundant anyway.
alter table public.members
  drop constraint if exists members_clan_email_uniq;

alter table public.members
  add constraint members_clan_email_uniq unique (clan_id, email);

-- Confirm the constraint exists
select conname, contype
from pg_constraint
where conrelid = 'public.members'::regclass
  and contype = 'u';
