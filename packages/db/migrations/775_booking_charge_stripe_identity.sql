-- 請求を始めた接続先と送信時刻を固定し、結果不明時に元の接続を照会する。
ALTER TABLE booking_charges ADD COLUMN stripe_connected_account_id TEXT;
ALTER TABLE booking_charges ADD COLUMN stripe_call_started_at TEXT;

-- 請求を送信中または結果不明の間は、請求の根拠となる取消・無断を変えない。
CREATE TRIGGER booking_charge_block_status_change
BEFORE UPDATE OF status ON bookings
WHEN NEW.status<>OLD.status AND EXISTS (
  SELECT 1 FROM booking_charges c WHERE c.booking_id=OLD.id AND c.line_account_id=OLD.line_account_id
    AND c.status IN ('processing','unknown','succeeded')
)
BEGIN
  SELECT RAISE(ABORT,'booking_charge_in_progress'); END;

-- 失敗が確定した請求も、無断などを取り消したら請求しない履歴へ移す。
CREATE TRIGGER booking_failed_fee_revert
AFTER UPDATE OF status ON bookings
WHEN OLD.status IN ('cancelled','no_show') AND NEW.status NOT IN ('cancelled','no_show')
BEGIN
  UPDATE booking_charges SET status='waived',reason='cancellation_reverted',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE booking_id=NEW.id AND line_account_id=NEW.line_account_id AND status='failed'; END;
