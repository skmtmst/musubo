'use client'

import { requestUnsavedAction } from '@/lib/unsaved-action'
import { ListPageStats } from '@/components/templates/list-page'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Grid2x2, HelpCircle, Send, Square, Users } from 'lucide-react'
import type { FriendField } from '@line-crm/shared'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { ListToolbarFrame, ListToolbarRow, ListToolbarEnd } from '@/components/shared/list-toolbar'
import Select from '@/components/shared/select'
import { api, ApiError, type AnalyticsCrossAxis, type AnalyticsCrossResult } from '@/lib/api'
import { formatNumber, formatTime } from '@/lib/format'
import { downloadCsv, periodCaption, useRegisterExport } from './parts'
import styles from './analytics.module.css'
import PeriodPicker, { useReportPeriod } from '@/components/shared/period-picker'
import { Field } from '@/components/shared/form-controls'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import AggregationStatus from '@/components/shared/aggregation-status'

/*
 * ★V8 分析「クロス分析」（Pencil ）。
 * 数の帯 → 選ぶ段（数えるもの・たての軸・よこの軸・期間・集計する・この分析を保存）
 * → 左に掛け合わせの表（濃さはその表の最大が基準・マスを押して選ぶ・凡例）、
 *   右に選んだマス（対象者を開く・この対象者へ配信を作る）とこの表から読めること → 見かたの注意。
 * 集計は重いので開いただけでは走らせない（「集計する」で受け付け、結果は待ち順で届く）。
 * 呼ぶ口・待ち順の確認（打ち切り・再接続・控え）・世代の守り・CSV は今の画面（CrossTab）と同じ。
 * よこの軸は友だち情報だけでなく、流入経路・タグなど口が受け付ける軸を選べる（絵どおり）。
 */

type CrossQueueStatus = { state: 'pending' | 'running' | 'available' | 'partial' | 'unavailable' | 'failed'; queuePosition: number | null; pendingAhead: number; estimatedWaitMs: number | null; nextTickAt: string | null }
export type CrossSaveSlot = (props: { sourceResultId: string; defaultName: string }) => ReactNode

// 自動確認は5分cronの最初の処理機会をまたいで続ける。打ち切りは「観測した最短目安+3分」と「開始から15分」の早い方。
const CROSS_AUTO_POLL_MIN_MS = 6 * 60_000
const CROSS_AUTO_POLL_MARGIN_MS = 3 * 60_000
const CROSS_AUTO_POLL_MAX_MS = 15 * 60_000
const CROSS_POLL_ERROR_BACKOFF_MS = 10_000
// 同じタブ・同じアカウントなら実行中の集計へ戻れるよう、run ID と作成時刻だけを控える（1日で捨てる）。
const CROSS_RUN_STORAGE_PREFIX = 'lh:analytics:cross-run:v1:'
const CROSS_STORED_RUN_TTL_MS = 24 * 60 * 60_000
type StoredCrossRun = { id: string; createdAt: number }
const storageKey = (accountId: string) => `${CROSS_RUN_STORAGE_PREFIX}${encodeURIComponent(accountId)}`
function validStoredCrossRun(value: unknown, now = Date.now()): value is StoredCrossRun {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredCrossRun>
  return typeof candidate.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(candidate.id)
    && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    && candidate.createdAt > 0 && candidate.createdAt <= now && now - candidate.createdAt <= CROSS_STORED_RUN_TTL_MS
}
function readStoredCrossRun(accountId: string): StoredCrossRun | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(accountId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (validStoredCrossRun(parsed)) return parsed
  } catch { /* storage が無効でも新規の集計は止めない */ }
  try { window.sessionStorage.removeItem(storageKey(accountId)) } catch { /* storage unavailable */ }
  return null
}
function saveStoredCrossRun(accountId: string, run: StoredCrossRun) {
  try { window.sessionStorage.setItem(storageKey(accountId), JSON.stringify(run)) } catch { /* storage unavailable */ }
}
function clearStoredCrossRun(accountId: string) {
  try { window.sessionStorage.removeItem(storageKey(accountId)) } catch { /* storage unavailable */ }
}
function explainStartError(code: string, fallback: string): string {
  if (code === 'analytics_cross_busy') return '他の集計が動いています。終わってからもう一度押してください'
  return fallback
}
const formatWait = (ms: number) => String(Math.max(1, Math.round(ms / 60_000)))
const formatNextTick = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : formatTime(parsed) }

// 「イベントの回数」で数えられる種類は、記録の接続が取得可能なものだけ（選べるのに必ず未取得、を置かない）。
const MEASURE_EVENTS = [
  { value: 'message_received', label: '友だちから届いたメッセージの回数' },
  { value: 'postback_received', label: 'ボタン・メニューを押した回数' },
  { value: 'friend_add', label: '友だち追加の回数' },
  { value: 'friend_unfollow', label: 'ブロック・友だち解除の回数' },
]
const AXIS_LABELS: Record<string, string> = { tag: 'タグ', route: '流入経路', score_band: 'スコア帯', conversion_point: '成果地点', booking_status: '予約状態', purchase_status: '購入状態' }
const ROW_AXES = ['tag', 'route', 'score_band', 'conversion_point', 'booking_status', 'purchase_status'] as const
const COLUMN_AXES = ['route', 'tag', 'score_band', 'conversion_point', 'booking_status', 'purchase_status'] as const
const PERIODS = [7, 30, 90]

function axisOf(value: string): AnalyticsCrossAxis {
  if (value.startsWith('field:')) return { kind: 'field_choice', fieldId: value.slice('field:'.length) }
  return { kind: value as Exclude<AnalyticsCrossAxis['kind'], 'field_choice'> } as AnalyticsCrossAxis
}

export default function CrossV8({ accountId, canManage, renderSave }: { accountId: string; canManage: boolean; renderSave?: CrossSaveSlot }) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const [fields, setFields] = useState<FriendField[]>([])
  const [fieldsError, setFieldsError] = useState('')
  const [fieldsLoading, setFieldsLoading] = useState(true)
  const [fieldsReload, setFieldsReload] = useState(0)
  const [measureKind, setMeasureKind] = useState<'unique_friends' | 'events'>('unique_friends')
  const [measureEventType, setMeasureEventType] = useState(MEASURE_EVENTS[0].value)
  const [rowAxis, setRowAxis] = useState<string>('tag')
  const [columnAxis, setColumnAxis] = useState<string>('route')
  const { days: crossDays, setDays: setCrossDays, customRange, setRange } = useReportPeriod()
  const [crossResult, setCrossResult] = useState<AnalyticsCrossResult | null>(null)
  const [crossRunId, setCrossRunId] = useState('')
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [crossResultId, setCrossResultId] = useState('')
  const [crossQueue, setCrossQueue] = useState<CrossQueueStatus | null>(null)
  const [crossAutoStopped, setCrossAutoStopped] = useState(false)
  const [crossRecheck, setCrossRecheck] = useState(0)
  const [loading, setLoading] = useState(false)
  const [restoredCrossRun, setRestoredCrossRun] = useState(false)
  const [crossStorageRestored, setCrossStorageRestored] = useState(false)
  const [error, setError] = useState('')
  const [audienceBusy, setAudienceBusy] = useState(false)
  const [pickedKey, setPickedKey] = useState<{ rowKey: string; columnKey: string } | null>(null)
  // 結果を出した時の軸の名前（表の題・CSV）。選ぶ欄を変えても、出ている表の名前は変えない。
  const [resultAxes, setResultAxes] = useState<{ row: string; column: string; unit: string } | null>(null)
  const viewGeneration = useRef(0)
  const crossStartInFlight = useRef(false)

  useEffect(() => {
    let active = true
    setFieldsLoading(true); setFieldsError('')
    void api.friendFields.list(accountId, undefined, { suppressFeatureDisabledEvent: true }).then((res) => {
      if (!active) return
      if (res.success) setFields(res.data)
      else setFieldsError(res.error || '友だち情報欄を読み込めませんでした')
    }).catch(() => { if (active) setFieldsError('友だち情報欄を読み込めませんでした') })
      .finally(() => { if (active) setFieldsLoading(false) })
    return () => { active = false }
  }, [accountId, fieldsReload])

  // 同じアカウントの実行中の集計だけを、hydration の後に一度だけ復元する。
  useEffect(() => {
    const stored = readStoredCrossRun(accountId)
    if (stored) { setStartedAt(new Date(stored.createdAt).toISOString()); setCrossRunId(stored.id); setCrossResultId(stored.id); setLoading(true); setRestoredCrossRun(true) }
    setCrossStorageRestored(true)
  }, [accountId])
  useEffect(() => {
    const generation = viewGeneration.current
    return () => { viewGeneration.current = generation + 1 }
  }, [accountId])

  const clearCrossRun = useCallback(() => {
    clearStoredCrossRun(accountId)
    setCrossRunId(''); setCrossResultId(''); setCrossQueue(null); setRestoredCrossRun(false)
  }, [accountId])

  // 結果待ちの読み直し（打ち切り・失敗時の間隔延長・再接続）。今の画面と同じ。
  useEffect(() => {
    if (!crossStorageRestored || !crossRunId) return
    let active = true
    let timer: number | undefined
    let attempts = 0
    let pollErrors = 0
    const pollStart = Date.now()
    let deadline = pollStart + CROSS_AUTO_POLL_MIN_MS
    const stopIfDeadlinePassed = (): boolean => {
      if (Date.now() < deadline) return false
      setCrossAutoStopped(true); setLoading(false)
      return true
    }
    const check = async () => {
      if (stopIfDeadlinePassed()) return
      attempts += 1
      try {
        const response = await api.analytics.crossResult(accountId, crossRunId)
        if (!active) return
        if (!response.success) throw new Error(response.error)
        pollErrors = 0
        setError('')
        setCrossQueue({ state: response.data.state, queuePosition: response.data.queuePosition ?? null, pendingAhead: response.data.pendingAhead ?? 0, estimatedWaitMs: response.data.estimatedWaitMs ?? null, nextTickAt: response.data.nextTickAt ?? null })
        const waitMs = response.data.estimatedWaitMs
        if (waitMs != null) deadline = Math.min(pollStart + CROSS_AUTO_POLL_MAX_MS, Math.max(deadline, Date.now() + waitMs + CROSS_AUTO_POLL_MARGIN_MS))
        if (response.data.result) {
          setCrossResult(response.data.result)
          clearCrossRun()
          // 待ち順の控えは消すが、保存に使う完成した結果のIDは残す。
          setCrossResultId(response.data.id)
          setLoading(false)
          return
        }
        if (response.data.state === 'failed') {
          setError(response.data.errorCode || 'クロス分析を集計できませんでした。条件を変えずにもう一度集計できます')
          clearCrossRun(); setLoading(false)
          return
        }
      } catch (caught) {
        if (!active) return
        const fieldFailure = saveErrors.capture(caught);

        if (caught instanceof ApiError && caught.status === 401) {
          setCrossAutoStopped(true)
          { if (!fieldFailure)


          setError('ログインを確認できません。ログインし直した後、同じ集計を確認できます') }
          setLoading(false)
          return
        }
        if (caught instanceof ApiError && [400, 403, 404, 410].includes(caught.status)) {
          clearCrossRun()
          if (caught.status === 404) {
            setError('')
            setCrossResult(null)
            setLoading(false)
            return
          }
          { if (!fieldFailure)
          setError('前回のクロス分析は利用できません。もう一度集計してください') }
          setLoading(false)
          return
        }
        pollErrors += 1
        { if (!fieldFailure)
        setError('クロス分析を確認できませんでした。確認を続けています') }
        if (stopIfDeadlinePassed()) return
        timer = window.setTimeout(() => void check(), CROSS_POLL_ERROR_BACKOFF_MS * Math.min(pollErrors, 3))
        return
      }
      if (!active) return
      if (stopIfDeadlinePassed()) return
      timer = window.setTimeout(() => void check(), attempts < 10 ? 3000 : 10000)
    }
    void check()
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [accountId, clearCrossRun, crossRunId, crossRecheck, crossStorageRestored, saveErrors])

  const recheckCross = () => {
    if (!crossStorageRestored || !crossRunId) return
    setCrossAutoStopped(false); setError(''); setLoading(true); setCrossRecheck((n) => n + 1)
  }

  const axisLabel = (value: string) => value.startsWith('field:') ? `友だち情報 / ${fields.find((field) => `field:${field.id}` === value)?.name ?? '項目'}` : AXIS_LABELS[value] ?? value
  const sameAxis = rowAxis === columnAxis

  const runCross = async () => {
    if (!crossStorageRestored || sameAxis || crossRunId || crossStartInFlight.current) return
    crossStartInFlight.current = true
    setStartedAt(new Date().toISOString())
    const generation = viewGeneration.current
    setLoading(true); setError(''); setPickedKey(null); setCrossResult(null); setCrossQueue(null); setCrossAutoStopped(false); setRestoredCrossRun(false)
    setResultAxes({ row: axisLabel(rowAxis), column: axisLabel(columnAxis), unit: measureKind === 'events' ? '回' : '人' })
    const now = new Date()
    const from = new Date(now.getTime() - crossDays * 24 * 3600_000)
    try {
      const response = await api.analytics.runCross(accountId, {
        rowAxis: axisOf(rowAxis),
        columnAxis: axisOf(columnAxis),
        measure: measureKind === 'events' ? { kind: 'events', eventType: measureEventType } : { kind: 'unique_friends' },
        filters: [],
        periodFrom: customRange ? `${customRange.from}T00:00:00+09:00` : from.toISOString(),
        periodTo: customRange ? new Date(Math.min(Date.now(), Date.parse(`${customRange.to}T23:59:59.999+09:00`))).toISOString() : now.toISOString(),
      })
      if (!response.success) throw new Error(response.error)
      if (viewGeneration.current !== generation) return
      saveStoredCrossRun(accountId, { id: response.data.id, createdAt: Date.now() })
      setCrossResultId(response.data.id)
      setCrossRunId(response.data.id)
    } catch (caught) {
      if (viewGeneration.current !== generation) return
      const fieldFailure = saveErrors.capture(caught);

      const code = caught instanceof Error ? caught.message : ''
      { if (!fieldFailure)


      setError(explainStartError(code, describeApiFailure(caught, 'クロス分析の開始'))) }
      setLoading(false)
    } finally {
      crossStartInFlight.current = false
    }
  }

  const rows = crossResult?.rowValues ?? []
  const cols = crossResult?.columnValues ?? []
  const cells = useMemo(() => crossResult?.cells ?? [], [crossResult])
  const lookup = useMemo(() => {
    const map = new Map<string, (typeof cells)[number]>()
    for (const cell of cells) map.set(`${cell.rowKey}\u0000${cell.columnKey}`, cell)
    return map
  }, [cells])
  const summary = useMemo(() => {
    if (cells.length === 0) return null
    const top = cells.reduce((best, cell) => (cell.value > best.value ? cell : best), cells[0])
    const empty = rows.length * cols.length - cells.filter((cell) => cell.value > 0).length
    const emptyLabels = rows.flatMap((row) => cols.filter((col) => (lookup.get(`${row.key}\u0000${col.key}`)?.value ?? 0) === 0).map((col) => `${row.label} × ${col.label}`))
    return { top, empty, emptyLabels, max: top.value }
  }, [cells, rows, cols, lookup])
  // 合計は延べ人数。1人が複数のタグを持つと、その人は行ごとに数えられる。
  const rowTotals = useMemo(() => { const m = new Map<string, number>(); for (const c of cells) m.set(c.rowKey, (m.get(c.rowKey) ?? 0) + c.value); return m }, [cells])
  const colTotals = useMemo(() => { const m = new Map<string, number>(); for (const c of cells) m.set(c.columnKey, (m.get(c.columnKey) ?? 0) + c.value); return m }, [cells])
  const grandTotal = useMemo(() => cells.reduce((sum, c) => sum + c.value, 0), [cells])
  // 選んでいないときは、いちばん多い組み合わせを選んだ形で見せる。
  const picked = pickedKey ? lookup.get(`${pickedKey.rowKey}\u0000${pickedKey.columnKey}`) ?? null : summary?.top ?? null

  /** 表から機械的に読めることだけ（割合の事実）。提案は作らない。 */
  const readings = useMemo(() => {
    if (!summary) return []
    const out: string[] = []
    const topRowTotal = rowTotals.get(summary.top.rowKey) ?? 0
    if (topRowTotal > 0) {
      out.push(`「${summary.top.rowLabel}」の ${Math.round(summary.top.value / topRowTotal * 100)}% が「${summary.top.columnLabel}」です`)
      const others = rows.filter((r) => r.key !== summary.top.rowKey).map((r) => {
        const total = rowTotals.get(r.key) ?? 0
        const n = lookup.get(`${r.key}\u0000${summary.top.columnKey}`)?.value ?? 0
        return { row: r.label, pct: total > 0 ? n / total * 100 : 0 }
      }).sort((a, b) => b.pct - a.pct)
      if (others.length > 0 && others[0].pct > 0) out.push(`同じ「${summary.top.columnLabel}」でも、「${others[0].row}」は ${Math.round(others[0].pct)}% です`)
    }
    if (summary.empty > 0) out.push(`${summary.empty} 個のマスに該当者がいません。掛け合わせが細かすぎるかもしれません`)
    return out
  }, [summary, rowTotals, rows, lookup])

  const exportCross = () => {
    if (!crossResult) return
    downloadCsv(csvFileName("掛け合わせ集計"), [
      [`${resultAxes?.row ?? 'たて'} ＼ ${resultAxes?.column ?? 'よこ'}`, ...cols.map((column) => column.label), '合計'],
      ...rows.map((row) => [row.label, ...cols.map((column) => lookup.get(`${row.key}\u0000${column.key}`)?.value ?? 0), rowTotals.get(row.key) ?? 0]),
      ['合計', ...cols.map((column) => colTotals.get(column.key) ?? 0), grandTotal],
    ])
  }
  const exportReason = fieldsLoading ? '友だち情報欄を読み込んでいます。' : fieldsError || error || (loading ? (crossQueue?.state === 'running' ? '集計しています。' : '集計の完了を待っています。') : crossRunId ? (crossAutoStopped ? '集計結果をもう一度確認してください。' : '集計の完了を待っています。') : '集計してから書き出してください。')
  useRegisterExport(exportCross, !crossResult, exportReason)

  const openAudience = async (to: 'friends' | 'broadcast') => {
    if (!picked || !crossResultId) return
    const generation = viewGeneration.current
    setError(''); setAudienceBusy(true)
    try {
      const response = await api.analytics.createResultAudience(accountId, crossResultId, { sourceKind: 'cross', rowKey: picked.rowKey, columnKey: picked.columnKey })
      if (!response.success) throw new Error(response.error)
      if (viewGeneration.current !== generation) return
      const id = encodeURIComponent(response.data.id)
      router.push(to === 'friends' ? `/friends?audienceId=${id}` : `/broadcasts/new?audienceId=${id}`)
    } catch (caught) {
      if (viewGeneration.current !== generation) return
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)


      setError(describeApiFailure(caught, '対象者の準備')) }
    } finally { setAudienceBusy(false) }
  }

  const unit = resultAxes?.unit ?? (measureKind === 'events' ? '回' : '人')
  const kpis = <ListPageStats><KpiBand className={styles.band}>
    {/* 表の合計は延べ人数。集計対象は口が数えた実際の人数（重複なし）。 */}
    <KpiCard presentation="band" title="集計対象" icon={<Users size={16} aria-hidden="true" />} value={crossResult ? crossResult.totalFriends : null} unit="人" detail={crossResult ? `表の延べ ${formatNumber(grandTotal)} ${unit}` : '結果が出ると数えます'} loading={loading} />
    <KpiCard presentation="band" title="いちばん多い組み合わせ" icon={<Grid2x2 size={16} aria-hidden="true" />} value={summary?.top.value ?? null} unit={unit} detail={summary ? `${summary.top.rowLabel} × ${summary.top.columnLabel}` : emptyValue('unknown')} loading={loading} />
    <KpiCard presentation="band" title="空のマス" icon={<Square size={16} aria-hidden="true" />} value={summary?.empty ?? null} unit="マス" detail={summary ? (summary.emptyLabels.slice(0, 2).join('・') || '該当者なし') : '該当者なし'} loading={loading} />
    {/* その項目に値が入っていない人は集計が数えていない。 */}
    <KpiCard presentation="band" title="未入力" icon={<HelpCircle size={16} aria-hidden="true" />} value={null} unit="人" detail="値がまだ無い人（表に出ない）" />
  </KpiBand></ListPageStats>

  if (fieldsLoading) return <SaveErrorScope errors={saveErrors}><>{kpis}<div className={styles.body} data-gap="tab"><ListState kind="loading" title="友だち情報欄を読み込んでいます" /></div></></SaveErrorScope>
  if (fieldsError) return <SaveErrorScope errors={saveErrors}><>{kpis}<div className={styles.body} data-gap="tab"><ListState kind="error" title="友だち情報欄を読み込めませんでした。" description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。" onRetry={() => setFieldsReload((n) => n + 1)} /></div></></SaveErrorScope>

  const axisOptions = (kinds: readonly string[]) => [
    ...kinds.map((kind) => ({ value: kind, label: AXIS_LABELS[kind] })),
    ...fields.map((field) => ({ value: `field:${field.id}`, label: `友だち情報 / ${field.name}` })),
  ]
  const tableTitle = resultAxes ? `何を掛け合わせるか：${resultAxes.row} × ${resultAxes.column}` : `何を掛け合わせるか：${axisLabel(rowAxis)} × ${axisLabel(columnAxis)}`

  return <SaveErrorScope errors={saveErrors}><>
    {kpis}
    <div className={styles.body} data-gap="tab">
      <ListToolbarFrame><ListToolbarRow>
        <Field label="数えるもの"><SaveErrorField names={["measureKind","measure_kind"]}><Select id="cross-measure" value={measureKind} onChange={(value) => setMeasureKind(value as 'unique_friends' | 'events')} aria-label="数えるもの" size="full" options={[{ value: 'unique_friends', label: '友だちの人数（重複なし）' }, { value: 'events', label: 'イベントの回数' }]} /></SaveErrorField></Field>
        {measureKind === 'events' ? <Field label="数えるイベント"><SaveErrorField names={["measureEventType","eventType","measure_event_type"]}><Select id="cross-measure-event" value={measureEventType} onChange={setMeasureEventType} aria-label="数えるイベント" size="full" options={MEASURE_EVENTS} /></SaveErrorField></Field> : null}
        <Field label="たての軸"><SaveErrorField names={["rowAxis","row_axis"]}><EntitySelect aria-label="たての軸" value={rowAxis} onChange={setRowAxis} size="full" options={axisOptions(ROW_AXES)} /></SaveErrorField></Field>
        <Field label="よこの軸"><SaveErrorField names={["columnAxis","column_axis"]}><EntitySelect id="cross-field" aria-label="よこの軸" value={columnAxis} onChange={setColumnAxis} size="full" options={axisOptions(COLUMN_AXES)} /></SaveErrorField></Field>
        <SaveErrorField names={["crossDays","cross_days"]}><PeriodPicker days={crossDays} onChange={setCrossDays} customRange={customRange} onRangeChange={setRange} /></SaveErrorField>
        <ListToolbarEnd>
        {crossResult && crossResultId && canManage && renderSave ? <span title="条件の定義と、いま表示している結果を別々に固定して残します">{renderSave({ sourceResultId: crossResultId, defaultName: `クロス分析 ${resultAxes?.row ?? ''} × ${resultAxes?.column ?? ''}` })}</span> : null}
        </ListToolbarEnd>
      </ListToolbarRow></ListToolbarFrame>
      {sameAxis ? <p className={styles.warnText}>たてとよこに同じ軸は選べません</p> : null}
      <AggregationStatus state={error ? { kind: 'failed', reason: error } : crossRunId || loading ? { kind: 'running', startedAt } : crossResult ? { kind: 'complete', dataAt: crossResult.dataCutoffAt } : { kind: 'empty' }} onRun={() => requestUnsavedAction(() => { if (crossRunId) recheckCross(); else void runCross() })} disabled={!crossStorageRestored || sameAxis} />
      {crossResult?.stateReason ? <p className={styles.warnText}>{crossResult.stateReason}</p> : null}

      {loading ? <div className={styles.waitBox} role="status">
        <p className={styles.audienceCount}>{restoredCrossRun ? '進行中の集計を確認しています。' : '集計を受け付けました。終わるまでこの画面で確認しています。'}</p>
        <p>{`現在の状態: ${crossQueue?.state === 'running' ? '処理中です' : 'このLINEアカウント内で待ち順に並んでいます'}`}</p>
        {crossQueue?.queuePosition != null ? <p>{`このLINEアカウント内の順番は${crossQueue.queuePosition}番目です${crossQueue.pendingAhead === 0 ? '（このアカウントであなたの前にはありません）' : `（このアカウントであなたの前に${crossQueue.pendingAhead} 件あります）`}`}</p> : null}
        {crossQueue?.estimatedWaitMs != null && crossQueue.estimatedWaitMs > 0 ? <p>{`最短で約${formatWait(crossQueue.estimatedWaitMs)}分です。他の処理状況により延びることがあります${crossQueue.nextTickAt && formatNextTick(crossQueue.nextTickAt) ? `（次回処理は${formatNextTick(crossQueue.nextTickAt)}ごろ）` : ''}`}</p> : null}
        <p className={styles.caption}>同じ分析をもう一度押す必要はありません。このままお待ちください。結果が出た後はこの画面で確認でき、失敗・時間切れのときも集計し直せます。</p>
      </div>
        : !crossResult && crossAutoStopped && crossRunId ? <div className={styles.waitBox} role="status">
          <p className={styles.audienceCount}>自動の確認を止めました。集計はこのまま続いています。</p>
          {crossQueue?.queuePosition != null ? <p>{`このLINEアカウント内の順番は${crossQueue.queuePosition}番目です`}</p> : null}
          <p>「結果をもう一度確認」を押すと同じ集計の続きを確認できます。もう一度集計を送り直す必要はありません。</p>
          <span><Button onClick={() => recheckCross()} variant="primary">結果をもう一度確認</Button></span>
        </div>
        : !crossResult ? <div className={styles.waitBox}><p>{fields.length === 0 && (rowAxis.startsWith('field:') || columnAxis.startsWith('field:')) ? '友だち情報欄の項目がまだありません。' : 'たて・よこの軸と期間を選び、集計を始めてください。'}{fields.length === 0 ? <Link href="/tags/fields/new" className={styles.textLink}>友だち情報の項目を追加</Link> : null}</p></div>
        : cells.length === 0 ? <div className={styles.waitBox}><p>{crossResult.state === 'unavailable' ? crossResult.stateReason || '未取得' : 'この条件に該当する人はいません。'}</p></div>
        : <div className={styles.routesSplit}>
          <section className={styles.funnelFlow} aria-labelledby="cross-table-title">
            <h2 id="cross-table-title" className={styles.hoursTitle}>{tableTitle}</h2>
            <p className={styles.caption}>{canManage ? 'マスを押すと、その人たちを抽出できます' : 'マスを押すと、内訳を確認できます'}</p>
            <div className={styles.gridRow} data-head>
              <span className={styles.gridLabel} />
              {cols.map((col) => <span key={col.key} className={styles.gridHead} title={`${col.label}の合計 ${formatNumber(colTotals.get(col.key) ?? 0)}`}>{col.label}</span>)}
              <span className={styles.gridHead} title={`全体の延べ ${formatNumber(grandTotal)}`}>合計</span>
            </div>
            {rows.map((row) => <div key={row.key} className={styles.gridRow}>
              <span className={styles.gridLabel} title={row.label}>{row.label}</span>
              {cols.map((col) => {
                const cell = lookup.get(`${row.key}\u0000${col.key}`)
                const n = cell?.value ?? 0
                // 濃さはその表の最大を基準にする（表ごとに桁が違うため）。
                const strength = summary && summary.max > 0 ? n / summary.max : 0
                const active = picked?.rowKey === row.key && picked?.columnKey === col.key
                return <button key={col.key} type="button" className={styles.gridCell} data-active={active || undefined} data-strong={strength > 0.5 || undefined} data-empty={n === 0 || undefined} disabled={n === 0} aria-pressed={active}
                  aria-label={`${row.label} × ${col.label} ${formatNumber(n)} ${unit}`}
                  onClick={() => setPickedKey({ rowKey: row.key, columnKey: col.key })}
                  style={n > 0 ? { backgroundColor: `color-mix(in srgb, var(--color-accent) ${Math.round((0.16 + strength * 0.7) * 100)}%, transparent)` } : undefined}>{formatNumber(n)}</button>
              })}
              <span className={styles.gridTotal}>{formatNumber(rowTotals.get(row.key) ?? 0)}</span>
            </div>)}
            <div className={styles.legend} data-size="grid">
              <strong>凡例</strong>
              <span data-swatch="none">0</span><span data-swatch="low">少ない</span><span data-swatch="mid">中くらい</span><span data-swatch="high">{`多い（最大 ${formatNumber(summary?.max ?? 0)} ${unit}）`}</span>
            </div>
          </section>
          <aside className={styles.funnelSide} data-w="cross" aria-labelledby="cross-picked-title">
            <h2 id="cross-picked-title" className={styles.hoursTitle}>{picked ? `${picked.rowLabel} × ${picked.columnLabel}（${formatNumber(picked.value)}${unit}${unit === '回' ? `・${formatNumber(picked.uniqueFriends)} 人` : ''}）` : 'マスを選んでください'}</h2>
            {picked && canManage ? <>
              <span><Button variant="secondary" disabled={audienceBusy} onClick={() => requestUnsavedAction(() => void openAudience('friends'))} busy={Boolean(audienceBusy)} busyLabel="処理中…"><Users size={16} aria-hidden="true" />対象者を開く</Button></span>
              <span><Button variant="secondary" disabled={audienceBusy} onClick={() => requestUnsavedAction(() => void openAudience('broadcast'))} busy={Boolean(audienceBusy)} busyLabel="処理中…"><Send size={16} aria-hidden="true" />この対象者へ配信を作る</Button></span>
            </> : picked ? <p className={styles.caption}>結果の保存と対象者づくりは、統括・管理者だけが行えます。</p> : null}
            {readings.length > 0 ? <>
              <h3 className={styles.compareTitle}>この表から読めること</h3>
              {readings.map((reading) => <p key={reading} className={styles.observation}>{`・${reading}`}</p>)}
            </> : null}
          </aside>
        </div>}
      {crossResult ? <p className={styles.noteBox} title={periodCaption(crossResult.periodFrom, crossResult.periodTo, crossResult.dataCutoffAt)}>見かたの注意：「未記録」は、その項目にまだ値が入っていない人です。いまは表に出ません。マスの色は、その表の中でいちばん多い数を基準にした濃さです。1人が複数のタグを持つ場合、それぞれの行に数えられます。数えているのは、こちらで観測できたことだけです。</p>
        : <p className={styles.noteBox}>数えているのは、こちらで観測できたことだけです。LINEで開かれたかどうかは取れないため、この画面には出しません。集計結果はその時点のデータで固定します。</p>}
    </div>
  </></SaveErrorScope>
}
