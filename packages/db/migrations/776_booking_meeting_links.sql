-- 自動発行した会議を予約とは別に記録し、既存の予約表は変更しない。
CREATE TABLE booking_meeting_links (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_meet', 'zoom', 'teams')),
  external_meeting_id TEXT,
  meeting_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'cancel_pending', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'active' OR (external_meeting_id IS NOT NULL AND meeting_url IS NOT NULL))
);

CREATE INDEX idx_booking_meeting_links_booking ON booking_meeting_links(booking_id, created_at);

CREATE UNIQUE INDEX idx_booking_meeting_links_current ON booking_meeting_links(booking_id) WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX idx_booking_meeting_links_remote ON booking_meeting_links(provider, external_meeting_id) WHERE external_meeting_id IS NOT NULL;
