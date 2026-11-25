import { activeTenantLineAccountSql } from '@line-crm/db';
import { readRestaurantCoursePhotos } from '@line-crm/shared';
import { computeHmacSha256Hex, safeEqualHex } from '../lib/hmac.js';
import { privateImageKey, publicDeliveryContentType, publicImageKey } from './image-access.js';
import { tzDateStr } from './availability.js';
import { readInventoryAllocation } from './restaurant-inventory-allocation.js';
import { restaurantReservationEmbed } from './restaurant-media-links.js';
import { connectedGoogleProfile, googleOpeningWeek } from './restaurant-google-hours-source.js';
import { primaryGoogleConnection } from './google-connection-primary.js';
import { validateRestaurantOpeningHours } from './restaurant-inventory.js';

type MenuStore = {
  id: string;
  name: string;
  liff_id: string | null;
  reservation_token: string | null;
};

type MenuPhotoFields = {
  image_media_id: string | null;
  photo_gallery_json: string | null;
};

type MenuRow = MenuPhotoFields & {
  id: string;
  kind: 'course' | 'a_la_carte';
  name: string;
  price: number;
  description: string | null;
  duration_minutes: number | null;
  service_periods_json: string;
};

type PhotoIdentity = {
  accountId: string;
  storeId: string;
  itemId: string;
  mediaId: string;
};

type MenuPhotoMedia = {
  id: string;
  r2_key: string;
  mime_type: string;
};

type PublishedMenuPhoto = MenuPhotoMedia & MenuPhotoFields & {
  account_id: string;
  filename: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
};

const photoLifetimeSeconds = 300;
const epochSeconds = () => Math.floor(Date.now() / 1000);

export function restaurantMenuStore(db: D1Database, accountId: string, selector: { token?: string; storeId?: string }) {
  return db.prepare(`SELECT s.id, s.name, a.liff_id, l.token AS reservation_token
    FROM rt_stores s INNER JOIN line_accounts a ON a.id=s.line_account_id
    LEFT JOIN rt_reservation_links l ON l.store_id=s.id
    WHERE s.line_account_id=?1 AND s.status='active'
      AND a.is_active=1 AND a.archived_at IS NULL AND ${activeTenantLineAccountSql('a.id')}
      AND ((?2 IS NOT NULL AND l.token=?2) OR (?3 IS NOT NULL AND s.id=?3))`)
    .bind(accountId, selector.token ?? null, selector.storeId ?? null).first<MenuStore>();
}

function allowedMenuPhoto(media: MenuPhotoMedia): boolean {
  return media.mime_type.toLowerCase().startsWith('image/') && publicDeliveryContentType(media.mime_type)
    && publicImageKey(media.r2_key) && !privateImageKey(media.r2_key);
}

function parseStringList(raw: string): string[] {
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function photoPayload({ accountId, storeId, itemId, mediaId }: PhotoIdentity, expires: string) {
  return JSON.stringify(['restaurant-menu-photo:v1', accountId, storeId, itemId, mediaId, expires]);
}

async function photoUrl(origin: string, secret: string, photo: PhotoIdentity, expires: string) {
  const { storeId, itemId, mediaId } = photo;
  const route = [storeId, itemId, mediaId].map(encodeURIComponent).join('/');
  const url = new URL(`/api/liff/restaurant/menu/photos/${route}`, origin);
  const signature = await computeHmacSha256Hex(secret, photoPayload(photo, expires));
  url.search = new URLSearchParams({ expires, signature }).toString();
  return url.href;
}

export async function restaurantMenuItems(
  db: D1Database, accountId: string, storeId: string, origin: string, secret?: string,
) {
  const { results } = await db.prepare(`SELECT i.id, i.kind, i.name, i.price, i.description, i.duration_minutes,
      i.service_periods_json, i.image_media_id, i.photo_gallery_json FROM rt_menu_items i
    JOIN rt_stores s ON s.id=i.store_id JOIN line_accounts a ON a.id=s.line_account_id
    WHERE s.id=? AND a.id=? AND s.status='active' AND i.status='active'
      AND a.is_active=1 AND a.archived_at IS NULL AND ${activeTenantLineAccountSql('a.id')}
    ORDER BY i.kind DESC, i.name, i.id`).bind(storeId, accountId).all<MenuRow>();
  const items = results.map(row => ({ row, photos: readRestaurantCoursePhotos(row.photo_gallery_json, row.image_media_id) }));
  const photoIds = [...new Set(items.flatMap(item => item.photos.map(photo => photo.mediaId)))];
  const photoMedia = secret && photoIds.length ? (await db.prepare(`SELECT id,r2_key,mime_type FROM media
    WHERE line_account_id=? AND kind='image' AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
    .bind(accountId, JSON.stringify(photoIds)).all<MenuPhotoMedia>()).results : [];
  const allowed = new Set(photoMedia.filter(allowedMenuPhoto).map(media => media.id));
  const expires = String(epochSeconds() + photoLifetimeSeconds);
  return Promise.all(items.map(async ({ row, photos }) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    price: row.price,
    description: row.description,
    durationMinutes: row.kind === 'course' ? row.duration_minutes : null,
    servicePeriods: parseStringList(row.service_periods_json),
    photos: secret ? await Promise.all(photos.filter(photo => allowed.has(photo.mediaId)).map(async photo => ({
      id: photo.mediaId,
      url: await photoUrl(origin, secret, { accountId, storeId, itemId: row.id, mediaId: photo.mediaId }, expires),
      x: photo.x,
      y: photo.y,
    }))) : [],
  })));
}

export function validMenuPhotoGrant(expires: string, signature: string) {
  const now = epochSeconds();
  return /^\d{10}$/.test(expires) && /^[a-f0-9]{64}$/.test(signature)
    && Number(expires) > now && Number(expires) <= now + photoLifetimeSeconds;
}

export async function permittedRestaurantMenuPhoto(
  db: D1Database, ids: Omit<PhotoIdentity, 'accountId'>, secret: string, expires: string, signature: string,
) {
  const row = await db.prepare(`SELECT a.id AS account_id, m.id, m.r2_key, m.mime_type, m.filename, m.size_bytes,
      m.width, m.height, i.image_media_id, i.photo_gallery_json
    FROM rt_stores s INNER JOIN rt_menu_items i ON i.store_id=s.id
    INNER JOIN line_accounts a ON a.id=s.line_account_id
    INNER JOIN media m ON m.line_account_id=a.id AND m.id=?
    WHERE s.id=? AND i.id=? AND s.status='active' AND i.status='active'
      AND a.is_active=1 AND a.archived_at IS NULL AND ${activeTenantLineAccountSql('a.id')}
      AND m.kind='image' AND m.archived_at IS NULL`)
    .bind(ids.mediaId, ids.storeId, ids.itemId).first<PublishedMenuPhoto>();
  if (!row || !allowedMenuPhoto(row)) return null;
  const expected = await computeHmacSha256Hex(secret, photoPayload({ ...ids, accountId: row.account_id }, expires));
  if (!safeEqualHex(expected, signature)) return null;
  const photos = readRestaurantCoursePhotos(row.photo_gallery_json, row.image_media_id);
  return photos.some(photo => photo.mediaId === ids.mediaId) ? row : null;
}

function hasOpeningPeriods(hours: string) {
  try {
    const saved: unknown = JSON.parse(hours);
    if (!Array.isArray(saved) || saved.some(day => !Number.isInteger(day?.weekday) || day.weekday < 0 || day.weekday > 6)) return false;
    const week = [...saved];
    for (let weekday = 0; weekday < 7; weekday++) {
      if (!saved.some(day => day.weekday === weekday)) week.push({ weekday, periods: [] });
    }
    return Boolean(validateRestaurantOpeningHours(week)?.some(day => day.periods.length > 0));
  } catch {
    return false;
  }
}

export async function restaurantMenuBookingUrl(db: D1Database, store: MenuStore) {
  const liffId = store.liff_id?.trim();
  if (!store.reservation_token || !liffId) return null;
  const [allocation, readiness] = await Promise.all([
    readInventoryAllocation(db, store.id).catch(() => null),
    db.prepare(`SELECT h.hours_json,
      EXISTS(SELECT 1 FROM rt_tables WHERE store_id=?1 AND is_active=1 AND max_capacity>0) AS has_tables,
      EXISTS(SELECT 1 FROM rt_inventory_slots WHERE store_id=?1 AND julianday(starts_at)>julianday('now')
        AND total_capacity>0 AND line_capacity>0) AS has_line_slots
      FROM rt_opening_hours_settings h WHERE h.store_id=?1`).bind(store.id)
      .first<{ hours_json: string | null; has_tables: number; has_line_slots: number }>(),
  ]);
  if (!allocation || !readiness?.has_tables || !readiness.hours_json) return null;
  const lineConfigured = allowsLineIntake(allocation) || (!allocation.standard && Boolean(readiness.has_line_slots));
  if (!lineConfigured) return null;
  const connection = await primaryGoogleConnection(db, store.id);
  const profile = connection ? await connectedGoogleProfile(db, store.id, connection.id) : null;
  const acceptsBookings = connection
    ? profile && googleOpeningWeek(profile)?.some(day => day.periods.length > 0)
    : hasOpeningPeriods(readiness.hours_json);
  return acceptsBookings ? restaurantReservationEmbed(liffId, store.reservation_token).url : null;
}

function allowsLineIntake(allocation: Awaited<ReturnType<typeof readInventoryAllocation>>) {
  const now = new Date();
  const today = tzDateStr(allocation.timezone, now);
  return (allocation.standard?.lineCapacity ?? 0) > 0
    || Object.entries(allocation.days).some(([date, value]) => date >= today && value.lineCapacity > 0)
    || Object.entries(allocation.slots).some(([start, value]) => Date.parse(start) > now.getTime() && (value?.lineCapacity ?? 0) > 0);
}
