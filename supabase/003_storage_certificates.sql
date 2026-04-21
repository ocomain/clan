-- MIGRATION 003: create Supabase Storage bucket for membership certificates.
-- Private bucket (public=false) — with RLS enabled and no allow policy, only
-- service_role can read/write. Backend generates signed URLs for member
-- downloads; browser never hits Storage directly.

-- Create the bucket (idempotent)
insert into storage.buckets (id, name, public)
values ('certificates', 'certificates', false)
on conflict (id) do nothing;

-- Verify
select
  id,
  name,
  public,
  created_at
from storage.buckets
where id = 'certificates';
