-- 確定した最終失敗の停止と通知予約を同じ取引で保存する。
CREATE TABLE booking_monthly_failure_notices (
  cycle_id TEXT NOT NULL REFERENCES booking_monthly_cycles(id) ON DELETE RESTRICT,
  audience TEXT NOT NULL CHECK(audience IN ('friend','store')),
  account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  PRIMARY KEY(cycle_id,audience)
);
