'use client'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { RestaurantChannelCloseTask, RestaurantClosure, RestaurantOpeningDay } from '@line-crm/shared'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import HelpTip from '@/components/shared/help-tip'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import TextLink from '@/components/shared/text-link'
import { notifyToast } from '@/components/shared/toast'
import { ApiError, describeSaveFailure } from '@/lib/api'
import { restaurantGoogleApi, type GoogleSpecialDay } from '@/lib/restaurant-google-api'
import { restaurantTestApi, type RestaurantReservation } from '@/lib/restaurant-test-api'
import type { RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { RowMore } from '@/v8/restaurant/booking-kit/public/parts/index'
import ClosureDialog, { type ClosureDialogTarget, type ClosureSaved } from './closure-dialog'
import {
  KIND_LABEL, addDays, covers, dayShort, dayTitle, kindTone, monthTitle, monthWeeks, overlapping, rangeTitle, regularHolidays,
  scopeText, shiftMonth, statusLine, tablesText, tasksFor, timeText, upcoming,
} from './format'
import styles from './closures.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

/*
 * ★V8 予約枠・在庫 ›「休業日・貸切」タブ（提案 E-10 。採用 2026-10-07）。
 *
 * 上：他の予約サイトの枠を閉じる知らせ（休業・貸切の分）→ 左：月のカレンダー（臨時休業・貸切・定休）
 * ｜右：これからの休業・貸切（「…」から変える・消す）と Google の営業時間。
 * 足す・変える窓（）は closure-dialog.tsx。動きは BEHAVIOR.md。
 */

type MediaLink = { code: string; name: string; loginUrl: string | null; closeOnBooking: boolean }

const WEEK = ['日', '月', '火', '水', '木', '金', '土']
const UPCOMING_LIMIT = 6

/** Google の特別営業時間に、その記録の日が全部「休み」で入っているか。 */
function inGoogle(closure: RestaurantClosure, special: GoogleSpecialDay[]): boolean {
  let day = closure.startDate
  for (let i = 0; i < 366 && day <= closure.endDate; i += 1) {
    const hit = special.find((s) => s.date === day)
    if (!hit || (closure.allDay && !hit.closed)) return false
    day = addDays(day, 1)
  }
  return true
}

function deleteMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'version_conflict') return 'ほかの人が先に変えました。読み直したので、もう一度確かめてください。'
  if (error instanceof ApiError && error.status === 403) return permissionDeniedMessage('store')
  return withPermissionFailure(error, describeSaveFailure(error), 'store')
}

export default function ClosuresBoard({ ctx, accountId, today, canWrite, canGoogle, dialog, onDialog }: {
  ctx: RestaurantV8Context
  accountId: string
  /** 店舗のタイムゾーンでの今日。 */
  today: string
  /** 足す・変える・消す・［閉じた］（owner・admin・staff）。 */
  canWrite: boolean
  /** Google の営業時間の案を作る（owner・admin）。 */
  canGoogle: boolean
  dialog: ClosureDialogTarget | null
  onDialog: (target: ClosureDialogTarget | null) => void
}) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const store = ctx.store
  const storeId = ctx.selectedStoreId
  const scopeKey = JSON.stringify([accountId, storeId])
  const scope = useRef({ key: scopeKey, generation: 1 })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 }
  const currentGeneration = scope.current.generation
  const [loadedGeneration, setLoadedGeneration] = useState(0)
  const removeGeneration = useRef(0)
  const timezone = store?.timezone || 'Asia/Tokyo'
  const tables = useMemo(() => ctx.data.tables.filter((t) => t.store_id === storeId), [ctx.data.tables, storeId])
  const [month, setMonth] = useState(today.slice(0, 7))
  const [closures, setClosures] = useState<RestaurantClosure[] | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [hours, setHours] = useState<RestaurantOpeningDay[] | null>(null)
  const [tasksError,setTasksError]=useState(false)
  const [mediaError,setMediaError]=useState(false)
  const [mediaRetry,setMediaRetry]=useState(0)
  const [tasks, setTasks] = useState<RestaurantChannelCloseTask[]>([])
  const [media, setMedia] = useState<MediaLink[]>([])
  const [reservations, setReservations] = useState<RestaurantReservation[] | null>(null)
  const [special, setSpecial] = useState<GoogleSpecialDay[] | null | 'none'>(null)
  const [madeGoogle, setMadeGoogle] = useState<string[]>([])
  const [removing, setRemoving] = useState<RestaurantClosure | null>(null)
  const [busy, setBusy] = useState('')
  const [removeError, setRemoveError] = useState('')
  useEffect(() => { setRemoving(null); setRemoveError(''); setBusy('') }, [currentGeneration])
  /* 記録ごとの重なる予約の数と連絡済みの数（contact-status。閲覧のみも読める）。 */
  const [contacts, setContacts] = useState<Record<string, { reservations: number; contacted: number }>>({})

  /* 予約の件数を数える範囲：見ている月と、今日から3か月先まで。 */
  const range = useMemo(() => {
    const monthStart = `${month}-01`
    const monthEnd = shiftMonth(month, 1) + '-01'
    const from = monthStart < today ? monthStart : today
    const until = addDays(today, 92)
    return { from, to: monthEnd > until ? monthEnd : until }
  }, [month, today])

  const loadClosures = useCallback(async () => {
    if (!accountId || !storeId) return
    const generation = scope.current.generation
    try {
      const res = await restaurantTestApi.closures(accountId, storeId)
      if (scope.current.generation !== generation) return
      setClosures(Array.isArray(res.data) ? res.data : [])
      setLoadedGeneration(generation)
      setLoadError(null)
    } catch (caught) {
      if (scope.current.generation !== generation) return
      setLoadedGeneration(0)
      setLoadError(caught)
    }
  }, [accountId, storeId])

  const loadTasks = useCallback(async () => {
    if (!accountId || !storeId) return
    await restaurantTestApi.channelCloseTasks(accountId, storeId).then((res) => {if(!Array.isArray(res.data))throw new Error('invalid_tasks');setTasks(res.data);setTasksError(false)}).catch(() => setTasksError(true))
  }, [accountId, storeId])

  useEffect(() => { void loadClosures(); void loadTasks() }, [loadClosures, loadTasks])

  useEffect(() => {
    if (!accountId || !storeId) return
    let current = true
    void restaurantTestApi.openingHours(accountId, storeId).then((res) => { if (current) setHours(res.data.hours ?? []) }).catch(() => { if (current) setHours(null) })
    void restaurantTestApi.mediaLinks(accountId, storeId)
      .then((res) => { if (current) {setMediaError(false);setMedia(res.data.map((m) => ({ code: m.code, name: m.name, loginUrl: m.loginUrl, closeOnBooking: Boolean(m.closeOnBooking) })));} })
      .catch(() => { if (current) setMediaError(true) })
    void restaurantGoogleApi.profile(accountId)
      .then((res) => { if (current) setSpecial(res.profile.specialHours ?? []) })
      .catch(() => { if (current) setSpecial('none') })
    return () => { current = false }
  }, [accountId, storeId, mediaRetry])

  useEffect(() => {
    if (!accountId) return
    let current = true
    const from = new Date(`${range.from}T00:00:00`).toISOString()
    const to = new Date(`${range.to}T00:00:00`).toISOString()
    void restaurantTestApi.snapshot(accountId, { from, to, limit: 500, offset: 0 })
      .then((res) => { if (current) setReservations(res.data.reservations.filter((r) => r.store_id === storeId)) })
      .catch(() => { if (current) setReservations(null) })
    return () => { current = false }
  }, [accountId, storeId, range])

  const holidays = useMemo(() => regularHolidays(hours), [hours])
  const list = useMemo(() => upcoming(closures ?? [], today), [closures, today])

  /* 右の列に出す記録だけ、連絡の状況を読む（読めない記録は予約の数だけ出す）。 */
  const shownKey = list.slice(0, UPCOMING_LIMIT).map((c) => `${c.id}:${c.version}`).join(',')
  useEffect(() => {
    if (!accountId || !shownKey) return
    let current = true
    const ids = shownKey.split(',').map((key) => key.split(':')[0])
    void Promise.all(ids.map((id) => restaurantTestApi.closureContactStatus(accountId, id)
      .then((res) => [id, { reservations: res.data.reservations.length, contacted: res.data.contactedCount }] as const)
      .catch(() => null)))
      .then((rows) => {
        if (!current) return
        const next: Record<string, { reservations: number; contacted: number }> = {}
        for (const row of rows) if (row) next[row[0]] = row[1]
        setContacts(next)
      })
    return () => { current = false }
  }, [accountId, shownKey])

  const countOf = useCallback((closure: RestaurantClosure): number | null => {
    if (!reservations || closure.startDate < range.from || closure.endDate >= range.to) return null
    return overlapping(closure, reservations, timezone).length
  }, [reservations, range, timezone])
  const nameOf = useCallback((code: string) => media.find((m) => m.code === code)?.name ?? code, [media])

  /* 上の知らせ：まだ閉じていない媒体がある、いちばん近い休業・貸切。 */
  const pending = useMemo(() => list.map((c) => ({ closure: c, t: tasksFor(c, tasks) })).filter((x) => x.t.open.length > 0), [list, tasks])
  const first = pending[0] ?? null
  const firstItem = first?.t.open[0] ?? null
  const firstMedium = firstItem ? media.find((m) => m.code === firstItem.channel) ?? null : null

  /* Google：まだ Google の営業時間に入っていない、いちばん近い店全体の休み（貸切は既定で作らない）。 */
  const googleTarget = useMemo(() => {
    if (!Array.isArray(special)) return null
    return list.find((c) => c.kind !== 'private_event' && c.tableIds.length === 0 && !inGoogle(c, special)) ?? null
  }, [list, special])

  const closeOne = async (task: RestaurantChannelCloseTask) => {
    setBusy(task.id)
    try {
      await restaurantTestApi.completeChannelCloseTask(accountId, task.id)
      notifyToast(`${nameOf(task.channel)}の枠を閉じた印を付けました。`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!fieldFailure) {
      notifyToast(withPermissionFailure(caught, describeSaveFailure(caught), 'store'), { tone: 'error' }) }
    } finally {
      await loadTasks()
      setBusy('')
    }
  }

  const proposeGoogle = async (closure: RestaurantClosure) => {
    setBusy(`google-${closure.id}`)
    try {
      await restaurantGoogleApi.proposeClosureHours(accountId, closure.id, closure.version, closure.kind === 'private_event')
      setMadeGoogle((ids) => [...ids, closure.id])
      notifyToast('Google の営業時間の案を作りました。Google ビジネスの画面で確かめてから送ってください。')
    } catch (caught) {
      notifyToast(caught instanceof ApiError && caught.status === 409 ? 'この休業は Google の案にできません（卓の一部・深夜をまたぐ時間など）。Google ビジネスの画面で日ごとに直してください。' : '案を作れませんでした。もう一度お試しください。', { tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    if (!removing || removeGeneration.current !== scope.current.generation || loadedGeneration !== scope.current.generation || removing.storeId !== storeId) return
    const generation = scope.current.generation
    setBusy(`remove-${removing.id}`); setRemoveError('')
    try {
      await restaurantTestApi.deleteClosure(accountId, removing.id, removing.version)
      if (generation !== scope.current.generation) return
      const hadTasks = tasksFor(removing, tasks).total > 0
      setRemoving(null)
      notifyToast(hadTasks ? '消しました。他の予約サイトに「もう開けてよい」の知らせを出しました。' : '消しました。LINE からの予約をまた受け付けます。')
      await Promise.all([loadClosures(), loadTasks()])
    } catch (caught) {
      if (generation !== scope.current.generation) return
      setRemoveError(deleteMessage(caught))
      void loadClosures()
    } finally {
      if (generation === scope.current.generation) setBusy('')
    }
  }

  const saved = (result: ClosureSaved) => {
    const editing = dialog?.mode === 'edit'
    onDialog(null)
    const tail = result.reservations > 0 ? `重なる予約 ${result.reservations} 件は取り消していません。1件ずつ連絡してください。` : ''
    const google = result.google === 'made' ? 'Google の営業時間の案も作りました。' : result.google === 'failed' ? 'Google の案は作れませんでした。右の列からもう一度作れます。' : ''
    notifyToast(`${editing ? '変えました。' : `${rangeTitle(result.closure)}を閉じました。`}${tail}${google}`, result.google === 'failed' ? { tone: 'error' } : undefined)
    if (result.google === 'made') setMadeGoogle((ids) => [...ids, result.closure.id])
    void loadClosures(); void loadTasks()
  }

  const openDay = (day: string) => {
    if (!canWrite || day < today) return
    const hit = (closures ?? []).find((c) => covers(c, day))
    onDialog(hit ? { mode: 'edit', closure: hit } : { mode: 'add', day })
  }

  if (loadError !== null && closures === null) {
    return <SaveErrorScope errors={saveErrors}><div className={styles.state}><ListState kind="error" error={loadError} onRetry={() => void loadClosures()} /></div></SaveErrorScope>
  }

  const weeks = monthWeeks(month)
  const closeMedia = media.filter((m) => m.closeOnBooking)

  return (
    <SaveErrorScope errors={saveErrors}><>
      {tasksError?<ListState kind="error" title="枠を閉じる知らせを読み込めませんでした" onRetry={()=>void loadTasks()}/>:null}
      {mediaError?<ListState kind="error" title="予約サイトを読み込めませんでした" onRetry={()=>setMediaRetry(n=>n+1)}/>:null}
      {first && firstItem ? (
        <div className={styles.bandRow}>
          <Notice tone="warn" role="status" data-closure-band="" action={<>
            {firstMedium?.loginUrl ? (
              <Button external href={firstMedium.loginUrl}  >{`${firstMedium.name}の管理画面を開く`}</Button>
            ) : null}
            {canWrite ? (
              <Button onClick={() => void closeOne(firstItem)} disabled={busy === firstItem.id} aria-label={`${nameOf(firstItem.channel)}の枠を閉じた`} busy={Boolean(busy === firstItem.id)} busyLabel="処理中…">
                <Check size={16} aria-hidden="true" />閉じた
              </Button>
            ) : null}
            <>
              <TextLink href="/restaurant-test/close-tasks">休業日の対応一覧へ</TextLink>
            </>
          </>} heading={<>{`${dayTitle(first.closure.startDate)}の${KIND_LABEL[first.closure.kind]}：他の予約サイトの枠を閉じてください（未対応 ${formatNumber(first.t.open.length)} 件）`}</>}>
            <p className={styles.bandDetail}>
              {`LINE の受付は止めました → ${first.t.open.map((t) => nameOf(t.channel)).join('・')}の ${first.closure.startDate === first.closure.endDate ? dayShort(first.closure.startDate) : rangeTitle(first.closure)} を${first.closure.allDay ? '終日' : ` ${timeText(first.closure)} `}閉じてください`}
            </p>

          </Notice>
        </div>
      ) : null}

      <div className={styles.body}>
        <section className={styles.calendar} aria-label="休業日・貸切のカレンダー">
          <div className={styles.monthHead}>
            <IconButton aria-label="前の月" className={styles.monthStep} onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={16} aria-hidden="true" /></IconButton>
            <h2 className={styles.monthTitle} aria-live="polite">{monthTitle(month)}</h2>
            <IconButton aria-label="次の月" className={styles.monthStep} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={16} aria-hidden="true" /></IconButton>
            <Button onClick={() => setMonth(today.slice(0, 7))} disabled={month === today.slice(0, 7)}>今月</Button>
            <span className={styles.spacer} />
            <ul className={styles.legend} aria-label="色の見方">
              <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchClosed}`} aria-hidden="true" />臨時休業</li>
              <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchPrivate}`} aria-hidden="true" />貸切</li>
              <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchHoliday}`} aria-hidden="true" />定休</li>
            </ul>
          </div>
          <div className={styles.grid} role="grid" aria-label={monthTitle(month)}>
            <div className={styles.weekHead} role="row">
              {WEEK.map((w) => <span key={w} role="columnheader" className={styles.weekDay}>{w}</span>)}
            </div>
            {weeks.map((week, i) => (
              <div key={i} className={styles.week} role="row">
                {week.map((day, j) => {
                  if (!day) return <span key={`e${j}`} role="gridcell" className={styles.cell} />
                  const hits = (closures ?? []).filter((c) => covers(c, day))
                  const hit = hits[0] ?? null
                  const holiday = holidays.has(j)
                  const past = day < today
                  const faint = holiday || past
                  const clickable = canWrite && !past
                  const tone = hit ? kindTone(hit.kind) : null
                  const count = hit ? countOf(hit) : null
                  const label = `${dayTitle(day)}${hit ? `・${KIND_LABEL[hit.kind]}` : holiday ? '・定休' : ''}`
                  const content = (
                    <>
                      <span className={`${styles.date} ${day === today ? styles.dateToday : faint ? styles.dateFaint : ''}`}>{Number(day.slice(8))}</span>
                      {hit ? (
                        <>
                          <span className={`${styles.mark} ${tone === 'closed' ? styles.markClosed : ''}`}>{KIND_LABEL[hit.kind]}</span>
                          <span className={styles.cellNote}>{hit.allDay ? `終日・${tablesText(hit.tableIds, tables)}` : timeText(hit)}</span>
                          <span className={styles.cellNote}>{hit.allDay ? (count === null ? '' : `予約 ${formatNumber(count)} 件`) : tablesText(hit.tableIds, tables)}</span>
                          {hits.length > 1 ? <span className={styles.cellNote}>{`ほか ${hits.length - 1} 件`}</span> : null}
                        </>
                      ) : holiday ? (
                        <span className={`${styles.mark} ${styles.markHoliday}`}>定休</span>
                      ) : null}
                    </>
                  )
                  return clickable ? (
                    <button key={day} type="button" role="gridcell" className={`${styles.cell} ${styles.cellButton} ${tone === 'closed' ? styles.cellClosed : tone === 'private' ? styles.cellPrivate : ''}`} aria-label={`${label}${hit ? 'を変更する' : 'を閉じる'}`} onClick={() => openDay(day)}>
                      {content}
                    </button>
                  ) : (
                    <span key={day} role="gridcell" className={`${styles.cell} ${past ? styles.cellPast : ''} ${tone === 'closed' ? styles.cellClosed : tone === 'private' ? styles.cellPrivate : ''}`} aria-label={label}>{content}</span>
                  )
                })}
              </div>
            ))}
          </div>
          <p className={styles.note}>
            {canWrite ? '今日から先の日を押すと、その日を閉じる窓が開きます。' : ''}定休は「時間帯ごとの在庫」の営業時間で決まります。
          </p>
        </section>

        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <h2 className={styles.sideTitle}>これからの休業・貸切</h2>
            <HelpTip label="これからの休業・貸切の説明">今日からあとの臨時休業・貸切です。閉じた日・時間帯は LINE からの予約・キャンセル待ち・仮押さえを止めます。入っている予約は取り消しません。</HelpTip>
          </div>
          {closures === null ? (
            <ListState kind="loading" />
          ) : list.length === 0 ? (
            <ListState kind="empty" title="これからの休業・貸切はありません" description={canWrite ? 'カレンダーの日か右上のボタンから足せます。' : '休業日・貸切が登録されると、ここに出ます。'} />
          ) : (
            <ul className={styles.cards}>
              {list.slice(0, UPCOMING_LIMIT).map((closure) => {
                const t = tasksFor(closure, tasks)
                const contact = contacts[closure.id]
                const count = contact ? contact.reservations : countOf(closure)
                const line = statusLine(count, t, contact ? contact.contacted : null)
                const warn = t.open.length > 0
                const items = [
                  ...(canWrite ? [
                    { id: 'edit', label: '変更する', onSelect: () => onDialog({ mode: 'edit', closure }) },
                  ] : []),
                  { id: 'ledger', label: '予約台帳でこの日を見る', onSelect: () => { router.push(`/restaurant-test/reservations?date=${closure.startDate}`) } },
                  ...(canWrite ? [
                    { id: 'remove', label: '消して開ける', tone: 'danger' as const, dividerBefore: true, onSelect: () => { if (loadedGeneration !== scope.current.generation || closure.storeId !== storeId) return; removeGeneration.current = scope.current.generation; setRemoveError(''); setRemoving(closure) } },
                  ] : []),
                ]
                return (
                  <li key={closure.id} className={styles.card} data-closure-card={closure.id}>
                    <div className={styles.cardHead}>
                      <span className={styles.cardDay}>{rangeTitle(closure)}</span>
                      <span className={`${styles.chip} ${closure.kind === 'private_event' ? styles.chipPrivate : styles.chipClosed}`}>{KIND_LABEL[closure.kind]}</span>
                      <span className={styles.spacer} />
                      <RowMore subject={`${rangeTitle(closure)}の${KIND_LABEL[closure.kind]}`} items={items} />
                    </div>
                    <p className={styles.cardText}>{scopeText(closure, tables)}</p>
                    {closure.memo ? <p className={styles.cardText} title={closure.memo}>{closure.memo}</p> : null}
                    {line ? <p className={`${styles.cardStatus} ${warn ? styles.cardStatusWarn : ''}`}>{line}</p> : null}
                  </li>
                )
              })}
              {list.length > UPCOMING_LIMIT ? <li className={styles.sideEmpty}>{`ほか ${list.length - UPCOMING_LIMIT} 件（カレンダーの月を進めると見られます）`}</li> : null}
            </ul>
          )}

          <div className={styles.sideHead}>
            <h2 className={styles.sideTitle}>Google の営業時間</h2>
            <HelpTip label="Google の営業時間の説明">臨時休業を Google の営業時間（特別営業時間）にも入れる案を作れます。案は自動では送りません。Google ビジネスの画面で確かめてから送ります。貸切は店全体の休みではないので、案を作りません。</HelpTip>
          </div>
          {special === null ? (
            <p className={styles.sideText}>Google の営業時間を読み込んでいます。</p>
          ) : special === 'none' ? (
            <p className={styles.sideText}>
              Google ビジネスとつないでいないため、営業時間を確かめられません。<TextLink href="/settings/sns">つなぐ</TextLink>
            </p>
          ) : googleTarget ? (
            <>
              <p className={styles.sideText}>
                {madeGoogle.includes(googleTarget.id)
                  ? `${dayShort(googleTarget.startDate)}の${KIND_LABEL[googleTarget.kind]}は、Google の営業時間の案を作りました。送る前に確かめてください。`
                  : `${dayShort(googleTarget.startDate)}の${KIND_LABEL[googleTarget.kind]}は、まだ Google の営業時間に入っていません。`}
              </p>
              {madeGoogle.includes(googleTarget.id) ? (
                <TextLink href="/restaurant-test/google">Google ビジネスで確かめる</TextLink>
              ) : canGoogle ? (
                <Button className={styles.sideButton} onClick={() => void proposeGoogle(googleTarget)} disabled={busy === `google-${googleTarget.id}`} busy={Boolean(busy === `google-${googleTarget.id}`)} busyLabel="処理中…">
                  {`Google にも${KIND_LABEL[googleTarget.kind]}を入れる案を作る`}
                </Button>
              ) : null}
            </>
          ) : (
            <p className={styles.sideText}>{list.some((c) => c.kind !== 'private_event') ? 'これからの臨時休業は、Google の営業時間に入っています。' : 'Google に入れる臨時休業はありません。'}</p>
          )}
        </aside>
      </div>

      {store ? (
        <ClosureDialog
          target={dialog}
          accountId={accountId}
          storeId={storeId}
          timezone={timezone}
          today={today}
          tables={tables}
          reservations={reservations ?? []}
          media={closeMedia}
          canGoogle={canGoogle && special !== 'none'}
          onClose={() => onDialog(null)}
          onSaved={saved}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null && removeGeneration.current === currentGeneration}
        destructive
        title={removing ? `${rangeTitle(removing)}の${KIND_LABEL[removing.kind]}を消しますか` : ''}
        description={removing && tasksFor(removing, tasks).total > 0
          ? '消すと LINE からの予約をまた受け付けます。閉じる知らせを出した予約サイトには「もう開けてよい」の知らせを出します。'
          : '消すと LINE からの予約をまた受け付けます。'}
        confirmLabel="消して開ける"
        busy={removing !== null && busy === `remove-${removing.id}`}
        error={removeError || undefined}
        onConfirm={() => remove()}
        onCancel={() => setRemoving(null)}
      ><OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: storeId, name: store?.id === storeId ? store.name : undefined }} /></ConfirmDialog>
    </></SaveErrorScope>
  )
}
