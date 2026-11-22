-- フォルダーの確認版を進めるだけの更新から、旧フォルダーへの同期を呼ばない。
-- D1 は条件を評価する前にトリガーを準備するため、同期対象の列を明示する。
DROP TRIGGER IF EXISTS folders_friend_add_rule_legacy_update;
CREATE TRIGGER folders_friend_add_rule_legacy_update
AFTER UPDATE OF id, kind, account_id, name, color, updated_at ON folders
WHEN NEW.kind = 'friend_add_rule'
BEGIN
  UPDATE friend_add_rule_folders
     SET name = NEW.name, color = NEW.color, updated_at = NEW.updated_at
   WHERE id = NEW.id AND line_account_id = NEW.account_id
     AND (name IS NOT NEW.name OR color IS NOT NEW.color); END;

DROP TRIGGER IF EXISTS folders_mileage_reward_legacy_update;
CREATE TRIGGER folders_mileage_reward_legacy_update
AFTER UPDATE OF id, kind, account_id, name, display_order, updated_at ON folders
WHEN NEW.kind = 'mileage_reward'
BEGIN
  UPDATE mileage_reward_folders
     SET name = NEW.name, display_order = NEW.display_order, updated_at = NEW.updated_at
   WHERE id = NEW.id AND line_account_id = NEW.account_id
     AND (name IS NOT NEW.name OR display_order IS NOT NEW.display_order); END;
