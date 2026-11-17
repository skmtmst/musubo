-- はじめにやることガイドの進行状態を、ユーザー×アカウントでサーバーに置く。
-- 承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen 枠 14 (orKSi)
-- のノード L3lP08 が「状態はユーザー×アカウントでサーバー保存: { 有効/一時停止, 現在ステップ, 現在手順 }。
-- リロード・端末切替・離脱後も再開可能」と定めている。
-- ブラウザ保存は表示を速くするための控えに留め、ここが正本になる（191_dashboard_preferences と同じ考え方）。
-- 9項目の済み判定はこの表に入れない。完了は常に設定の実データ計測 (setup-progress) で、
-- ガイドの進行状態とは独立させる。
CREATE TABLE IF NOT EXISTS onboarding_guide_progress (
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('idle', 'active', 'paused', 'done')),
  step_key TEXT,
  procedure_index INTEGER NOT NULL DEFAULT 1 CHECK (procedure_index >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (staff_id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_guide_progress_account
  ON onboarding_guide_progress(line_account_id, updated_at DESC);
