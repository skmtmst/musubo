'use client'

import React, { useContext, useEffect, useLayoutEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelsTopLeft, X } from 'lucide-react'
import { OVERLAY_MODAL_OPEN_EVENT, OverlayDepthContext, useOverlayFocus, useOverlayLayer, useV8Leave } from './overlay-utils'
import styles from './drawer.module.css'
import detailStyles from './detail-content.module.css'
import DetailActions, { hasDetailActions, type DetailActionsProps } from './detail-actions'
import Dialog from './dialog'
import IconButton from './icon-button'
import { useFormInputDirty } from './form-input-dirty'
import { captureOverlayClose, useOverlayDiscard } from './overlay-discard'
import { drawerWidth } from './destination-policy'
import Notice from '@/components/shared/notice'

export type DrawerDetail = { label: string; value: ReactNode }

export type DrawerProps = {
  open: boolean
  title: string
  titleAccessory?: ReactNode
  /** 題と説明の左に置く、線のアイコン。false なら印を省く。 */
  headerIcon?: ReactNode
  closeAppearance?: 'box'
  description?: ReactNode
  contentSpacing?: 'sections'
  dirty?: boolean
  /** 未保存の確認を保ち、題の印だけ省く場合は false。 */
  showDirtyIndicator?: boolean
  busy?: boolean
  error?: string
  onClose: () => void
  children?: ReactNode
  details?: DrawerDetail[]
  footer?: ReactNode
  footerLayout?: 'actions'
  actions?: DetailActionsProps
  status?: ReactNode
  /** falseは参照画像と同じ面だけをページ内に描画する。 */
  modal?: boolean
  /**
   * 幅。省くと480。'narrow' は 480。
   * 'editor' は 540 の編集の引き出し（ダッシュボード編集 ：頭 16/20・閉じるは枠つき 30・
   * 中 12/20・下 14/20・開くのは 200ms）。v8 だけで効く。
   */
  width?: 'narrow' | 'editor' | 'order' | 'composer' | 'hours'
  /** V8は480・540の2段。旧指定は共通部品で段へそろえる。 */
  designWidth?: number
  /** 編集の引き出しを画面の下端まで伸ばす。省略時は内容の高さ。 */
  heightMode?: 'content' | 'viewport'
  /** 狭い画面でも外側の余白を保つ。 */
  viewportInset?: boolean
  /** 620幅の紹介者の板など、全体に同じ余白がある型。 */
  layout?: 'inset'
  /** 題に状態の札を添える板。閉じる操作は共通のまま。 */
  heading?: ReactNode
  /** 頭の題の行の下に置くもの（タブ・説明の1行）。渡したときだけ頭を縦に積む。 */
  toolbar?: ReactNode
  /** 下の帯（footer）のすぐ上に置く知らせ（保存の失敗など）。中身の帯は呼び出し側の Notice。 */
  band?: ReactNode
  /**
   * 開いたときに寄せる先。'panel' は面そのもの（輪を出さない）。題がその場で直せる板で、
   * 開いただけで題に輪が出て編集の入口に見えるのを避ける。Tab で先頭の操作へ進める。
   */
  guideSlot?: string
  initialFocus?: 'panel'
}

/** Pencil V5 `VJKAT` を正本にした右詳細パネル。 */
export default function Drawer({
  open,
  title,
  titleAccessory,
  headerIcon = <PanelsTopLeft />,
  closeAppearance,
  description,
  contentSpacing,
  dirty,
  showDirtyIndicator = true,
  busy = false,
  error,
  onClose,
  children,
  details,
  footer,
  footerLayout,
  actions,
  status,
  modal = true,
  width,
  designWidth,
  viewportInset,
  heightMode,
  layout,
  heading,
  toolbar,
  band,
  initialFocus,
  guideSlot,
}: DrawerProps) {
  const formInput = useFormInputDirty(open)
  const isDirty = dirty ?? formInput.dirty
  const discard = useOverlayDiscard(open, isDirty, busy, onClose)
  const depth = useContext(OverlayDepthContext)
  const titleId = useId()
  const descriptionId = useId()
  const [mounted, setMounted] = useState(false)
  const panelRef: React.RefObject<HTMLElement | null> = useOverlayFocus<HTMLElement>(open && modal, discard.requestClose, busy, initialFocus === 'panel' ? (): HTMLElement | null => panelRef.current : undefined)
  const layer = useOverlayLayer(open && modal)
  useLayoutEffect(() => {
    if (open && modal) document.dispatchEvent(new Event(OVERLAY_MODAL_OPEN_EVENT))
  }, [open, modal])
  /* ★V8 仕上げ（M10）：閉じるときは逆再生してから外す（v8 のみ）。 */
  const leaving = useV8Leave(open)

  useEffect(() => setMounted(true), [])
  if (!open && !leaving) return null

  const titleBlock = (
    <div className={styles.heading}>
      <div className={styles.headingText}>
        <div className={titleAccessory ? styles.titleRow : undefined}><h2 id={titleId} title={title} className={`${styles.title} ${detailStyles.title} ${modal ? '' : styles.inlineTitle}`}>{headerIcon ? <span className={styles.headerIcon} aria-hidden="true">{headerIcon}</span> : null}<span className={styles.titleText} data-detail-title-text>{heading ?? title}</span>{isDirty && showDirtyIndicator ? <span aria-label="未保存"> *</span> : null}</h2>{titleAccessory}</div>
        {actions !== undefined || status !== undefined || footerLayout === 'actions' ? (status || description ? <div className={detailStyles.summary}>{status}{description ? typeof description === 'string' ? <span id={descriptionId} className={detailStyles.summaryText} title={description}>{description}</span> : <div id={descriptionId}>{description}</div> : null}</div> : null) : description ? <p id={descriptionId} className={styles.description}>{description}</p> : null}
      </div>
    </div>
  )
  const closeButton = closeAppearance === 'box' ? <IconButton data-close-control="" variant="plain" className={styles.close} onClick={discard.requestClose} disabled={busy} aria-label="閉じる"><X aria-hidden="true" size={20} /></IconButton> : <button data-close-control="" type="button" className={styles.close} onClick={discard.requestClose} disabled={busy} aria-label="閉じる"><X aria-hidden="true" size={20} /></button>

  const panel = (
    <aside
      ref={(element) => { panelRef.current = element; formInput.ref.current = element }}
      onChangeCapture={formInput.onChangeCapture}
      onInputCapture={formInput.onChangeCapture} onInput={formInput.onChange} onChange={formInput.onChange}
      onClickCapture={(event) => { formInput.onClickCapture(event); captureOverlayClose(event, isDirty || busy, discard.requestClose) }}
      className={`${styles.panel} ${detailStyles.surface} ${modal ? '' : styles.inline}`}
      role="dialog"
      aria-modal={modal || undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      data-dirty={isDirty || undefined}
      data-width={width}
      data-layout={layout}
      data-design-width=""
      data-height-mode={heightMode}
      data-viewport-inset={viewportInset || undefined}
      style={{ '--drawer-design-width': `${width === 'composer' ? 1160 : width === 'hours' ? 520 : width === 'editor' ? 540 : drawerWidth(designWidth ?? (width === 'order' ? 540 : 480))}px` } as CSSProperties}
      tabIndex={-1}
      data-initial-focus={initialFocus}
      data-closing={leaving || undefined}
      data-design-part="drawer"
      data-design-node="VJKAT"
    >
      {toolbar ? (
        <header className={`${styles.header} ${styles.headerStack}`}>
          <div className={styles.headerRow}>
            {titleBlock}
            {closeButton}
          </div>
          {toolbar}
        </header>
      ) : (
        <header className={`${styles.header} ${modal ? '' : styles.inlineHeader}`}>
          {titleBlock}
          {closeButton}
        </header>
      )}
      <div className={`${styles.body} ${modal ? '' : styles.inlineBody}`} data-window-body data-content-spacing={contentSpacing}>
        {details ? <dl className={styles.rows}>{details.map((detail) => <div className={styles.row} key={detail.label}><dt>{detail.label}</dt><dd className={styles.rowValue}>{detail.value}</dd></div>)}</dl> : children}
      </div>
      {error ? <Notice tone="danger" role="alert">
        {error}
      </Notice> : null}
      {band ? <div className={styles.band}>{band}</div> : null}
      {open && guideSlot ? <div data-guide-slot={guideSlot} style={{ display: 'contents' }} /> : null}
      {hasDetailActions(actions) ? <footer className={styles.actionFooter} data-window-actions><DetailActions {...actions} /></footer> : actions ? null : footer ? <footer className={footerLayout === 'actions' ? styles.actionFooter : styles.footer} data-window-actions>{footer}</footer> : null}
    </aside>
  )
  const discardDialog = discard.confirming ? <Dialog open title="入力を破棄しますか？" description="保存していない入力が消えます。" primaryAction="cancel" cancelLabel="編集を続ける" confirmLabel="破棄する" onCancel={discard.continueEditing} onConfirm={discard.discard} busy={busy} confirmation compact /> : null
  if (!modal) return <OverlayDepthContext.Provider value={depth + 1}>{panel}{discardDialog}</OverlayDepthContext.Provider>
  const overlay = <div className={styles.overlay} data-width={width} role="presentation" data-closing={leaving || undefined} style={{ zIndex: layer }} onMouseDown={(event) => {
    if (!busy && event.target === event.currentTarget) discard.requestClose()
  }}>{panel}</div>
  return <OverlayDepthContext.Provider value={depth + 1}>{discardDialog}{mounted && typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay}</OverlayDepthContext.Provider>
}
