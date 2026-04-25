-- Migration 010: Postal address for physical certificate delivery
--
-- Guardian, Steward, and Life Member tiers include a physical certificate
-- posted on heavyweight stock with the Chief's handwritten signature. We
-- need to capture postal address to actually post it.
--
-- Captured AFTER digital cert confirmation, not before — the address
-- corresponds to the sealed cert version (post-grace-window edits don't
-- regenerate the physical cert anyway). Workflow:
--
--   1. Buyer pays
--   2. Welcome page captures cert details (name, ancestor, family, register)
--   3. Buyer saves → digital cert sealed
--   4. NEW: Guardian+ buyers see postal address card immediately after
--   5. Buyer saves address → cert queued for printing/posting
--   6. Operator (Linda) prints + posts → flips cert_posted_at
--   7. Member sees status in dashboard ("posted on 12 May 2026")
--
-- Schema decisions:
--
-- postal_address as JSONB rather than separate columns. Reasons:
--   - International addresses don't map cleanly to a fixed column set
--     (eg JP postcodes precede city, US has state, UK has county, etc)
--   - Easier to extend later (add 'instructions' field, 'address_format' tag)
--     without further migrations
--   - Operator (Linda) reads the formatted address as a single block anyway
--   - Easier to render on a label/envelope from one structured field
--
-- Address shape stored:
--   {
--     "recipient_name": "John Smith",  -- defaults to cert name; editable
--     "line1":          "10 Lakeside Avenue",
--     "line2":          "Apt 3B",       -- nullable
--     "city":           "Dublin",
--     "region":         "Co. Dublin",   -- state/county/province (nullable)
--     "postal_code":    "D04 F2K9",
--     "country":        "Ireland",      -- full name not ISO code, for label clarity
--     "country_code":   "IE",           -- ISO for sorting/grouping
--     "instructions":   "Letterbox by side gate"  -- nullable courier note
--   }
--
-- Tracking fields:
--   postal_address_provided_at - timestamptz when buyer saved the address
--   cert_posted_at             - timestamptz when Linda confirms post
--                                (via admin tool / dashboard / direct DB update)
--
-- The provided_at timestamp lets us:
--   - Surface 'awaiting address' members to Linda as a ready queue
--   - Track lag from cert seal -> address provided -> posted
--
-- The posted_at timestamp lets us show members 'posted on X' on dashboard.

alter table public.members
  add column if not exists postal_address jsonb,
  add column if not exists postal_address_provided_at timestamptz,
  add column if not exists cert_posted_at timestamptz;

-- Index supports Linda's 'who needs a cert posted' query: members with
-- a Guardian+ tier, address provided, but cert not yet posted.
create index if not exists members_cert_to_post_idx
  on public.members (postal_address_provided_at)
  where postal_address_provided_at is not null
    and cert_posted_at is null;
