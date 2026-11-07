import {expect,it} from 'vitest'
import type {RestaurantFloor} from '@line-crm/shared'
import {refreshFloorDraft} from './restaurant-floor-refresh'

const table={id:'t',x:50,y:50,width:80,height:60,rotation:0,shape:'rectangle' as const}
const base:RestaurantFloor={id:'f',storeId:'s',name:'1階',width:500,height:300,version:7,outline:[],fixtures:[],tables:[table]}
const local={...base,tables:[{...table,x:60}]}

it('未変更の席条件は最新値を使い、動かした位置だけ引き継ぐ',()=>{
 const incoming={...base,version:8,tables:[{...table,maxCapacity:4,smokingPolicy:'smoking' as const}]}
 const result=refreshFloorDraft(base,local,incoming)
 expect(result.conflict).toBe(false)
 expect(result.baseline).toBe(incoming)
 expect(result.draft).toMatchObject({version:8,tables:[{x:60,maxCapacity:4,smokingPolicy:'smoking'}]})
 expect(base.tables[0].x).toBe(50)
})
it('動かしていた卓自体が削除されたら復活させず、未保存状態も解消する',()=>{
 const incoming={...base,version:8,tables:[]}
 const result=refreshFloorDraft(base,local,incoming)
 expect(result.draft).toEqual(incoming)
 expect(result.conflict).toBe(false)
})
it.each(['overlap','outside'] as const)('新しい卓や図の縮小と配置が%sで競合したら期待版を進めない',mode=>{
 const incoming=mode==='overlap'
  ?{...base,version:8,tables:[table,{...table,id:'new',x:135}]}
  :{...base,version:8,width:135}
 const result=refreshFloorDraft(base,local,incoming)
 expect(result.conflict).toBe(true)
 expect(result.baseline).toBe(base)
 expect(result.draft.version).toBe(7)
 expect(result.draft.tables[0].x).toBe(60)
})
it('同じ卓を続けて更新しても競合の基準を失わない',()=>{
 const incoming={...base,version:8,tables:[{...table,x:80}]}
 const first=refreshFloorDraft(base,local,incoming)
 const second=refreshFloorDraft(first.baseline,first.draft,{...incoming,version:9})
 expect(second.conflict).toBe(true)
 expect(second.draft.version).toBe(7)
})
it('設備を移動していても新しい卓を追加し、設備の変更だけは残す',()=>{
 const fixture={id:'entrance',kind:'entrance' as const,x:16,y:16,width:84,height:32}
 const incoming={...base,version:8,tables:[table,{...table,id:'new',x:200}]}
 const result=refreshFloorDraft(base,{...base,fixtures:[fixture]},incoming)
 expect(result.conflict).toBe(false)
 expect(result.draft.fixtures).toEqual([fixture])
 expect(result.draft.tables).toHaveLength(2)
 expect(result.baseline.fixtures).toEqual([])
})
