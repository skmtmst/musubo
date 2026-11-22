-- migration 790 適用前に読み取りだけで実行する。結果が0行なら組織の重複なし。
-- 行が返ったときは変更を行わず、統括ごとの件数を確認する。
SELECT tenant_id, COUNT(*) AS duplicate_count
FROM rt_organizations
WHERE tenant_id IS NOT NULL
GROUP BY tenant_id
HAVING COUNT(*) > 1;
