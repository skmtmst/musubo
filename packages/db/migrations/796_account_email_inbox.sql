-- A new forwarding address starts an independent generation of the store inbox.
CREATE TABLE account_email_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  mailbox TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('setup','pending','connected','revoked')),
  challenge_hash TEXT,
  challenge_sent INTEGER,
  forwarding_confirmation TEXT,
  checked_at TEXT,
  automated_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX account_email_active ON account_email_connections(account_id) WHERE status <> 'revoked';
CREATE INDEX account_email_history ON account_email_connections(account_id, created_at DESC);

CREATE TABLE account_email_threads (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES account_email_connections(id) ON DELETE CASCADE,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread','in_progress','on_hold','resolved')),
  revision INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  UNIQUE(connection_id,customer_email)
);
CREATE INDEX account_email_latest ON account_email_threads(connection_id,last_message_at DESC,id);
CREATE TABLE account_email_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES account_email_threads(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id,dedup_key)
);
CREATE INDEX account_email_timeline ON account_email_messages(thread_id,created_at,id);
CREATE TABLE account_email_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES account_email_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE account_email_attachment_parts (
  attachment_id TEXT NOT NULL REFERENCES account_email_attachments(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(attachment_id,part)
);
CREATE INDEX account_email_files ON account_email_attachments(message_id);
CREATE TABLE account_email_reads (
  thread_id TEXT NOT NULL REFERENCES account_email_threads(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  PRIMARY KEY(thread_id,staff_id)
);
-- Only an actually inserted message moves the thread. Redelivery never resets reads.
CREATE TRIGGER account_email_received AFTER INSERT ON account_email_messages BEGIN
  UPDATE account_email_threads SET status='unread', revision=revision+1, last_message_at = MAX(last_message_at, NEW.created_at),
    subject = CASE WHEN NEW.created_at >= last_message_at THEN NEW.subject ELSE subject END
  WHERE id = NEW.thread_id; END;
-- A separate visibility hint keeps the unassigned legacy mailbox private.
CREATE TRIGGER account_email_connection_status AFTER UPDATE OF status ON account_email_connections WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO account_settings(id,line_account_id,key,value)
    SELECT lower(hex(randomblob(16))),NEW.account_id,'inbox_email_forwarding_connected','true'
    WHERE NEW.status='connected'
    ON CONFLICT(line_account_id,key) DO UPDATE SET value='true'; DELETE FROM account_settings WHERE line_account_id=NEW.account_id AND key='inbox_email_forwarding_connected'
    AND NEW.status='revoked' AND NOT EXISTS (SELECT 1 FROM account_email_connections WHERE account_id=NEW.account_id AND status='connected'); END;
-- If ownership moves to another tenant, the old address must stop working immediately.
CREATE TRIGGER account_email_tenant_change AFTER UPDATE OF tenant_id ON line_accounts
WHEN OLD.tenant_id IS NOT NEW.tenant_id BEGIN
  UPDATE account_email_connections SET status='revoked',challenge_hash=NULL,forwarding_confirmation=NULL
    WHERE account_id=OLD.id AND status <> 'revoked'; END;
CREATE TRIGGER account_email_retire_notices AFTER UPDATE OF status ON account_email_connections
WHEN NEW.status='revoked' AND OLD.status<>'revoked' BEGIN
  DELETE FROM notifications WHERE line_account_id=NEW.account_id AND event_type='account_email_received'
    AND id IN (SELECT m.id FROM account_email_messages m JOIN account_email_threads t ON t.id=m.thread_id
               WHERE t.connection_id=NEW.id); END;
