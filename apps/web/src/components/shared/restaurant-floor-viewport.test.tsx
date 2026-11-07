// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import RestaurantFloorEditor from './restaurant-floor-editor'
import RestaurantFloorMap,{floorTableViewBox} from './restaurant-floor-map'
const api=vi.hoisted(()=>({floors:vi.fn(),saveFloor:vi.fn(),createFloor:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}))
vi.mock('@/lib/api/helpers/reservation-board',()=>({reservationBoardApi:api}))
const floor={id:'f',storeId:'s',name:'1階',width:500,height:300,version:7,outline:[],fixtures:[],tables:[{id:'t',x:50,y:50,width:80,height:60,rotation:0,shape:'rectangle' as const}]}
const props={accountId:'a',storeId:'s',resources:[{id:'t',label:'T1',active:true,capacity:2}],onSelect:vi.fn(),canEdit:true}
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('＋／−は表示倍率だけを変え、配置は保存しない',async()=>{
 api.floors.mockResolvedValue({data:[floor]});render(<RestaurantFloorEditor {...props}/>)
 const map=await screen.findByRole('group',{name:'1階の座席表'})
 const initial=map.getAttribute('viewBox')??''
 const [, ,initialWidth,initialHeight]=initial.split(' ').map(Number)
 expect(initialWidth).toBe(initialHeight)
 fireEvent.click(screen.getByRole('button',{name:'拡大'}))
 const [, ,zoomedWidth,zoomedHeight]=(map.getAttribute('viewBox')??'').split(' ').map(Number)
 expect(zoomedWidth).toBe(zoomedHeight)
 expect(zoomedWidth).toBeLessThan(initialWidth)
 fireEvent.click(screen.getByRole('button',{name:'縮小'}))
 expect(map.getAttribute('viewBox')).toBe(initial)
 expect(api.saveFloor).not.toHaveBeenCalled()
})
it('全体表示は拡大後の表示範囲を元に戻し、配置は保存しない',async()=>{
 api.floors.mockResolvedValue({data:[floor]});render(<RestaurantFloorEditor {...props}/>)
 const map=await screen.findByRole('group',{name:'1階の座席表'})
 const initial=map.getAttribute('viewBox')
 fireEvent.click(screen.getByRole('button',{name:'拡大'}))
 expect(map.getAttribute('viewBox')).not.toBe(initial)
 fireEvent.click(screen.getByRole('button',{name:'全体表示'}))
 expect(map.getAttribute('viewBox')).toBe(initial)
 expect(api.saveFloor).not.toHaveBeenCalled()
 for(const name of ['卓に合わせて表示','全体を表示','外形を線で描く','つまんで置く'])expect(screen.queryByRole('button',{name})).toBeNull()
})
it('拡大後のトラックパッド操作で座席図を横へ動かせる',async()=>{
 api.floors.mockResolvedValue({data:[floor]});render(<RestaurantFloorEditor {...props}/>)
 const map=await screen.findByRole('group',{name:'1階の座席表'})
 const frame=map.closest('[class*="mapFrame"]') as HTMLElement
 vi.spyOn(frame,'getBoundingClientRect').mockReturnValue({width:604,height:604,left:0,right:604,top:0,bottom:604,x:0,y:0,toJSON:()=>({})})
 fireEvent.click(screen.getByRole('button',{name:'拡大'}))
 const before=Number(map.getAttribute('viewBox')?.split(' ')[0])
 fireEvent.wheel(frame,{deltaX:50,deltaY:0})
 expect(Number(map.getAttribute('viewBox')?.split(' ')[0])).toBeGreaterThan(before)
 expect(api.saveFloor).not.toHaveBeenCalled()
})
it('回転した卓の表示範囲の計算は維持する',()=>{
 const [x,y,w,h]=floorTableViewBox({...floor,tables:[{...floor.tables[0],rotation:90}]}).split(' ').map(Number)
 expect(x).toBeLessThanOrEqual(60);expect(y).toBeLessThanOrEqual(40)
 expect(x+w).toBeGreaterThanOrEqual(120);expect(y+h).toBeGreaterThanOrEqual(120)
})
it('広いフロアの縮小表示ではマークと椅子を隠し、卓の操作名は残す',()=>{
 const wide={...floor,width:4000,height:4000,tables:[{...floor.tables[0],smokingPolicy:'non_smoking' as const,shoesAllowed:false,maxCapacity:2}]}
 const view=render(<RestaurantFloorMap floor={wide} labels={props.resources} onSelect={props.onSelect} viewport="0 0 4000 4000" penTableStyle/>)
 const table=screen.getByRole('button',{name:'T1'})
 expect(table.querySelector('.lucide-cigarette-off')).toBeNull()
 expect(table.querySelector('rect[class*="chair"]')).toBeNull()
 expect(table.querySelector('title')?.textContent).toBe('T1')
 view.rerender(<RestaurantFloorMap floor={wide} labels={props.resources} onSelect={props.onSelect} viewport="0 0 500 500" penTableStyle/>)
 expect(screen.getByRole('button',{name:'T1'}).querySelector('.lucide-cigarette-off')).toBeTruthy()
})
