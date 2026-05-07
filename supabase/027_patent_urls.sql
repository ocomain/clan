-- Migration 027: Letters patent storage tracking
--
-- Adds a JSONB column to members for storing letters-patent metadata,
-- one entry per dignity (Cara/Ardchara/Onóir). Once the conferral
-- pipeline generates a per-member patent PDF and uploads it to
-- Supabase storage, the storage path + issuance metadata are recorded
-- here. The signed download URL is generated on-demand at read time
-- (signed URLs expire; the storage path does not).
--
-- Shape:
--   {
--     "cara": {
--       "path": "patents/cara/<member-id>.pdf",
--       "issued_at": "2026-04-15T11:42:00Z",
--       "issued_name": "James Comyn"
--     },
--     "ardchara": { ... },
--     "onoir": { ... }
--   }
--
-- Field semantics:
--   - path: Supabase storage object path. NEVER the signed URL itself
--     (those expire); always regenerate signed URLs on read.
--   - issued_at: ISO timestamp of patent generation. Distinct from
--     sponsor_titles_awarded[<slug>] which records the moment of
--     RAISING — the patent may be issued later (after the member
--     seals their certificate, per the cert-first ceremonial rule).
--   - issued_name: the recipient name as it appeared on the patent at
--     the moment of issuance. Frozen forever — does NOT update if the
--     member later changes their member.name. The patent is a singular
--     historical issuance with a specific date and name; reissuance
--     under a new name is a separate paid Office action (not built).
--
-- Triggering:
--   - The conferral handler checks "is the member's certificate
--     sealed?" — if yes, generate the patent now.
--   - The cert-seal handler checks "has the member already been
--     raised?" — if yes, generate the patent now.
--   - Whichever happens last triggers generation. Both gate on
--     patent_urls[<slug>] being NULL to avoid double-issuance.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS patent_urls jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN members.patent_urls IS
  'Letters patent storage metadata, keyed by dignity slug. Each entry is { path, issued_at, issued_name }. Path is the Supabase storage object path; signed URLs are generated on-demand at read time. Issued_name is frozen at issuance — never updates on member name change.';
