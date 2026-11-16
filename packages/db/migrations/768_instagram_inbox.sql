CREATE TABLE instagram_inbox_reads (
  staff_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  sender_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, line_account_id, sender_id)
);
CREATE INDEX idx_instagram_messages_conversation_768
  ON instagram_messages(line_account_id, sender_id, received_at DESC, id DESC);
CREATE TABLE instagram_outbound_messages (
  idempotency_key TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  instagram_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','unknown')),
  meta_message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE UNIQUE INDEX idx_instagram_outbound_pending_768
  ON instagram_outbound_messages(instagram_id, sender_id) WHERE status IN ('pending','unknown');
