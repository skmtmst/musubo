-- 一斉配信で使用する共通情報の版を、アカウントごとに固定する。
CREATE TABLE broadcast_common_var_pins (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (broadcast_id, common_var_id)
);
