'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  input_startDate: requiredText("はじめの日を入れてください。"),
  input_endDate: requiredText("おわりの日を入れてください。"),
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Phone } from 'lucide-react'
import type { RestaurantClosure, RestaurantClosureInput, RestaurantClosureKind, RestaurantClosurePreview } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import DateField from '@/components/shared/date-field'
import Dialog from '@/components/shared/dialog'
import Radio from '@/components/shared/radio'
import SegmentedControl from '@/components/shared/segmented'
import TimeField from '@/components/shared/time-field-v8'
import { Field, OptionalBadge } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { ApiError, describeSaveFailure } from '@/lib/api'
import { restaurantGoogleApi } from '@/lib/restaurant-google-api'
import { restaurantTestApi, type RestaurantReservation, type RestaurantTable } from '@/lib/restaurant-test-api'
import {
  KIND_LABEL, KIND_ORDER, clock, conflictsOf, dayOfIso, dayShort, emptyInput, inputError, inputOf, overlapMessage, overlapping, sourceLabel,
} from './format'
import styles from './closures.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'
import { withHonorific } from '@line-crm/shared'


/*
 * ★V8 臨時休業・貸切を足す／変える窓（提案 E-10 ）。
 *
 * 種類 → はじめの日〜おわりの日 → 時間（終日／時間帯だけ）→ 閉じる卓（全部／選ぶ）→ メモ
 * → 重なる予約（保存しても取り消さない・1件ずつ「LINE で連絡する」）→ 他の予約サイトと Google。
 * 入力が変わるたびに少し待って preview を呼び、重なる予約を出す。保存は予約を取り消さず、お客さまへ送信もしない。
 * 動きは BEHAVIOR.md。
 */

export type ClosureDialogTarget = { mode: 'add'; day: string } | { mode: 'edit'; closure: RestaurantClosure }

type Row = { id: string; startsAt: string; guestCount: number; customerName: string; source: string; friendId: string | null; phone: string | null; contacted: boolean }

export type ClosureSaved = { closure: RestaurantClosure; reservations: number; google: 'made' | 'failed' | 'skipped' }

function rowsFromPreview(preview: RestaurantClosurePreview, known: RestaurantReservation[]): Row[] {
  return preview.reservations.map((r) => ({
    id: r.id, startsAt: r.startsAt, guestCount: r.guestCount, customerName: r.customerName, source: r.source,
    friendId: r.isLineFriend ? r.friendId : null,
    phone: r.customerPhone ?? known.find((k) => k.id === r.id)?.customer_phone ?? null,
    contacted: r.contacted === true,
  }))
}

function rowsFromLedger(rows: RestaurantReservation[]): Row[] {
  return rows.map((r) => ({ id: r.id, startsAt: r.starts_at, guestCount: r.guest_count, customerName: r.customer_name, source: r.source, friendId: null, phone: r.customer_phone, contacted: false }))
}

function saveMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'closure_overlap') return overlapMessage(conflictsOf(error.data))
    if (error.code === 'confirmation_changed') return '予約が変わりました。閉じて最新の予約を確認してください。'
    if (error.code === 'version_conflict') return 'ほかの人が先に変えました。閉じて、読み直してからもう一度変えてください。'
    if (error.status === 403) return permissionDeniedMessage('store')
  }
  return withPermissionFailure(error, describeSaveFailure(error), 'store')
}

export default function ClosureDialog({
  target, accountId, storeId, timezone, today, tables, reservations, media, canGoogle, onClose, onSaved,
}: {
  /** null のとき閉じている。 */
  target: ClosureDialogTarget | null
  accountId: string
  storeId: string
  timezone: string
  today: string
  tables: RestaurantTable[]
  /** 画面が読んだ予約（電話番号を出す・変える窓で重なる予約を数える）。 */
  reservations: RestaurantReservation[]
  /** 閉じる知らせを出す媒体（店が「予約が入ったら閉じる」を選んだ媒体）。 */
  media: Array<{ code: string; name: string }>
  /** Google の営業時間の案を作れる人（owner・admin）か。 */
  canGoogle: boolean
  onClose: () => void
  onSaved: (result: ClosureSaved) => void
}) {
  const saveErrors = useSaveFormErrors()
  const open = target !== null
  const editing = target?.mode === 'edit' ? target.closure : null
  const [input, setInput] = useState<RestaurantClosureInput>(() => emptyInput(storeId, today))
  const [pickTables, setPickTables] = useState(false)
  const [google, setGoogle] = useState(true)
  const [preview, setPreview] = useState<{ rows: Row[]; waitlist: number; contacted: number; overlap: string; snapshot?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const formRef = useRef<HTMLDivElement>(null)
  const [fieldErrors, setFieldErrors] = useState<{ start?: string; end?: string; time?: string; tables?: string }>({})

  const active = useMemo(() => tables.filter((t) => t.is_active), [tables])
  const seats = active.reduce((sum, t) => sum + t.max_capacity, 0)

  /* 開くたびに入力を作り直す（足す＝押した日、変える＝その記録）。 */
  useEffect(() => {
    if (!target) return
    const next = target.mode === 'edit' ? inputOf(target.closure) : emptyInput(storeId, target.day)
    setInput(next)
    setPickTables(next.tableIds !== undefined && next.tableIds.length > 0)
    setGoogle(target.mode === 'add')
    setPreview(null)
    setError(''); setFieldErrors({})
  }, [target, storeId])

  const problem = inputError(input, today)
  const partial = (input.tableIds ?? []).length > 0

  /*
   * 重なる予約。preview の口（電話番号・LINE の友だちか・連絡済みも返る）。
   * 変える窓は自分自身を除く（excludeId）。口が読めないときは画面が読んだ予約から数える。
   */
  useEffect(() => {
    if (!open || problem || !accountId) { seq.current += 1; setPreview(null); return }
    const id = ++seq.current
    const timer = setTimeout(() => {
      const fallback = () => rowsFromLedger(overlapping(input, reservations, timezone))
      void restaurantTestApi.previewClosure(accountId, editing ? { ...input, excludeId: editing.id } : input)
        .then((res) => {
          if (id !== seq.current) return
          const conflicts = res.data.conflicts ?? []
          setPreview({
            rows: rowsFromPreview(res.data, reservations), waitlist: res.data.waitlistCount, contacted: res.data.contactedCount ?? 0,
            overlap: conflicts.length > 0 ? overlapMessage(conflicts) : '', snapshot: res.data.confirmationSnapshot,
          })
        })
        .catch((caught) => {
          if (id !== seq.current) return
          const overlap = caught instanceof ApiError && caught.code === 'closure_overlap' ? overlapMessage(conflictsOf(caught.data)) : ''
          setPreview({ rows: fallback(), waitlist: 0, contacted: 0, overlap })
        })
    }, 300)
    return () => { clearTimeout(timer); if (seq.current === id) seq.current += 1 }
  }, [open, problem, accountId, input, editing, reservations, timezone])

  const set = (patch: Partial<RestaurantClosureInput>) => { seq.current += 1; setPreview(null); setInput((current) => ({ ...current, ...patch })); setError(''); setFieldErrors({}) }

  const save = async () => {
    const errors: typeof fieldErrors = {}
    if ((FIELD_REQUIREMENTS.input_startDate.check(input.startDate) !== null) || input.startDate < today) errors.start = problem
    else if ((FIELD_REQUIREMENTS.input_endDate.check(input.endDate) !== null) || input.endDate < input.startDate) errors.end = problem
    else if (problem) errors.time = problem
    if (pickTables && !partial) errors.tables = '閉じる卓を1つ以上選んでください。'
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => { const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]'); field?.focus(); field?.scrollIntoView?.({ block: 'center' }) })
      return
    }
    if (!preview?.snapshot) { setError('予約を確認できませんでした。読み直してからもう一度お試しください。'); return }
    setBusy(true); setError('')
    try {
      const body: RestaurantClosureInput = { ...input, tableIds: pickTables ? input.tableIds : [], memo: input.memo?.trim() || null, notifyMedia: input.notifyMedia !== false, expectedSnapshot: preview.snapshot }
      const res = editing
        ? await restaurantTestApi.updateClosure(accountId, editing.id, { ...body, expectedVersion: editing.version })
        : await restaurantTestApi.createClosure(accountId, body)
      const saved = res.data.closure
      let googleResult: ClosureSaved['google'] = 'skipped'
      if (google && canGoogle && !partial && !editing) {
        try {
          await restaurantGoogleApi.proposeClosureHours(accountId, saved.id, saved.version, saved.kind === 'private_event')
          googleResult = 'made'
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          googleResult = 'failed'
        }
      }
      onSaved({ closure: saved, reservations: res.data.reservations.length, google: googleResult })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(saveMessage(caught)) }
    } finally {
      setBusy(false)
    }
  }

  const days = input.startDate === input.endDate ? 'この日' : 'この期間'
  const rows = preview?.rows ?? []
  const mediaNames = media.map((m) => m.name).join('・')

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={open}
      designNode="nVvXy"
      designWidth={600}
      designHeaderPadding="20px 24px 0"
      footerAlign="center"
      title={editing ? '臨時休業・貸切を変える' : '臨時休業・貸切を足す'}
      description="閉じた日・時間帯は LINE から予約できなくなります"
      busy={busy}
      error={error || undefined}
      confirmLabel={editing ? '変更を保存' : days === 'この日' ? 'この日を閉じる' : 'この期間を閉じる'}
      onConfirm={() => save()}
      onCancel={onClose}
    >
      <div className={styles.form} ref={formRef}>
        <div className={styles.field}>
          <span className={styles.label} id="e10-kind">種類</span>
          <SaveErrorField names={["kind","input.kind","google"]}><SegmentedControl<RestaurantClosureKind>
            aria-label="種類"
            className={styles.kinds}
            options={KIND_ORDER.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))}
            value={input.kind}
            onChange={(kind) => { set({ kind }); if (!editing) setGoogle(kind !== 'private_event') }}
          /></SaveErrorField>
        </div>

        <div className={styles.dates}>
          <Field label="はじめの日" htmlFor="e10-start" error={fieldErrors.start} requirement={FIELD_REQUIREMENTS.input_startDate}>
            <SaveErrorField names={["startDate","input.startDate","start_date","input.start_date"]}><DateField
              id="e10-start"
              aria-label="はじめの日"
              invalid={Boolean(fieldErrors.start)}
              value={input.startDate}
              min={today}
              onChange={(value) => set({ startDate: value, endDate: input.endDate < value ? value : input.endDate })}
            /></SaveErrorField>
          </Field>
          <span className={styles.wave} aria-hidden="true">〜</span>
          <Field label="おわりの日" htmlFor="e10-end" error={fieldErrors.end} requirement={FIELD_REQUIREMENTS.input_endDate}>
            <SaveErrorField names={["endDate","input.endDate","end_date","input.end_date"]}><DateField id="e10-end" aria-label="おわりの日" invalid={Boolean(fieldErrors.end)} value={input.endDate} min={input.startDate || today} onChange={(value) => set({ endDate: value })} /></SaveErrorField>
          </Field>
        </div>

        <Field label="時間" error={fieldErrors.time}>
          <div role="radiogroup" aria-label="時間">
          <div className={styles.choices}>
            <SaveErrorField names={["e10-time","allDay","input.allDay"]}><Radio name="e10-time" checked={input.allDay} onChange={() => set({ allDay: true, startTime: null, endTime: null })}>終日</Radio></SaveErrorField>
            <SaveErrorField names={["e10-time"]}><Radio name="e10-time" checked={!input.allDay} onChange={() => set({ allDay: false, startTime: input.startTime ?? '18:00', endTime: input.endTime ?? '22:00' })}>
              時間帯だけ（例：18:00〜22:00）
            </Radio></SaveErrorField>
          </div>
          {!input.allDay ? (
            <div className={styles.times}>
              <SaveErrorField names={["startTime","input.startTime","start_time","input.start_time"]}><TimeField aria-label="閉じる時間の始まり" invalid={Boolean(fieldErrors.time)} minuteStep={30} size="field" value={input.startTime ?? ''} onChange={(value) => set({ startTime: value })} /></SaveErrorField>
              <span className={styles.wave} aria-hidden="true">〜</span>
              <SaveErrorField names={["endTime","input.endTime","end_time","input.end_time"]}><TimeField aria-label="閉じる時間の終わり" invalid={Boolean(fieldErrors.time)} allowEndOfDay minuteStep={30} size="field" value={input.endTime ?? ''} onChange={(value) => set({ endTime: value })} /></SaveErrorField>
            </div>
          ) : null}
          </div>
        </Field>

        <Field label="閉じる卓" error={fieldErrors.tables}>
          <div role="radiogroup" aria-label="閉じる卓" aria-invalid={Boolean(fieldErrors.tables)} tabIndex={-1}>
          <div className={styles.choices}>
            <SaveErrorField names={["e10-tables","pickTables"]}><Radio name="e10-tables" checked={!pickTables} onChange={() => { setPickTables(false); set({ tableIds: [] }) }}>
              {`全部の卓（${active.length}卓・${seats}席）`}
            </Radio></SaveErrorField>
            <SaveErrorField names={["e10-tables","pickTables"]}><Radio name="e10-tables" checked={pickTables} onChange={() => setPickTables(true)}>卓を選ぶ（貸切の一部など）</Radio></SaveErrorField>
          </div>
          {pickTables ? (
            <div className={styles.tablePicks}>
              {active.map((t, saveFieldIndex) => (
                <SaveErrorField names={[`active.${saveFieldIndex}.id`,"id","t.id"]} key={t.id}><Checkbox
                  key={t.id}
                  checked={(input.tableIds ?? []).includes(t.id)}
                  onCheckedChange={(on) => set({ tableIds: on ? [...(input.tableIds ?? []), t.id] : (input.tableIds ?? []).filter((id) => id !== t.id) })}
                >
                  {`${t.code}（${t.max_capacity}席）`}
                </Checkbox></SaveErrorField>
              ))}
            </div>
          ) : null}
          </div>
        </Field>

        <Field label="メモ"><SaveErrorField names={["memo","input.memo"]}><TextField value={input.memo ?? ''} maxLength={200} placeholder="例：設備点検のため" onChange={(event) => set({ memo: event.target.value })} /></SaveErrorField></Field>

        {problem ? null : preview === null ? (
          <p className={styles.hint} aria-live="polite">{`${days}の予約を調べています。`}</p>
        ) : (
          <>
            {preview.overlap ? (
              <p className={styles.overlap} role="alert">{preview.overlap}</p>
            ) : null}
            {rows.length > 0 ? (
              <div className={styles.affected} data-affected="">
                <p className={styles.affectedTitle}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  {`${days}の予約が ${formatNumber(rows.length)} 件あります（保存しても取り消しません${editing && preview.contacted > 0 ? `・連絡済み ${preview.contacted} 件` : ''}）`}
                </p>
                {rows.map((row) => (
                  <div key={row.id} className={styles.affectedRow}>
                    <span className={styles.affectedTime}>{input.startDate === input.endDate ? clock(row.startsAt, timezone) : `${dayShort(dayOfIso(row.startsAt, timezone))} ${clock(row.startsAt, timezone)}`}</span>
                    <span className={styles.affectedName} title={row.customerName}>{`${withHonorific(row.customerName, 'さま', { space: true })}・${row.guestCount}名`}</span>
                    <span className={styles.route}>{sourceLabel(row.source, media)}</span>
                    {row.contacted && row.friendId ? (
                      <Button variant="text" data-contacted="" href={`/chats?friend=${encodeURIComponent(row.friendId)}`}>連絡済み（会話を見る）</Button>
                    ) : row.friendId ? (
                      <Button href={`/chats?friend=${encodeURIComponent(row.friendId)}`}>LINE で連絡する</Button>
                    ) : (
                      <Button variant="text" href={`/restaurant-test/reservations?date=${dayOfIso(row.startsAt, timezone)}`}>
                        <Phone size={16} aria-hidden="true" />{row.phone ? `電話で連絡（${row.phone}）` : '電話で連絡（番号は予約台帳）'}
                      </Button>
                    )}
                  </div>
                ))}
                {preview.waitlist > 0 ? <p className={styles.hint}>{`キャンセル待ちの ${preview.waitlist} 件には、閉じた時間帯の空きを案内しません。`}</p> : null}
              </div>
            ) : (
              <p className={styles.hint}>{`${days}の予約はありません。`}</p>
            )}
          </>
        )}

        <div className={styles.field}>
          <span className={styles.label}>他の予約サイトと Google</span>
          <div className={styles.checks}>
            {media.length > 0 ? (
              <SaveErrorField names={["notifyMedia","input.notifyMedia","notify_media","input.notify_media"]}><Checkbox
                checked={input.notifyMedia !== false}
                onCheckedChange={(on) => set({ notifyMedia: on })}
                description={input.notifyMedia === false ? '知らせを出しません。他の予約サイトの枠は、それぞれの管理画面で閉じてください。' : undefined}
              >
                {`${mediaNames}に「閉じる知らせ」を出す（媒体ごとに［閉じた］を押す）`}
              </Checkbox></SaveErrorField>
            ) : (
              <p className={styles.hint}>閉じる知らせを出す予約サイトはありません（予約経路の連携で選べます）。</p>
            )}
            {canGoogle && !editing ? (
              <SaveErrorField names={["google"]}><Checkbox
                checked={google && !partial}
                disabled={partial}
                onCheckedChange={setGoogle}
                description={partial ? '卓を選んだ貸切は、Google では店全体の休みになるので案を作りません。' : undefined}
              >
                Google の営業時間にも臨時休業を入れる案を作る
              </Checkbox></SaveErrorField>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog></SaveErrorScope>
  )
}
