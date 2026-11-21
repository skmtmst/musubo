import { listAutomationTemplates } from '../features/automations/automation-drafts/index.js';

export async function automationTabCounts(db: D1Database, accountId: string) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM automation_definitions WHERE line_account_id = ? AND status <> 'archived') AS rules,
    (SELECT COUNT(*) FROM common_actions WHERE line_account_id = ? AND status <> 'archived') AS commonActions`)
    .bind(accountId, accountId).first<{ rules: number; commonActions: number }>();
  if (!row) throw new Error('automation_counts_unavailable');
  return { ...row, templates: listAutomationTemplates().length };
}

export async function mediaTabCounts(db: D1Database, accountId: string) {
  const row = await db.prepare(`SELECT
    COUNT(CASE WHEN m.archived_at IS NULL THEN 1 END) AS total,
    COUNT(CASE WHEN m.archived_at IS NULL AND m.kind = 'image' THEN 1 END) AS image,
    COUNT(CASE WHEN m.archived_at IS NULL AND m.kind = 'video' THEN 1 END) AS video,
    COUNT(CASE WHEN m.archived_at IS NULL AND m.kind = 'audio' THEN 1 END) AS audio,
    COUNT(CASE WHEN m.archived_at IS NULL AND m.kind = 'file' THEN 1 END) AS file,
    COUNT(CASE WHEN m.archived_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM media_usages u WHERE u.media_id = m.id) AND menu_uses.image_media_id IS NULL THEN 1 END) AS unused,
    COUNT(CASE WHEN m.archived_at IS NOT NULL THEN 1 END) AS archived
    FROM media m LEFT JOIN (SELECT image_media_id FROM rt_menu_items WHERE image_media_id IS NOT NULL
      UNION SELECT json_extract(photo.value, '$.mediaId') FROM rt_menu_items menu, json_each(menu.photo_gallery_json) photo) menu_uses ON menu_uses.image_media_id = m.id WHERE m.line_account_id = ?`).bind(accountId).first<{
      total: number; image: number; video: number; audio: number; file: number; unused: number; archived: number;
    }>();
  if (!row) throw new Error('media_counts_unavailable');
  const { image, video, audio, file, ...counts } = row;
  return { ...counts, byKind: { image, video, audio, file } };
}

export async function conversionApprovalCounts(db: D1Database, scope: {
  allowedAccountIds: readonly string[]; includeUnassigned: boolean;
}) {
  const row = await db.prepare(`SELECT
    COUNT(CASE WHEN ce.approval_status = 'pending' THEN 1 END) AS pending,
    COUNT(CASE WHEN ce.approval_status = 'approved' THEN 1 END) AS approved,
    COUNT(CASE WHEN ce.approval_status = 'rejected' THEN 1 END) AS rejected
    FROM conversion_events ce
    JOIN friends f ON f.id = ce.friend_id
    JOIN conversion_points cp ON cp.id = ce.conversion_point_id
    WHERE ce.affiliate_id IS NOT NULL
      AND (cp.line_account_id IN (SELECT value FROM json_each(?))
        OR (? = 1 AND cp.line_account_id IS NULL))`)
    .bind(JSON.stringify(scope.allowedAccountIds), Number(scope.includeUnassigned))
    .first<{ pending: number; approved: number; rejected: number }>();
  if (!row) throw new Error('approval_counts_unavailable');
  return { ...row, total: row.pending + row.approved + row.rejected };
}
