export { checkRestaurantMenuPrice } from './restaurant-menu-price.js';
import { expect } from 'vitest';
import { countMedia, getMedia, getMediaDeleteImpactSnapshot, getMediaReplacementPlan } from '@line-crm/db';
import { mediaTabCounts } from '../services/tab-counts.js';
import { collectFeatureImpact } from '../routes/feature-settings-definition-collect-feature-impact.js';
import type { SqliteD1 } from './d1-sqlite.js';

export async function checkRestaurantMenuMedia({ testDb, seedRestaurantFixture, request, requestWithMethod }: {
  testDb: SqliteD1;
  seedRestaurantFixture: () => void;
  request: (path: string, body?: unknown) => Response | Promise<Response>;
  requestWithMethod: (path: string, method: string, body?: unknown) => Response | Promise<Response>;
}): Promise<void> {
    seedRestaurantFixture();
    testDb.raw.prepare(`INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key) VALUES('menu-photo','account-2','image','dish.png','image/png',100,'fake/menu.png')`).run();
    const response = await request('/api/restaurant-test/menu?account_id=account-1', { storeId:'store-ginza', kind:'course', name:'架空のコース', price:1000, status:'draft', description:'季節の料理', imageMediaId:'menu-photo' });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as {data:{id:string}}).data.id;
    const list = await request('/api/restaurant-test/menus?account_id=account-1&storeId=store-ginza');
    const result = (await list.json()) as {data:Array<{id:string;description:string|null;image_media_id:string|null}>};
    expect(result.data.find(row => row.id === id)).toMatchObject({ description:'季節の料理', image_media_id:'menu-photo' });
    const impact = await getMediaDeleteImpactSnapshot(testDb.db, 'menu-photo', 'account-2', '2026-11-03T00:00:00Z');
    expect(impact?.impact).toMatchObject({ canDelete:false, usageCount:1, references:[expect.objectContaining({ kind:'restaurant_menu', name:'架空のコース' })] });
    testDb.raw.prepare(`INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key) VALUES('replacement','account-2','image','other.png','image/png',100,'fake/replacement.png')`).run();
    const plan = await getMediaReplacementPlan(testDb.db, { sourceId:'menu-photo', replacementId:'replacement', lineAccountId:'account-2', checkedAt:'2026-11-03T00:00:00Z' });
    expect(plan?.impact).toMatchObject({ canReplace:false, canPartiallyReplace:false, blockedCount:1 });
    const rows = await getMedia(testDb.db, { lineAccountId:'account-2', sort:'usage' });
    expect(rows.find(row => row.id === 'menu-photo')?.usage_count).toBe(1);
    expect((await getMedia(testDb.db, { lineAccountId:'account-2', unusedOnly:true })).map(row=>row.id)).not.toContain('menu-photo');
    expect(await countMedia(testDb.db, { lineAccountId:'account-2', unusedOnly:true })).toBe(1);
    expect((await mediaTabCounts(testDb.db, 'account-2')).unused).toBe(1);
    expect((await collectFeatureImpact(testDb.db, 'account-2', 'media')).find(item=>item.targetType==='素材への利用参照')?.ids).toContain('menu-photo');
    const path = `/api/restaurant-test/menu/${id}?account_id=account-1`;
    expect((await requestWithMethod(path, 'PATCH', { name:'名前だけ変更' })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT description,image_media_id FROM rt_menu_items WHERE id=?').get(id)).toEqual({ description:'季節の料理', image_media_id:'menu-photo' });
    testDb.raw.prepare("UPDATE media SET archived_at='2026-11-03T00:00:00Z' WHERE id='menu-photo'").run();
    const stale = await requestWithMethod(path, 'PATCH', { name:'画像が使えないメニュー' });
    expect(stale.status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { status:'archived' })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { status:'active' })).status).toBe(200);
    testDb.raw.prepare("UPDATE media SET archived_at=NULL WHERE id='menu-photo'").run();
    expect((await requestWithMethod(path, 'PATCH', { description:'新しい説明', imageMediaId:null })).status).toBe(200);
    const updated = await request('/api/restaurant-test/menus?account_id=account-1&storeId=store-ginza');
    expect(((await updated.json()) as typeof result).data.find(row => row.id === id)).toMatchObject({ description:'新しい説明', image_media_id:null });
    testDb.raw.prepare(`INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key) VALUES('other-photo','account-3','image','x.png','image/png',1,'other.png')`).run();
    const unavailable = await requestWithMethod(path, 'PATCH', { imageMediaId:'other-photo' });
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({ code:'MENU_IMAGE_UNAVAILABLE' });
    const missing = await request('/api/restaurant-test/menu?account_id=account-1', { storeId:'store-ginza', kind:'course', name:'欠けた画像', price:1000, imageMediaId:'missing' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code:'MENU_IMAGE_UNAVAILABLE' });
    expect((await requestWithMethod(path, 'PATCH', { description:'x'.repeat(2001) })).status).toBe(400);
    const photos = [{ mediaId:'replacement', x:75, y:25 }, { mediaId:'menu-photo', x:30, y:60 }];
    expect((await requestWithMethod(path, 'PATCH', { photos })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT image_media_id, photo_gallery_json FROM rt_menu_items WHERE id=?').get(id))
      .toEqual({ image_media_id:'replacement', photo_gallery_json:JSON.stringify(photos) });
    const secondPhoto = await getMediaDeleteImpactSnapshot(testDb.db, 'menu-photo', 'account-2', '2026-11-03T00:00:00Z');
    expect(secondPhoto?.impact).toMatchObject({ canDelete:false, usageCount:1 });
    expect((await requestWithMethod(path, 'PATCH', { photos: [{ mediaId:'other-photo', x:50, y:50 }] })).status).toBe(400);
    expect((await requestWithMethod(path, 'PATCH', { photos: [{ ...photos[0], x:101 }] })).status).toBe(400);
    expect((await requestWithMethod(path, 'PATCH', { photos: [...photos, photos[0]] })).status).toBe(400);
    expect((await requestWithMethod(path, 'PATCH', { name:'写真を保持' })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT photo_gallery_json FROM rt_menu_items WHERE id=?').get(id)).toEqual({ photo_gallery_json:JSON.stringify(photos) });

}
