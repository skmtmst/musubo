'use client'

/* 本文と下の操作は共通Dialogへ渡す。 */
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { type ReactNode } from 'react'

/** 窓の大きさと上からの位置（絵ごと）。値は globals.css の `--tpl-hb-dialog-*`。 */
export type BannerDialogKind = 'create' | 'upload' | 'confirm' | 'detail' | 'reference'

export default function BannerDialogFrame({
  open,
  kind,
  title,
  description,
  onClose,
  busy = false,
  error,
  actions,
  actionsAlign = 'center',
  designNode,
  role = 'dialog',
  contentLayout,
  children,
}: {
  open: boolean
  kind: BannerDialogKind
  title: string
  description?: ReactNode
  onClose: () => void
  busy?: boolean
  error?: string
  /** 区切り線の下のボタン。渡さなければ線も出さない。 */
  actions?: ReactNode
  /** ボタンの並び。絵は真ん中（確かめる窓・作る窓）か、左と右に分ける（画像の詳細）。 */
  actionsAlign?: 'center' | 'split'
  designNode: string
  /** 危ない操作の確かめは alertdialog。 */
  role?: 'dialog' | 'alertdialog'
  contentLayout?: 'form'
  children?: ReactNode
}) {
  // 絵 ：取り込む窓も作る窓と同じ囲み（幅 560・説明は題の下の小さい文）。
  const inset = kind === 'create' || kind === 'confirm' || kind === 'detail' || kind === 'upload' || kind === 'reference'
  return <Dialog open={open} title={title} description={inset && typeof description === 'string' ? description : undefined} onCancel={onClose} busy={busy} error={error} designNode={designNode}
    tone={role === 'alertdialog' ? 'destructive' : 'default'} confirmation contentLayout={contentLayout} layout={inset ? 'inset' : undefined} footer={actions ? <DialogActions>{actions}</DialogActions> : undefined} footerAlign={actionsAlign === 'center' ? 'center' : 'start'}
    designWidth={kind === 'confirm' ? 480 : kind === 'detail' ? 960 : 560} designTop={kind === 'reference' ? 16 : undefined} fitViewport={kind === 'reference' || undefined}>
    {description && (!inset || typeof description !== 'string') ? <p className="text-body">{description}</p> : null}{children}
  </Dialog>
}
