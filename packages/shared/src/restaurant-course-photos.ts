export const RESTAURANT_COURSE_PHOTO_LIMIT = 5;

export type RestaurantCoursePhoto = { mediaId: string; x: number; y: number };

export function parseRestaurantCoursePhotos(value: unknown): RestaurantCoursePhoto[] | null {
  if (!Array.isArray(value) || value.length > RESTAURANT_COURSE_PHOTO_LIMIT) return null;
  const photos: RestaurantCoursePhoto[] = [];
  const ids = new Set<string>();
  const isPosition = (position: unknown): position is number =>
    typeof position === 'number' && Number.isInteger(position) && position >= 0 && position <= 100;
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const { mediaId, x, y } = item as Record<string, unknown>;
    if (typeof mediaId !== 'string' || !mediaId.trim() || ids.has(mediaId) || !isPosition(x) || !isPosition(y)) return null;
    ids.add(mediaId);
    photos.push({ mediaId, x, y });
  }
  return photos;
}

export function readRestaurantCoursePhotos(value: string | null | undefined, cover: string | null | undefined) {
  if (value) {
    try {
      const photos = parseRestaurantCoursePhotos(JSON.parse(value));
      if (photos) return photos;
    } catch { /* 以前の表紙があれば下の互換表示を使う。 */ }
  }
  return cover ? [{ mediaId: cover, x: 50, y: 50 }] : [];
}
