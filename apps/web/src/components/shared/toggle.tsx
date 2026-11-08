'use client'

import { useId, type ReactNode } from 'react'
import { joinDescribedBy, useFieldContext } from './field-context'
import Button from './button'
import styles from './toggle.module.css'
import { usePermissionLockTip } from './permission-lock-tip'

/**
 * スイッチ。オン／オフを切り替える。
 *
 * `locked` は「消せない項目」。**オンのまま押せない**状態で描く。
 * オフに見せると、出ているのに消えていると読めてしまう。
 */
export default function Toggle({
  id,
  invalid,
  checked,
  locked,
  disabled,
  lockedReason,
  label,
  labelledBy,
  describedBy,
  onChange,
  className,
  size,
}: {
  id?: string
  invalid?: boolean
  checked: boolean
  size?: 'large' | 'restaurant'
  /** 消せない項目。オンのまま押せない。 */
  locked?: boolean
  /** 一時的に押せない（保存中など）。見た目のオン・オフはそのまま。 */
  disabled?: boolean
  /** 権限で使えない理由。保存中のdisabledや消せないlockedとは分ける。 */
  lockedReason?: string
  /** 読み上げ用の名前。何のスイッチかを必ず渡す。 */
  label: string
  labelledBy?: string
  describedBy?: string
  onChange?: (next: boolean) => void
  className?: string
}) {
  const field = useFieldContext()
  const bad = invalid || field?.invalid
  const on = locked || checked
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, joinDescribedBy(describedBy, field?.describedBy))
  return (<>
    <button
      ref={lock.ref}
      id={id ?? field?.controlId}
      aria-invalid={bad || undefined}
      aria-describedby={joinDescribedBy(describedBy, field?.describedBy)}
      style={bad ? { outline: '1px solid var(--color-danger)' } : undefined}
      type="button"
      role="switch"
      data-size={size}
      aria-checked={on}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-description={locked ? 'この設定はいつもオンで変更できません' : undefined}
      disabled={locked || disabled}
      onClick={onChange ? () => onChange(!checked) : undefined}
      {...lock.handlers}
      className={[styles.toggle, on && !locked && styles.on, locked && styles.locked, className]
        .filter(Boolean)
        .join(' ')}
    />
    {lock.node}
  </>)
}

/** 説明のある設定行。文字とスイッチの配置を全画面で共通にする。 */
export function ToggleField({ id: controlId, children, description, 'aria-label': label, title, className, ...props }: {
  id?: string
  children: ReactNode
  description?: ReactNode
  'aria-label'?: string
  title?: string
  className?: string
  checked: boolean
  size?: 'large' | 'restaurant'
  disabled?: boolean
  locked?: boolean
  lockedReason?: string
  invalid?: boolean
  onChange?: (next: boolean) => void
}) {
  const id = useId()
  const field = useFieldContext()
  const switchId = controlId ?? field?.controlId ?? `${id}-switch`
  const descriptionId = `${id}-description`
  return <span className={[styles.field, className].filter(Boolean).join(' ')} data-size={props.size} title={title}>
    <span className={styles.fieldBody}><label id={id} htmlFor={switchId}>{children}</label>{description ? <span id={descriptionId} className={styles.description}>{description}</span> : null}</span>
    <Toggle {...props} id={switchId} label={label ?? ''} labelledBy={label ? undefined : id} describedBy={description ? descriptionId : undefined} />
  </span>
}

/** まとまりの状態を件数で伝え、行ごとの設定を一括で切り替える。 */
export function ToggleGroupActions({ total, enabled, label, disabled, disabledReason = '変更を反映しています', lockedReason, onChange }: {
  total: number
  enabled: number
  label: string
  disabled?: boolean
  /** nullなら、本人未確認など入力以外のdisabled理由を表示しない。 */
  disabledReason?: string | null
  lockedReason?: string
  onChange: (next: boolean) => void
}) {
  const summaryId = useId()
  return <span role="group" aria-label={`${label}の一括設定`} aria-describedby={summaryId} className={styles.groupActions}>
    <span id={summaryId} className={styles.description}>{total} 件中 {enabled} 件オン</span>
    <Button variant="text" textTone="accent" disabled={disabled} disabledReason={disabledReason ?? undefined} lockedReason={lockedReason} aria-describedby={summaryId} aria-label={`${label}をすべてオン`} onClick={() => onChange(true)}>すべてオン</Button>
    <Button variant="text" textTone="accent" disabled={disabled} disabledReason={disabledReason ?? undefined} lockedReason={lockedReason} aria-describedby={summaryId} aria-label={`${label}をすべてオフ`} onClick={() => onChange(false)}>すべてオフ</Button>
  </span>
}
