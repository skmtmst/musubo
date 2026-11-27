// @vitest-environment happy-dom
import {useLayoutEffect,type ComponentProps} from 'react'
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
const api=vi.hoisted(()=>({floors:vi.fn(),saveFloor:vi.fn()}))
const nav=vi.hoisted(()=>({push:vi.fn(),follow:vi.fn(),onMapMount:null as null|(()=>void)}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:nav.push})}))
vi.mock('@/lib/api/helpers/reservation-board',()=>({reservationBoardApi:api}))
vi.mock('@/lib/restaurant-test-api',()=>({restaurantTestApi:{createTable:vi.fn(),deleteTable:vi.fn()}}))
/* 座席図が初めて描かれた描画の直後、useEffect の片付けより前に操作するための差し込み口。描画そのものは本物に任せる。 */
vi.mock('./restaurant-floor-map',async importOriginal=>{
 const actual=await importOriginal<typeof import('./restaurant-floor-map')>()
 function MapWithMountProbe(props:ComponentProps<typeof actual.default>){
  useLayoutEffect(()=>{const run=nav.onMapMount;nav.onMapMount=null;run?.()},[])
  return <actual.default {...props}/>
 }
 return {...actual,default:MapWithMountProbe}
})
import RestaurantFloorEditor from './restaurant-floor-editor'

type Reply=(value:unknown)=>void
const table={id:'t',x:50,y:50,width:80,height:60,rotation:0,shape:'rectangle' as const}
const floor={id:'f',storeId:'s',name:'1階',width:500,height:300,version:7,outline:[],fixtures:[],tables:[table]}
const resource={id:'t',label:'T1',active:true,capacity:2}
const added=[resource,{...resource,id:'t2',label:'T2'}]
const props={accountId:'a',storeId:'s',resources:[resource],onSelect:vi.fn(),canEdit:true}
const LEAVE='保存していない変更があります'
const HREF='/restaurant-test/reservations'

/* 左メニューの Link と同じく、離脱の見張りが止めなかった押下だけを移動として数える。 */
function renderWithLeftMenu(){
 const page=(resources=[resource])=><><aside><a href={HREF}>予約台帳</a></aside><RestaurantFloorEditor {...props} resources={resources}/></>
 const view=render(page())
 const link=screen.getByRole('link',{name:'予約台帳'})
 link.addEventListener('click',event=>{if(event.defaultPrevented)return;event.preventDefault();nav.follow(link.getAttribute('href'))})
 return {link,showTables:(resources:typeof added)=>view.rerender(page(resources))}
}
const leaveDialog=()=>screen.queryByRole('dialog',{name:LEAVE})
const saveState=()=>screen.getByText(/^(保存済み|未保存の変更があります)$/).textContent
function pending(){let reply!:Reply;api.floors.mockImplementationOnce(()=>new Promise(resolve=>{reply=resolve}));return (value:unknown)=>act(async()=>reply(value))}

beforeEach(()=>{
 api.floors.mockReset().mockResolvedValue({data:[floor]});api.saveFloor.mockReset().mockResolvedValue({})
 nav.onMapMount=null
 window.history.replaceState(null,'','/restaurant-test/tables')
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})

describe('座席図の未保存確認と左メニューの移動',()=>{
 it('何も変えていなければ、座席図や卓の一覧の読み込みが遅れても確認を出さずに移る',async()=>{
  const firstReply=pending(),secondReply=pending()
  const {link,showTables}=renderWithLeftMenu()
  expect(screen.getByText('座席図を読み込み中です。')).toBeTruthy()
  fireEvent.click(link)
  expect(nav.follow).toHaveBeenCalledTimes(1)
  expect(leaveDialog()).toBeNull()
  // 読み込み中の再読込と戻るも、守る変更が無いので止めない。
  const reload=new Event('beforeunload',{cancelable:true})
  window.dispatchEvent(reload)
  expect(reload.defaultPrevented).toBe(false)
  const restore=vi.spyOn(window.history,'go').mockImplementation(()=>{})
  fireEvent.popState(window)
  expect(restore).not.toHaveBeenCalled()

  // 卓の一覧が後から届くと、先の応答を捨てて読み直す。その間も同じ。
  showTables(added)
  await firstReply({data:[floor]})
  await waitFor(()=>expect(api.floors).toHaveBeenCalledTimes(2))
  expect(screen.getByText('座席図を読み込み中です。')).toBeTruthy()
  fireEvent.click(link)
  expect(nav.follow).toHaveBeenCalledTimes(2)
  expect(leaveDialog()).toBeNull()

  await secondReply({data:[{...floor,version:8,tables:[table,{...table,id:'t2',x:150}]}]})
  expect(await screen.findByRole('button',{name:'T2'})).toBeTruthy()
  expect(saveState()).toBe('保存済み')
  fireEvent.click(link)
  expect(nav.follow).toHaveBeenCalledTimes(3)
  expect(leaveDialog()).toBeNull()
  expect(nav.push).not.toHaveBeenCalled()
  expect(api.saveFloor).not.toHaveBeenCalled()
 })

 it('読み込みが終わった描画の直後に押しても、保存済みなら確認を出さずに移る',async()=>{
  const reply=pending()
  const {link}=renderWithLeftMenu()
  const atClick:{state?:string|null;saveDisabled?:boolean}={}
  nav.onMapMount=()=>{
   atClick.state=saveState()
   atClick.saveDisabled=(screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled
   link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}))
  }
  await reply({data:[floor]})
  expect(atClick).toEqual({state:'保存済み',saveDisabled:true})
  expect(leaveDialog()).toBeNull()
  expect(nav.follow).toHaveBeenCalledTimes(1)
  expect(nav.push).not.toHaveBeenCalled()
 })

 it('配置を変えたときは、読み直しの間も変更を残し、左メニューで確認を出す',async()=>{
  const {link,showTables}=renderWithLeftMenu()
  const moved=await screen.findByRole('button',{name:'T1'})
  fireEvent.keyDown(moved,{key:'ArrowRight'})
  expect(saveState()).toBe('未保存の変更があります')

  const reply=pending()
  showTables(added)
  await waitFor(()=>expect(api.floors).toHaveBeenCalledTimes(2))
  fireEvent.click(link)
  expect(nav.follow).not.toHaveBeenCalled()
  await reply({data:[{...floor,version:8,tables:[table,{...table,id:'t2',x:150}]}]})
  expect(await screen.findByRole('button',{name:'T2'})).toBeTruthy()
  expect(moved.getAttribute('transform')).toContain('translate(60 50)')
  expect(saveState()).toBe('未保存の変更があります')

  fireEvent.click(link)
  const dialog=screen.getByRole('dialog',{name:LEAVE})
  expect(within(dialog).getByText('このまま移ると、座席図の変更が消えます。')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button',{name:'編集を続ける'}))
  expect(leaveDialog()).toBeNull()
  expect(moved.getAttribute('transform')).toContain('translate(60 50)')
  fireEvent.click(link)
  fireEvent.click(within(screen.getByRole('dialog',{name:LEAVE})).getByRole('button',{name:'保存せずに移る'}))
  expect(nav.push).toHaveBeenCalledExactlyOnceWith(HREF)
  expect(nav.follow).not.toHaveBeenCalled()
  expect(api.saveFloor).not.toHaveBeenCalled()
 })
})
