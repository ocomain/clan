-- 028_honour_number_sequence.sql
--
-- Adds the honour-number register: a clan-wide monotonically
-- increasing counter assigned to every letters patent at issuance.
-- Surfaces on the patent itself as "Cl. Ó.C. · Honours · No. NNNN"
-- and gets stored as patent_urls.<slug>.honour_number on the
-- recipient's member row.
--
-- Why a sequence (not max+1 in app code):
-- Postgres sequences are atomic across concurrent transactions.
-- If two title-award handlers fire simultaneously (gift-paid +
-- invitation-paid both completing in the same second), we need
-- the second issuance to get number+1, not collide with the first.
-- max+1-in-app would race; nextval() can't.
--
-- Why honour_number is stored on patent_urls (not as its own column):
-- Each member can hold up to three patents (Cara → Ardchara → Onóir)
-- in their patent_urls JSONB, each with its own honour_number. A
-- single column on members couldn't represent that. The JSONB shape
-- already carries path/issued_at/issued_name; adding honour_number
-- as a fourth key keeps the locality.
--
-- Backfill: Antoin holds the first conferral (Cara), so his
-- patent_urls.cara.honour_number is set to 1 here. The sequence
-- starts at 2 so the next ensurePatent call gets number 2.

CREATE SEQUENCE IF NOT EXISTS honour_number_seq
  AS bigint
  START WITH 2
  MINVALUE 1
  NO MAXVALUE
  CACHE 1
  NO CYCLE;

COMMENT ON SEQUENCE honour_number_seq IS
  'Clan-wide letters patent register number. Each ensurePatent call
   reads nextval(''honour_number_seq''), bakes the value into the PDF
   reference stamp, and stores it in members.patent_urls.<slug>.
   honour_number. Monotonic, never reused. Antoin (first conferral)
   has number 1; sequence starts at 2.';

-- RPC wrapper — Supabase JS client can't call nextval() directly
-- (sequences aren't tables, the .from() builder doesn't apply).
-- This security-definer function exposes the sequence to the
-- service-role client used by ensurePatent.
CREATE OR REPLACE FUNCTION public.nextval_honour_number()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('honour_number_seq');
$$;

COMMENT ON FUNCTION public.nextval_honour_number() IS
  'RPC wrapper exposing nextval(honour_number_seq) to the Supabase
   client. Called by ensurePatent in lib/patent-service.js to
   atomically assign each new conferral its register number.';

-- Grant execute on the function to the service_role (which is
-- what the Supabase server client uses). Anonymous users should
-- NOT be able to consume sequence numbers — restrict accordingly.
GRANT EXECUTE ON FUNCTION public.nextval_honour_number() TO service_role;
REVOKE EXECUTE ON FUNCTION public.nextval_honour_number() FROM anon;
REVOKE EXECUTE ON FUNCTION public.nextval_honour_number() FROM authenticated;

-- Backfill Antoin's Cara patent — issued before this sequence
-- existed. He's the first conferral, so honour_number = 1.
UPDATE members
SET patent_urls = jsonb_set(
  patent_urls,
  '{cara,honour_number}',
  '1'::jsonb,
  true
)
WHERE email = 'antoin@gmail.com'
  AND patent_urls ? 'cara'
  AND NOT (patent_urls -> 'cara' ? 'honour_number');
