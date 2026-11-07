import type {ReservationBoardPage,ReservationBoardEntry,ReservationBoardMove,RestaurantFloor,RestaurantFloorWrite} from '@line-crm/shared'
import {fetchApi} from '../../api'
const account=(path:string,id:string)=>`${path}${path.includes('?')?'&':'?'}account_id=${encodeURIComponent(id)}`
export const reservationBoardApi={
 page:(kind:'people'|'seats',accountId:string,from:string,to:string,offset=0,scopeId?:string)=>fetchApi<{success:true;data:ReservationBoardPage}>(account(`/api/${kind==='people'?'booking/admin':'restaurant-test'}/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500&offset=${offset}${kind==='seats'&&scopeId?'&storeId='+encodeURIComponent(scopeId):''}`,accountId)),
 move:(accountId:string,id:string,body:ReservationBoardMove)=>fetchApi(account(`/api/${body.kind==='people'?'booking/admin/board':'restaurant-test/reservations'}/${encodeURIComponent(id)}`,accountId),{method:'PATCH',body:JSON.stringify(body)}),
 floors:(accountId:string,storeId:string)=>fetchApi<{success:true;data:RestaurantFloor[]}>(account(`/api/restaurant-test/floors?storeId=${encodeURIComponent(storeId)}`,accountId)),
 reorderFloors:(accountId:string,storeId:string,orderedIds:string[],expectedIds:string[])=>fetchApi(account('/api/restaurant-test/floors/order',accountId),{method:'PUT',body:JSON.stringify({storeId,orderedIds,expectedIds})}),
 createFloor:(accountId:string,storeId:string,name:string,kind:'floor'|'area'='floor',parentFloorId?:string|null,afterFloorId?:string|null)=>fetchApi(account('/api/restaurant-test/floors',accountId),{method:'POST',body:JSON.stringify({storeId,name,kind,parentFloorId,afterFloorId})}),
 deleteFloor:(accountId:string,floorId:string,storeId:string,expectedVersion:number)=>fetchApi(account(`/api/restaurant-test/floors/${encodeURIComponent(floorId)}`,accountId),{method:'DELETE',body:JSON.stringify({storeId,expectedVersion})}),
 saveFloor:(accountId:string,body:RestaurantFloorWrite)=>fetchApi(account(`/api/restaurant-test/floors/${encodeURIComponent(body.id)}`,accountId),{method:'PUT',body:JSON.stringify(body)}),
}
export async function allBoardPages(kind:'people'|'seats',accountId:string,from:string,to:string,scopeId?:string):Promise<ReservationBoardEntry[]> {
 const result:ReservationBoardEntry[]=[]
 for(let offset=0;;){const page=await reservationBoardApi.page(kind,accountId,from,to,offset,scopeId);if(!page.success)throw new Error('読み込めませんでした');result.push(...page.data.entries.filter(e=>!scopeId||e.scopeId===scopeId));offset+=page.data.entries.length;if(offset>=page.data.total)break;if(!page.data.entries.length)throw new Error('予約の取得が途中で止まりました')}
 return result
}
