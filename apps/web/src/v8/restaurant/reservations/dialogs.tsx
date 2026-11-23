'use client'
import { allergyValues, normalizePhone, phoneProblem, type RestaurantReservationAllergy } from '@line-crm/shared';
import ReservationAllergySelect from '@/components/shared/reservation-allergy-select'

import { datetimeLocalJstToUtcIso, jstDateTimeLocal, jstCalendar } from '@/lib/jst-datetime'


import { useEffect, useRef, useState } from 'react'
import { Check, Download } from 'lucide-react'
import { Field } from '@/components/shared/form-controls'
import { useFormErrors } from '@/lib/use-form-errors'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import DateTimeField from '@/components/shared/date-time-field'
import type { RestaurantMenuItem, RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { DialogNote, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { INACTIVE_STATUSES, hm, isHold, pad2 } from './format'
import styles from './reservations.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { formatYen as polishFormatYen } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { describeApiFailure } from '@/components/shared/api-error-message'
import EntitySelect from '@/components/shared/entity-select'
import { withHonorific } from '@line-crm/shared'
import type { ReservationEditSaveResult } from './edit-save-result'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

/*
 * ★V8 予約台帳の窓：予約の変更（取消・復活・押さえの解除もここ）・取消の確認・受信データの試し。
 * 送る形は今の画面（app/restaurant-test/v8/reservations.tsx）と同じ。
 */

function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return jstDateTimeLocal(date)
}

/** 「10/2（金）」の形（取消の確認の1行目）。 */
function monthDayWeek(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${jstCalendar(date).getUTCMonth() + 1}/${jstCalendar(date).getUTCDate()}（${'日月火水木金土'[jstCalendar(date).getUTCDay()]}）`
}

export type ReservationPatch = Record<string, unknown>

/** 閲覧のみ：選ぶ部品は置かず、選んでいる値を読み取りだけの欄で見せる（2026-10-06 オーナー決定）。 */
function ReadOnlyChoice({ label, value, options }: { label: string; value: string; options: Array<{ value: string; label: string }> }) {
  const shown = options.find((option) => option.value === value)?.label ?? value
  return <SaveErrorField names={["shown"]}><TextField aria-label={label} value={shown} readOnly aria-readonly="true" title={shown} /></SaveErrorField>
}

export function EditReservationDialog({ reservation, tables, courses, busy, canWrite, accountId, allergyAccountId, staffRole, onClose, onSave, onCancelReservation, onRestore, missing = false }: {
  reservation: RestaurantReservation | null
  missing?: boolean
  tables: RestaurantTable[]
  courses: RestaurantMenuItem[]
  busy: boolean
  canWrite: boolean
  accountId?: string | null
  allergyAccountId?: string | null
  staffRole?: string | null
  onClose: () => void
  onSave: (patch: ReservationPatch) => Promise<ReservationEditSaveResult> | void
  onCancelReservation: (id: string) => void
  onRestore: (id: string) => void
}) {
  const initialReservation = useRef<{ id: string; version: number } | null>(null)
  if (reservation && initialReservation.current?.id !== reservation.id) {
    initialReservation.current = { id: reservation.id, version: reservation.customer_version ?? 1 }
  }
  const changedElsewhere = missing || (!!reservation && !!initialReservation.current && (reservation.customer_version ?? 1) !== initialReservation.current.version)
  const [allergies, setAllergies] = useState<RestaurantReservationAllergy[]>([])
  const [draft, setDraft] = useState({ customerName: '', customerPhone: '', guestCount: '2', allergyNote: '', startsAt: '', endsAt: '', tableId: '', courseId: '' })
  useEffect(() => {
    if (!reservation || (reservation.customer_version ?? 1) !== initialReservation.current?.version) return
    setAllergies(reservation.allergies ?? allergyValues(reservation.allergy_note).map(value => ({ kind: 'other' as const, value })))
    setDraft({
      customerName: reservation.customer_name,
      customerPhone: reservation.customer_phone || '',
      guestCount: String(reservation.guest_count),
      allergyNote: reservation.allergy_note || '',
      startsAt: toLocalInput(reservation.starts_at),
      endsAt: toLocalInput(reservation.ends_at),
      tableId: reservation.table_id || '',
      courseId: reservation.course_id || '',
    })
  }, [reservation?.id])
  const fields = useSaveFormErrors()
  const [saveError, setSaveError] = useState<unknown>(null)
  const saving = useRef(false)
  const attempt = useRef(0)
  const currentInput = useRef({ draft, canWrite, busy, changedElsewhere, onSave })
  currentInput.current = { draft, canWrite, busy, changedElsewhere, onSave }
  useEffect(() => () => { attempt.current += 1 }, [])
  fields.define('name', 'お客様名', () => draft.customerName.trim() ? null : 'お客様名を入れてください。', { required: true })
  fields.define('phone', '電話番号', () => phoneProblem(draft.customerPhone) || null)
  fields.define('count', '人数', () => Number.isInteger(Number(draft.guestCount)) && Number(draft.guestCount) >= 1 && Number(draft.guestCount) <= 100 ? null : '人数は1〜100で入れてください。', { required: true })
  fields.define('start', '開始日時', () => Number.isFinite(Date.parse(draft.startsAt)) ? null : '開始日時を選んでください。', { required: true })
  fields.define('end', '終了日時', () => Number.isFinite(Date.parse(draft.endsAt)) && Date.parse(draft.endsAt) > Date.parse(draft.startsAt) ? null : '終了日時は開始日時より後にしてください。', { required: true })
  if (!reservation) return null
  const originalAllergies = reservation.allergies ?? allergyValues(reservation.allergy_note).map(value => ({ kind: 'other' as const, value }))
  const allergyChanged = JSON.stringify(allergies) !== JSON.stringify(originalAllergies)
  const hold = isHold(reservation)
  const inactive = INACTIVE_STATUSES.includes(reservation.status)
  const save = async () => {
    const { draft: input, canWrite: allowed, busy: working, changedElsewhere: stale, onSave: commit } = currentInput.current
    if (saving.current || working || !allowed || stale) return
    if (fields.submit().length > 0) {
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')
        target?.focus(); target?.scrollIntoView({ block: 'center' })
      })
      return
    }
    const ticket = ++attempt.current
    saving.current = true
    setSaveError(null)
    try {
      const result = await commit({
        expectedVersion: initialReservation.current?.version ?? 1,
        customerName: input.customerName,
        customerPhone: normalizePhone(input.customerPhone) || null,
        guestCount: Number(input.guestCount),
        startsAt: datetimeLocalJstToUtcIso(input.startsAt),
        endsAt: datetimeLocalJstToUtcIso(input.endsAt),
        tableId: input.tableId || null,
        courseId: input.courseId || null,
        ...(allergyChanged ? { allergies } : {}),
      })
      if (ticket === attempt.current && result?.inputError !== undefined && !fields.capture(result.inputError)) setSaveError(result.inputError)
    } catch (error) {
      if (ticket === attempt.current && !fields.capture(error)) setSaveError(error)
    } finally {
      if (ticket === attempt.current) saving.current = false
    }
  }
  const tableOptions = [
    { value: '', label: '未配席' },
    ...tables.filter((table) => table.is_active || table.id === reservation.table_id).map((table) => ({ value: table.id, label: `${table.code}・${table.label}` })),
  ]
  const courseOptions = [
    { value: '', label: '席のみ' },
    ...courses.filter((course) => course.status === 'active' || course.id === reservation.course_id).map((course) => ({ value: course.id, label: `${course.name} ${polishFormatYen(course.price)}` })),
  ]
  return (
    <SaveErrorScope errors={fields}><RsDialog
      noValidate
      open
      title={hold ? `押さえ（${hm(reservation.starts_at)}〜${hm(reservation.ends_at)}）` : `${withHonorific(reservation.customer_name)}の予約${canWrite ? 'を変更' : ''}`}
      width={600}
      top={120}
      busy={busy}
      extraDirty={allergyChanged}
      onCancel={onClose}
      onSubmit={canWrite && !hold ? save : undefined}
      actions={(
        <>
          {canWrite ? (
            hold ? (
              <Button type="button" variant="danger" className={styles.dialogLeft} disabled={busy || changedElsewhere} onClick={() => onCancelReservation(reservation.id)}>押さえを解除</Button>
            ) : inactive ? (
              <Button type="button" className={styles.dialogLeft} disabled={busy || changedElsewhere} onClick={() => onRestore(reservation.id)}>予約を有効に戻す</Button>
            ) : (
              <Button type="button" className={styles.dialogLeft} variant="danger-outline" disabled={busy || changedElsewhere} onClick={() => onCancelReservation(reservation.id)}>予約を取り消す</Button>
            )
          ) : null}
          <Button type="button" onClick={onClose} disabled={busy}>{canWrite && !hold ? 'キャンセル' : '閉じる'}</Button>
          {canWrite && !hold ? <Button type="submit" variant="primary" disabled={busy || changedElsewhere}><Check aria-hidden="true" />保存する</Button> : null}
        </>
      )}
    >
      {changedElsewhere ? <Notice tone="warn" role="alert" message={canWrite && !hold ? "別の操作で予約が変更されたか、一覧から移動しました。入力を控えてから閉じ、最新の予約を開き直してください。" : "別の操作で予約が変更されたか、一覧から移動しました。閉じて最新の予約を開き直してください。"} /> : null}
      {!changedElsewhere && saveError !== null ? <Notice tone="danger" role="alert" message={describeApiFailure(saveError, '保存')} /> : null}
      {hold ? (
        <DialogNote>{`${reservation.note || '仮押さえ'}・解除の期限 ${reservation.hold_expires_at ? hm(reservation.hold_expires_at) : emptyValue('unknown')}。期限を過ぎると空き卓に戻ります。台帳には履歴が残ります。`}</DialogNote>
      ) : (
        <>
          <div className={styles.pair}>
            <Field label="お客様名" htmlFor="rs-edit-name" error={fields.error('name')} requirement={fields.requirement('name')}>
              <SaveErrorField names={["customerName","draft.customerName","customer_name","draft.customer_name"]}><TextField id="rs-edit-name" invalid={fields.invalid('name')} required readOnly={!canWrite} value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} /></SaveErrorField>
            </Field>
            <Field label="電話番号" htmlFor="rs-edit-phone" error={fields.error('phone')}>
              <SaveErrorField names={["customerPhone","draft.customerPhone","customer_phone","draft.customer_phone"]}><TextField id="rs-edit-phone" invalid={fields.invalid('phone')} readOnly={!canWrite} value={draft.customerPhone} onChange={(event) => setDraft({ ...draft, customerPhone: event.target.value })} /></SaveErrorField>
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="人数" htmlFor="rs-edit-guests" error={fields.error('count')} requirement={fields.requirement('count')}>
              <SaveErrorField names={["guestCount","draft.guestCount","guest_count","draft.guest_count"]}><NumberInput id="rs-edit-guests" invalid={fields.invalid('count')} type="number" min={1} max={100} required readOnly={!canWrite} value={draft.guestCount} onChange={(event) => setDraft({ ...draft, guestCount: event.target.value })} /></SaveErrorField>
            </Field>
            <Field labelSize="compact" label="卓">
              {canWrite ? (
                <SaveErrorField names={["tableId","draft.tableId","table_id","draft.table_id"]}><EntitySelect aria-label="卓" size="full" value={draft.tableId} onChange={(value) => setDraft({ ...draft, tableId: value })} options={tableOptions} /></SaveErrorField>
              ) : <ReadOnlyChoice label="卓" value={draft.tableId} options={tableOptions} />}
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="開始日時" htmlFor="rs-edit-start" error={fields.error('start')} requirement={fields.requirement('start')}>
              <SaveErrorField names={["startsAt","draft.startsAt","starts_at","draft.starts_at"]}><DateTimeField id="rs-edit-start" invalid={fields.invalid('start')} required readOnly={!canWrite} value={draft.startsAt} onChange={(next) => setDraft({ ...draft, startsAt: next })} /></SaveErrorField>
            </Field>
            <Field label="終了日時" htmlFor="rs-edit-end" error={fields.error('end')} requirement={fields.requirement('end')}>
              <SaveErrorField names={["endsAt","draft.endsAt","ends_at","draft.ends_at"]}><DateTimeField id="rs-edit-end" invalid={fields.invalid('end')} required readOnly={!canWrite} value={draft.endsAt} onChange={(next) => setDraft({ ...draft, endsAt: next })} /></SaveErrorField>
            </Field>
          </div>
          <Field labelSize="compact" label="コース">
            {canWrite ? (
              <SaveErrorField names={["courseId","draft.courseId","course_id","draft.course_id"]}><EntitySelect aria-label="コース" size="full" value={draft.courseId} onChange={(value) => setDraft({ ...draft, courseId: value })} options={courseOptions} /></SaveErrorField>
            ) : <ReadOnlyChoice label="コース" value={draft.courseId} options={courseOptions} />}
          </Field>
          <ReservationAllergySelect accountId={allergyAccountId === undefined ? accountId : allergyAccountId} role={staffRole} values={allergies} onChange={setAllergies} disabled={!canWrite || busy} />
        </>
      )}
    </RsDialog></SaveErrorScope>
  )
}

export function CancelReservationDialog({ reservation, accountId, busy, onClose, onConfirm }: {
  reservation: RestaurantReservation | null
  accountId: string
  busy: boolean
  onClose: () => void
  onConfirm: (id: string) => void
}) {
  const hold = reservation ? isHold(reservation) : false
  return (
    <RsDialog
      noValidate
      open={Boolean(reservation)}
      title={hold ? 'この押さえを解除しますか？' : 'この予約を取り消しますか？'}
      width={480}
      top={300}
      busy={busy}
      onCancel={onClose}
      actions={(
        <>
          <Button onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button variant="danger" disabled={busy} onClick={() => { if (reservation) onConfirm(reservation.id) }}>{hold ? '解除する' : '取り消す'}</Button>
        </>
      )}
    >
      {reservation ? <OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: reservation.store_id, name: reservation.store_name }} /> : null}
      {reservation ? <p className={styles.dialogStrong}>{hold ? `押さえ ${hm(reservation.starts_at)}〜${hm(reservation.ends_at)}` : `${monthDayWeek(reservation.starts_at)} ${hm(reservation.starts_at)} ${withHonorific(reservation.customer_name)} ${reservation.guest_count}名`}</p> : null}
      <DialogNote>{hold ? '押さえを解除すると、その時間の卓は空きに戻ります。台帳には履歴が残ります。' : '台帳には取消として残ります。その時間帯の卓は空きに戻ります。取り消した予約は「復活」で戻せます。'}</DialogNote>
    </RsDialog>
  )
}

export function InboundTrialDialog({ open, busy, onClose, onSubmit }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (body: { provider: string; externalId: string; customerName: string; guestCount: number; startsAt: string }) => void
}) {
  const [draft, setDraft] = useState({ provider: 'restaurant_board', externalId: '', customerName: '', guestCount: '2', startsAt: '' })
  const fields = useFormErrors()
  fields.define('externalId', '外部予約ID', () => draft.externalId.trim() ? null : '外部予約IDを入れてください。', { required: true })
  fields.define('name', 'お客様名', () => draft.customerName.trim() ? null : 'お客様名を入れてください。', { required: true })
  fields.define('count', '人数', () => Number.isInteger(Number(draft.guestCount)) && Number(draft.guestCount) >= 1 && Number(draft.guestCount) <= 100 ? null : '人数は1〜100で入れてください。', { required: true })
  fields.define('start', '開始日時', () => Number.isFinite(Date.parse(draft.startsAt)) ? null : '開始日時を選んでください。', { required: true })
  useEffect(() => { if (open) setDraft({ provider: 'restaurant_board', externalId: `DEMO-${Date.now()}`, customerName: '', guestCount: '2', startsAt: '' }) }, [open])
  return (
    <RsDialog
      noValidate
      open={open}
      title="媒体受信シミュレーター（外部への書戻しなし）"
      width={560}
      top={160}
      busy={busy}
      designNode="l4qsT"
      onCancel={onClose}
      onSubmit={() => {
        if (fields.submit().length > 0) {
          requestAnimationFrame(() => {
            const target = document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')
            target?.focus(); target?.scrollIntoView({ block: 'center' })
          })
          return
        }
        onSubmit({ provider: draft.provider, externalId: draft.externalId, customerName: draft.customerName.trim(), guestCount: Number(draft.guestCount), startsAt: datetimeLocalJstToUtcIso(draft.startsAt) })
      }}
      actions={(
        <>
          <Button type="button" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={busy}><Download aria-hidden="true" />受信として取り込む</Button>
        </>
      )}
    >
      <Field labelSize="compact" label="受信元">
        <SaveErrorField names={["provider","draft.provider"]}><Select aria-label="受信元" size="full" value={draft.provider} onChange={(value) => setDraft({ ...draft, provider: value })} options={[
          { value: 'restaurant_board', label: 'レストランボード' },
          { value: 'hotpepper', label: 'Hot Pepper' },
          { value: 'tabelog', label: '食べログ' },
        ]} /></SaveErrorField>
      </Field>
      <Field label="外部予約ID" htmlFor="rs-trial-id" error={fields.error('externalId')} requirement={fields.requirement('externalId')}>
        <SaveErrorField names={["externalId","draft.externalId","external_id","draft.external_id"]}><TextField id="rs-trial-id" invalid={fields.invalid('externalId')} required value={draft.externalId} onChange={(event) => setDraft({ ...draft, externalId: event.target.value })} /></SaveErrorField>
      </Field>
      <div className={styles.pair}>
        <Field label="お客様名" htmlFor="rs-trial-name" error={fields.error('name')} requirement={fields.requirement('name')}>
          <SaveErrorField names={["customerName","draft.customerName","customer_name","draft.customer_name"]}><TextField id="rs-trial-name" invalid={fields.invalid('name')} required value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} /></SaveErrorField>
        </Field>
        <Field label="人数" htmlFor="rs-trial-guests" error={fields.error('count')} requirement={fields.requirement('count')}>
          <SaveErrorField names={["guestCount","draft.guestCount","guest_count","draft.guest_count"]}><NumberInput id="rs-trial-guests" invalid={fields.invalid('count')} type="number" min={1} max={100} required value={draft.guestCount} onChange={(event) => setDraft({ ...draft, guestCount: event.target.value })} /></SaveErrorField>
        </Field>
      </div>
      <Field label="開始日時" htmlFor="rs-trial-start" error={fields.error('start')} requirement={fields.requirement('start')}>
        <SaveErrorField names={["startsAt","draft.startsAt","starts_at","draft.starts_at"]}><DateTimeField id="rs-trial-start" invalid={fields.invalid('start')} required value={draft.startsAt} onChange={(next) => setDraft({ ...draft, startsAt: next })} /></SaveErrorField>
      </Field>
      <DialogNote>試した予約は台帳に入ります。予約サイトへは何も送りません。</DialogNote>
    </RsDialog>
  )
}
