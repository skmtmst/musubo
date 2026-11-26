'use client'

import { isDeleteConfirmation, normalizeDeleteTitle } from './delete-confirmation'
import React, { useContext, useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, PanelsTopLeft, X } from 'lucide-react'
import Button from './button'
import IconButton from './icon-button'
import { OVERLAY_MODAL_OPEN_EVENT, OverlayDepthContext, useOverlayFocus, useOverlayLayer, useV8Leave } from './overlay-utils'
import styles from './dialog.module.css'
import { useFormInputDirty } from './form-input-dirty'
import { captureOverlayClose, useOverlayDiscard } from './overlay-discard'
import { useStepMotion } from './use-step-motion'
import { dialogWidth } from './destination-policy'
import Notice from '@/components/shared/notice'
import { useDialogActionWidth } from './use-dialog-action-width'

export type DialogProps = {
  open: boolean
  contentLayout?: 'form'
  /** V8 の幅。管理画面 の寸法は維持する。 */
  size?: 'small' | 'medium' | 'large' | 'wide'
  /**
   * ★V8：480・560・720・960の4段。旧指定は共通部品で段へそろえる。
   * 渡さなければ size の幅のまま。互換経路では効かない。
   */
  /** 頭・説明・本文・操作を同じ余白で積む小窓（ 等）。 */
  designLayout?: 'stacked' | 'stacked-centered' | 'stacked-guided' | 'stacked-picker' | 'fullscreen'
  /** 確認のボタンを先に置く板だけで指定する。 */
  confirmFirst?: boolean
  designWidth?: number
  /** 承認済みの個別デザインで正確な幅が必要な窓だけ、段への丸めを省く。 */
  exactDesignWidth?: boolean
  /** 承認済みの個別デザインで指定された高さ。短い画面では画面内に収める。 */
  designMinHeight?: number
  /** の共通選択窓だけ640pxの幅を使う。 */
  widthPreset?: 'picker'
  /** ★V8：絵の窓の上からの位置（px）。渡すと上寄せにする。渡さなければ今までどおり。互換経路では効かない。 */
  designTop?: number
  /** 指定した上位置を含めて窓を画面内に収め、本文だけをスクロールする。 */
  fitViewport?: boolean
  /**
   * ★V8：絵の窓の頭（題と×の行）の余白。CSS の padding と同じ書き方（例 `'20px 20px 0'`）。
   * 小窓だけの絵（・・ など）は頭が今の共通の値（上20・左右24・下8）より
   * 詰まっているので、絵の値を画面から渡す。渡さなければ今までどおり。互換経路では効かない。
   * 読み方：~/lh-work/design/v8/html/<板>.html の窓（角丸16px の箱）の padding が上と左右、
   * 窓の gap が頭と次の段の間。
   */
  designHeaderPadding?: string
  /** ★V8：絵の窓の頭の高さ（px）。渡すと頭の行をこの高さに固定する。渡さなければ中身なり。互換経路では効かない。 */
  designHeaderHeight?: number
  /** 頭の×の左に置く操作（選ぶ窓の「＋タグを作る」など）。 */
  headerAction?: ReactNode
  /** 既定は窓の形で決まる。ガイドの窓にも閉じる操作が必要なら true。 */
  showCloseButton?: boolean
  /** ガイドなどで、通常時の閉じるボタンの枠を省く。 */
  plainCloseButton?: boolean
  /** 題と説明の左に置く、線のアイコン。false なら印を省く。 */
  headerIcon?: ReactNode
  /** 指定した窓だけ本文の余白を変える（フォルダ付きの選択窓など）。 */
  designContentPadding?: string
  /** 指定した窓だけ下の操作段の余白を変える。 */
  designFooterPadding?: string
  /** 本文と操作が続く窓では区切り線を省く。既定は線あり。 */
  footerDivider?: boolean
  /** 左の操作で残り幅を埋めるか。既定は埋める。 */
  footerLeadFlexible?: boolean
  /** 題の隣の補足。ほかの窓の題の並びは変えない。 */
  titleHelp?: ReactNode
  /** 題の下に小さく置く補足（絵の窓の頭が題＋1行のとき）。渡さないときは今までどおり出ない。 */
  titleNote?: ReactNode
  /*
   * ★V8：題の段の形を絵の値にする。渡さない窓は今までどおり（上そろえ・間8・太さ600）。
   * `'mark'`：絵（dgeTy・XCVGd）の確認の窓のように、左の丸い印と題を縦の中央でそろえ、
   * 間を 12 にして題を 18/700 にする。
   */
  designTitleRow?: 'mark'
  /** 段の帯を使わず続ける窓、またはアカウントの窓の余白。既定の窓は変えない。 */
  layout?: 'continuous' | 'account-inset' | 'inset'
  /** 手順や表示の切り替えの帯。本文のスクロールから独立させる。 */
  steps?: ReactNode
  /** 手順の本文を閉じずに切り替える鍵。StepsのcurrentKeyは自動で読む。 */
  stepKey?: string | number
  /** 操作の左に出す現在の手順など。 */
  footerLead?: ReactNode
  title: string
  /** 題の文字列と読み上げを保ったまま、省略などの表示を指定する。 */
  titleContent?: ReactNode
  description?: string
  tone?: 'default' | 'destructive'
  /**
   * 説明文を帯で囲む。'warning' は琥珀帯（ 送受信を止める）。
   * 'danger' は桃箱（ 解除。題は箱の外・説明だけ箱の中）。
   * tone（題・ボタンの色）とは独立。渡さなければ帯なし。
   */
  descriptionBand?: 'warning' | 'danger'
  /** 入力の誤りがある欄など、開いた窓のフォーカス先。省けば従来どおり。 */
  initialFocusId?: string
  dirty?: boolean
  busy?: boolean
  /** 実行ボタンを押せない形で出す（確かめのチェックが入るまで、など）。処理中の busy とは別。 */
  confirmDisabled?: boolean
  confirmDisabledReason?: string
  /** 権限不足はTabで止まれるボタンと吹き出しにする。 */
  confirmLockedReason?: string
  actionWidthReserve?: 'states' | 'idle'
  guideSlot?: string
  /** 広い画面用の案内を本文に置く場合、フッター側は狭い画面だけで使う。 */
  guideSlotNarrow?: boolean
  confirmPlacement?: 'start'
  error?: string
  confirmLabel?: string
  confirmVariant?: 'danger'
  /** 再試行中も元の操作の意味と色を保ち、表示だけを変える。既定は今までどおり。 */
  confirmRetry?: boolean
  /** 実行中の文字。Buttonのbusyへ渡す。 */
  busyLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  onCancel: () => void
  children?: ReactNode
  footer?: ReactNode
  /**
   * 見出しの左に置く絵。渡さなければ今までどおり何も足さない。
   * 危険な操作の確認で「これは戻せない」を一目で分かるようにするため。
   */
  titleIcon?: ReactNode
  /** 実行ボタンの中、文字の左に置く絵。処理中は文字だけにする。 */
  confirmIcon?: ReactNode
  /** 参照画像の固定比較やページ内プレビューで、背景を付けず面だけ表示する。 */
  modal?: boolean
  /** 画面固有のPencil Node。未指定なら共通部品のNodeだけを持つ。 */
  designNode?: string
  /** ConfirmDialog の構造。重要操作でも説明を赤帯へ入れない。 */
  confirmation?: boolean
  /** 見た目を変えず、重要操作の読み上げの役割を保つ。 */
  role?: 'dialog' | 'alertdialog'
  /** 本文を持たない短い確認窓。 */
  compact?: boolean
  /**
   * 主にする操作。`'confirm'`（既定）は実行が主、`'cancel'` は取消が主。
   * 未保存の離脱確認のように「残る方」を主の緑にし、離れる方を枠線にするとき
   * `'cancel'` を渡す。×と背景は取消と同じ動きのまま変えない。
   */
  primaryAction?: 'confirm' | 'cancel'
  /** ★V8：下のボタンの並び。省くと今までどおり右寄せ。'center' は中央（E-3 ウォークイン ）。互換経路では効かない。 */
  footerAlign?: 'center' | 'start'
  /** 絵で操作の間隔が指定されている窓だけに使う。 */
  designFooterGap?: number
}

/** Pencil 管理画面 `J6x4Q` と重要操作 `H2S1T4` を1つにした共通ダイアログ。 */
export default function Dialog({
  open,
  contentLayout,
  size = 'medium',
  designWidth,
  exactDesignWidth = false,
  designMinHeight,
  widthPreset,
  designLayout,
  confirmFirst,
  designTop,
  fitViewport = true,
  designHeaderPadding,
  designHeaderHeight,
  headerAction,
  showCloseButton,
  plainCloseButton = false,
  headerIcon,
  designContentPadding,
  designFooterPadding,
  footerDivider = true,
  footerLeadFlexible = true,
  titleHelp,
  titleNote,
  designTitleRow,
  layout,
  steps,
  stepKey,
  footerLead,
  title,
  titleContent,
  description,
  tone = 'default',
  descriptionBand,
  dirty,
  busy: providedBusy,
  initialFocusId,
  error,
  confirmLabel = '保存する',
  confirmVariant,
  confirmRetry = false,
  busyLabel = '処理中…',
  cancelLabel = 'キャンセル',
  confirmDisabled = false,
  confirmDisabledReason,
  confirmLockedReason,
  actionWidthReserve,
  guideSlot,
  guideSlotNarrow,
  confirmPlacement,
  onConfirm,
  onCancel,
  children,
  footer,
  titleIcon,
  confirmIcon,
  modal = true,
  designNode,
  confirmation = false,
  role: suppliedRole,
  compact = false,
  primaryAction = 'confirm',
  footerAlign,
  designFooterGap,
}: DialogProps) {
  const [automaticBusy, setAutomaticBusy] = useState(false)
  const [automaticError, setAutomaticError] = useState('')
  const automaticLock = useRef(false)
  const automaticGeneration = useRef(0)
  useEffect(() => {
    if (open) return
    automaticGeneration.current += 1
    automaticLock.current = false
    setAutomaticBusy(false)
    setAutomaticError('')
  }, [open])
  const busy = providedBusy === true || automaticBusy
  const runConfirm = onConfirm ? () => {
    if (busy || confirmDisabled || confirmLockedReason || automaticLock.current) return
    setAutomaticError('')
    let pending: unknown
    try { pending = onConfirm() }
    catch { setAutomaticError('実行できませんでした。もう一度お試しください。'); return }
    if (!pending || typeof (pending as PromiseLike<unknown>).then !== 'function') return
    const generation = automaticGeneration.current
    automaticLock.current = true
    setAutomaticBusy(true)
    setAutomaticError('')
    return Promise.resolve(pending).catch(() => {
      if (generation === automaticGeneration.current) setAutomaticError('実行できませんでした。もう一度お試しください。')
    }).finally(() => {
      if (generation !== automaticGeneration.current) return
      automaticLock.current = false
      setAutomaticBusy(false)
    })
  } : undefined
  const formInput = useFormInputDirty(open)
  const isDirty = dirty ?? (confirmation ? false : formInput.dirty)
  const discard = useOverlayDiscard(open, isDirty, busy, onCancel)
  const depth = useContext(OverlayDepthContext)
  const titleId = useId()
  const descriptionId = useId()
  const [mounted, setMounted] = useState(false)
  const motion = useStepMotion(Boolean(steps) && open && mounted, stepKey ?? (React.isValidElement<{ currentKey?: string | number }>(steps) ? steps.props.currentKey : undefined))
  /* ★V8 仕上げ（M10）：閉じるときは逆再生してから外す（v8 のみ）。 */
  const leaving = useV8Leave(open)
  // フォーカス制御はportalの準備後に開始し、イベント時のrefを読む。
  const cancelRef = useRef<HTMLButtonElement>(null)
  const panelRef = useOverlayFocus(
    open && modal && mounted,
    discard.requestClose,
    busy,
    // 主が取消の窓は、開いた直後の標的を主のボタンへ寄せる。Enter を押しても
    // 残る方が動く向きにする（×と背景は従来どおり取消）。
    initialFocusId ? () => document.getElementById(initialFocusId)
      : primaryAction === 'cancel' ? () => cancelRef.current : undefined,
  )
  const layer = useOverlayLayer(open && modal)
  useLayoutEffect(() => {
    if (!open || !modal) return
    document.dispatchEvent(new Event(OVERLAY_MODAL_OPEN_EVENT))
  }, [open, modal])
  const fullscreen = designLayout === 'fullscreen'
  const shortConfirmation = confirmation && !children && !steps
  const confirmationSizeClass = confirmation && compact
    ? tone === 'destructive'
      ? styles.destructiveConfirmation
      : styles.compactConfirmation
    : ''

  // 最初の描画前にportalへ移す。利用者が触れた入力DOMは入れ替えない。
  useLayoutEffect(() => setMounted(true), [])
  if (!open && !leaving) return null

  const shownHeaderIcon = headerIcon ?? (!titleIcon && !designHeaderHeight ? <PanelsTopLeft /> : null)
  const titleNode = (
    <h2 id={titleId} className={`${styles.title} ${tone === 'destructive' ? styles.destructiveTitle : styles.standardTitle}`} data-has-heading-icon={Boolean(titleIcon || shownHeaderIcon) || undefined}>
      {titleIcon || shownHeaderIcon ? <span className={styles.headerIcon} aria-hidden="true">{titleIcon || shownHeaderIcon}</span> : null}
      <span>{titleContent ?? (typeof title === 'string' && tone === 'destructive' && isDeleteConfirmation(confirmLabel) ? normalizeDeleteTitle(title) : title)}</span>
    </h2>
  )
  /*  解除の桃箱は「題は箱の外・説明だけ箱の中」のため、題と説明を分けておく。
     かけらは描画に出ない（囲み要素なし）。渡さないときは h2 そのまま。 */
  const titlePart = titleHelp ? <div className={styles.titleRow}>{titleNode}{titleHelp}</div> : titleNode
  const descriptionNode = description ? <p id={descriptionId} className={styles.description}>{description}</p> : null
  const heading = (
    <>
      {/* 絵が無いときは今までどおり h2 を直接置く。囲むと既存の余白が動く。 */}
      {titlePart}
      {titleNote ? <p className={styles.titleNote}>{titleNote}</p> : null}
      {designLayout || descriptionBand === 'danger' ? null : descriptionNode}
    </>
  )
  const panel = (
    <div
      ref={(element) => { panelRef.current = element; formInput.ref.current = element }}
      onChangeCapture={formInput.onChangeCapture}
      onInputCapture={formInput.onChangeCapture} onInput={formInput.onChange} onChange={formInput.onChange}
      onClickCapture={(event) => { formInput.onClickCapture(event); captureOverlayClose(event, isDirty || busy, discard.requestClose) }}
      className={`${styles.panel} ${styles.standardPanel} ${confirmation ? styles.confirmationPanel : ''} ${confirmationSizeClass}`}
      role={suppliedRole ?? (tone === 'destructive' ? 'alertdialog' : 'dialog')}
      aria-modal={modal || undefined}
      aria-label={fullscreen ? title : undefined}
      aria-labelledby={fullscreen ? undefined : titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      tabIndex={-1}
      data-title-content={titleContent != null || undefined}
      data-closing={leaving || undefined}
      data-size={size}
      data-design-layout={designLayout}
      data-plain-close={plainCloseButton || undefined}
      data-confirm-first={confirmFirst || undefined}
      data-confirm-placement={confirmPlacement}
      data-layout={layout}
      data-description-band={descriptionBand}
      data-footer-align={footerAlign}
      data-design-footer-gap={designFooterGap !== undefined || undefined}
      data-confirmation={shortConfirmation ? 'compact' : undefined}
      data-footer-divider={shortConfirmation || !footerDivider ? 'none' : undefined}
      data-footer-lead={footerLeadFlexible ? undefined : 'fixed'}
      data-design-width=""
      data-design-min-height={designMinHeight ? '' : undefined}
      data-design-header-padding={designHeaderPadding ? '' : undefined}
      data-design-header-height={designHeaderHeight ? '' : undefined}
      data-design-content-padding={designContentPadding ? '' : undefined}
      data-design-title-row={designTitleRow}
      style={({
        ...(designFooterGap !== undefined ? { '--dialog-footer-gap': `${designFooterGap}px` } : {}),
        '--dialog-design-width': `${widthPreset === 'picker' ? 640 : exactDesignWidth && designWidth ? designWidth : dialogWidth((designWidth === 600 ? 560 : designWidth === 844 ? 720 : designWidth) ?? ({ small: 480, medium: 560, large: 720, wide: 960 } as const)[size])}px`,
        ...(designMinHeight ? { '--dialog-design-min-height': `${designMinHeight}px` } : {}),
        ...(designHeaderPadding ? { '--dialog-design-header-padding': designHeaderPadding } : {}),
        ...(designHeaderHeight ? { '--dialog-design-header-height': `${designHeaderHeight}px` } : {}),
        ...(designContentPadding ? { '--dialog-design-content-padding': designContentPadding } : {}),
        ...(designFooterPadding ? { '--dialog-design-footer-padding': designFooterPadding } : {}),
      } as CSSProperties)}
      data-design-part="dialog"
      data-design-node={tone === 'destructive' ? 'H2S1T4' : 'J6x4Q'}
    >
      {fullscreen ? null : (
        <div className={styles.headerRow}>
          <div className={styles.headerContent}>
            {descriptionBand === 'danger' ? heading : (tone === 'destructive' && !confirmation) || descriptionBand === 'warning' ? <Notice tone={descriptionBand === 'warning' ? 'warn' : 'danger'} statusWord={false} icon={null} role="presentation" data-qa-dialog-callout>{heading}</Notice> : heading}
          </div>
          {headerAction ? <div className={styles.headerAction}>{headerAction}</div> : null}
          {/* 窓の形に応じて閉じる操作を表示する。 */}
          {(showCloseButton ?? (designLayout !== 'stacked-centered' && designLayout !== 'stacked-guided' && designLayout !== 'stacked-picker')) ? (
            <IconButton data-close-control="" variant="plain" aria-label="閉じる" title="閉じる" className={styles.close} onClick={discard.requestClose} disabled={busy}>
              <X aria-hidden="true" size={20} />
            </IconButton>
          ) : null}
        </div>
      )}
      {descriptionBand === 'danger' && description ? <div className={styles.descriptionBand}><Notice tone="danger" statusWord={false} data-qa-dialog-callout>{descriptionNode}</Notice></div> : designLayout ? descriptionNode : null}
      {steps ? <div className={styles.steps}>{steps}</div> : null}
      {children ? <div className={styles.content} data-window-body data-dialog-content data-content-layout={contentLayout} ref={motion.outerRef}>{steps ? <div ref={motion.innerRef} data-step-content>{children}</div> : children}</div> : null}
      {error || automaticError ? <Notice tone="danger" role="alert">
        {error || automaticError}
      </Notice> : null}
      {open && guideSlot ? <div data-guide-slot={guideSlot} data-guide-narrow={guideSlotNarrow || undefined} style={{ display: 'contents' }} /> : null}
      <div className={styles.footer} data-window-actions>
      {footer != null ? (layout === 'account-inset' ? <div className={styles.insetActions}>{footer}</div> : footer) : (onConfirm ? (
        /*
         * 実行・取消は共通Buttonの役割（primary/danger/secondary）をそのまま
         * 使う（#976 U077/U083/U084）。ここで赤や緑を自前で持つと、コントラストが
         * 画面ごとにずれる。横幅の指定だけ `.designButton` で足す。
         * 実行ボタンの無い参照窓では「キャンセル」を出さない。閉じ方は右上の×
         * に一本化する（UI-25）。
         */
        <div className={styles.actions} data-dialog-actions data-dialog-action-pair>
          {footerLead ? <span className={styles.footerLead}>{footerLead}</span> : null}
          <span className={styles.buttonPair}>
            <Button
              data-dialog-action={primaryAction === 'cancel' ? 'primary' : 'secondary'}
              variant={primaryAction === 'cancel' ? 'primary' : undefined}
              className={styles.designButton}
              widthReserve={actionWidthReserve}
              ref={primaryAction === 'cancel' ? cancelRef : undefined}
              onClick={discard.requestClose}
              disabled={busy}
            >
              {cancelLabel}
            </Button>
            <Button
              actionWording
              data-guide-anchor={guideSlot}
              data-guide-action-label={guideSlot ? confirmLabel : undefined}
              data-dialog-action={confirmVariant === 'danger' || tone === 'destructive' ? 'danger' : primaryAction === 'cancel' ? 'secondary' : 'primary'}
              variant={confirmVariant ?? (tone === 'destructive' ? 'danger' : primaryAction === 'cancel' ? 'secondary' : 'primary')}
              className={styles.designButton}
              widthReserve={actionWidthReserve}
              onClick={runConfirm}
              disabled={busy || confirmDisabled} aria-description={confirmDisabled && !confirmLockedReason ? confirmDisabledReason : undefined} lockedReason={confirmLockedReason} busy={busy} busyLabel={busyLabel}>
              {!busy && !confirmRetry && confirmIcon && !isDeleteConfirmation(confirmLabel) ? <span className={styles.buttonIcon} aria-hidden="true">{confirmIcon}</span> : null}
              {confirmRetry ? 'もう一度' : tone === 'destructive' && isDeleteConfirmation(confirmLabel) ? '削除する' : confirmLabel}
            </Button>
          </span>
          {confirmDisabled && !busy && !confirmLockedReason && confirmDisabledReason ? <p className={styles.confirmReason} role="status">{confirmDisabledReason}</p> : null}
        </div>
      ) : null)}
      </div>
    </div>
  )

  const discardDialog = discard.confirming ? <Dialog open={discard.confirming} title="入力を破棄しますか？" description="保存していない入力が消えます。" primaryAction="cancel" cancelLabel="編集を続ける" confirmLabel="破棄する" onCancel={discard.continueEditing} onConfirm={discard.discard} busy={busy} confirmation compact /> : null
  if (!modal) return <OverlayDepthContext.Provider value={depth + 1}>{panel}{discardDialog}</OverlayDepthContext.Provider>
  const overlay = (
    <div className={`${styles.overlay} ${confirmation ? styles.confirmationOverlay : ''}`} role="presentation" data-closing={leaving || undefined} data-design-node={designNode} data-design-layout={designLayout} data-viewport-fit={fitViewport || undefined} data-design-top={designTop ? '' : undefined} style={{ zIndex: layer, ...(designTop ? ({ '--dialog-design-top': `${designTop}px` } as CSSProperties) : null) }} onMouseDown={(event) => {
      if (!busy && event.target === event.currentTarget) discard.requestClose()
    }}>
      {panel}
    </div>
  )
  return <OverlayDepthContext.Provider value={depth + 1}>{discardDialog}{mounted && typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay}</OverlayDepthContext.Provider>
}

/** q3DPdz の手順。済みは戻れるボタン、現在は aria-current で伝える。 */
export function DialogSteps({ steps }: { steps: Array<{ label: string; done?: boolean; current?: boolean; onSelect?: () => void }> }) {
  return <nav aria-label="手順" className={styles.stepItems}>
    {steps.map((step, index) => <React.Fragment key={step.label}>
      {index > 0 ? <span className={styles.stepLine} aria-hidden="true" /> : null}
      <button type="button" className={styles.stepItem} onClick={step.onSelect} disabled={!step.onSelect} aria-current={step.current ? 'step' : undefined}>
        <span className={`${styles.stepCircle} ${step.done ? styles.stepDone : step.current ? styles.stepCurrent : ''}`}>
          {step.done ? <Check size={16} aria-hidden="true" /> : index + 1}
        </span>
        <span>{step.label}</span>
      </button>
    </React.Fragment>)}
  </nav>
}

/** 自前の処理でも、下の操作の余白と配置は窓の共通部品が持つ。 */
export function DialogActions({ children, leadingAction, align, layout, padding, note, summary }: { children: ReactNode; leadingAction?: ReactNode; align?: 'center'; layout?: 'inline'; padding?: 'none'; note?: ReactNode; summary?: ReactNode }) {
  const centered = align === 'center' || leadingAction !== undefined
  const hasSummary = summary != null
  const ref = useDialogActionWidth()
  return <div ref={ref} className={styles.actions} data-dialog-actions data-dialog-action-pair={centered || undefined} data-dialog-action-summary={hasSummary || undefined} data-action-layout={layout} data-padding={padding}>
    {hasSummary ? <div role="status">{summary}</div> : null}
    {leadingAction ? <span data-dialog-action-leading className={centered ? styles.actionStart : styles.actionLead}>{typeof leadingAction === 'string' ? <span className={styles.footerLead}>{leadingAction}</span> : leadingAction}</span> : null}
    {centered || hasSummary ? <span className={styles.buttonPair}>{children}</span> : children}
    {note !== undefined ? <span className={styles.actionNote} role="status">{note}</span> : null}
  </div>
}
