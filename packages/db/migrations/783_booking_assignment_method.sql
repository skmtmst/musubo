-- 既存の予約は、担当の決まり方を推測せず不明として扱う。
ALTER TABLE bookings ADD COLUMN assignment_method TEXT NOT NULL DEFAULT 'unknown'
  CHECK (assignment_method IN ('unknown', 'designated', 'automatic', 'manual'));
ALTER TABLE bookings ADD COLUMN assignment_reviewed_at TEXT;
