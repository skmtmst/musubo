-- 残りの送信中に処理が中断した場合は自動で送り直さず、運用者の確認を待つ。
ALTER TABLE broadcast_ab_live_tests ADD COLUMN remainder_started_at TEXT;
