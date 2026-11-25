-- migration-policy: table-rebuild
-- migration-state: ledger-only
-- Instagram返信の未送信確定を行削除ではなく状態遷移で記録し、確認者・時刻・根拠を保持する。

CREATE TABLE instagram_outbound_messages_new (
  idempotency_key TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  instagram_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','unknown','not_sent_confirmed')),
  meta_message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  resolved_by_staff_id TEXT,
  resolved_at TEXT,
  resolution_kind TEXT CHECK(resolution_kind IS NULL OR resolution_kind IN ('reason','meta_conversation_absent')),
  resolution_evidence TEXT,
  CHECK(
    status <> 'not_sent_confirmed'
    OR (
      resolved_by_staff_id IS NOT NULL AND length(trim(resolved_by_staff_id)) > 0
      AND resolved_at IS NOT NULL AND length(trim(resolved_at)) > 0
      AND resolution_kind IS NOT NULL AND resolution_kind IN ('reason','meta_conversation_absent')
      AND resolution_evidence IS NOT NULL AND length(trim(resolution_evidence)) > 0
    )
  )
);

INSERT INTO instagram_outbound_messages_new (
  idempotency_key, line_account_id, instagram_id, sender_id, staff_id,
  content, status, meta_message_id, created_at, sent_at
)
SELECT
  idempotency_key, line_account_id, instagram_id, sender_id, staff_id,
  content, status, meta_message_id, created_at, sent_at
FROM instagram_outbound_messages;

DROP TABLE instagram_outbound_messages;

ALTER TABLE instagram_outbound_messages_new RENAME TO instagram_outbound_messages;

CREATE UNIQUE INDEX idx_instagram_outbound_pending_768
  ON instagram_outbound_messages(instagram_id, sender_id) WHERE status IN ('pending','unknown');
