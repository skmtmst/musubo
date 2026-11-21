import type { RestaurantCoursePhoto } from '@line-crm/shared';

/** メニュー画像はその店舗の登録メディアから選ぶ。 */
export async function validRestaurantMenuImage(db: D1Database, storeId: string, mediaId: string | null): Promise<boolean> {
  if (mediaId === null) return true;
  const row = await db.prepare(`SELECT m.id FROM media m JOIN rt_stores s ON s.line_account_id = m.line_account_id
    WHERE s.id = ? AND m.id = ? AND m.kind = 'image' AND m.archived_at IS NULL`)
    .bind(storeId, mediaId).first();
  return Boolean(row);
}

export function validRestaurantMenuDescription(value: unknown): value is string | null | undefined {
  return value == null || typeof value === 'string' && value.length <= 2000;
}

export async function validRestaurantCoursePhotos(db: D1Database, storeId: string, photos: RestaurantCoursePhoto[]) {
  const checked = await Promise.all(photos.map(photo => validRestaurantMenuImage(db, storeId, photo.mediaId)));
  return checked.every(Boolean);
}
