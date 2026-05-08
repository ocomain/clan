-- 029_honour_reference.sql
--
-- Reverses the sequence-based honour numbering introduced in 028
-- and replaces it with a deterministic honour reference derived
-- from member.id + member.joined_at — mirroring the cert pattern
-- (shortCertNumber = OC-YYYY-NNNNNN; honour reference = OCH-YYYY-NNNNNN).
--
-- Why the change: 028 produced sequential register numbers (No. 0001,
-- No. 0002, ...) but the spec was always to mirror the cert's
-- per-member stable identifier, not a clan-wide counter. Reverting
-- here.
--
-- After this migration:
--   - honour_number_seq sequence removed
--   - nextval_honour_number RPC removed
--   - members.patent_urls.<slug>.honour_number removed
--   - members.patent_urls.<slug>.honour_reference added, computed
--     deterministically from member.id + joined_at
--
-- The reference is the SAME across all of a member's patents
-- (Cara, Ardchara, Onóir if raised through them all).
-- Code in netlify/functions/lib/patent-service.js computes this
-- value at issuance via shortHonourReference(memberId, joinedAt).

-- 1. Drop the sequence + RPC from migration 028.
DROP FUNCTION IF EXISTS public.nextval_honour_number();
DROP SEQUENCE IF EXISTS honour_number_seq;

-- 2. Backfill: for any patent_urls entry that has honour_number set
--    (legacy from 028), replace it with a computed honour_reference
--    and remove the old honour_number key. Loop over each dignity
--    slug separately because jsonb_set can't address dynamic paths
--    in a single statement.
--
-- Computation logic, per JSONB entry:
--   honour_reference = 'OCH-' || EXTRACT(YEAR FROM joined_at) || '-'
--                      || SUBSTRING(REPLACE(id::text, '-', ''), 1, 6)
--
-- Apply for each of the three dignity slugs.

DO $$
DECLARE
  slug text;
BEGIN
  FOREACH slug IN ARRAY ARRAY['cara', 'ardchara', 'onoir']
  LOOP
    -- Set honour_reference where the entry exists.
    EXECUTE format($f$
      UPDATE members
      SET patent_urls = jsonb_set(
        patent_urls #- ARRAY[%L, 'honour_number']::text[],
        ARRAY[%L, 'honour_reference']::text[],
        to_jsonb(
          'OCH-' ||
          EXTRACT(YEAR FROM joined_at)::text ||
          '-' ||
          SUBSTRING(REPLACE(id::text, '-', ''), 1, 6)
        ),
        true
      )
      WHERE patent_urls ? %L
        AND joined_at IS NOT NULL;
    $f$, slug, slug, slug);
  END LOOP;
END $$;

-- 3. Verification queries the operator can run after applying:
--   SELECT
--     email,
--     name,
--     patent_urls -> 'cara' ->> 'honour_reference' AS cara_ref,
--     patent_urls -> 'ardchara' ->> 'honour_reference' AS ardchara_ref,
--     patent_urls -> 'onoir' ->> 'honour_reference' AS onoir_ref
--   FROM members
--   WHERE patent_urls IS NOT NULL AND patent_urls != '{}'::jsonb;
--
-- Expected: each row's references all share the same OCH-YYYY-NNNNNN
-- prefix (or NULL if the dignity isn't held).

-- 4. After applying this migration, regenerate stored PDFs so the
-- rendered reference stamps reflect the new format. Run:
--
--   curl -X POST '.../admin-generate-patent' \
--     -H 'Content-Type: application/json' \
--     -d '{"email":"<email>","dignitySlug":"<slug>","force":true}'
--
-- for each member who currently holds a patent. Do this AFTER the
-- code deploy completes — otherwise the JS picks up nextval calls
-- that no longer exist and ensurePatent throws.
