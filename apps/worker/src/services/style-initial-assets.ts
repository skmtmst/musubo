import { initialRestaurantStore,initialRestaurantStoreGuard } from './style-initial-store.js';
import { initialMenuImageKey, initialMenuPng, type AccountStyle, type RestaurantGuideMenu } from '@line-crm/shared';
import presetImages from './restaurant-guide-menu-images.json';
import type { StarterDefinition } from './style-starter-definition.js';

/** 明示的な保存・入れ直し・配布からだけ呼ぶ。読む口では画像も予約リンクも作らない。 */
export async function materializeInitialMenuAssets(_db:D1Database,images:R2Bucket|undefined,account:string,style:AccountStyle,definition:StarterDefinition,preset?: RestaurantGuideMenu) {
 if(!definition.items.some(item=>item.initialMenu===style))return;
 if(images) {
  const key=initialMenuImageKey(account,style,preset);
  if(!await images.head(key)) {
    const image = preset ? Uint8Array.from(atob(presetImages[preset]), character => character.charCodeAt(0)) : initialMenuPng(style);
    await images.put(key,image,{httpMetadata:{contentType:'image/png'}});
  }
 }
}

/** URLを先に作る必要がある予約リンクも、スタイルのCASと同じbatchへ積む。 */
export async function planInitialMenuHistory(db:D1Database,account:string,statements:D1PreparedStatement[],planned:Map<string,string>,actor:string) {
 if(planned.has('restaurant-history-token'))return;
 const store=await initialRestaurantStore(db,account);
 if(!store)return;
 const existing=await db.prepare('SELECT token FROM rt_reservation_links WHERE store_id=?').bind(store).first<{token:string}>();
 const token=existing?.token??crypto.randomUUID();
 planned.set('restaurant-history-token',token);
 statements.push(initialRestaurantStoreGuard(db,account,store));
 if(existing)return;
 statements.push(db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM rt_reservation_links WHERE store_id=?) OR EXISTS(SELECT 1 FROM rt_reservation_links WHERE store_id=? AND token=?) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`).bind(store,store,token),
  db.prepare('INSERT OR IGNORE INTO rt_reservation_links(store_id,token) VALUES(?,?)').bind(store,token),
  db.prepare(`INSERT INTO style_change_logs(id,line_account_id,actor_id,action,after_json,created_at) VALUES(?,?,?,'initial_menu.history_link.created',?,?)`).bind(crypto.randomUUID(),account,actor,JSON.stringify({storeId:store}),new Date().toISOString()));
}
