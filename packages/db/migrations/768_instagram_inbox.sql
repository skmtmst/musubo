CREATE TABLE instagram_inbox_reads (
  staff_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  sender_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, line_account_id, sender_id)
);
CREATE INDEX idx_instagram_messages_conversation_768
  ON instagram_messages(line_account_id, sender_id, received_at DESC, id DESC);
