-- MIGRATION 002 (v2): fix members unique constraint so ON CONFLICT works.
-- A constraint already existed, so we drop that (it takes its underlying
-- index with it) and then create a clean non-functional one.

-- Drop the existing constraint. This automatically drops the underlying index.
alter table public.members drop constraint if exists members_clan_email_uniq;

-- Safety: also drop any orphaned index of the same name.
drop index if exists public.members_clan_email_uniq;

-- Create a proper unique constraint on (clan_id, email). Webhook already
-- normalises email to lowercase before writing, so lower() is not needed.
alter table public.members
  add constraint members_clan_email_uniq unique (clan_id, email);

-- Verify: should return one row showing the constraint is on (clan_id, email).
select
  conname                          as constraint_name,
  contype                          as constraint_type,
  pg_get_constraintdef(oid)        as definition
from pg_constraint
where conrelid = 'public.members'::regclass
  and contype = 'u';
