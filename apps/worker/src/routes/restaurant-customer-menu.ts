import { isAccountFeatureEnabled } from '@line-crm/db';
import type { Context, Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import { checkMediaGate } from '../services/file-scan.js';
import { isWebinarSource } from '../services/image-access.js';
import { getPinnedMediaObject } from '../services/media-upload-storage.js';
import {
  permittedRestaurantMenuPhoto,
  restaurantMenuBookingUrl,
  restaurantMenuItems,
  restaurantMenuStore,
  validMenuPhotoGrant,
} from '../services/restaurant-customer-menu.js';
import { liffBookingJson } from './liff-booking-response.js';
import { identity } from './restaurant-customer-identity.js';

const notFound = (c: Context<Env>) => liffBookingJson(c, { success: false, error: 'not_found' }, 404);

export function registerRestaurantCustomerMenuRoutes(routes: Hono<Env>) {
  routes.get('/api/liff/restaurant/menu', async c => {
    const self = await identity(c);
    if (self instanceof Response) return self;
    const token = c.req.query('token')?.trim();
    const storeId = c.req.query('storeId')?.trim();
    if (Boolean(token) === Boolean(storeId)) return notFound(c);
    const store = await restaurantMenuStore(dbFor(c.env), self.accountId, { token, storeId });
    if (!store) return notFound(c);
    const db = dbFor(c.env, store.id);
    const origin = c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin;
    const [items, bookingUrl] = await Promise.all([
      restaurantMenuItems(db, self.accountId, store.id, origin, c.env.API_KEY),
      restaurantMenuBookingUrl(db, store),
    ]);
    return liffBookingJson(c, { success: true, data: { storeId: store.id, storeName: store.name, bookingUrl, items } });
  });

  routes.get('/api/liff/restaurant/menu/photos/:storeId/:itemId/:mediaId', async c => {
    const secret = c.env.API_KEY;
    const expires = c.req.query('expires') ?? '';
    const signature = c.req.query('signature') ?? '';
    if (!secret || !validMenuPhotoGrant(expires, signature)) return notFound(c);
    const { storeId, itemId, mediaId } = c.req.param();
    const db = dbFor(c.env, storeId);
    const media = await permittedRestaurantMenuPhoto(db, { storeId, itemId, mediaId }, secret, expires, signature);
    if (!media || !await isAccountFeatureEnabled(db, media.account_id, 'restaurant_test')
      || await isWebinarSource(db, media.r2_key)) return notFound(c);
    const gate = await checkMediaGate(db, c.env.IMAGES, {
      id: media.id,
      lineAccountId: media.account_id,
      r2Key: media.r2_key,
      filename: media.filename,
      mimeType: media.mime_type,
      sizeBytes: media.size_bytes,
      width: media.width,
      height: media.height,
    });
    if (!gate.allowed) return notFound(c);
    const object = await getPinnedMediaObject(c.env.IMAGES, media.r2_key, gate.etag);
    if (!object) return notFound(c);
    return new Response(object.body, { headers: {
      'Content-Type': media.mime_type,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
}
