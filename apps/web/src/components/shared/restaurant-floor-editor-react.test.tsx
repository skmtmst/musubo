// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import type {RestaurantFloor} from '@line-crm/shared'
import RestaurantFloorEditor,{initialFloorViewport} from './restaurant-floor-editor'
const api=vi.hoisted(()=>({floors:vi.fn(),saveFloor:vi.fn(),createFloor:vi.fn(),deleteFloor:vi.fn(),reorderFloors:vi.fn()}))
const tableApi=vi.hoisted(()=>({createTable:vi.fn(),deleteTable:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}))
vi.mock('@/lib/api/helpers/reservation-board',()=>({reservationBoardApi:api}))
vi.mock('@/lib/restaurant-test-api',()=>({restaurantTestApi:tableApi}))
const floor={id:'f',storeId:'s',name:'1階',width:500,height:300,version:7,outline:[],fixtures:[],tables:[{id:'t',x:50,y:50,width:80,height:60,rotation:0,shape:'rectangle'}]}
const props={accountId:'a',storeId:'s',resources:[{id:'t',label:'T1',active:true,capacity:2}],onSelect:vi.fn()}
beforeEach(()=>{api.floors.mockResolvedValue({data:[floor]});api.saveFloor.mockRejectedValue(new Error('409'));api.createFloor.mockReset();api.deleteFloor.mockReset();api.reorderFloors.mockReset();tableApi.createTable.mockReset();tableApi.deleteTable.mockReset()})
afterEach(()=>{cleanup();vi.clearAllMocks()})
it('保存操作を座席図の下に常時表示し、変更がある時だけ押せる',async()=>{
 api.saveFloor.mockResolvedValue({})
 render(<RestaurantFloorEditor {...props} canEdit/>)
 const table=await screen.findByRole('button',{name:'T1'})
 const save=screen.getByRole('button',{name:'保存'}) as HTMLButtonElement
 const map=screen.getByRole('group',{name:'1階の座席表'})
 expect(map.compareDocumentPosition(save)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
 expect(save.disabled).toBe(true)
 fireEvent.keyDown(table,{key:'ArrowRight'})
 expect(save.disabled).toBe(false)
 fireEvent.click(save)
 await waitFor(()=>expect(save.disabled).toBe(true))
 expect(api.saveFloor).toHaveBeenCalledTimes(1)
})
it('競合の保存失敗でも配置を残し、取得した版で保存する',async()=>{
 render(<RestaurantFloorEditor {...props} canEdit/>)
 const table=await screen.findByRole('button',{name:'T1'});fireEvent.keyDown(table,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));await screen.findByText(/入力を控えて/)
 expect(api.saveFloor).toHaveBeenCalledWith('a',expect.objectContaining({expectedVersion:7,tables:[expect.objectContaining({x:60})]}))
 expect(table.getAttribute('transform')).toContain('translate(60 50)');expect(screen.getByRole('button',{name:'保存'})).toBeTruthy()
})
it('閲覧のみには配置・保存・階の追加を出さず、卓の読み取りは残す',async()=>{
 render(<RestaurantFloorEditor {...props} canEdit={false}/>);const table=await screen.findByRole('button',{name:'T1'});
 fireEvent.keyDown(table,{key:'ArrowRight'});expect(table.getAttribute('transform')).toContain('translate(50 50)')
 expect(screen.queryByRole('button',{name:'保存'})).toBeNull();expect(screen.queryByRole('button',{name:'外形を線で描く'})).toBeNull();expect(api.saveFloor).not.toHaveBeenCalled()
})
it('店を切り替えた後に古い座席図が届いても、新しい店へ上書きしない',async()=>{
 let old!:(value:unknown)=>void;api.floors.mockImplementation((_a:string,s:string)=>s==='s'?new Promise(r=>{old=r}):Promise.resolve({data:[{...floor,id:'f2',storeId:'s2',name:'別店'}]}))
 const view=render(<RestaurantFloorEditor {...props} canEdit/>);view.rerender(<RestaurantFloorEditor {...props} storeId="s2" canEdit/>);await screen.findByRole('group',{name:'別店の座席表'})
 old({data:[floor]});await waitFor(()=>expect(screen.queryByRole('group',{name:'1階の座席表'})).toBeNull());expect(screen.getByRole('group',{name:'別店の座席表'})).toBeTruthy()
})
it('階とエリアの追加方法を表示し、親の階を指定して送信する',async()=>{
 api.createFloor.mockResolvedValue({data:{id:'a2'}})
 render(<RestaurantFloorEditor {...props} canEdit/>);await screen.findByRole('button',{name:'T1'})
 fireEvent.click(screen.getByRole('button',{name:'階・エリアを追加'}))
 fireEvent.click(screen.getByRole('button',{name:'エリア'}))
 fireEvent.change(screen.getByPlaceholderText('例：テラス'),{target:{value:'テラス'}})
 fireEvent.click(screen.getByRole('button',{name:'エリアを追加'}))
 await waitFor(()=>expect(api.createFloor).toHaveBeenCalledWith('a','s','テラス','area','f'))
})
it('新しい階は並び順の指定なしで追加する',async()=>{
 api.createFloor.mockResolvedValue({data:{id:'f2'}})
 render(<RestaurantFloorEditor {...props} canEdit/>);await screen.findByRole('button',{name:'T1'})
 fireEvent.click(screen.getByRole('button',{name:'階・エリアを追加'}))
 fireEvent.change(screen.getByPlaceholderText('例：3階'),{target:{value:'2階'}})
 expect(screen.queryByText('タブの表示位置')).toBeNull()
 expect(screen.queryByText('追加後の表示')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'階を追加する'}))
 await waitFor(()=>expect(api.createFloor).toHaveBeenCalledWith('a','s','2階','floor',null))
})
it('階とエリアを矢印で並べ替えて保存する',async()=>{
 const area={...floor,id:'area',name:'テラス',kind:'area',parentFloorId:'f',tables:[]}
 api.floors.mockResolvedValue({data:[floor,area]})
 api.reorderFloors.mockResolvedValue({data:{orderedIds:['area','f']}})
 render(<RestaurantFloorEditor {...props} canEdit/>)
 await screen.findByRole('tab',{name:'テラス'})
 fireEvent.click(screen.getByRole('button',{name:'並び替え'}))
 const dialog=screen.getByRole('dialog',{name:'タブの並び替え'})
 fireEvent.click(within(dialog).getByRole('button',{name:'テラスを上へ移動'}))
 expect(within(dialog).getByText('この順番で表示').nextElementSibling?.textContent).toBe('テラス1階')
 fireEvent.click(within(dialog).getByRole('button',{name:'並び順を保存'}))
 await waitFor(()=>expect(api.reorderFloors).toHaveBeenCalledWith('a','s',['area','f'],['f','area']))
})
it('主操作の「卓を作る」から選択中の階を指定して作成画面へ進む',async()=>{
 const onCreate=vi.fn()
 render(<RestaurantFloorEditor {...props} canEdit onCreate={onCreate}/>);await screen.findByRole('button',{name:'T1'})
 fireEvent.click(screen.getByRole('button',{name:'卓を作る'}))
 expect(onCreate).toHaveBeenCalledWith('f')
})
it('選択した卓を複製してコピー名の停止中の卓を作る',async()=>{
 tableApi.createTable.mockResolvedValueOnce({data:{id:'new-2'}}).mockResolvedValueOnce({data:{id:'new-3'}})
 const view=render(<RestaurantFloorEditor {...props} canEdit existingCodes={['1']} selectedId="t" duplicateRequest={0}/>);await screen.findByRole('button',{name:'T1'})
 view.rerender(<RestaurantFloorEditor {...props} canEdit existingCodes={['1']} selectedId="t" duplicateRequest={1}/>)
 fireEvent.click(screen.getByRole('button',{name:'複製する数を増やす'}))
 fireEvent.click(screen.getByRole('button',{name:'2卓を複製する'}))
 await waitFor(()=>expect(tableApi.createTable).toHaveBeenCalledTimes(2))
 expect(tableApi.createTable).toHaveBeenNthCalledWith(1,'a',expect.objectContaining({code:'2',label:'T1（コピー1）',isActive:false}))
 expect(tableApi.createTable).toHaveBeenNthCalledWith(2,'a',expect.objectContaining({code:'3',label:'T1（コピー2）',isActive:false}))
})
it('複製の途中で失敗したら作成済みの卓を取り消す',async()=>{
 tableApi.createTable.mockResolvedValueOnce({data:{id:'new-2'}}).mockRejectedValueOnce(new Error('失敗'))
 tableApi.deleteTable.mockResolvedValue({data:{}})
 const view=render(<RestaurantFloorEditor {...props} canEdit existingCodes={['1']} selectedId="t" duplicateRequest={0}/>);await screen.findByRole('button',{name:'T1'})
 view.rerender(<RestaurantFloorEditor {...props} canEdit existingCodes={['1']} selectedId="t" duplicateRequest={1}/>)
 fireEvent.click(screen.getByRole('button',{name:'複製する数を増やす'}))
 fireEvent.click(screen.getByRole('button',{name:'2卓を複製する'}))
 await waitFor(()=>expect(tableApi.deleteTable).toHaveBeenCalledWith('a','new-2'))
 expect(await screen.findByText(/卓を作成できませんでした/)).toBeTruthy()
})
it('閲覧のみにはつまんで置く札を出さない',async()=>{
 render(<RestaurantFloorEditor {...props} canEdit={false}/>);await screen.findByRole('button',{name:'T1'})
 expect(screen.queryByRole('group',{name:'つまんで置く'})).toBeNull()
})

it('長い卓名は枠内で一行に省略し、全文を確認できる',async()=>{
 const name='窓側のとても長い名前の特別なテーブル'
 render(<RestaurantFloorEditor {...props} resources={[{...props.resources[0],label:name}]} canEdit={false}/>)
 const table=await screen.findByRole('button',{name})
 const label=within(table).getByTitle(name)
 expect(label.textContent).toBe(name)
 expect(label.closest('foreignObject')?.getAttribute('width')).toBe('80')
 expect(label.className).toContain('tableLabel')
})
it('密集した卓では隣の椅子に重なる卓名だけを省略する',async()=>{
 api.floors.mockResolvedValue({data:[{...floor,tables:[floor.tables[0],{...floor.tables[0],id:'t2',y:130}]}]})
 render(<RestaurantFloorEditor {...props} resources={[...props.resources,{id:'t2',label:'T2',active:true,capacity:2}]} canEdit={false}/>);
 const first=await screen.findByRole('button',{name:'T1'})
 const second=screen.getByRole('button',{name:'T2'})
 expect(within(first).queryByTitle('T1')).toBeNull()
 expect(within(second).getByTitle('T2')).toBeTruthy()
})
it('カウンター1名の椅子は設定した側だけに表示する',async()=>{
 api.floors.mockResolvedValue({data:[{...floor,tables:[{...floor.tables[0],seatType:'counter',maxCapacity:1,chairSide:'right'}]}]})
 render(<RestaurantFloorEditor {...props} canEdit={false}/>);
 const table=await screen.findByRole('button',{name:'T1'})
 const chairs=table.querySelectorAll('rect[class*="chair"]')
 expect(chairs).toHaveLength(1)
 expect(Number(chairs[0].getAttribute('x'))).toBeGreaterThan(floor.tables[0].width)
})

it('卓を読める正方形の範囲へ寄せ、外形の太い枠を描かない',async()=>{
 const view=initialFloorViewport(floor as RestaurantFloor)
 expect(view.size).toBe(480)
 expect(initialFloorViewport({...floor,width:1500,height:900,tables:[floor.tables[0],{...floor.tables[0],id:'far',x:1200,y:700}]} as RestaurantFloor).size).toBe(1330)
 render(<RestaurantFloorEditor {...props} canEdit={false}/>)
 const map=await screen.findByRole('group',{name:'1階の座席表'})
 const [, ,width,height]=(map.getAttribute('viewBox')??'').split(' ').map(Number)
 expect(width).toBe(height)
 expect(map.querySelector('rect[class*="outline"]')).toBeNull()
})

it('入口を矢印キーで動かすと座席図の保存内容へ含める',async()=>{
 render(<RestaurantFloorEditor {...props} canEdit/>)
 const entrance=await screen.findByRole('button',{name:'入口を移動'})
 fireEvent.keyDown(entrance,{key:'ArrowRight'})
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(api.saveFloor).toHaveBeenCalledWith('a',expect.objectContaining({fixtures:[expect.objectContaining({kind:'entrance',x:26})]})))
})

it('選択中のエリアを削除でき、卓が残る階には理由を表示する',async()=>{
 const area={...floor,id:'area',name:'テラス',kind:'area',parentFloorId:'f',tables:[]}
 api.floors.mockResolvedValue({data:[floor,area]})
 api.deleteFloor.mockResolvedValue({data:{id:'area'}})
 render(<RestaurantFloorEditor {...props} canEdit/>)
 await screen.findByRole('button',{name:'T1'})
 fireEvent.click(screen.getByRole('button',{name:'この階・エリアを削除'}))
 expect(screen.getByText(/1卓が残っています/)).toBeTruthy()
 expect((screen.getByRole('button',{name:'削除する'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'閉じる'}))
 fireEvent.click(screen.getByRole('tab',{name:'テラス'}))
 fireEvent.click(screen.getByRole('button',{name:'この階・エリアを削除'}))
 fireEvent.click(screen.getByRole('button',{name:'削除する'}))
 await waitFor(()=>expect(api.deleteFloor).toHaveBeenCalledWith('a','area','s',7))
})
