-- migration-state: ledger-only
-- 773: 772 で残した「1接続1店舗」時代の互換索引を外す（複数接続を実際に入れられるようにする）
--
-- 状態の判定について: このファイルは索引を外すだけで、新しい表・列・索引を作らない。
--   `scripts/deploy/migrate.ts status` の現物判定は「持ち込む物が在るか」で見るので
--   目印が0個になり「判定不能（データのみ）」に化ける。実際はスキーマを変えるため、
--   772 と同じく `_migrations` の記録で判定する。
--
-- 置き場所: `packages/db/migrations-pending/` から
--   `packages/db/migrations/` へ移した。移す条件（共有検証へ 772 だけを当て、
--   接続IDで読み書きする新しいWorkerとWebを配備し、既存接続の互換性を確かめる）は
--   済んでいる。移した結果、配備の見張り（`packages/db/migrations/*.sql` を数えて
--   「未適用が残っていたらWorkerを配らない」）がこのファイルも数えるので、
--   **このPRを統合した後の次のWorker配備は、773 を当ててからでないと通らない**。
--   これは意図した順番（772 → 新Worker → 互換性確認 → 773 → 複数接続確認）であり、
--   見張りを緩めずに段階を踏むための仕組み。手順は
--   `packages/db/migrations-pending/README.md`。
--
-- 当てる時期: 772 を当て、接続IDで読み書きする新しいWorkerを配備し終えた後。
--   772 は `ON CONFLICT(store_id)` / `ON CONFLICT(line_account_id)` と書いた
--   配備中のWorkerを落とさないために、外した主キー / UNIQUE と同じ形の索引を
--   `_compat_772` という名前で残してある。残っているあいだは同じ店舗 /
--   LINEアカウントの2件目の接続行が一意制約で弾かれる。
--   新しいWorkerは `COALESCE(connection_id, 'store:' || store_id)` の式索引
--   （`_key_772`）に当たるので、この5本を外しても upsert の当たり先は変わらない。
--
-- 残すもの: 772 で作った接続単位の鍵と、複数接続でも必要な重複防止。
--   - idx_rt_google_profiles_key_772 / idx_rt_google_metrics_daily_key_772 /
--     idx_rt_google_location_candidates_key_772（接続ごとに1行）
--   - idx_rt_google_connections_location_772（同じ店舗に同じロケーションを二重に接続させない）
--   - idx_instagram_connections_account_ig_772（同じLINEアカウントに同じInstagramを二重に接続させない）
--   - 754 由来の統括越え拒否トリガー、772 で足した接続と親の一致を見るトリガー
--
-- 戻し方: このmigrationを当てた後に 772 時点へ戻す必要が出た場合は、
--   D1 Time Travel で巻き戻す（docs/migration-runbook.md の戻し方に従う）。
--   2件目の接続行が既に入っている状態で索引を作り直すと一意制約で失敗するため、
--   索引を手で作り直す方法は取らない。

DROP INDEX IF EXISTS idx_rt_google_connections_store_compat_772;

DROP INDEX IF EXISTS idx_rt_google_profiles_store_compat_772;

DROP INDEX IF EXISTS idx_rt_google_metrics_daily_store_date_compat_772;

DROP INDEX IF EXISTS idx_rt_google_location_candidates_store_compat_772;

DROP INDEX IF EXISTS idx_instagram_connections_account_compat_772;
