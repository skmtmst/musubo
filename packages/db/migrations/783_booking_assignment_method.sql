-- 既存の予約は、担当の決まり方を推測せず不明として扱う。
ALTER TABLE bookings ADD COLUMN assignment_method TEXT NOT NULL DEFAULT 'unknown'
  CHECK (assignment_method IN ('unknown', 'designated', 'automatic', 'manual'));
ALTER TABLE bookings ADD COLUMN assignment_reviewed_at TEXT;

-- 担当が変わったら、それ以前の確認を引き継がない。
CREATE TRIGGER booking_assignment_reassign AFTER UPDATE OF staff_id ON bookings
WHEN OLD.staff_id IS NOT NEW.staff_id AND NEW.assignment_method IS OLD.assignment_method
BEGIN
  UPDATE bookings SET assignment_method='manual', assignment_reviewed_at=NULL WHERE id=NEW.id; END;
