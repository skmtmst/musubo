import { formReferenceImage } from '../features/forms/index.js';
import type { Env } from '../worker-env.js';

/** 公開フォームと同じ門番で、店の現在の表紙だけをお客さまに渡す。 */
export async function restaurantCoursePhoto(env: Env['Bindings'], accountId: string, storeId: string, courseId: string, origin: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT m.id, v.version_no FROM rt_menu_items c
    JOIN rt_stores s ON s.id=c.store_id
    JOIN media m ON m.id=c.image_media_id AND m.line_account_id=s.line_account_id
    JOIN media_versions v ON v.media_id=m.id AND v.r2_key=m.r2_key AND v.published_at IS NOT NULL
    WHERE c.id=? AND c.store_id=? AND s.line_account_id=? AND c.kind='course' AND c.status='active'`)
    .bind(courseId, storeId, accountId).first<{ id: string; version_no: number }>();
  if (!row) return null;
  const image = await formReferenceImage(env, accountId, { kind: 'image', blockId: 'course', mediaId: row.id, versionNo: row.version_no, alt: '' });
  return image ? `${origin.replace(/\/$/, '')}/media/${encodeURIComponent(row.id)}/content` : null;
}
