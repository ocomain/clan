-- =====================================================================
-- 037 — gathering-avatars storage bucket
-- ---------------------------------------------------------------------
-- Records the gathering-avatars bucket in the migrations folder so the
-- canonical schema is fully version-controlled. The bucket was created
-- manually via Studio on 2026-05-25 after a host (Maria) reported
-- avatar upload failures and we traced the cause to a missing bucket
-- that had been silently referenced by the code since the host-form
-- feature shipped (commit d5e4058 added the diagnostic that surfaced
-- the underlying "Bucket not found" error).
--
-- Settings (set when the bucket was created in Studio):
--   - public               = true   (avatars load via <img src=…>)
--   - file_size_limit      = 5 MB   (matches server-side decode ceiling
--                                    in gathering-host-upsert.js)
--   - allowed_mime_types   = jpeg, png, webp
--
-- The service_role key used by Netlify functions bypasses RLS, so no
-- additional storage.objects policies are needed for the upload path.
-- Public reads work via Supabase's built-in public-bucket URL routing.
--
-- Idempotent via ON CONFLICT. Safe to re-run.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gathering-avatars',
  'gathering-avatars',
  true,
  5242880,                                              -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
