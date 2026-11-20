-- migration-policy: table-rebuild
-- 配信を削除しても承認履歴は残し、配信への参照だけを外す。
CREATE TABLE broadcast_approval_events_new (
  id              TEXT PRIMARY KEY,
  broadcast_id    TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'cancelled', 'expired', 'reminded')),
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
INSERT INTO broadcast_approval_events_new (id, broadcast_id, actor_staff_id, action, reason, created_at)
  SELECT e.id, CASE WHEN EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = e.broadcast_id)
    THEN e.broadcast_id ELSE NULL END, e.actor_staff_id, e.action, e.reason, e.created_at
  FROM broadcast_approval_events e;
DROP TABLE broadcast_approval_events;
ALTER TABLE broadcast_approval_events_new RENAME TO broadcast_approval_events;
CREATE INDEX idx_broadcast_approval_events_broadcast
  ON broadcast_approval_events (broadcast_id, created_at DESC);
