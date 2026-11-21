-- migration-policy: table-rebuild
-- migration-state: ledger-only
-- 772: Googleビジネス・Instagram の複数連携（第1段のDB基盤）
--
-- 状態の判定について（`-- migration-state: ledger-only` を書く理由）:
--   表を作り直すと古い表と一緒にその索引も消えるので、このファイルは
--   `idx_rt_google_metrics_daily_store_date` と `idx_instagram_connections_instagram_id`
--   を同じ名前で作り直す。この2本は当てる前から現物に在るため、
--   `scripts/deploy/migrate.ts status` の現物判定では「26個の目印のうち2個だけ在る」と見えて
--   「部分（途中で落ちた跡かもしれない）」になり、apply が止まっていた。
--   実際には途中状態ではない。D1 はファイル単位で当ててから `_migrations` に記録するので、
--   このファイルは記録で判定する。
--
-- 目的: 1つの店舗 / LINEアカウントに複数の接続を持てるようにする。
--   - rt_google_connections.store_id の UNIQUE（446:8）を外して非一意のFKにする
--   - rt_google_profiles.store_id の PRIMARY KEY（447:8）を接続単位の鍵に置き換える
--   - rt_google_metrics_daily の PRIMARY KEY (store_id, date)（512:33）を接続単位に置き換える
--   - instagram_connections.line_account_id の PRIMARY KEY（603:8 / 754:5）を外し、
--     不変の接続ID列 id を導入する
--   - 取り込み・履歴・OAuth状態の各表に connection_id を足し、既存行を既存の接続へ割り当てる
--
-- 方針:
--   - 適用済みの 446 / 447 / 511 / 512 / 603 / 611 / 754 / 757 / 769 は書き換えない。
--     変更はすべてこのファイル内の table-rebuild と ADD COLUMN で行う。
--   - 既存の接続・履歴・暗号化された認証情報は INSERT … SELECT で無変換に移送する
--     （refresh_token_enc / access_token_enc / code_verifier_enc /
--      page_token_encrypted / user_token_encrypted / candidates_encrypted）。
--   - 主連携は account_settings（sns.google.primary_connection）を正本のままとし、
--     列を新設しない。
--   - テナント（統括）越えの拒否は 754 のトリガー2本を同じ条件で作り直して維持する。
--
-- 当てる順番（止めずに入れ替えるための段取り）:
--   このmigrationは「足すだけ」にしてある。表を作り直して店舗・LINEアカウントの
--   主キー / UNIQUE を外すが、同じ形の UNIQUE 索引（末尾 `_compat_772`）を同時に作るので、
--   `ON CONFLICT(store_id)` / `ON CONFLICT(line_account_id)` と書いた配備中のWorkerは
--   このmigrationを当てた後もそのまま動く。接続IDで読み書きする新しいWorkerは
--   `COALESCE(connection_id, 'store:' || store_id)` の式索引に当たるので、
--   どちらの書き方でも upsert が通る。
--   772（DB）→ 新しいWorkerを配備 → 773（互換索引だけを外す）の順に進める。
--   `_compat_772` が残っているあいだは同じ店舗 / LINEアカウントの2件目の接続行は入らない。
--   2件目が実際に入るのは 773 を当てた後。

-- ---------------------------------------------------------------------------
-- 1. rt_google_connections: store_id の UNIQUE を外し、並び順を持たせる
-- ---------------------------------------------------------------------------

CREATE TABLE rt_google_connections_new (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  line_account_id TEXT REFERENCES line_accounts(id),
  google_account_email TEXT,
  location_name TEXT,
  location_title TEXT,
  location_maps_url TEXT,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('pending_location', 'connected', 'expired', 'no_permission', 'disconnected')),
  connected_by_staff_id TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  average_rating REAL,
  total_review_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_posts_synced_at TEXT,
  last_metrics_synced_at TEXT,
  confirmation_revision INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

INSERT INTO rt_google_connections_new (
  id, store_id, line_account_id, google_account_email, location_name, location_title,
  location_maps_url, refresh_token_enc, access_token_enc, access_token_expires_at, status,
  connected_by_staff_id, connected_at, disconnected_at, last_synced_at, last_sync_error,
  average_rating, total_review_count, created_at, updated_at,
  last_posts_synced_at, last_metrics_synced_at, confirmation_revision, sort_order
)
SELECT
  id, store_id, line_account_id, google_account_email, location_name, location_title,
  location_maps_url, refresh_token_enc, access_token_enc, access_token_expires_at, status,
  connected_by_staff_id, connected_at, disconnected_at, last_synced_at, last_sync_error,
  average_rating, total_review_count, created_at, updated_at,
  last_posts_synced_at, last_metrics_synced_at, confirmation_revision, 0
FROM rt_google_connections;

DROP TABLE rt_google_connections;

ALTER TABLE rt_google_connections_new RENAME TO rt_google_connections;

-- 同じ店舗に同じロケーションを二重に接続させない（ロケーション未確定の行は対象外）
CREATE UNIQUE INDEX idx_rt_google_connections_location_772
  ON rt_google_connections(store_id, location_name) WHERE location_name IS NOT NULL;

CREATE INDEX idx_rt_google_connections_store_772
  ON rt_google_connections(store_id, sort_order, created_at);

-- 446 の UNIQUE(store_id) と同じ形。配備中のWorkerの `ON CONFLICT(store_id)` が
-- 当たる先を残すためだけに置く。773 で外す。
CREATE UNIQUE INDEX idx_rt_google_connections_store_compat_772
  ON rt_google_connections(store_id);

-- ---------------------------------------------------------------------------
-- 2. rt_google_profiles: 店舗単位の主キーを接続単位の鍵に置き換える
-- ---------------------------------------------------------------------------

CREATE TABLE rt_google_profiles_new (
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE CASCADE,
  location_name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO rt_google_profiles_new (
  store_id, connection_id, location_name, profile_json, fingerprint, fetched_at, updated_at
)
SELECT
  p.store_id,
  (SELECT c.id FROM rt_google_connections c
     WHERE c.store_id = p.store_id
     ORDER BY c.sort_order, c.created_at, c.id LIMIT 1),
  p.location_name, p.profile_json, p.fingerprint, p.fetched_at, p.updated_at
FROM rt_google_profiles p;

DROP TABLE rt_google_profiles;

ALTER TABLE rt_google_profiles_new RENAME TO rt_google_profiles;

-- 接続ごとに1行。接続が無い引き継ぎ行だけは店舗ごとに1行として残す
CREATE UNIQUE INDEX idx_rt_google_profiles_key_772
  ON rt_google_profiles(COALESCE(connection_id, 'store:' || store_id));

CREATE INDEX idx_rt_google_profiles_store_772 ON rt_google_profiles(store_id);

-- 447 の PRIMARY KEY(store_id) と同じ形。配備中のWorkerの `ON CONFLICT(store_id)` が
-- 当たる先を残すためだけに置く。773 で外す。
CREATE UNIQUE INDEX idx_rt_google_profiles_store_compat_772
  ON rt_google_profiles(store_id);

-- ---------------------------------------------------------------------------
-- 3. rt_google_metrics_daily: (store_id, date) の主キーを接続単位に置き換える
-- ---------------------------------------------------------------------------

CREATE TABLE rt_google_metrics_daily_new (
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  impressions_desktop_maps INTEGER,
  impressions_desktop_search INTEGER,
  impressions_mobile_maps INTEGER,
  impressions_mobile_search INTEGER,
  direction_requests INTEGER,
  call_clicks INTEGER,
  website_clicks INTEGER,
  menu_clicks INTEGER,
  bookings INTEGER,
  food_orders INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO rt_google_metrics_daily_new (
  store_id, connection_id, date,
  impressions_desktop_maps, impressions_desktop_search,
  impressions_mobile_maps, impressions_mobile_search,
  direction_requests, call_clicks, website_clicks,
  menu_clicks, bookings, food_orders, fetched_at
)
SELECT
  m.store_id,
  (SELECT c.id FROM rt_google_connections c
     WHERE c.store_id = m.store_id
     ORDER BY c.sort_order, c.created_at, c.id LIMIT 1),
  m.date,
  m.impressions_desktop_maps, m.impressions_desktop_search,
  m.impressions_mobile_maps, m.impressions_mobile_search,
  m.direction_requests, m.call_clicks, m.website_clicks,
  m.menu_clicks, m.bookings, m.food_orders, m.fetched_at
FROM rt_google_metrics_daily m;

DROP TABLE rt_google_metrics_daily;

ALTER TABLE rt_google_metrics_daily_new RENAME TO rt_google_metrics_daily;

CREATE UNIQUE INDEX idx_rt_google_metrics_daily_key_772
  ON rt_google_metrics_daily(COALESCE(connection_id, 'store:' || store_id), date);

CREATE INDEX idx_rt_google_metrics_daily_store_date
  ON rt_google_metrics_daily(store_id, date DESC);

-- 512 の PRIMARY KEY(store_id, date) と同じ形。配備中のWorkerの
-- `ON CONFLICT(store_id, date)` が当たる先を残すためだけに置く。773 で外す。
CREATE UNIQUE INDEX idx_rt_google_metrics_daily_store_date_compat_772
  ON rt_google_metrics_daily(store_id, date);

-- ---------------------------------------------------------------------------
-- 4. Google 取り込み・履歴・OAuth状態を接続単位で引けるようにする
--    （一意制約の変更が不要な表は ADD COLUMN のみ。review_name / google_post_name は
--      ロケーション名を含むため、既存の一意制約は複数接続でも衝突しない）
--
--    接続を削除したときは ON DELETE SET NULL にする。履歴を黙って失わず、外部キーが
--    有効でも削除が止まらない。接続ごとの取り込みデータの削除は
--    `DELETE … WHERE connection_id = ?` としてアプリ側で明示的に行う。
-- ---------------------------------------------------------------------------

ALTER TABLE rt_google_reviews ADD COLUMN connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL;

UPDATE rt_google_reviews SET connection_id = (
  SELECT c.id FROM rt_google_connections c
   WHERE c.store_id = rt_google_reviews.store_id
   ORDER BY c.sort_order, c.created_at, c.id LIMIT 1
) WHERE connection_id IS NULL;

CREATE INDEX idx_rt_google_reviews_connection_772
  ON rt_google_reviews(connection_id, reply_status, create_time DESC);

ALTER TABLE rt_google_posts ADD COLUMN connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL;

UPDATE rt_google_posts SET connection_id = (
  SELECT c.id FROM rt_google_connections c
   WHERE c.store_id = rt_google_posts.store_id
   ORDER BY c.sort_order, c.created_at, c.id LIMIT 1
) WHERE connection_id IS NULL;

CREATE INDEX idx_rt_google_posts_connection_772
  ON rt_google_posts(connection_id, status, created_at DESC);

ALTER TABLE rt_google_changes ADD COLUMN connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL;

UPDATE rt_google_changes SET connection_id = (
  SELECT c.id FROM rt_google_connections c
   WHERE c.store_id = rt_google_changes.store_id
   ORDER BY c.sort_order, c.created_at, c.id LIMIT 1
) WHERE connection_id IS NULL;

CREATE INDEX idx_rt_google_changes_connection_772
  ON rt_google_changes(connection_id, created_at DESC);

ALTER TABLE rt_google_write_log ADD COLUMN connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL;

UPDATE rt_google_write_log SET connection_id = (
  SELECT c.id FROM rt_google_connections c
   WHERE c.store_id = rt_google_write_log.store_id
   ORDER BY c.sort_order, c.created_at, c.id LIMIT 1
) WHERE connection_id IS NULL;

CREATE INDEX idx_rt_google_write_log_connection_772
  ON rt_google_write_log(connection_id, created_at DESC);

ALTER TABLE rt_google_oauth_states ADD COLUMN connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL;

CREATE INDEX idx_rt_google_oauth_states_connection_772
  ON rt_google_oauth_states(connection_id);

-- 店舗の選択候補は接続ごとの一時的な一覧。UNIQUE(store_id, location_name) のままだと、
-- 同じ店舗の2つの接続が同じGoogleアカウント（同じ候補一覧）で選択待ちになったとき、
-- 後から認可した側の候補が INSERT OR IGNORE で黙って落ちて「選べる店舗ではありません」になる。
-- 接続を鍵に含めて作り直す。
CREATE TABLE rt_google_location_candidates_new (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES rt_google_connections(id) ON DELETE SET NULL,
  location_name TEXT NOT NULL,
  location_title TEXT NOT NULL,
  address_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO rt_google_location_candidates_new (
  id, store_id, connection_id, location_name, location_title, address_text, created_at
)
SELECT
  -- 旧定義は非INTEGERの主キーに NULL を通すので、空の行があっても落ちないようにする
  COALESCE(d.id, 'cand_' || d.store_id || ':' || d.location_name),
  d.store_id,
  (SELECT c.id FROM rt_google_connections c
     WHERE c.store_id = d.store_id
     ORDER BY c.sort_order, c.created_at, c.id LIMIT 1),
  d.location_name, d.location_title, d.address_text, d.created_at
FROM rt_google_location_candidates d;

DROP TABLE rt_google_location_candidates;

ALTER TABLE rt_google_location_candidates_new RENAME TO rt_google_location_candidates;

-- 接続ごとに同じ店舗名は1件。接続が無い引き継ぎ行だけは店舗ごとに1件として残す
CREATE UNIQUE INDEX idx_rt_google_location_candidates_key_772
  ON rt_google_location_candidates(COALESCE(connection_id, 'store:' || store_id), location_name);

CREATE INDEX idx_rt_google_location_candidates_store_772
  ON rt_google_location_candidates(store_id);

CREATE INDEX idx_rt_google_location_candidates_connection_772
  ON rt_google_location_candidates(connection_id);

-- 446 の UNIQUE(store_id, location_name) と同じ形。配備中のWorkerの
-- `INSERT OR IGNORE` が同じ重複の弾き方を続けられるように残す。773 で外す。
CREATE UNIQUE INDEX idx_rt_google_location_candidates_store_compat_772
  ON rt_google_location_candidates(store_id, location_name);

-- ---------------------------------------------------------------------------
-- 5. instagram_connections: line_account_id の主キーを外し、不変の接続IDを導入する
--    （既存行の id は移行前の1接続1アカウントから決まる 'igc_' || line_account_id）
-- ---------------------------------------------------------------------------

CREATE TABLE instagram_connections_new (
  -- NOT NULL を付ける。SQLite は非INTEGERの主キーに NULL を通し、NULL同士は別物として扱うので、
  -- id を渡さない既存の INSERT が黙って id=NULL の行をいくつも作ってしまう。止めるほうを選ぶ。
  -- そのうえで既定値を置く。配備中の旧Workerの upsert は id を渡さず、SQLite は
  -- ON CONFLICT の衝突解決より前に NOT NULL を見るので、既定値がないと既存行を
  -- 更新するだけの経路でも `NOT NULL constraint failed` で落ちてしまう。
  -- 既定値で埋めれば旧Workerの upsert は通り、id を明示 NULL で渡す書き方は今も弾かれる。
  id TEXT PRIMARY KEY NOT NULL DEFAULT ('igc_' || lower(hex(randomblob(12)))),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  page_id TEXT NOT NULL,
  instagram_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  username TEXT,
  page_token_encrypted TEXT NOT NULL,
  user_token_encrypted TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  data_access_expires_at TEXT,
  profile_json TEXT,
  posts_json TEXT,
  refreshed_at TEXT NOT NULL,
  synced_at TEXT,
  connected_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

INSERT INTO instagram_connections_new (
  id, line_account_id, page_id, instagram_id, page_name, username,
  page_token_encrypted, user_token_encrypted, expires_at, data_access_expires_at,
  profile_json, posts_json, refreshed_at, synced_at, connected_by, version, scopes, sort_order
)
SELECT
  'igc_' || line_account_id, line_account_id, page_id, instagram_id, page_name, username,
  page_token_encrypted, user_token_encrypted, expires_at, data_access_expires_at,
  profile_json, posts_json, refreshed_at, synced_at, connected_by, version, scopes, 0
FROM instagram_connections;

DROP TABLE instagram_connections;

ALTER TABLE instagram_connections_new RENAME TO instagram_connections;

CREATE INDEX idx_instagram_connections_instagram_id ON instagram_connections(instagram_id);

CREATE INDEX idx_instagram_connections_account_772
  ON instagram_connections(line_account_id, sort_order, id);

-- 同じLINEアカウントに同じInstagramアカウントを二重に接続させない
CREATE UNIQUE INDEX idx_instagram_connections_account_ig_772
  ON instagram_connections(line_account_id, instagram_id);

-- 603 / 754 の PRIMARY KEY(line_account_id) と同じ形。配備中のWorkerの
-- `ON CONFLICT(line_account_id)` が当たる先を残すためだけに置く。773 で外す。
CREATE UNIQUE INDEX idx_instagram_connections_account_compat_772
  ON instagram_connections(line_account_id);

-- 754 の統括（テナント）越え拒否を同じ条件で作り直す。1接続1行ではなくなったので、
-- 同じLINEアカウント内の複数行は通し、別統括のLINEアカウントとの共有だけを止める。
CREATE TRIGGER instagram_connection_tenant_insert BEFORE INSERT ON instagram_connections WHEN EXISTS(SELECT 1 FROM instagram_connections existing JOIN line_accounts old_account ON old_account.id=existing.line_account_id JOIN line_accounts new_account ON new_account.id=NEW.line_account_id WHERE existing.instagram_id=NEW.instagram_id AND existing.line_account_id<>NEW.line_account_id AND COALESCE(old_account.tenant_id,'00000000-0000-4000-8000-000000000001')<>COALESCE(new_account.tenant_id,'00000000-0000-4000-8000-000000000001')) BEGIN SELECT RAISE(ABORT,'instagram_cross_tenant'); END;

CREATE TRIGGER instagram_connection_tenant_update BEFORE UPDATE OF instagram_id,line_account_id ON instagram_connections WHEN EXISTS(SELECT 1 FROM instagram_connections existing JOIN line_accounts old_account ON old_account.id=existing.line_account_id JOIN line_accounts new_account ON new_account.id=NEW.line_account_id WHERE existing.instagram_id=NEW.instagram_id AND existing.line_account_id<>NEW.line_account_id AND COALESCE(old_account.tenant_id,'00000000-0000-4000-8000-000000000001')<>COALESCE(new_account.tenant_id,'00000000-0000-4000-8000-000000000001')) BEGIN SELECT RAISE(ABORT,'instagram_cross_tenant'); END;

-- ---------------------------------------------------------------------------
-- 6. Instagram の受信とOAuth状態を接続単位で引けるようにする
--    （受信の主キー (line_account_id, id) は mid が一意なので変えない）
-- ---------------------------------------------------------------------------

ALTER TABLE instagram_messages ADD COLUMN connection_id TEXT REFERENCES instagram_connections(id) ON DELETE SET NULL;

UPDATE instagram_messages SET connection_id = (
  SELECT c.id FROM instagram_connections c
   WHERE c.line_account_id = instagram_messages.line_account_id
     AND c.instagram_id = instagram_messages.instagram_id
   LIMIT 1
) WHERE connection_id IS NULL;

CREATE INDEX idx_instagram_messages_connection_772
  ON instagram_messages(connection_id, received_at, id);

ALTER TABLE instagram_oauth_states ADD COLUMN connection_id TEXT REFERENCES instagram_connections(id) ON DELETE SET NULL;

CREATE INDEX idx_instagram_oauth_states_connection_772
  ON instagram_oauth_states(connection_id);

-- ---------------------------------------------------------------------------
-- 7. 子表の connection_id が、その行自身の店舗／LINEアカウントの接続であることをDBで保証する
--    外部キーだけでは「接続が実在するか」しか見ないので、統括Aの口コミに統括Bの接続IDを
--    入れても通ってしまう（PRAGMA foreign_key_check も 0 件になる）。アプリ側の絞り込みを
--    信用せず、書き込みの時点で止める。
--    複合外部キーにせずトリガーにしたのは、754 と書き方が揃うことと、
--    子表8つを table-rebuild せずに足せるため。
--    connection_id が NULL の行（移行直後の引き継ぎ行・接続削除で SET NULL された行）は通す。
-- ---------------------------------------------------------------------------

CREATE TRIGGER rt_google_reviews_connection_store_insert BEFORE INSERT ON rt_google_reviews WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_reviews_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_reviews WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_posts_connection_store_insert BEFORE INSERT ON rt_google_posts WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_posts_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_posts WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_changes_connection_store_insert BEFORE INSERT ON rt_google_changes WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_changes_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_changes WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_write_log_connection_store_insert BEFORE INSERT ON rt_google_write_log WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_write_log_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_write_log WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_oauth_states_connection_store_insert BEFORE INSERT ON rt_google_oauth_states WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_oauth_states_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_oauth_states WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_location_candidates_connection_store_insert BEFORE INSERT ON rt_google_location_candidates WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_location_candidates_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_location_candidates WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_profiles_connection_store_insert BEFORE INSERT ON rt_google_profiles WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_profiles_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_profiles WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_metrics_daily_connection_store_insert BEFORE INSERT ON rt_google_metrics_daily WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER rt_google_metrics_daily_connection_store_update BEFORE UPDATE OF connection_id,store_id ON rt_google_metrics_daily WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_google_connections c WHERE c.id=NEW.connection_id AND c.store_id=NEW.store_id) BEGIN SELECT RAISE(ABORT,'google_connection_store_mismatch'); END;

CREATE TRIGGER instagram_messages_connection_account_insert BEFORE INSERT ON instagram_messages WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=NEW.connection_id AND c.line_account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'instagram_connection_account_mismatch'); END;

CREATE TRIGGER instagram_messages_connection_account_update BEFORE UPDATE OF connection_id,line_account_id ON instagram_messages WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=NEW.connection_id AND c.line_account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'instagram_connection_account_mismatch'); END;

CREATE TRIGGER instagram_oauth_states_connection_account_insert BEFORE INSERT ON instagram_oauth_states WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=NEW.connection_id AND c.line_account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'instagram_connection_account_mismatch'); END;

CREATE TRIGGER instagram_oauth_states_connection_account_update BEFORE UPDATE OF connection_id,line_account_id ON instagram_oauth_states WHEN NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=NEW.connection_id AND c.line_account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'instagram_connection_account_mismatch'); END;
