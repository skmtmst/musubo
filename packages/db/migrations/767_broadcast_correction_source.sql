ALTER TABLE broadcasts ADD COLUMN correction_of_broadcast_id TEXT;
CREATE INDEX idx_broadcasts_correction_source ON broadcasts (correction_of_broadcast_id);
