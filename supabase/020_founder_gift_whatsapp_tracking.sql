-- Migration 020: founder gift WhatsApp follow-up tracking
--
-- Adds two columns to pending_founder_gifts so Fergus can track
-- which recipients he has personally messaged via WhatsApp asking
-- them to check their email + click the claim button.
--
-- Why this matters: the email goes out from the system but Fergus
-- knows many of his 60 recipients personally. He wants to send a
-- short personal nudge over WhatsApp ('check your inbox, just
-- sent you something') for each. The admin panel needs a tickbox
-- per row so he can mark progress as he works through the list.
--
-- Without persistent storage, the tick would reset on page reload
-- — useless when the list is 60 long and he needs to come back
-- to it across sessions.
--
-- Columns:
--
--   whatsapp_sent_at — timestamp the tickbox was first checked.
--     NULL = no WhatsApp follow-up sent. NULLABLE so the toggle
--     can also clear it (untick) without losing the row's identity.
--
--   whatsapp_sent_by — operator email who pressed the tick. Only
--     useful if the admin user-base ever expands beyond Fergus +
--     Linda; today both share clan@ocomain.org so this is mostly
--     audit metadata. Stored as text rather than FK because admin
--     allowlist is in code, not in members.

ALTER TABLE public.pending_founder_gifts
  ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_sent_by text;

COMMENT ON COLUMN public.pending_founder_gifts.whatsapp_sent_at IS
  'When Fergus marked the WhatsApp follow-up as sent in the admin panel. NULL = not yet sent.';
COMMENT ON COLUMN public.pending_founder_gifts.whatsapp_sent_by IS
  'Email of the admin operator who toggled the tick. Audit only.';
