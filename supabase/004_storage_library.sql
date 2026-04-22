-- Migration 004 — Clan Member Library
-- Private storage bucket for scholarly primary-source PDFs.
-- Read access is via signed URLs produced by the service_role only, after
-- the Netlify function has verified the requester is an authenticated member.

insert into storage.buckets (id, name, public, file_size_limit)
values ('clan-library', 'clan-library', false, 52428800)  -- 50 MB per file
on conflict (id) do nothing;

-- RLS: no direct access for authenticated users — all access goes through
-- the service_role via signed URLs from /api/library-fetch. This prevents
-- non-members (and non-authenticated visitors) from enumerating or
-- downloading the library content.
-- (Bucket is private by default; no auth policies needed. The service_role
-- key used by our function bypasses RLS entirely.)
