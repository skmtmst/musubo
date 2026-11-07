'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowDown,ArrowUp,Cigarette,CigaretteOff,Copy,Footprints,GripVertical,Minus,Plus,Save,Scan,Trash2,X} from 'lucide-react'
import {floorBoxCorners,type RestaurantFloor,type ReservationBoardResource} from '@line-crm/shared'
import {reservationBoardApi} from '@/lib/api/helpers/reservation-board'
import {restaurantTestApi} from '@/lib/restaurant-test-api'
import {useUnsavedGuard} from '@/lib/use-unsaved-guard'
import {UnsavedLeaveDialog} from '@/lib/unsaved-leave-dialog'
import Notice from './notice'
import Button from './button'
import RestaurantFloorMap from './restaurant-floor-map'
import {SaveErrorField,SaveErrorScope,useSaveFormErrors} from './save-form-errors'
import EntitySelect from './entity-select'
import styles from './restaurant-floor-editor.module.css'

import {planFloorTables} from './restaurant-floor-placement'
type Viewport={x:number;y:number;size:number}
function DuplicateTableMark({capacity,minCapacity=1,smokingPolicy,shoesAllowed}:{capacity:number;minCapacity?:number;smokingPolicy?:string;shoesAllowed?:boolean}){
 return <div className={styles.duplicateTableMark}><span className={styles.duplicateChairLeft}/><div className={styles.duplicateTableFace}><span>{minCapacity}〜{capacity}名</span><div className={styles.duplicateMarks}><span className={smokingPolicy==='smoking'?styles.allowedMark:styles.prohibitedMark}>{smokingPolicy==='smoking'?<Cigarette size={17}/>:<CigaretteOff size={17}/>}</span><span className={shoesAllowed===false?styles.prohibitedMark:styles.allowedMark}><Footprints size={17}/></span></div></div><span className={styles.duplicateChairRight}/></div>
}
function clampViewport(view:Viewport,floor:RestaurantFloor):Viewport {
 const axis=(start:number,extent:number)=>view.size>=extent?(extent-view.size)/2:Math.max(0,Math.min(extent-view.size,start))
 return {...view,x:axis(view.x,floor.width),y:axis(view.y,floor.height)}
}
function visibleFloorViewport(base:Viewport,zoom:number,floor:RestaurantFloor):Viewport {
 const size=base.size*100/zoom
 return clampViewport({x:base.x+(base.size-size)/2,y:base.y+(base.size-size)/2,size},floor)
}
function panFloorViewport(base:Viewport,zoom:number,floor:RestaurantFloor,dx:number,dy:number):Viewport {
 const visible=visibleFloorViewport(base,zoom,floor)
 const moved=clampViewport({...visible,x:visible.x-dx,y:visible.y-dy},floor)
 return {...base,x:moved.x-(base.size-moved.size)/2,y:moved.y-(base.size-moved.size)/2}
}
/** 卓を読める大きさで見せ、離れた卓も最初の表示に含める。保存座標は変更しない。 */
export function initialFloorViewport(floor:RestaurantFloor):Viewport {
 const points=floor.tables.filter(t=>t.visibleOnMap!==false).flatMap(floorBoxCorners)
 if(!points.length)return clampViewport({x:0,y:0,size:Math.min(600,Math.max(floor.width,floor.height))},floor)
 const xs=points.map(p=>p.x),ys=points.map(p=>p.y)
 const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys)
 const spread=Math.max(right-left+100,bottom-top+100)
 const size=Math.min(Math.max(floor.width,floor.height),Math.max(480,spread))
 const cx=(left+right)/2
 const cy=(top+bottom)/2
 return clampViewport({x:cx-size/2,y:cy-size/2,size},floor)
}
export default function RestaurantFloorEditor({accountId,storeId,resources,canEdit,onSelect,onCreate,refreshKey,onCreated,selectedId,duplicateRequest,existingCodes=[]}:{accountId:string;storeId:string;resources:ReservationBoardResource[];canEdit:boolean;onSelect:(id:string)=>void;onCreate?:(floorId:string)=>void;refreshKey?:string;onCreated?:()=>Promise<void>;selectedId?:string;duplicateRequest?:number;existingCodes?:string[]}){
 const [floors,setFloors]=useState<RestaurantFloor[]>([]),[draft,setDraft]=useState<RestaurantFloor|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[refreshPending,setRefreshPending]=useState(false)
 const [zoom,setZoom]=useState(100),[viewport,setViewport]=useState<Viewport|null>(null),[modal,setModal]=useState<'add'|'duplicate'|'delete'|null>(null),[newKind,setNewKind]=useState<'floor'|'area'>('floor'),[newName,setNewName]=useState(''),[parent,setParent]=useState('')
 const [count,setCount]=useState(1),[source,setSource]=useState(''),[targetFloor,setTargetFloor]=useState('')
 const [orderOpen,setOrderOpen]=useState(false),[orderedIds,setOrderedIds]=useState<string[]>([]),[orderError,setOrderError]=useState('')
 const draggedFloor=useRef('')
 const saveErrors=useSaveFormErrors()
 const observed=useRef(''),latest=useRef(0)
 const resourceKey=JSON.stringify([refreshKey??'',resources.map(r=>r.id).sort()])
 const load=useCallback(async()=>{const ticket=++latest.current,requested=observed.current;setLoading(true);setError('');try{const result=await reservationBoardApi.floors(accountId,storeId);if(!Array.isArray(result.data))throw Error('invalid floor');if(ticket!==latest.current)return;setFloors(result.data);const floor=result.data.find(f=>f.id===draft?.id)??result.data[0]??null;setDraft(floor);setViewport(floor?initialFloorViewport(floor):null);setZoom(100);setRefreshPending(observed.current!==requested)}catch{if(ticket===latest.current)setError('座席図を読み込めませんでした。')}finally{if(ticket===latest.current)setLoading(false)}},[accountId,storeId,draft?.id])
 useEffect(()=>{observed.current=resourceKey;setFloors([]);setDraft(null);setSelected('');setZoom(100);setViewport(null);void load();return()=>{latest.current++}},[accountId,storeId]) // eslint-disable-line react-hooks/exhaustive-deps
 const dirty=!!draft&&JSON.stringify(draft)!==JSON.stringify(floors.find(f=>f.id===draft.id))
 const guard=useUnsavedGuard({dirty,busy:busy||loading})
 useEffect(()=>{if(observed.current!==resourceKey){observed.current=resourceKey;setRefreshPending(true)}},[resourceKey])
 useEffect(()=>{if(refreshPending&&!dirty&&!busy&&!loading){setRefreshPending(false);void load()}},[refreshPending,dirty,busy,loading,load])
 const save=async()=>{if(!draft||!canEdit||busy)return;setBusy(true);setError('');try{await reservationBoardApi.saveFloor(accountId,{...draft,expectedVersion:draft.version});const next={...draft,version:draft.version+1};setDraft(next);setFloors(fs=>fs.map(f=>f.id===next.id?next:f))}catch(cause){saveErrors.capture(cause);setError('保存できませんでした。版が変わった場合は、入力を控えて最新の座席図を読み込んでください。')}finally{setBusy(false)}}
 const addFloor=async()=>{if(!newName.trim()){setError('階・エリアの名前を入れてください。');return}setBusy(true);setError('');try{await reservationBoardApi.createFloor(accountId,storeId,newName.trim(),newKind,newKind==='area'?parent||null:null);setNewName('');setModal(null);await load()}catch{setError('階・エリアを追加できませんでした。名前と権限を確認してください。')}finally{setBusy(false)}}
 const moveFloor=(id:string,target:number)=>setOrderedIds(ids=>{const from=ids.indexOf(id);if(from<0||target<0||target>=ids.length||from===target)return ids;const next=[...ids];next.splice(from,1);next.splice(target,0,id);return next})
 const saveOrder=async()=>{if(busy)return;setBusy(true);setOrderError('');try{await reservationBoardApi.reorderFloors(accountId,storeId,orderedIds,floors.map(f=>f.id));setOrderOpen(false);await load()}catch{setOrderError('並び順を保存できませんでした。最新のタブを読み込んでからやり直してください。')}finally{setBusy(false)}}
 const deleteFloor=async()=>{if(!draft||busy||!canEdit)return;setBusy(true);setError('');try{await reservationBoardApi.deleteFloor(accountId,draft.id,storeId,draft.version);setModal(null);setDraft(null);setSelected('');await load()}catch{setError('階・エリアを削除できませんでした。卓や子エリアが残っていないか確認し、最新の座席図を読み込んでください。')}finally{setBusy(false)}}
 const createMany=async()=>{
  if(!draft||!canEdit||busy||!count)return
  const sourceFloor=floors.find(f=>f.tables.some(t=>t.id===source))
  const original=sourceFloor?.tables.find(t=>t.id===source)
  const destination=floors.find(f=>f.id===targetFloor)??sourceFloor??draft
  if(!original){setError('複製する卓を選び直してください。');return}
  if(destination.tables.length+count>200){setError('1つの階・エリアに置ける卓は200卓までです。');return}
  const spots=planFloorTables(destination,count,original.width,original.height)
  if(!spots){setError('この階には配置できません。作成する数を減らしてください。');return}
  setBusy(true);setError('')
  const createdIds:string[]=[]
  let created=0,failed=false
  let resultError=''
  try{
   if(spots.width!==destination.width||spots.height!==destination.height)await reservationBoardApi.saveFloor(accountId,{...destination,width:spots.width,height:spots.height,expectedVersion:destination.version})
   const used=new Set(existingCodes),usedNames=new Set(resources.map(r=>r.label))
   const sourceLabel=resources.find(r=>r.id===original.id)?.label??'卓'
   let nextNo=1
   let copyNo=1
   for(const spot of spots.tables){
    while(used.has(String(nextNo)))nextNo++
    const code=String(nextNo++)
    while(usedNames.has(`${sourceLabel}（コピー${copyNo}）`))copyNo++
    const label=`${sourceLabel}（コピー${copyNo++}）`
    used.add(code)
    usedNames.add(label)
    const result=await restaurantTestApi.createTable(accountId,{storeId,floorId:destination.id,code,label,seatType:original.seatType??'table',seatDetailType:original.seatDetailType??original.seatType??'table',minCapacity:original.minCapacity??1,maxCapacity:original.maxCapacity??2,floorX:spot.x,floorY:spot.y,shape:original.shape,width:original.width,height:original.height,rotation:original.rotation,smokingPolicy:original.smokingPolicy??'non_smoking',partition:original.partition??'open',shoesAllowed:original.shoesAllowed??true,visibleOnMap:original.visibleOnMap??true,chairArrangement:original.chairArrangement??'both',chairSide:original.chairSide??null,isActive:false}) as {data?:{id?:string}}
    if(result.data?.id)createdIds.push(result.data.id)
    created++
   }
  }catch{failed=true}
  if(failed){
   let removed=0
   for(const id of createdIds.reverse()){try{await restaurantTestApi.deleteTable(accountId,id);removed++}catch{/* the remaining count is shown below */}}
   resultError=created>removed?`${created-removed}卓が残りました。作成結果を座席図で確認してください。`:'卓を作成できませんでした。入力と配置を確認してください。'
  }else setModal(null)
  try{await onCreated?.();await load()}catch{resultError=resultError||'座席図を読み直せませんでした。再読み込みしてください。'}
  if(resultError)setError(resultError)
  setBusy(false)
 }

 const selectedTable=draft?.tables.find(t=>t.id===selected)
 const duplicateSource=floors.flatMap(f=>f.tables).find(t=>t.id===source)
 const duplicateLabel=resources.find(r=>r.id===source)?.label??'卓'
 const openModal=(name:'add'|'duplicate'|'delete')=>{setError('');setModal(name);setParent(floors.find(f=>f.kind!=='area')?.id??'');setSource(selectedTable?.id??draft?.tables[0]?.id??'');setTargetFloor(draft?.id??'');setCount(1)}
 const childAreas=draft?floors.filter(f=>f.parentFloorId===draft.id):[]
 const lastFloor=!!draft&&draft.kind!=='area'&&floors.filter(f=>f.kind!=='area').length<=1
 const deleteReason=draft?.tables.length?`${draft.tables.length}卓が残っています。卓を別の階・エリアへ移すか削除してください。`:childAreas.length?`${childAreas.length}件のエリアが残っています。先にエリアを削除してください。`:lastFloor?'最後の階は削除できません。先に別の階を追加してください。':null
 useEffect(()=>{if(selectedId)setSelected(selectedId)},[selectedId])
 useEffect(()=>{if(duplicateRequest){openModal('duplicate');if(selectedId){setSource(selectedId);const selectedFloor=floors.find(f=>f.tables.some(t=>t.id===selectedId));if(selectedFloor)setTargetFloor(selectedFloor.id)}}},[duplicateRequest]) // eslint-disable-line react-hooks/exhaustive-deps
 const baseViewport=draft?viewport??initialFloorViewport(draft):null
 const visibleViewport=draft&&baseViewport?visibleFloorViewport(baseViewport,zoom,draft):null
 const viewBox=visibleViewport?`${visibleViewport.x} ${visibleViewport.y} ${visibleViewport.size} ${visibleViewport.size}`:undefined
 const panBy=(dx:number,dy:number)=>{if(!draft)return;setViewport(current=>panFloorViewport(current??initialFloorViewport(draft),zoom,draft,dx,dy))}
 return <SaveErrorScope errors={saveErrors}><div className={styles.editor}>
  {loading?<p className={styles.note} role="status">座席図を読み込み中です。</p>:null}
  {refreshPending&&dirty?<Notice tone="warn">卓の情報が変わりました。配置の変更は残しています。<Button type="button" variant="text" size="inline" onClick={()=>guard.guarded(()=>void load())}>最新の座席図を読み込む</Button></Notice>:null}
  {error?<Notice tone="danger">{error}<Button type="button" variant="text" size="inline" onClick={()=>guard.guarded(()=>void load())}>もう一度読み込む</Button></Notice>:null}
  {draft?<><div className={styles.top}><div className={styles.tabs} role="tablist" aria-label="階・エリア">{floors.map(f=><button type="button" role="tab" aria-selected={f.id===draft.id} key={f.id} className={f.id===draft.id?styles.activeTab:''} onClick={()=>guard.guarded(()=>{setDraft(f);setViewport(initialFloorViewport(f));setSelected('');setZoom(100)})}>{f.name}</button>)}</div>{canEdit?<button type="button" className={styles.reorderButton} disabled={busy||loading||floors.length<2} onClick={()=>guard.guarded(()=>{setOrderedIds(floors.map(f=>f.id));setOrderError('');setOrderOpen(true)})}><span aria-hidden="true">⇅</span>並び替え</button>:null}</div>
   {canEdit?<div className={styles.actionLine}><div className={styles.createActions}><button type="button" className={styles.createButton} disabled={busy||loading} onClick={()=>onCreate?.(draft.id)}><Plus size={16}/>卓を作る</button><button type="button" className={styles.outlineButton} disabled={busy||loading} onClick={()=>openModal('add')}><Plus size={16}/>階・エリアを追加</button></div><button type="button" className={styles.deleteFloorButton} disabled={busy||loading} onClick={()=>guard.guarded(()=>openModal('delete'))}>この階・エリアを削除</button></div>:null}
   <div className={styles.mapFrame} onWheel={e=>{e.preventDefault();if(e.ctrlKey||e.metaKey){setZoom(z=>Math.min(250,Math.max(50,z+(e.deltaY<0?10:-10))));return}if(!visibleViewport)return;const scale=visibleViewport.size/e.currentTarget.getBoundingClientRect().width;const horizontal=e.shiftKey&&!e.deltaX;panBy(-(horizontal?e.deltaY:e.deltaX)*scale,-(horizontal?0:e.deltaY)*scale)}}>
    <SaveErrorField names={['tables']}><RestaurantFloorMap floor={draft} labels={resources} viewport={viewBox} canEdit={canEdit&&!busy&&!loading} penTableStyle selectedId={selected} onSelect={id=>{setSelected(id);if(!id.startsWith('fixture:'))onSelect(id)}} onChange={tables=>setDraft({...draft,tables})} onFloorChange={setDraft} onPan={panBy}/></SaveErrorField>
    <button type="button" className={styles.fullView} onClick={()=>{setViewport(initialFloorViewport(draft));setZoom(100)}}><Scan size={14} aria-hidden="true"/>全体表示</button>
    <div className={styles.zoom}><button type="button" aria-label="縮小" onClick={()=>setZoom(z=>Math.max(50,z-10))}><Minus size={15}/></button><span>{zoom}%</span><button type="button" aria-label="拡大" onClick={()=>setZoom(z=>Math.min(250,z+10))}><Plus size={15}/></button></div>
   </div>{canEdit?<div className={styles.saveRow}><span className={styles.saveStatus} role="status">{dirty?'未保存の変更があります':'保存済み'}</span><button type="button" className={styles.saveButton} disabled={!dirty||busy||loading} onClick={()=>void save()}><Save size={16} aria-hidden="true"/>保存</button></div>:null}
  </>:null}
  {modal?<div className={styles.backdrop} role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setModal(null)}}><div className={styles.dialog} data-floor-dialog={modal} role="dialog" aria-modal="true" aria-label={modal==='add'?'階・エリアを追加':modal==='delete'?'階・エリアを削除':`${duplicateLabel}を複製`}><header><strong>{modal==='add'?'階・エリアを追加':modal==='delete'?'階・エリアを削除':`${duplicateLabel}を複製`}</strong><button type="button" aria-label="閉じる" onClick={()=>setModal(null)}><X size={18}/></button></header><div className={styles.dialogBody}>
   {modal==='add'?<><div className={styles.group}>何を追加しますか？<div className={styles.segment}><button type="button" aria-pressed={newKind==='floor'} onClick={()=>setNewKind('floor')}>階</button><button type="button" aria-pressed={newKind==='area'} onClick={()=>setNewKind('area')}>エリア</button></div></div><p>{newKind==='floor'?'階を追加すると、座席表の上にタブとして表示されます。':'エリアは階の中に作れます。テラスなどは「階なし」も選べます。'}</p>{newKind==='area'?<div className={styles.entityField}>所属する階（任意）<EntitySelect aria-label="所属する階" size="full" value={parent} onChange={setParent} options={[{value:'',label:'階なし'},...floors.filter(f=>f.kind!=='area').map(f=>({value:f.id,label:f.name}))]}/></div>:null}<label><span className={styles.inlineLabel}>{newKind==='floor'?'階の名前':'エリア名'} <span className={styles.inlineRequired}>必須</span></span><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder={newKind==='floor'?'例：3階':'例：テラス'}/></label></>:modal==='delete'?<><p>「{draft?.name}」を座席図の一覧から削除します。操作履歴は残ります。</p>{deleteReason?<p className={styles.deleteReason} role="alert">{deleteReason}</p>:<p>この階・エリアには卓がありません。削除しても予約には影響しません。</p>}</>:<>
    <div className={styles.duplicateSource}><DuplicateTableMark capacity={duplicateSource?.maxCapacity??2} minCapacity={duplicateSource?.minCapacity??1} smokingPolicy={duplicateSource?.smokingPolicy} shoesAllowed={duplicateSource?.shoesAllowed}/><div><strong>{duplicateLabel}</strong><p>{duplicateSource?.minCapacity??1}〜{duplicateSource?.maxCapacity??2}名・{duplicateSource?.smokingPolicy==='smoking'?'喫煙':'禁煙'}・{duplicateSource?.shoesAllowed===false?'土足不可':'土足可'}</p></div><span>複製元</span></div>
    <div className={styles.duplicateControls}><div className={styles.group}>複製する数<div className={styles.stepper}><button type="button" aria-label="複製する数を減らす" onClick={()=>setCount(n=>Math.max(1,n-1))}>−</button><output>{count}</output><button type="button" aria-label="複製する数を増やす" onClick={()=>setCount(n=>Math.min(100,n+1))}>＋</button></div></div>
    <div className={styles.entityField}>配置先<EntitySelect aria-label="配置先" size="full" value={targetFloor} onChange={setTargetFloor} options={floors.map(f=>({value:f.id,label:f.kind==='area'&&f.parentFloorId?`${floors.find(p=>p.id===f.parentFloorId)?.name??''} / ${f.name}`:f.name}))}/></div></div>
    <div className={styles.duplicatePreview}><div className={styles.duplicatePreviewHead}><strong>作成後の配置</strong><span>{duplicateLabel}の席条件を引き継ぎ、椅子{(duplicateSource?.maxCapacity??2)*count}席を配置</span></div><div className={styles.duplicatePreviewGrid}>{Array.from({length:Math.min(count,3)},(_,i)=><div key={i}><DuplicateTableMark capacity={duplicateSource?.maxCapacity??2} minCapacity={duplicateSource?.minCapacity??1} smokingPolicy={duplicateSource?.smokingPolicy} shoesAllowed={duplicateSource?.shoesAllowed}/><span>{duplicateLabel}（コピー{i+1}）</span></div>)}{count>3?<span>ほか{count-3}卓</span>:null}</div></div>
   </>}
  </div><footer>{modal==='add'?<span className={styles.addHelp}>{newKind==='floor'?'卓を作る画面でこの階を選べます。':'卓を作る画面でこのエリアを選べます。'}</span>:null}<button type="button" onClick={()=>setModal(null)}>キャンセル</button><button type="button" className={modal==='delete'?styles.dangerButton:styles.primary} disabled={busy||modal==='delete'&&!!deleteReason} onClick={()=>void(modal==='add'?addFloor():modal==='delete'?deleteFloor():createMany())}>{modal==='delete'?<Trash2 size={16}/>:modal==='duplicate'?<Copy size={16}/>:<Plus size={16}/>} {modal==='add'?newKind==='floor'?'階を追加する':'エリアを追加':modal==='delete'?'削除する':`${count}卓を複製する`}</button></footer></div></div>:null}
  {orderOpen?<div className={styles.backdrop} role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setOrderOpen(false)}}><div className={styles.orderDialog} role="dialog" aria-modal="true" aria-label="タブの並び替え"><header><strong>タブの並び替え</strong><button type="button" aria-label="閉じる" disabled={busy} onClick={()=>setOrderOpen(false)}><X size={18}/></button></header><div className={styles.orderBody}><p>タブをドラッグ。矢印でも1つずつ移動できます。</p><strong>タブの順番</strong><div className={styles.orderList}>{orderedIds.map((id,index)=>{const floor=floors.find(f=>f.id===id);if(!floor)return null;return <div key={id} className={styles.orderRow} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();moveFloor(draggedFloor.current,index);draggedFloor.current=''}}><span className={styles.dragHandle} draggable onDragStart={e=>{draggedFloor.current=id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id)}} onDragEnd={()=>{draggedFloor.current=''}} aria-label={`${floor.name}をドラッグ`}><GripVertical size={18}/></span><span className={styles.orderName}><strong>{floor.name}</strong><small>{floor.kind==='area'?(floor.parentFloorId?`${floors.find(f=>f.id===floor.parentFloorId)?.name??''}のエリア`:'エリア'):'階'}</small></span><button type="button" aria-label={`${floor.name}を上へ移動`} disabled={index===0||busy} onClick={()=>moveFloor(id,index-1)}><ArrowUp size={16}/></button><button type="button" aria-label={`${floor.name}を下へ移動`} disabled={index===orderedIds.length-1||busy} onClick={()=>moveFloor(id,index+1)}><ArrowDown size={16}/></button></div>})}</div><strong>この順番で表示</strong><div className={styles.orderPreview}>{orderedIds.map(id=><span key={id}>{floors.find(f=>f.id===id)?.name}</span>)}</div>{orderError?<p role="alert" className={styles.deleteReason}>{orderError} <button type="button" onClick={()=>{setOrderOpen(false);void load()}}>最新のタブを読み込む</button></p>:null}</div><footer><button type="button" disabled={busy} onClick={()=>setOrderOpen(false)}>キャンセル</button><button type="button" className={styles.primary} disabled={busy||orderedIds.every((id,index)=>id===floors[index]?.id)} onClick={()=>void saveOrder()}>並び順を保存</button></footer></div></div>:null}
  <UnsavedLeaveDialog open={guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy} subject="座席図の変更"/>
 </div></SaveErrorScope>
}
