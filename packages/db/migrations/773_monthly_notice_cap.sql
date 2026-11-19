-- 送信開始後の結果不明も枠を占有し、別の通知による重複を防ぐ。
CREATE TABLE booking_monthly_notice_cap (
  cycle_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  day_jst TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY(cycle_id,audience),
  UNIQUE(account_id,friend_id,day_jst),
  FOREIGN KEY(cycle_id,audience) REFERENCES booking_monthly_failure_notices(cycle_id,audience) ON DELETE RESTRICT
);
