'use client'
import { DetailPreview } from '@/components/shared/detail-content'

import { tableRequirements as b244Requirements } from './requirements'

import {reservationBoardApi} from '@/lib/api/helpers/reservation-board'
import {seatBoardEntry,type RestaurantFloor} from '@line-crm/shared'
import RestaurantFloorEditor from '@/components/shared/restaurant-floor-editor'

/*
 * ★V8 座席・卓管理（板 `BERxg`・卓を止める ・卓を追加・変更 ）。
 *
 * 数4（卓数・総席数・結合可能・個室）→ 右上に「卓を作る」→
 * 左にフロアマップ（結合グループは緑の地と札・停止中は薄く）、右に卓の詳細
 * （有効／停止中の札・変更・停止／再開）→ 自動配席ルール。
 * 止めるときは、この卓に入っている先の予約を見せ、別の卓へ移すか未配席に戻してから止める。
 * データの口・送る形は今の画面（app/restaurant-test/v8/tables.tsx）と同じ。動きは BEHAVIOR.md。
 */
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import KpiCard from '@/components/shared/kpi-card'
import { useEffect,useMemo, useRef, useState } from 'react'
import { Grid2X2, Inbox, Plus } from 'lucide-react'
import { DetailColumns } from '@/components/templates/detail-columns'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { useAccount } from '@/contexts/account-context'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { restaurantTestApi, type RestaurantReservation, type RestaurantTable } from '@/lib/restaurant-test-api'
import { RestaurantShell, QuietError, StatRow, type RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { DialogField, DialogNote, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { pickMoveTarget, reservationLine } from './move'
import styles from '@/components/shared/restaurant-table-board.module.css'
import TableRowActions from './table-row-actions'
import StatusBadge from '@/components/shared/status-badge'
import TablesAssignBoard from './assign'
import { useSearchParams } from 'next/navigation'
import { Map as MapIcon } from 'lucide-react'
import TablePenEditor, {type Draft} from '@/components/shared/restaurant-table-pen-editor'
import RestaurantTableHeaderActions from '@/components/shared/restaurant-table-header-actions'
import RestaurantFloorPanel from '@/components/shared/restaurant-floor-panel'
import {planFloorTables} from '@/components/shared/restaurant-floor-placement'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { notifyToast } from '@/components/shared/toast'


/*
 * ★V8 座席・卓管理（板 `BERxg`・卓を止める ・卓を追加・変更 ）。
 *
 * 数4（卓数・総席数・結合可能・個室）→ 右上に「卓を作る」→
 * 左にフロアマップ（結合グループは緑の地と札・停止中は薄く）、右に卓の詳細
 * （有効／停止中の札・変更・停止／再開）→ 自動配席ルール。
 * 止めるときは、この卓に入っている先の予約を見せ、別の卓へ移すか未配席に戻してから止める。
 * データの口・送る形は今の画面（app/restaurant-test/v8/tables.tsx）と同じ。動きは BEHAVIOR.md。
 */

const SEAT_TYPE_LABEL: Record<string, string> = {
  table: 'テーブル',
  counter: 'カウンター',
  private_room: '個室',
  terrace: 'テラス',
  horigotatsu:'掘りごたつ',zashiki:'座敷',
}

function seatTypeLabel(value: string): string {
  return SEAT_TYPE_LABEL[value] ?? value
}

type MoveMode = 'move' | 'unassign'

function TablesBoard({ ctx }: { ctx: RestaurantV8Context }) {
  const saveErrors = useSaveFormErrors()
  const { data, store, busy, mutate, tableDefinition } = ctx
  const { selectedAccountId, accounts } = useAccount()
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const snapshotAccountCurrent = Boolean(tableDefinition && tableDefinition.accountId === selectedAccountId && tableDefinition.snapshot === data)
  const snapshotCurrentRef = useRef(snapshotAccountCurrent); snapshotCurrentRef.current = snapshotAccountCurrent
  const scope = useRef({ accountId: selectedAccountId, storeId: store?.id, generation: 0 })
  if (scope.current.accountId !== selectedAccountId || scope.current.storeId !== store?.id) scope.current = { accountId: selectedAccountId, storeId: store?.id, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const [floors,setFloors]=useState<RestaurantFloor[]>([])
  useEffect(()=>{let active=true;if(selectedAccountId&&store)void reservationBoardApi.floors(selectedAccountId,store.id).then(r=>{if(active)setFloors(r.data)}).catch(()=>{});return ()=>{active=false}},[selectedAccountId,store?.id,data.tables])
  const role = useStaffRole()
  /* 閲覧のみの人には、追加・変更・停止・再開・並べ替えを置かない（2026-10-06 オーナー）。 */
  const canEdit = canManageRole(role)
  const canEditRef = useRef(canEdit); canEditRef.current = canEdit
  const rows = useMemo(() => (store ? data.tables.filter((row) => row.store_id === store.id) : data.tables), [data.tables, store])
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [duplicateRequest,setDuplicateRequest]=useState(0)
  const [statusFilter,setStatusFilter]=useState<'all'|'active'|'suspended'>('all')
  /* 窓：'new' は追加、卓の id は変更。 */
  const [editor, setEditor] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [createCount,setCreateCount]=useState(1)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const [editorError, setEditorError] = useState('')
  const editorRef = useRef<HTMLFormElement>(null)
  const [deleteId, setDeleteId] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [stopId, setStopId] = useState('')
  const [deleteScope, setDeleteScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const [stopScope, setStopScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const stopTicket = useRef<object | null>(null)
  const [stopError, setStopError] = useState('')
  const [stopProgress, setStopProgress] = useState('')
  const stopProgressRef = useRef(false)
  const [moveMode, setMoveMode] = useState<MoveMode>('move')
  const editing = editor && editor !== 'new' ? rows.find((row) => row.id === editor) ?? null : null
  const deleting = deleteScope?.scope === scope.current && deleteScope.ticket === deleteTicket.current ? rows.find((row) => row.id === deleteId) : undefined
  const stopping = stopScope?.scope === scope.current && stopScope.ticket === stopTicket.current ? rows.find((row) => row.id === stopId) : undefined
  const now = Date.now()
  /* この卓に入っている、これから先の予約（取消・無断キャンセル・来店済みは除く）。 */
  const upcoming = useMemo(() => (stopping
    ? data.reservations
      .filter((item) => seatBoardEntry(item as unknown as Record<string,unknown>).resourceIds.includes(stopping.id) && !['cancelled', 'no_show', 'completed', 'visited', 'seated'].includes(item.status) && !item.departed_at)
      .filter((item) => new Date(item.ends_at).getTime() > now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    : []), [data.reservations, stopping, now])

  const openNew = (floorId?:string) => {
    setEditorError('')
    setDraft({ code: '', label: '', seatType: 'table', seatDetailType:'table', minCapacity: '1', maxCapacity: '2', floorX: '', floorY: '', joinGroup: '',floorId:floorId??floors[0]?.id??'floor-'+store?.id,shape:'rectangle',orientation:'horizontal',smokingPolicy:'non_smoking',partition:'open',shoesAllowed:true,isActive:true,visibleOnMap:true,chairArrangement:'both',chairSide:'left' })
    setCreateCount(1)
    setFieldErrors({})
    setEditor('new')
  }
  const openEdit = (table: RestaurantTable) => {
    setEditorError('')
    setDraft({
      code: table.code, label: table.label, seatType: table.seat_type,
      minCapacity: String(table.min_capacity), maxCapacity: String(table.max_capacity),
      floorX: String(table.floor_x), floorY: String(table.floor_y), joinGroup: table.join_group || '',floorId:table.floor_id??'floor-'+table.store_id,
      shape:table.shape==='circle'?'circle':table.shape==='long'?'long':'rectangle',orientation:(table.height??64)>(table.width??80)?'vertical':'horizontal',smokingPolicy:table.smoking_policy??'non_smoking',partition:table.partition_type??'open',shoesAllowed:table.shoes_allowed!==0,isActive:!!table.is_active,visibleOnMap:table.visible_on_map!==0,chairArrangement:table.chair_arrangement??'both',chairSide:table.chair_side??'left',
      seatDetailType:(table.seat_detail_type??table.seat_type) as Draft['seatDetailType'],
    })
    setFieldErrors({})
    setEditor(table.id)
  }

  const changeCapacity = (field: 'minCapacity' | 'maxCapacity', value: string) => {
    if (!draft) return
    const next = { ...draft, [field]: value }
    setDraft(next)
    setFieldErrors((current) => {
      const errors = { ...current }
      const min = Number(next.minCapacity), max = Number(next.maxCapacity)
      // 保存時に表示済みの人数の理由だけを現在値で見直す。
      if (current.minCapacity && Number.isInteger(min) && min >= 1) delete errors.minCapacity
      if (current.maxCapacity && Number.isInteger(max) && max >= min && max >= 1) delete errors.maxCapacity
      return errors
    })
  }

  const save = async () => {
    if (!draft) return
    setEditorError('')
    if (!selectedAccountId) { setEditorError('LINEアカウントを選んでから、もう一度お試しください。'); return }
    if (!editing && !store) { setEditorError('店舗を選んでから、もう一度お試しください。'); return }
    const errors: Partial<Record<keyof Draft, string>> = {}
    if ((b244Requirements.draft_code.check(draft.code) !== null)) errors.code = '卓番を入れてください。'
    if ((b244Requirements.draft_label.check(draft.label) !== null)) errors.label = '表示名を入れてください。'
    if(!draft.floorId||(floors.length>0&&!floors.some(f=>f.id===draft.floorId))) errors.floorId='階・エリアを選んでください。'
    const min = Number(draft.minCapacity), max = Number(draft.maxCapacity)
    if (!Number.isInteger(min) || min < 1) errors.minCapacity = '最小人数は1以上の整数にしてください。'
    if (!Number.isInteger(max) || max < min || max < 1) errors.maxCapacity = '最大人数は最小人数以上の整数にしてください。'
    if(!editing&&(!Number.isInteger(createCount)||createCount<1||createCount>100)){setEditorError('作成する数は1〜100卓にしてください。');return}
    for (const key of ['floorX', 'floorY'] as const) {
      if (!draft[key].trim()) { if (editing) errors[key] = '位置を入れてください。'; continue }
      if (!Number.isInteger(Number(draft[key])) || Number(draft[key]) < 0 || Number(draft[key]) > 10000) errors[key] = '配置は0〜10000の整数にしてください。'
    }
    if (!editing && Boolean(draft.floorX.trim()) !== Boolean(draft.floorY.trim())) errors[draft.floorX.trim() ? 'floorY' : 'floorX'] = '横と縦の位置を一緒に指定してください。'
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => { const field = editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    const selectedFloor=floors.find(f=>f.id===draft.floorId)
    if(!editing&&selectedFloor&&selectedFloor.tables.length+createCount>200){setEditorError('1つの階・エリアに置ける卓は200卓までです。');return}
    const body = {
      floorId:draft.floorId,expectedTargetVersion:floors.find(f=>f.id===draft.floorId)?.version,
      expectedVersion:editing?.floor_version??1,
      code: draft.code,
      label: draft.label,
      seatType: draft.seatType,
      minCapacity: Number(draft.minCapacity),
      maxCapacity: Number(draft.maxCapacity),
      floorX: draft.floorX.trim()?Number(draft.floorX):undefined,
      floorY: draft.floorY.trim()?Number(draft.floorY):undefined,
      joinGroup: draft.joinGroup.trim() || null,
      shape:draft.seatType==='counter'?'counter':draft.shape,
      seatDetailType:draft.seatDetailType,
      width:draft.shape==='long'?(draft.orientation==='vertical'?64:120):draft.seatType==='counter'?(draft.orientation==='vertical'?64:80):80,
      height:draft.shape==='long'?(draft.orientation==='vertical'?120:64):draft.seatType==='counter'?(draft.orientation==='vertical'?80:64):80,
      rotation:0,smokingPolicy:draft.smokingPolicy,partition:draft.partition,shoesAllowed:draft.shoesAllowed,visibleOnMap:draft.visibleOnMap,chairArrangement:draft.chairArrangement,chairSide:draft.seatType==='counter'||draft.chairArrangement==='one'?draft.chairSide:null,
      ...(!editing?{isActive:draft.isActive}:{}),
      ...(editing&&draft.isActive&&!editing.is_active?{isActive:true}:{}),
    }
    let ok = false
    try {
      const options = { rethrow: () => true }
      ok = editing
        ? await mutate(() => restaurantTestApi.updateTable(selectedAccountId, editing.id, body), '卓を更新しました。', options)
        : store
          ? await mutate(async()=>{
              const floor=selectedFloor
              const width=Number(body.width),height=Number(body.height)
              const plan=floor?planFloorTables(floor,createCount,width,height):null
              if(floor&&!plan)throw new Error('この階には卓を配置できません。作成する数を減らしてください。')
              if(floor&&plan&&(plan.width!==floor.width||plan.height!==floor.height))await reservationBoardApi.saveFloor(selectedAccountId,{...floor,width:plan.width,height:plan.height,expectedVersion:floor.version})
              const created:string[]=[]
              const usedCodes=new Set(rows.map(row=>row.code))
              const nameParts=draft.label.match(/^(.*?)(\d+)$/)
              try{
                for(let index=0;index<createCount;index++){
                  let candidate=index===0?draft.code:/^\d+$/.test(draft.code)?String(Number(draft.code)+index):`${draft.code}-${index+1}`
                  let suffix=index+1
                  while(usedCodes.has(candidate)){suffix++;candidate=/^\d+$/.test(draft.code)?String(Number(draft.code)+suffix):`${draft.code}-${suffix}`}
                  usedCodes.add(candidate)
                  const label=index===0?draft.label:nameParts?`${nameParts[1]}${Number(nameParts[2])+index}`:`${draft.label} ${index+1}`
                  const position=plan?.tables[index]
                  const response=await restaurantTestApi.createTable(selectedAccountId,{storeId:store.id,...body,code:candidate,label,...(position?{floorX:position.x,floorY:position.y}:{})}) as {data?:{id?:string}}
                  if(response.data?.id)created.push(response.data.id)
                }
              }catch(cause){
                saveErrors.capture(cause)
                let rollbackFailed=false
                for(const id of created.reverse())try{await restaurantTestApi.deleteTable(selectedAccountId,id)}catch{rollbackFailed=true}
                if(rollbackFailed)throw new Error('一部の卓が残りました。卓一覧と座席図を確認してください。')
                throw cause
              }
            }, createCount===1?'卓を作りました。':`${createCount}卓を作りました。`, options)
          : false
    } catch (cause) {
      if (!saveErrors.capture(cause)) setEditorError(japaneseDetailOf(cause) || '卓を保存できませんでした。')
      return
    }
    if (ok) {
      setEditor(null)
      if(editing&&editing.is_active&&!draft.isActive){
        const ticket={};stopTicket.current=ticket;setStopScope({scope:renderedScope,ticket});setStopError('');stopProgressRef.current=false;setStopProgress('');setMoveMode('move');setStopId(editing.id)
      }
    }
  }

  /* 先の予約を移して（または未配席に戻して）から卓を止める。1件ずつ送り、失敗したらそこで止める。 */
  const stop = (table: RestaurantTable, reservations: RestaurantReservation[]) => {
    if (!alive.current || stopProgressRef.current || !selectedAccountId || !snapshotCurrentRef.current || !canEditRef.current || !stopScope || stopScope.scope !== scope.current || stopScope.ticket !== stopTicket.current) return
    const belongs = () => alive.current && canEditRef.current && stopScope.scope === scope.current && stopScope.ticket === stopTicket.current
    const current = () => snapshotCurrentRef.current && belongs()
    setStopError(''); setStopProgress('')
    let moved = 0
    let unassigned = 0
    let inFlight = false
    void mutate(async () => {
      try {
        const taken: RestaurantReservation[] = data.reservations.filter((item) => item.table_id !== table.id)
        for (const item of reservations) {
          if (!current()) throw new QuietError()
          const target = moveMode === 'move' ? pickMoveTarget(item, rows.filter((row) => row.id !== table.id), taken) : null
          inFlight = true
          await restaurantTestApi.updateReservation(selectedAccountId, item.id, { tableId: target?.id ?? null, expectedVersion: item.customer_version ?? 1 })
          inFlight = false
          if (target) { moved += 1; taken.push({ ...item, table_id: target.id }) } else { unassigned += 1 }
        }
        if (!current()) throw new QuietError()
        inFlight = true
        await restaurantTestApi.updateTable(selectedAccountId, table.id, { isActive: false })
        inFlight = false
        return { moved, unassigned }
      } catch (error) {
        const target = accounts.find(account => account.id === selectedAccountId)?.name || '名前を確認できないLINEアカウント'
        const progress = `${target}・${store?.name || '名前を確認できない店舗'}の卓「${table.code}」：予約${moved + unassigned}件の変更を確認しました（別の卓へ${moved}件、未配席${unassigned}件）。${inFlight ? '通信中の変更は結果を確認できません。' : ''}予約台帳と卓の状態を確認してください。`
        if (!current()) { notifyToast(progress, { tone: 'info', duration: 0 }); throw new QuietError() }
        stopProgressRef.current = true; setStopProgress(progress)
        const fieldFailure = saveErrors.capture(error)

        { if (!fieldFailure && current())
        setStopError(japaneseDetailOf(error) || '予約の移動・卓の停止を完了できませんでした。予約台帳と卓の状態を確認してください。') }
        throw new QuietError()
      }
    }, reservations.length === 0
      ? '卓を停止しました。予約履歴と卓の情報は残ります。'
      : moveMode === 'move'
        ? '先の予約を別の卓へ移して、卓を停止しました。入る卓が無かった予約は未配席にしました。'
        : '先の予約を未配席に戻して、卓を停止しました。予約台帳で卓を割り当ててください。').then((ok) => { if (ok && belongs()) { stopTicket.current = null; setStopId('') } })
  }

  const resume = (table: RestaurantTable) => {
    if (!selectedAccountId) return
    void mutate(
      () => restaurantTestApi.updateTable(selectedAccountId, table.id, { isActive: true }),
      '卓を再開しました。',
    )
  }

  const closeStop = () => {
    if (stopScope?.ticket !== stopTicket.current) return
    stopTicket.current = null; setStopId('')
    if (stopProgressRef.current) void ctx.reload()
  }

  const activeRows = rows.filter((item) => item.is_active)
  const visibleRows=rows.filter(item=>statusFilter==='all'||(statusFilter==='active'?!!item.is_active:!item.is_active))
  useEffect(()=>{if(rows.length&&!selectedId)setSelectedId(rows[0].id)},[rows,selectedId])

  return (
    <SaveErrorScope errors={saveErrors}><>
      <StatRow fusion>
        <KpiCard title="卓数" value={rows.length} unit="卓" detail="停止中の卓を含む" icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="受付中の卓" value={activeRows.length} unit="卓" detail="新規予約を受ける卓" icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="受付中の定員" value={activeRows.reduce((sum, item) => sum + item.max_capacity, 0)} unit="名" detail="最大人数の合計" icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="個室" value={rows.filter((item) => item.partition_type === 'private').length} unit="卓" detail="個室の卓数" icon={<Inbox size={16} aria-hidden />} presentation="band" />
      </StatRow>
      <DetailColumns variant="restaurant-tables" asideLabel="卓一覧を見る" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<DetailPreview title="卓一覧" headerActions={<RestaurantTableHeaderActions statusFilter={statusFilter} onStatusFilter={setStatusFilter}/>}>
          <ul className={styles.detailList}>
            {visibleRows.map((item) => (
              <li key={item.id} className={`${styles.detailRow} ${item.id === selectedId ? styles.detailRowSelected : ''}`}>
                <div className={styles.detailMain}>
                  <p className={styles.detailName} title={`${item.code} · ${item.label}`}>{`${item.code} · ${item.label}`}</p>
                  <p className={styles.detailSub}>{`${seatTypeLabel(item.seat_detail_type??item.seat_type)} / ${item.min_capacity}〜${item.max_capacity}名 / ${item.smoking_policy==='smoking'?'喫煙':item.smoking_policy==='heated_tobacco'?'加熱式のみ':'禁煙'} / ${item.shoes_allowed===0?'土足不可':'土足可'}`}</p>
                </div>
                <span className={styles.detailStatus}><StatusBadge tone={item.is_active ? 'success' : 'neutral'} dot={false}>{item.is_active ? '受付中' : '停止中'}</StatusBadge></span>
                <TableRowActions table={item} canEdit={canEdit} busy={busy} pendingAccount={!snapshotAccountCurrent} onEdit={openEdit} onDuplicate={table=>{setSelectedId(table.id);setDuplicateRequest(n=>n+1)}} onResume={resume}
                  onDelete={(table) => { if (!selectedAccountId || !store || !snapshotAccountCurrent || !canEditRef.current || renderedScope !== scope.current) return; const ticket = {}; deleteTicket.current = ticket; setDeleteScope({ scope: renderedScope, ticket }); setDeleteError(''); setDeleteId(table.id) }}
                  onStop={(table) => { if (!selectedAccountId || !store || !snapshotAccountCurrent || !canEditRef.current || renderedScope !== scope.current) return; const ticket = {}; stopTicket.current = ticket; setStopScope({ scope: renderedScope, ticket }); setStopError(''); stopProgressRef.current = false; setStopProgress(''); setMoveMode('move'); setStopId(table.id) }} />
              </li>
            ))}
          </ul>
        </DetailPreview>} asideLayout="detail">
        <RestaurantFloorPanel>
          {store&&selectedAccountId?<RestaurantFloorEditor accountId={selectedAccountId} storeId={store.id} refreshKey={JSON.stringify(rows.map(t=>[t.id,t.floor_id,t.floor_version,t.label,t.min_capacity,t.max_capacity,t.shape,t.width,t.height,t.smoking_policy,t.shoes_allowed,t.visible_on_map,t.chair_arrangement,t.chair_side,t.is_active]))} resources={rows.map(t=>({id:t.id,label:t.label,capacity:t.max_capacity,active:!!t.is_active}))} existingCodes={rows.map(t=>t.code)} canEdit={canEdit} onSelect={setSelectedId} onCreate={openNew} selectedId={selectedId} duplicateRequest={duplicateRequest} onCreated={async()=>{await ctx.reload()}}/>:null}
        </RestaurantFloorPanel>
      </DetailColumns>
      <RsDialog open={Boolean(deleting)} title="この卓を削除しますか？" width={480} top={300} busy={busy}
        onCancel={() => { if (deleteScope?.ticket === deleteTicket.current) { deleteTicket.current = null; setDeleteId('') } }} actions={<>
          <Button disabled={busy} onClick={() => { if (deleteScope?.ticket === deleteTicket.current) { deleteTicket.current = null; setDeleteId('') } }}>キャンセル</Button>
          <Button variant="danger" disabled={busy} onClick={() => {
            if (!alive.current || !selectedAccountId || !deleting || !snapshotCurrentRef.current || !canEditRef.current || !deleteScope || deleteScope.scope !== scope.current || deleteScope.ticket !== deleteTicket.current) return
            const belongs = () => alive.current && canEditRef.current && deleteScope.scope === scope.current && deleteScope.ticket === deleteTicket.current
            const current = () => snapshotCurrentRef.current && belongs()
            setDeleteError('')
            void mutate(async () => {
              try { await restaurantTestApi.deleteTable(selectedAccountId, deleting.id) }
              catch (error) { if (current()) setDeleteError(japaneseDetailOf(error) || '削除できませんでした。'); throw new QuietError() }
            }, '卓を削除しました。').then((ok) => { if (ok && belongs()) { deleteTicket.current = null; setDeleteId('') } })
          }}>削除する</Button>
        </>}>
        {deleteScope?.scope.accountId && store && <OperationTargetSummary accounts={[{ id: deleteScope.scope.accountId, name: accounts.find(account => account.id === deleteScope.scope.accountId)?.name }]} store={{ id: store.id, name: store.name }} />}
        <p>{deleting?.code}・{deleting?.label}</p>
        <DialogNote>予約や設定で使われていない卓だけ削除できます。元に戻せません。</DialogNote>
        {deleteError ? <Notice tone="danger">{deleteError}</Notice> : null}
      </RsDialog>
      <RsDialog
        open={editor !== null && draft !== null}
        title={editing ? '卓を変更する' : '卓を作る'}
        actionsPlacement="footer"
        width={824}
        exactWidth
        minHeight={650}
        top={265}
        headerHeight={62}
        busy={busy}
        designNode="ljShF"
        titleIcon={<Grid2X2 size={17} aria-hidden="true"/>}
        titleRow="mark"
        plainTitle
        onCancel={() => setEditor(null)}
        actions={<><Button presentation="restaurant" type="button" onClick={() => setEditor(null)} disabled={busy}>キャンセル</Button><Button presentation="restaurant" type="submit" form="rs-table-editor" variant="primary" disabled={busy}><Plus size={16} aria-hidden="true" />{editing ? '変更を保存' : createCount===1?'卓を作る':`${createCount}卓を作る`}</Button></>}
      >
        {draft && selectedAccountId && store ? <form id="rs-table-editor" ref={editorRef} className={styles.editorFields} noValidate onSubmit={(event) => { event.preventDefault(); void save() }}>
          {editorError ? <Notice tone="danger" role="alert">{editorError}</Notice> : null}
          <TablePenEditor draft={draft} onChange={setDraft} floors={floors} errors={fieldErrors} onCapacity={changeCapacity} count={createCount} onCount={setCreateCount} canBatch={!editing}/>
        </form> : null}
      </RsDialog>
      <RsDialog
        open={Boolean(stopping)}
        actionsPlacement="footer"
        title={stopping ? `卓「${stopping.code}・${stopping.label}」を止めますか？` : ''}
        width={560}
        top={260}
        busy={busy}
        designNode="eY9F3"
        onCancel={closeStop}
        actions={(
          <>
            <Button presentation="restaurant" onClick={closeStop} disabled={busy}>キャンセル</Button>
            <Button presentation="restaurant" variant="danger" disabled={busy} lockedReason={stopProgress ? '予約台帳と卓の状態を確認してから、操作をやり直してください。' : undefined} onClick={() => { if (stopping) stop(stopping, upcoming) }}>
              {upcoming.length === 0 ? '止める' : moveMode === 'move' ? '予約を移して止める' : '未配席に戻して止める'}
            </Button>
          </>
        )}
      >
        {stopScope?.scope.accountId && store && <OperationTargetSummary accounts={[{ id: stopScope.scope.accountId, name: accounts.find(account => account.id === stopScope.scope.accountId)?.name }]} store={{ id: store.id, name: store.name }} />}
        {stopError ? <Notice tone="danger" role="alert" message={stopError} /> : null}
        {stopProgress ? <Notice tone="info">{stopProgress}</Notice> : null}
        {upcoming.length === 0 ? (
          <>
            <p className={styles.stopLead}>この卓には、これから先の予約はありません。</p>
            <DialogNote>予約履歴と卓の情報は残ります。停止中の卓は自動配席の候補から外れ、後で再開できます。</DialogNote>
          </>
        ) : (
          <>
            <p className={styles.stopLead}>{`この卓には、これから先の予約が ${upcoming.length} 件あります。`}</p>
            <ul className={styles.stopList}>
              {upcoming.map((item) => <li key={item.id}>{reservationLine(item, store?.timezone)}</li>)}
            </ul>
            <DialogField label="この予約をどうしますか" kind="select">
              <SaveErrorField names={["moveMode","move_mode"]}><Select
                aria-label="この予約をどうしますか"
                size="full"
                value={moveMode}
                onChange={(value) => setMoveMode(value === 'unassign' ? 'unassign' : 'move')}
                options={[
                  { value: 'move', label: '同じ人数が入る別の卓へ自動で移す' },
                  { value: 'unassign', label: '未配席に戻す（予約台帳で割り当てる）' },
                ]}
              /></SaveErrorField>
            </DialogField>
            <p className={styles.stopNotice}>お客さまへの LINE のお知らせは、この画面からは送りません。</p>
          </>
        )}
      </RsDialog>
    </></SaveErrorScope>
  )
}

export default function TablesPage() {
  const canEdit=canManageRole(useStaffRole())
  /* ?view=assign：卓の割り当て方（jmVYJ・）。座席表へは［座席表を直す］で戻る。 */
  const assignView=useSearchParams().get('view')==='assign'
  if(assignView) return (
    <RestaurantShell templateHeading boundary={false} boardId="jmVYJ" title="座席・卓管理" description={ctx=>ctx?.store?.name??''} headAfter={(_ctx,picker)=><>{picker}<Button presentation="restaurant" href="/restaurant-test/tables"><MapIcon size={16} aria-hidden="true"/>座席表を直す</Button></>} renderPage={(ctx, heading, notice) => <TablesAssignBoard ctx={ctx} canEdit={canEdit} heading={heading} notice={notice} />} />
  )
  return (
    <RestaurantShell templateHeading boundary={false} boardId="BERxg" title="座席・卓管理" description={ctx=>ctx?.store?.name??''} headAfter={(_ctx,picker)=><>{picker}</>}>
      {(ctx) => <TablesBoard ctx={ctx} />}
    </RestaurantShell>
  )
}
