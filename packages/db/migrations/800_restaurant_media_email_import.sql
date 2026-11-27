-- 店舗と予約媒体ごとのメール取込設定。未登録は従来どおり有効。
CREATE TABLE rt_store_media_email_settings (
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES rt_media(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, media_id)
);

-- 原文は従来の非公開R2に残し、保留状態・一意の処理権・期限だけをD1に記録する。
CREATE TABLE rt_held_reservation_emails (
  inbound_email_id TEXT PRIMARY KEY REFERENCES rt_inbound_emails(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES rt_media(id),
  sync_event_id TEXT NOT NULL UNIQUE REFERENCES rt_sync_events(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('held', 'processing', 'archived', 'processed', 'expiring', 'expired')),
  claim_token TEXT UNIQUE,
  claim_expires_at TEXT,
  last_error TEXT,
  held_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rt_held_reservation_emails_media ON rt_held_reservation_emails(store_id, media_id, state, expires_at);
CREATE INDEX idx_rt_held_reservation_emails_expiry ON rt_held_reservation_emails(state, expires_at);
