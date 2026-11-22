-- 顧客削除後の遅延通知と再連結で、削除した自由記述や領収書を復元しない。
ALTER TABLE booking_payments ADD COLUMN customer_redacted_at TEXT;
-- 匿名化後の予約監査にも期限を設け、保持停止中は消去しない。
ALTER TABLE booking_audit_logs ADD COLUMN customer_redacted_at TEXT;
CREATE INDEX idx_booking_audit_redacted_retention ON booking_audit_logs(customer_redacted_at,line_account_id) WHERE customer_redacted_at IS NOT NULL;
