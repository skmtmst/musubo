-- 会議の主催者と作成時の日時を残し、担当変更後も古い会議を取り消せるようにする。
ALTER TABLE booking_meeting_links ADD COLUMN staff_id TEXT;
ALTER TABLE booking_meeting_links ADD COLUMN starts_at TEXT;
ALTER TABLE booking_meeting_links ADD COLUMN ends_at TEXT;

UPDATE booking_meeting_links SET
 staff_id=(SELECT staff_id FROM bookings WHERE bookings.id=booking_meeting_links.booking_id),
 starts_at=(SELECT starts_at FROM bookings WHERE bookings.id=booking_meeting_links.booking_id),
 ends_at=(SELECT ends_at FROM bookings WHERE bookings.id=booking_meeting_links.booking_id);

-- 予約と同じ取引で古いURLを無効にし、相手先での削除は後で再試行できるよう残す。
CREATE TRIGGER booking_meeting_link_invalidate
AFTER UPDATE OF status, staff_id, starts_at, ends_at, meeting_mode, meeting_url, meeting_url_source ON bookings
WHEN (OLD.status='confirmed' AND NEW.status<>'confirmed')
 OR OLD.staff_id IS NOT NEW.staff_id OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at
 OR (OLD.meeting_mode='online' AND NEW.meeting_mode IS NOT 'online')
 OR (NEW.meeting_url_source='manual' AND (OLD.meeting_url IS NOT NEW.meeting_url OR OLD.meeting_url_source IS NOT NEW.meeting_url_source))
BEGIN
 UPDATE booking_meeting_links SET status='cancel_pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE booking_id=NEW.id AND status='active'; UPDATE booking_meeting_links SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE booking_id=NEW.id AND status='pending' AND attempt_count=0; END;
