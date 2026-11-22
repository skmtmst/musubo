-- 最初の手動返信を、当時の期限と実際の返信者で保存する。本文は保存しない。
CREATE TABLE inbox_response_samples (
  account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  pending_since TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  due_at TEXT,
  responder_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  minutes REAL NOT NULL CHECK(minutes >= 0),
  PRIMARY KEY (account_id, chat_id, pending_since)
);
CREATE INDEX inbox_response_samples_period ON inbox_response_samples(account_id, responded_at, responder_staff_id);
CREATE TRIGGER inbox_response_sample_capture AFTER UPDATE OF first_response_at ON chats
WHEN OLD.first_response_at IS NULL AND NEW.first_response_at IS NOT NULL
  AND NEW.pending_since IS NOT NULL AND julianday(NEW.first_response_at)>=julianday(NEW.pending_since)
BEGIN
  INSERT OR IGNORE INTO inbox_response_samples(account_id,chat_id,pending_since,responded_at,due_at,responder_staff_id,minutes)
  SELECT f.line_account_id,NEW.id,NEW.pending_since,NEW.first_response_at,OLD.sla_due_at,
    (SELECT CASE WHEN COUNT(*)=COUNT(sm.id) AND COUNT(DISTINCT sm.id)=1 THEN MIN(sm.id) END FROM messages_log m LEFT JOIN staff_members sm ON sm.id=m.sent_by_staff_id
      WHERE m.friend_id=NEW.friend_id AND m.line_account_id=f.line_account_id AND m.direction='outgoing'
        AND m.source='manual' AND m.created_at=NEW.first_response_at
      ),
    (julianday(NEW.first_response_at)-julianday(NEW.pending_since))*1440
  FROM friends f WHERE f.id=NEW.friend_id AND f.line_account_id IS NOT NULL; END;
-- 一括割当は要求時の未割当を固定し、分割実行して途中から再開する。
CREATE TABLE inbox_assignment_jobs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed')),
 assigned INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(account_id,idempotency_key)
);
CREATE INDEX inbox_assignment_jobs_due ON inbox_assignment_jobs(status,lease_until,created_at);
CREATE TABLE inbox_assignment_job_items (
 job_id TEXT NOT NULL REFERENCES inbox_assignment_jobs(id) ON DELETE CASCADE,
 chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','assigned','skipped')),
 PRIMARY KEY(job_id,chat_id)
);
-- 無効化された担当者には新しい受信を割り当てず、未割当へ戻す。
CREATE TRIGGER inbox_unassign_inactive_staff AFTER UPDATE OF is_active ON staff_members WHEN OLD.is_active=1 AND NEW.is_active=0 BEGIN UPDATE chats SET assignee_staff_id=NULL,assigned_by=NULL,assigned_at=NULL,assignment_token=NULL,revision=revision+1 WHERE assignee_staff_id=NEW.id AND status!='resolved'; END;
