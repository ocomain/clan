-- Migration 026: Antoin same-day follow-up email tracking column
--
-- Adds a new tracking column for Email 3B — Antoin's same-day follow-up
-- to Email 3 ("How I became Cara"). Email 3B fires shortly after Email 3
-- on the same day, with subject "I forgot to attach this", embedding
-- Antoin's actual Cara letters patent inline as the persuasive artefact.
--
-- The cron logic in daily-post-signup-sweep.js will dispatch Email 3B
-- to any member who has _21_sent_at set but _21b_sent_at null. This
-- decoupling means a member always receives Email 3 first (the story),
-- then Email 3B (the proof). Order is guaranteed by the data check, not
-- by clock timing within the cron.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS post_signup_email_21b_sent_at timestamptz;

COMMENT ON COLUMN members.post_signup_email_21b_sent_at IS
  'When Email 3B (Antoin "I forgot to attach this") was sent. Fires after _21_sent_at is set, on the next cron tick.';
