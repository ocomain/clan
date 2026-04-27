-- Migration 014: invitations table
--
-- Tracks invitations sent by existing members to potential new
-- members. Each row represents ONE invitation sent to one recipient.
-- The same recipient can receive multiple invitations from different
-- members (a popular cousin, say) but the rate-limiting and dedup
-- logic in send-invitation.js prevents one inviter spamming the same
-- recipient in quick succession.
--
-- Why a dedicated table rather than overloading members.metadata?
-- Three reasons:
--   1. Volume — invitations could grow large. A separate table keeps
--      the members table lean.
--   2. Query patterns — we want 'how many invites has X sent in the
--      last hour' (rate limiting) and 'has X already invited Y?'
--      (dedup) as cheap indexed lookups, not JSON traversals.
--   3. Future rewards — when we add invite-rewards (referral perks,
--      acknowledgement at clan gatherings), having a clean
--      invitations table makes the join-on-conversion query trivial.
--      Avoids a refactor.
--
-- Status field uses an enum-like text values:
--   'sent'     → email queued / accepted by Resend (default)
--   'accepted' → recipient eventually became a paid member
--                  (set by the conversion-tracking job, future)
--   'bounced'  → email returned bounce (future, when we wire bounces)
--   'unsub'    → recipient hit unsubscribe link (set by the
--                  unsubscribe endpoint, also v1)
--
-- For the v1 we only set 'sent' and 'unsub'. 'accepted' and 'bounced'
-- are included in the schema so we don't need another migration when
-- we add those flows.

CREATE TABLE IF NOT EXISTS invitations (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clan_id            uuid          NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  inviter_member_id  uuid          NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  recipient_email    text          NOT NULL,
  recipient_name     text          NOT NULL,
  personal_note      text          NULL,
  status             text          NOT NULL DEFAULT 'sent'
                       CHECK (status IN ('sent', 'accepted', 'bounced', 'unsub')),
  sent_at            timestamptz   NOT NULL DEFAULT now(),
  responded_at       timestamptz   NULL,
  -- Stamped if/when the recipient becomes a paid member, for
  -- attribution. Nullable; the conversion-tracking job populates it.
  converted_member_id uuid         NULL REFERENCES members(id) ON DELETE SET NULL,
  metadata           jsonb         NOT NULL DEFAULT '{}'
);

-- Rate-limit lookup: how many invites has this member sent in the
-- last N minutes? Indexed on (inviter, sent_at) so the window scan
-- is cheap.
CREATE INDEX IF NOT EXISTS idx_invitations_inviter_sent_at
  ON invitations (inviter_member_id, sent_at DESC);

-- Dedup lookup: has this inviter already invited this recipient?
-- Indexed on (inviter, lowercase recipient email).
CREATE INDEX IF NOT EXISTS idx_invitations_inviter_recipient
  ON invitations (inviter_member_id, lower(recipient_email));

-- Unsubscribe lookup: did this recipient unsub from any inviter?
-- The unsubscribe table covers cross-inviter dedup (recipient who
-- hits unsub once should not receive another invitation from anyone).
CREATE TABLE IF NOT EXISTS invitation_unsubscribes (
  email          text          PRIMARY KEY,
  unsubbed_at    timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE invitations IS
  'Member-to-recipient invitations sent via the invite-a-friend feature. One row per send. Status reflects the lifecycle of the invitation. converted_member_id is populated by the conversion-tracking job when a recipient eventually becomes a paid member.';

COMMENT ON TABLE invitation_unsubscribes IS
  'Email addresses that have requested to never receive invitations again. Cross-inviter — once an email is in this table, no member can invite it. Populated by the public unsubscribe endpoint.';
