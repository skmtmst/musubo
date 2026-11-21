-- 店頭で渡す景品の種類と引渡し・訂正の記録。
-- 既存の景品・交換の種類制約は変更しない。
ALTER TABLE mileage_redemptions ADD COLUMN anonymized_at TEXT;
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
       OR (OLD.cancellation_reason IS NOT NEW.cancellation_reason AND NOT (
         NEW.cancellation_reason = '削除済みのお客さまの取消' AND EXISTS (
           SELECT 1 FROM mileage_redemptions r JOIN friends f
             ON f.id = r.beneficiary_friend_id OR (r.beneficiary_friend_id IS NULL AND (
               r.beneficiary_key = 'friend:' || f.id OR
               (f.user_id IS NOT NULL AND (f.user_id = r.beneficiary_user_id OR r.beneficiary_key = 'user:' || f.user_id))))
           JOIN operation_audit a ON a.id = 'customer-delete:friend_data:' || f.id
           WHERE r.id = OLD.redemption_id AND a.action = 'deleting'
             AND a.target_kind = 'customer_deletion' AND a.friend_id = f.id
             AND json_extract(a.detail_json, '$.leaseUntil') > CAST(strftime('%s','now') AS INTEGER) * 1000
         )
       ))))
  OR (OLD.cancelled_at IS NOT NULL AND OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'handgift history is immutable'); END;

-- テナントの正式な消去以外では受け渡し履歴を消さない。
CREATE TRIGGER mileage_handgifts_no_delete BEFORE DELETE ON mileage_handgifts
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_purge_guard g
  JOIN tenants t ON t.id = g.tenant_id
  JOIN line_accounts a ON a.tenant_id = t.id
  JOIN mileage_redemptions r ON r.line_account_id = a.id
  WHERE g.table_name = 'mileage_handgifts' AND r.id = OLD.redemption_id
    AND t.data_purged_at IS NULL
    AND (t.plan_status = 'canceled' OR
      (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'handgift history cannot be deleted'); END;
