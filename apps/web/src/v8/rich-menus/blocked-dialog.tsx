'use client'

/*
 * ★V8 リッチメニュー「まだ消せません」の窓（Pencil ）。
 *
 * 共通の Dialog（q3DPdz：頭・中身・下を別の段、幅560）とは形が違う
 * （幅600・1枚の面に 題→説明→理由の行→ボタン を間14で積む・下に線なし）ため、
 * 面はここで組む。フォーカスの移動・Esc・背景を止めるのは共通の useOverlayFocus。
 */
import { type ReactNode } from 'react'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import styles from './blocked-dialog.module.css'

export type BlockedRow = {
  key: string
  text: string
  action: { label: string; onSelect: () => void } | null
}

export default function BlockedDeleteDialog({
  title,
  description,
  rows,
  busy,
  error,
  footer,
  onClose,
  children,
}: {
  title: string
  description: string
  rows: BlockedRow[]
  busy: boolean
  error: string | null
  footer: ReactNode
  onClose: () => void
  children?: ReactNode
}) {
  const handleClose = () => {
    if (busy) return
    return onClose()
  }

  return <Dialog open title={title} description={description} onCancel={handleClose} busy={busy} error={error ?? undefined}
    tone="destructive" confirmation designLayout="stacked" designWidth={480} designNode="yOyCg" footer={footer ? <DialogActions>{footer}</DialogActions> : undefined}>
    {children}
    <ol className={styles.rows}>{rows.map((row, index) => <li key={row.key} className={styles.row}>
      <span className={styles.rowText}>{`${index + 1} ${row.text}`}</span><span className={styles.spacer} aria-hidden="true" />
      {row.action ? <button type="button" className={styles.rowAction} onClick={() => {
        if (busy) return
        return row.action?.onSelect()
      }} disabled={busy}>{row.action.label}</button> : null}
    </li>)}</ol>
  </Dialog>
}
