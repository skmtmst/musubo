'use client'

import { useId, type ReactNode } from 'react'
import InlineEdit, { type InlineEditProps } from './inline-edit'
import { useStaffRole } from '@/lib/staff-role'
import { lockReason, type PermissionLockKind } from './permission-lock'
import { formatNumber } from '@/lib/format'
import { isCountableValue } from './not-connected'
import styles from './detail-content.module.css'
import DetailActions, { hasDetailActions, type DetailActionsProps } from './detail-actions'

/** 詳細の本文。項目・区切りの見た目はここで持つ。 */
export function DetailContent({ children }: { children: ReactNode }) {
  return <div className={styles.content} data-detail-content>{children}</div>
}

/** 題付きのまとまり。カードの面を増やさず線で区切る。 */
export function DetailSection({ title, help, children, label }: { title?: ReactNode; help?: ReactNode; children: ReactNode; label?: string }) {
  const id = useId()
  return <section className={styles.section} aria-label={label} aria-labelledby={!label && title ? id : undefined}>
    {title ? <div className={styles.sectionHeading}><h3 id={id}>{title}</h3>{help}</div> : null}
    {children}
  </section>
}

/** 項目名と中身を縦に置く。中身の入力・コピーなどの動作は呼ぶ側に残す。 */
export function DetailField({ label, children, note, multiline }: { label: ReactNode; children: ReactNode; note?: ReactNode; multiline?: boolean }) {
  return <div className={styles.field} data-detail-field><div className={styles.label} data-detail-label>{label}</div><div className={styles.value} data-detail-value data-multiline={multiline || undefined}>{children}</div>{note ? <div className={styles.note}>{note}</div> : null}</div>
}

/** 既存の定義リストも、同じ項目名と中身の段で読む。 */
export function DetailFields({ children }: { children: ReactNode }) {
  return <dl className={styles.fields} data-detail-fields>{children}</dl>
}

/** 埋め込みの補助欄も、浮く詳細面と同じ題・本文・操作帯を使う。 */
export function DetailPreview({ title, description, children, actions, headerActions, titleActions, titleId }: { title: string; titleId?: string; description?: string; children: ReactNode; actions?: DetailActionsProps; headerActions?: ReactNode; titleActions?: ReactNode }) {
  return <section className={`${styles.preview} ${styles.surface}`} data-detail-preview aria-label={titleId ? undefined : title} aria-labelledby={titleId}>
    <header className={styles.previewHeader}><div className={styles.previewTitleRow}>{titleActions ? <div className={styles.previewTitleGroup}><h2 id={titleId} className={styles.title} title={title}>{title}</h2>{titleActions}</div> : <h2 id={titleId} className={styles.title} title={title}>{title}</h2>}{headerActions}</div>{description ? <div className={styles.summary}>{description}</div> : null}</header>
    <div className={styles.previewBody}><DetailContent>{children}</DetailContent></div>
    {hasDetailActions(actions) ? <footer className={styles.previewFooter}><DetailActions {...actions} /></footer> : null}
  </section>
}

/** 名前の編集は、権限が変わっても同じ入力を保ち、保存だけを止める。 */
export function DetailInlineEdit({ allowed, need = 'feature', ...props }: InlineEditProps & { allowed: boolean; need?: Exclude<PermissionLockKind, 'viewer'> }) {
  const role = useStaffRole()
  return <InlineEdit {...props} disabled={props.disabled || !allowed}
    lockedReason={!allowed && role !== null ? lockReason(false, need) : props.lockedReason}
    canSaveNow={() => allowed && (props.canSaveNow?.() ?? true)} />
}

/** 数の帯を詳細の項目へ移すときも、欠測・実0・範囲の扱いを保つ。 */
export function DetailNumber({ value, text, range, unit = '' }: { value?: number | null; text?: string; range?: { from?: number | null; to?: number | null }; unit?: string }) {
  if (text !== undefined) return <>{text}</>
  const known = range ? isCountableValue(range.from) && isCountableValue(range.to) : isCountableValue(value)
  const label = !known ? '—' : range ? `${formatNumber(range.from!)} → ${formatNumber(range.to!)}` : formatNumber(value!)
  return <>{label}{known && unit ? ` ${unit}` : ''}</>
}

/** 本文内の題も、同じ小さな見出しの段を使う。 */
export function DetailSectionTitle({ children }: { children: ReactNode }) {
  return <h3 className={styles.sectionTitle} title={typeof children === 'string' ? children : undefined}>{children}</h3>
}
