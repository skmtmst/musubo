-- 読み取り専用。0 件以外なら 785 を適用せず、参照元の確認・対処を行う。
SELECT COUNT(*) AS orphan_count
FROM broadcast_approval_events AS approval
LEFT JOIN broadcasts AS broadcast ON broadcast.id = approval.broadcast_id
WHERE approval.broadcast_id IS NOT NULL AND broadcast.id IS NULL;
