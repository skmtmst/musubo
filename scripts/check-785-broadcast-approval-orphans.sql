-- 読み取り専用。785 適用時に配信 ID が NULL になる承認履歴を数える。
SELECT COUNT(*) AS orphan_count
FROM broadcast_approval_events AS approval
LEFT JOIN broadcasts AS broadcast ON broadcast.id = approval.broadcast_id
WHERE approval.broadcast_id IS NOT NULL AND broadcast.id IS NULL;
