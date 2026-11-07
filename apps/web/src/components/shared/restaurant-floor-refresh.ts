import {floorBoxInside,floorBoxesOverlap,type RestaurantFloor} from '@line-crm/shared'

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)

/** 変更した値だけを重ね、同じ値を別の人が変更していたら競合として残す。 */
function mergeChanges<T extends object>(base:T,local:T,incoming:T,skip:readonly (keyof T)[]=[]) {
 const value={...incoming}
 let conflict=false
 for(const key of Object.keys(local) as (keyof T)[]) {
  if(skip.includes(key)||same(local[key],base[key]))continue
  if(!same(incoming[key],base[key])&&!same(incoming[key],local[key]))conflict=true
  value[key]=local[key]
 }
 return {value,conflict}
}

/** 追加・削除は最新の卓を使い、未保存の配置だけを引き継ぐ。 */
export function refreshFloorDraft(base:RestaurantFloor,local:RestaurantFloor,incoming:RestaurantFloor) {
 if(same(base,local))return {draft:incoming,baseline:incoming,conflict:false}
 const merged=mergeChanges(base,local,incoming,['version','tables'])
 const tables=incoming.tables.map(table=>{
  const before=base.tables.find(t=>t.id===table.id),edited=local.tables.find(t=>t.id===table.id)
  if(!before||!edited)return table
  const result=mergeChanges(before,edited,table)
  merged.conflict ||= result.conflict
  return result.value
 })
 // 未保存の卓に新しい卓が重なった場合も、自動で保存可能にはしない。
 merged.conflict ||= tables.some((t,i)=>tables.slice(i+1).some(other=>floorBoxesOverlap(t,other)))
 merged.conflict ||= tables.some(t=>!floorBoxInside(t,merged.value.width,merged.value.height))
 const draft={...merged.value,tables,version:merged.conflict?base.version:incoming.version}
 return {draft,baseline:merged.conflict?base:incoming,conflict:merged.conflict}
}
