'use client'

import { useId } from 'react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Field, FieldError } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import NumberField from '@/components/shared/number-field'
import type { RestaurantInventoryAllocationWrite } from '@/lib/restaurant-test-api'
import type { Alloc } from './stock-types'
import styles from './inventory.module.css'

const fields = [
  ['ota', '予約サイト（グルメサイト）'],
  ['line', 'LINEで受ける席数'],
  ['walkin', '当日（ウォークイン）'],
] as const
const dialogFields = [fields[1], fields[0], fields[2]]

export function remainingSeats(totalSeats: number, allocation: Alloc): number {
  return totalSeats - allocation.ota - allocation.line - allocation.walkin
}

export function validAllocation(totalSeats: number, allocation: Alloc): boolean {
  return Object.values(allocation).every(value => Number.isInteger(value) && value >= 0)
    && remainingSeats(totalSeats, allocation) >= 0
}

export function StandardAllocationCard({ allocation, totalSeats, canEdit, lockedReason, onEdit }: {
  allocation: Alloc | null
  totalSeats: number
  canEdit: boolean
  lockedReason?: string
  onEdit: () => void
}) {
  return (
    <Card layout="vertical" padding="spacious" gap="tight" aria-labelledby="rs-alloc-title">
      <div className={styles.allocationCardHead}>
        <CardHeader size="stacked" titleId="rs-alloc-title" title="営業日の基本配分" meta="受付期間内の営業日の全時間帯に適用します。" />
        <span className={styles.allocationTotal}>1枠の総数 {totalSeats}席</span>
      </div>
      <dl className={styles.allocationSummary}>
        {fields.map(([key, label]) => <div key={key} className={styles.allocationMetric}>
          <dt>{key === 'line' ? 'LINE' : label}</dt>
          <dd>{allocation ? `${allocation[key]}席` : '未設定'}</dd>
        </div>)}
        <div className={styles.allocationMetric}>
          <dt>電話・店頭の取り置き</dt>
          <dd>{allocation ? `${Math.max(0, remainingSeats(totalSeats, allocation))}席` : '—'}</dd>
        </div>
      </dl>
      <div className={styles.allocationSummaryActions}>
        <p className={styles.note}>選んだ日や時間帯の調整は、下の在庫表から行えます。</p>
        <Button lockedReason={lockedReason} disabled={!canEdit} onClick={onEdit}>基本配分をまとめて{allocation ? '変更' : '設定'}</Button>
      </div>
    </Card>
  )
}

export function GuideAllocationCard({ value, onChange, allocation, totalSeats, activeTableCount, valid, disabled, error, onReload, hoursLink }: {
  value: string
  onChange: (value: string) => void
  allocation: Alloc
  totalSeats: number
  activeTableCount: number
  valid: boolean
  disabled: boolean
  error: string
  onReload?: () => void
  hoursLink?: string
}) {
  const label = 'LINEで受ける席数（各枠）'
  const max = Math.max(0, totalSeats - allocation.ota - allocation.walkin)
  return (
    <Card layout="vertical" padding="spacious" gap="tight" aria-labelledby="rs-alloc-title">
      <CardHeader size="stacked" titleId="rs-alloc-title" title="席と枠の配分（卓とつながる）" />
      <div className={styles.totalLine}>
        <div className={styles.totalText}>
          <p className={styles.totalValue}>1つの時間帯の総数 {totalSeats}席</p>
          <p className={styles.totalSub}>有効な卓 {activeTableCount}卓</p>
        </div>
        <Button variant="text" size="inline" href="/restaurant-test/tables">座席・卓管理で変更する →</Button>
      </div>
      <div className={styles.allocationFields}>
        <Field label={label} optional={false} labelWrap>
          <NumberField aria-label={label} min={1} max={max} disabled={disabled} invalid={value !== '' && !valid}
            value={value} placeholder="例：4" unit="席" note={false} onChange={event => onChange(event.currentTarget.value)}
            data-guide-anchor={hoursLink ? undefined : 'reception.lineSeats'} />
        </Field>
        <div className={styles.allocField}>
          <span className={styles.allocLabel}>電話・店頭の取り置き</span>
          <span className={styles.remainder}>{value && valid ? `${remainingSeats(totalSeats, allocation)}席` : '—'}</span>
        </div>
      </div>
      {value && !valid && !disabled ? <p className={styles.noteInvalid}>1〜{max}席で入力してください。</p> : null}
      <p className={styles.note}>{hoursLink ? '営業日の各枠に適用するため、先に営業時間を設定します。'
        : '予約受付期間内の営業日の全時間帯に適用します。これから受付が始まる日にも自動で適用します。'}</p>
      {hoursLink ? <Button href={hoursLink} data-guide-anchor="reception.lineSeats" data-guide-hours-setup>営業時間を設定する</Button> : null}
      {error ? <Notice tone="danger" action={onReload ? <Button onClick={onReload}>最新の配分を確認する</Button> : undefined}>{error}</Notice> : null}
    </Card>
  )
}

export function AllocationDialog({ scope, dateLabel, time, allocation, totalSeats, busy, error, reload, canRestore, restoreLabel, onChange, onClose, onSave, onRestore }: {
  scope: RestaurantInventoryAllocationWrite['scope']
  dateLabel: string
  time?: string
  allocation: Alloc
  totalSeats: number
  busy: boolean
  error: string
  reload?: () => void
  canRestore: boolean
  restoreLabel: string
  onChange: (allocation: Alloc) => void
  onClose: () => void
  onSave: () => void
  onRestore: () => void
}) {
  const title = scope === 'standard' ? '営業日の基本配分を変更' : scope === 'day' ? 'この日の配分を変更' : `${time}の配分を変更`
  const description = scope === 'standard'
    ? '予約受付期間内の営業日の各枠に適用します。個別に設定した日や時間帯はそのままです。'
    : scope === 'day' ? `${dateLabel}の各枠に適用します。個別に変更した時間帯の配分はそのままです。`
      : `${dateLabel} ${time}の枠に適用します。`
  const label = scope === 'standard' ? '基本配分を保存' : scope === 'day' ? 'この日だけ保存' : 'この時間帯だけ保存'
  const valid = validAllocation(totalSeats, allocation)
  const allocationErrorId = useId()
  return (
    <Dialog open title={title} description={description} designWidth={560} designLayout="stacked" designMinHeight={407} onCancel={onClose} busy={busy}
      footer={<DialogActions align="center" layout="inline">
        <Button disabled={busy} onClick={onClose}>キャンセル</Button>
        <Button variant="primary" disabled={!valid || Boolean(reload)} busy={busy} onClick={onSave}>{label}</Button>
      </DialogActions>}>
      <div className={styles.allocationDialogBody}>
        <div className={styles.totalLine}><p className={styles.totalValue}>1枠の総数 {totalSeats}席</p></div>
        <div className={styles.allocationFields}>
          {dialogFields.map(([key, label]) => <Field key={key} label={label} optional={false} labelWrap>
            <NumberField aria-label={label} min={0} max={totalSeats} value={String(allocation[key])} unit="席" note={false}
              aria-describedby={valid ? undefined : allocationErrorId}
              invalid={!valid} disabled={busy} onChange={event => onChange({ ...allocation, [key]: Number(event.currentTarget.value) })} />
          </Field>)}
          <div className={styles.allocField}>
            <span className={styles.allocLabel}>電話・店頭の取り置き</span>
            <span className={styles.remainder}>{valid ? `${remainingSeats(totalSeats, allocation)}席` : '—'}</span>
          </div>
        </div>
        <FieldError id={allocationErrorId}>{!valid ? `各項目に0以上の整数を入力し、合計を${totalSeats}席以内にしてください。` : null}</FieldError>
        {scope === 'standard' ? <p className={styles.note}>予約サイトの配分はmusubo内で管理します。</p> : null}
        {canRestore ? <Button variant="text" disabled={busy || Boolean(reload)} onClick={onRestore}>{restoreLabel}</Button> : null}
        {error ? <Notice tone="danger" action={reload ? <Button onClick={reload}>最新の配分を確認する</Button> : undefined}>{error}</Notice> : null}
      </div>
    </Dialog>
  )
}
