-- 下書きと公開版を分け、公開済みの内容に後の固定変更を混ぜない。
CREATE TABLE scenario_step_common_var_pins (
  scenario_step_id TEXT NOT NULL REFERENCES scenario_steps(id) ON DELETE CASCADE,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (scenario_step_id, common_var_id)
);
CREATE TABLE scenario_version_common_var_pins (
  scenario_version_id TEXT NOT NULL REFERENCES scenario_versions(id) ON DELETE CASCADE,
  live_step_id TEXT NOT NULL,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (scenario_version_id, live_step_id, common_var_id)
);
CREATE TABLE form_common_var_pins (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (form_id, common_var_id)
);
CREATE TABLE form_version_common_var_pins (
  form_version_id TEXT NOT NULL REFERENCES form_versions(id) ON DELETE CASCADE,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (form_version_id, common_var_id)
);
-- 公開版の固定は公開時に作り、以後 UPDATE しない。
CREATE TRIGGER scenario_version_common_var_pins_immutable
BEFORE UPDATE ON scenario_version_common_var_pins
BEGIN SELECT RAISE(ABORT, 'published_pin_immutable'); END;
CREATE TRIGGER form_version_common_var_pins_immutable
BEFORE UPDATE ON form_version_common_var_pins
BEGIN SELECT RAISE(ABORT, 'published_pin_immutable'); END;
CREATE TABLE scenario_action_common_var_pins (
  scenario_action_id TEXT NOT NULL REFERENCES scenario_actions(id) ON DELETE CASCADE,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (scenario_action_id, common_var_id)
);
CREATE TABLE scenario_version_action_common_var_pins (
  scenario_version_id TEXT NOT NULL REFERENCES scenario_versions(id) ON DELETE CASCADE,
  live_action_id TEXT NOT NULL,
  common_var_id TEXT NOT NULL REFERENCES common_vars(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES common_var_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (scenario_version_id, live_action_id, common_var_id)
);
CREATE TRIGGER scenario_version_action_common_var_pins_immutable
BEFORE UPDATE ON scenario_version_action_common_var_pins
BEGIN SELECT RAISE(ABORT, 'published_pin_immutable'); END;
