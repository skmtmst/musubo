import {floorBoxInside,floorBoxesOverlap,type RestaurantFloorWrite } from '@line-crm/shared';

export function validRestaurantFloor(value: unknown): value is RestaurantFloorWrite {
 if(!value||typeof value!=='object')return false;
 const f=value as RestaurantFloorWrite;
 const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
 if(typeof f.id!=='string'||!f.id||typeof f.storeId!=='string'||!f.storeId||typeof f.name!=='string'||!f.name.trim()||f.name.length>80
 ||!Number.isInteger(f.expectedVersion)||f.expectedVersion<1||!finite(f.width)||!finite(f.height)||f.width<100||f.height<100||f.width>10000||f.height>10000
 ||!Array.isArray(f.outline)||f.outline.length>100||!Array.isArray(f.fixtures)||f.fixtures.length>100||!Array.isArray(f.tables)||f.tables.length>200)return false;
 if(f.outline.some(p=>!p||!finite(p.x)||!finite(p.y)||p.x<0||p.y<0||p.x>f.width||p.y>f.height))return false;
 if(new Set(f.tables.map(t=>t?.id)).size!==f.tables.length||new Set(f.fixtures.map(t=>t?.id)).size!==f.fixtures.length)return false;
 const inside=(t:{x:number;y:number;width:number;height:number})=>t&&[t.x,t.y,t.width,t.height].every(finite)&&t.x>=0&&t.y>=0&&t.width>0&&t.height>0&&t.x+t.width<=f.width&&t.y+t.height<=f.height;
 if(f.tables.some(t=>!inside(t)||!floorBoxInside(t,f.width,f.height)||typeof t.id!=='string'||!finite(t.rotation)||Math.abs(t.rotation)>360||!['rectangle','circle','long','counter','sofa'].includes(t.shape)))return false;
 if(f.fixtures.some(t=>!inside(t)||typeof t.id!=='string'||!['wall','entrance','kitchen','toilet','window'].includes(t.kind)))return false;
 return !f.tables.some((a,i)=>f.tables.slice(i+1).some(b=>floorBoxesOverlap(a,b)));
}
/** 版更新と配置の保存を同じD1 batchに入れる。版違いなら配置は書き込まれない。 */
export async function saveRestaurantFloor(db:D1Database,f:RestaurantFloorWrite):Promise<boolean> {
 // batch の後段は、この文で保存した版・値を再確認する。
 const result=await db.batch([
 db.prepare(`UPDATE rt_floors SET name=?,width=?,height=?,outline_json=?,fixtures_json=?,version=version+1
 WHERE id=? AND store_id=? AND archived_at IS NULL AND version=? AND (SELECT COUNT(*) FROM rt_tables WHERE floor_id=rt_floors.id)=? AND (SELECT COUNT(*) FROM rt_tables WHERE floor_id=rt_floors.id AND store_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)))=?`)
 .bind(f.name.trim(),f.width,f.height,JSON.stringify(f.outline),JSON.stringify(f.fixtures),f.id,f.storeId,f.expectedVersion,f.tables.length,f.storeId,JSON.stringify(f.tables),f.tables.length),
 db.prepare(`UPDATE rt_tables SET confirmation_revision=confirmation_revision+1, floor_id=?,floor_x=json_extract(p.value,'$.x'),floor_y=json_extract(p.value,'$.y'),
 width=json_extract(p.value,'$.width'),height=json_extract(p.value,'$.height'),shape=json_extract(p.value,'$.shape'),rotation=json_extract(p.value,'$.rotation'),updated_at=datetime('now')
 FROM json_each(?) p WHERE rt_tables.id=json_extract(p.value,'$.id') AND rt_tables.store_id=? AND changes()=1`)
 .bind(f.id,JSON.stringify(f.tables),f.storeId),
 ]);
 return result[0].meta.changes===1;
}

export async function readRestaurantFloor(db:D1Database,id:string,storeId:string):Promise<RestaurantFloorWrite|null> {
 const row=await db.prepare('SELECT * FROM rt_floors WHERE id=? AND store_id=? AND archived_at IS NULL').bind(id,storeId).first<Record<string,unknown>>();
 if(!row)return null;
 const tables=await db.prepare('SELECT * FROM rt_tables WHERE floor_id=? AND store_id=?').bind(id,storeId).all<Record<string,unknown>>();
 return {id,storeId,name:String(row.name),width:Number(row.width),height:Number(row.height),expectedVersion:Number(row.version),outline:JSON.parse(String(row.outline_json)),fixtures:JSON.parse(String(row.fixtures_json)),tables:tables.results.map(t=>({id:String(t.id),x:Number(t.floor_x),y:Number(t.floor_y),width:Number(t.width),height:Number(t.height),rotation:Number(t.rotation),shape:t.shape as RestaurantFloorWrite['tables'][number]['shape']}))};
}
export function tablePlacementFits(f:RestaurantFloorWrite,table:RestaurantFloorWrite['tables'][number]):boolean {
 return floorBoxInside(table,f.width,f.height)&&!f.tables.some(other=>other.id!==table.id&&floorBoxesOverlap(table,other));
}
export function firstTablePlacement(f:RestaurantFloorWrite,width=80,height=64):{x:number;y:number}|null {
 for(let y=20;y+height<=f.height;y+=10)for(let x=20;x+width<=f.width;x+=10)if(tablePlacementFits(f,{id:'new',x,y,width,height,rotation:0,shape:'rectangle'}))return {x,y};
 return null;
}
