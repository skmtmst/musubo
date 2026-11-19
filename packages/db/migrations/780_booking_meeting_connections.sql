-- 担当ごとの認可情報と一度きりの認可状態。秘密は暗号文のみ保存する。
CREATE TABLE booking_meeting_connections (
 id TEXT PRIMARY KEY NOT NULL,
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
 staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('google_meet','zoom','teams','outlook')),
 credential_enc TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 refresh_state TEXT NOT NULL DEFAULT 'ready' CHECK(refresh_state IN ('ready','refreshing','unknown')),
 refresh_claim TEXT,
 connected_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(line_account_id,staff_id,provider),
 CHECK((refresh_state='refreshing' AND refresh_claim IS NOT NULL) OR (refresh_state<>'refreshing' AND refresh_claim IS NULL))
);
CREATE TABLE booking_meeting_oauth_states (
 state TEXT PRIMARY KEY NOT NULL,
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
 staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('google_meet','zoom','teams','outlook')),
 verifier_enc TEXT NOT NULL,
 used_at TEXT,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_booking_meeting_oauth_states_expiry ON booking_meeting_oauth_states(expires_at);
-- 論理削除でも鍵と未使用の認可状態を残さない。
CREATE TRIGGER booking_meeting_remove_staff_credentials AFTER UPDATE OF deleted_at ON staff
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN DELETE FROM booking_meeting_connections WHERE staff_id=NEW.id; DELETE FROM booking_meeting_oauth_states WHERE staff_id=NEW.id; END;
