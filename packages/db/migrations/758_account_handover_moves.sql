-- 引き継ぎで実際に移した友だちだけを切り戻すための記録。
CREATE TABLE account_handover_moves (
  handover_id TEXT NOT NULL REFERENCES account_handovers(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  PRIMARY KEY (handover_id, friend_id)
);
