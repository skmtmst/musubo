-- 店頭で渡す景品の種類と引渡し・訂正の記録。
-- 既存の景品・交換の種類制約は変更しない。
CREATE TABLE mileage_handgift_rewards (
  reward_id TEXT PRIMARY KEY REFERENCES mileage_rewards(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mileage_handgifts (
  redemption_id TEXT PRIMARY KEY REFERENCES mileage_redemptions(id),
  reward_id TEXT NOT NULL REFERENCES mileage_handgift_rewards(reward_id),
  delivered_at TEXT,
  delivered_by TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancellation_reason TEXT,
  CHECK ((delivered_at IS NULL) = (delivered_by IS NULL)),
  CHECK ((cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
      OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
          AND cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0))
);

CREATE TRIGGER mileage_handgifts_match_redemption BEFORE INSERT ON mileage_handgifts
WHEN NOT EXISTS (
  SELECT 1 FROM mileage_redemptions r
  WHERE r.id = NEW.redemption_id AND r.reward_id = NEW.reward_id
)
BEGIN SELECT RAISE(ABORT, 'handgift redemption does not match reward'); END;

CREATE TRIGGER mileage_handgifts_identity_immutable BEFORE UPDATE OF redemption_id, reward_id ON mileage_handgifts
WHEN OLD.redemption_id IS NOT NEW.redemption_id OR OLD.reward_id IS NOT NEW.reward_id
BEGIN SELECT RAISE(ABORT, 'handgift identity is immutable'); END;

-- 引渡し・取消の確定後は履歴を上書きしない。
CREATE TRIGGER mileage_handgifts_history_immutable BEFORE UPDATE ON mileage_handgifts
WHEN (OLD.delivered_at IS NOT NULL AND
      (OLD.delivered_at IS NOT NEW.delivered_at OR OLD.delivered_by IS NOT NEW.delivered_by))
  OR (OLD.cancelled_at IS NOT NULL AND
      (OLD.cancelled_at IS NOT NEW.cancelled_at OR OLD.cancelled_by IS NOT NEW.cancelled_by
       OR OLD.cancellation_reason IS NOT NEW.cancellation_reason))
  OR (OLD.cancelled_at IS NOT NULL AND OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'handgift history is immutable'); END;
