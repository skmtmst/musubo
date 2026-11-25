-- A trusted login is a verified pairing, never a raw device marker or full IP.
CREATE TABLE auth_trusted_logins (
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  marker_hash TEXT NOT NULL,
  ip_prefix TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, marker_hash, ip_prefix)
);

-- Invalidate trust when credentials or staff status change.
CREATE TRIGGER auth_trusted_logins_invalidate_credentials AFTER UPDATE OF totp_secret_enc, password_hash, is_active ON staff_members WHEN OLD.totp_secret_enc IS NOT NEW.totp_secret_enc OR OLD.password_hash IS NOT NEW.password_hash OR OLD.is_active IS NOT NEW.is_active BEGIN DELETE FROM auth_trusted_logins WHERE staff_id = NEW.id; END;
