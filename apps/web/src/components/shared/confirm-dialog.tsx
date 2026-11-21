'use client'

import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, Trash2, TriangleAlert } from 'lucide-react'
import Dialog from './dialog'
import { deleteConfirmationTitle, isDeleteConfirmation, normalizeDeleteTitle } from './delete-confirmation'
import { CONFIRM_WIDTH } from './destination-policy'
import { describeSaveFailure } from '@/lib/api'
import type { ConfirmedUndoHandle, ConfirmedUndoResult } from '@/lib/undoable'
import Button from './button'
import { notifyToast } from './toast'

interface ConfirmDialogBaseProps {
  open: boolean
  dirty?: boolean
  contentLayout?: 'form'
  title: string
  /** 削除の対象名。削除の題と実行ボタンの文言は共通部品が持つ。 */
  deleteName?: string
  description: string
  confirmLabel?: string
  confirmVariant?: 'danger'
  /** 実行中の文字。Buttonのbusyへ渡す。 */
  busyLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /**
   * 説明文を琥珀帯で囲む（ 送受信を止める）。
   * destructive（赤い題・ボタン）とは独立に使える。
   */
  warning?: boolean
  /**
   * 説明文を桃箱で囲む（ 解除。題は箱の外・説明だけ箱の中）。
   * destructive（赤い題・ボタン）とは独立に使える。
   */
  dangerBand?: boolean
  busy?: boolean
  error?: string
  /**
   * 押す前に読み合わせる中身。
   *
   * **確認は「はい／いいえ」だけでは足りないことがある。** 一斉配信の
   * 最終確認は、対象人数・配信日時・送る中身を並べてから決める
   * （設計 `FpgxH`）。`Dialog` はもともと受け取れるので、素通しにする。
   */
  children?: ReactNode
  /** 見出しの左に置く絵。危険な操作は警告、と一目で分かるようにする。 */
  titleIcon?: ReactNode | false
  /** 題と説明の左に置く、淡い色の丸に置く線のアイコン。 */
  headerIcon?: ReactNode
  /** 実行ボタンの中、文字の左に置く絵。 */
  confirmIcon?: ReactNode
  /** この確認画面に対応するPencilの実Node。 */
  designNode?: string
  /** ★V8：絵の窓の頭の余白（Dialog の designHeaderPadding と同じ）。渡さなければ今までどおり。 */
  designHeaderPadding?: string
  /** ★V8：絵の窓の頭の高さ px（Dialog の designHeaderHeight と同じ）。渡さなければ今までどおり。 */
  designHeaderHeight?: number
  /** ★V8：絵の窓の幅 px（Dialog の designWidth と同じ）。 */
  designLayout?: 'stacked'
  footerAlign?: 'center' | 'start'
  /** 下の帯の左に置く一言（例「閉じても送りません」）。 */
  footerLead?: ReactNode
  /** 絵で操作の間隔が指定されている窓だけに使う。 */
  designFooterGap?: number
  confirmFirst?: boolean
  size?: 'small' | 'medium' | 'large' | 'wide'
  designWidth?: number
  /** ★V8：絵の窓の上からの位置 px（Dialog の designTop と同じ）。 */
  designTop?: number
  /**
   * 主にする操作。`'cancel'` は取消（残る方）を主の緑にし、実行を枠線にする。
   * 未保存の離脱確認で使い、うっかり Enter や緑で入力が消える向きにしない。
   * 印も付けない（緑のチェックは「完了・成功」の意味のため）。
   */
  primaryAction?: 'confirm' | 'cancel'
  /**
   * `undefined` を渡すと**確認のボタンそのものが出ない**（`Dialog` の作り）。
   * 数えられていない人数のまま送らせない、といった止め方に使う。
   */
  /** 取消の結果。未指定なら確認の中身を保つ。 */
  onUndone?: () => void
  /** 実行ボタンを押せない形で出す（WEB228：確かめのチェックが入るまで）。 */
  confirmDisabled?: boolean
  confirmDisabledReason?: string
  /** 権限で使えない理由。Dialogの専用口へそのまま渡す。 */
  confirmLockedReason?: string
  actionWidthReserve?: 'states' | 'idle'
  guideSlot?: string
  confirmPlacement?: 'start'
  onCancel: () => void
}

type ConfirmDialogProps = ConfirmDialogBaseProps & (
  | {
      /** true / committedだけを完了にする。未指定なら従来どおり呼出側が閉じる。 */
      onSuccess: () => void
      onConfirm?: () => boolean | void | ConfirmedUndoResult | Promise<boolean | void | ConfirmedUndoResult>
      /** 窓内に取消を置き、送信と同じ期限を止める。成功/失敗の受取も必須。 */
      pendingUndo?: ConfirmedUndoHandle | null
    }
  | { onSuccess?: undefined; pendingUndo?: undefined; onConfirm?: () => void }
)

export { deleteConfirmationTitle, normalizeDeleteTitle } from './delete-confirmation'

/** ブラウザ標準 confirm の代わりに使う、管理画面共通の確認ダイアログ。 */
export default function ConfirmDialog({
  open,
  dirty,
  contentLayout,
  title,
  deleteName,
  description,
  confirmLabel = '実行する',
  confirmVariant,
  busyLabel = '処理中…',
  cancelLabel = 'キャンセル',
  destructive = false,
  warning = false,
  dangerBand = false,
  busy = false,
  error,
  children,
  titleIcon,
  headerIcon,
  confirmIcon,
  designNode,
  designHeaderPadding,
  designHeaderHeight,
  designWidth,
  size,
  designLayout,
  footerAlign,
  footerLead,
  designFooterGap,
  confirmFirst,
  designTop,
  primaryAction = 'confirm',
  onConfirm,
  onSuccess,
  onUndone,
  pendingUndo,
  confirmDisabled = false,
  confirmDisabledReason,
  confirmLockedReason,
  actionWidthReserve,
  guideSlot,
  confirmPlacement,
  onCancel,
}: ConfirmDialogProps) {
  const [executing, setExecuting] = useState(false)
  const [executionError, setExecutionError] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [undoReady, setUndoReady] = useState<ConfirmedUndoHandle | null>(null)
  const undoButtonRef = useRef<HTMLButtonElement>(null)
  const focusAfterUndo = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const lock = useRef(false)
  const executionGeneration = useRef(0)
  const managed = onSuccess !== undefined
  useEffect(() => {
    if (open || !managed) return
    executionGeneration.current += 1
    if (!lock.current) setExecuting(false)
    setExecutionError('')
    setAcknowledged(false)
  }, [open, managed])
  useEffect(() => () => { executionGeneration.current += 1 }, [])
  useEffect(() => {
    if (!pendingUndo || !open) { setUndoReady(null); return }
    let current = true
    setUndoReady(pendingUndo)
    const settled = () => {
      if (!current) return
      const undoButton = undoButtonRef.current
      if (undoButton && undoButton === document.activeElement) {
        focusAfterUndo.current = undoButton.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
      }
      setUndoReady(null)
    }
    void pendingUndo.undoWindowClosed.then(settled, settled)
    return () => {
      current = false
      pendingUndo.resume('pointer')
      pendingUndo.resume('focus')
    }
  }, [open, pendingUndo])
  useLayoutEffect(() => {
    if (undoReady || executing || busy || !focusAfterUndo.current) return
    const frame = focusAfterUndo.current
    focusAfterUndo.current = null
    const cancelAction = primaryAction === 'cancel' ? 'primary' : 'secondary'
    if (frame.isConnected) frame.querySelector<HTMLButtonElement>(`[data-dialog-action="${cancelAction}"]:not(:disabled)`)?.focus()
  }, [undoReady, executing, busy, primaryAction])
  const runConfirm = onConfirm ? () => {
    if (lock.current || busy || confirmLockedReason || confirmDisabled || (managed && acknowledged)) return
    lock.current = true
    setExecutionError('')
    const generation = executionGeneration.current
    const current = () => !managed || generation === executionGeneration.current
    const fallback = '実行できませんでした。もう一度お試しください。'
    const failed = (reason: unknown) => {
      if (current()) setExecutionError(managed ? describeSaveFailure(reason) : fallback)
      else if (managed && openRef.current) notifyToast(describeSaveFailure(reason), { tone: 'error' })
    }
    const complete = (result: unknown) => {
      if (!onSuccess) return
      const outcome = result && typeof result === 'object' && 'status' in result ? result as ConfirmedUndoResult : null
      if (!current()) {
        if (openRef.current && (result === true || outcome?.status === 'committed')) {
          notifyToast('前の操作を保存しました。表示を読み直してください。')
        } else if (openRef.current && (result === false || outcome?.status === 'failed')) {
          notifyToast(outcome?.status === 'failed' ? outcome.message ?? describeSaveFailure(outcome.error) : fallback, { tone: 'error' })
        }
        return
      }
      if (result === true || outcome?.status === 'committed') {
        setAcknowledged(true)
        try { onSuccess() }
        catch { notifyToast('保存しました。表示を読み直してください。', { tone: 'error' }) }
      } else if (outcome?.status === 'undone') {
        setExecutionError('')
        try { onUndone?.() }
        catch { notifyToast('取り消しました。表示を読み直してください。', { tone: 'error' }) }
      } else if (outcome?.status === 'failed') setExecutionError(outcome.message ?? describeSaveFailure(outcome.error))
      else if (result === false) setExecutionError(fallback)
    }
    try {
      const pending = onConfirm() as unknown
      if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
        setExecuting(true)
        return Promise.resolve(pending).then(complete).catch(failed).finally(() => {
          lock.current = false
          setExecuting(false)
        })
      }
      complete(pending)
    } catch (reason) {
      failed(reason)
    }
    lock.current = false
  } : undefined
  const undoHandle = undoReady === pendingUndo ? undoReady : null

  /*
   * 未保存の離脱確認（主が取消）は印を付けない。緑のチェックは
   * 「完了・成功」の意味なので、まだ何も済んでいない窓には出さない。
   * 危険な操作の警告印は従来どおり残す。
   */
  const shownTitleIcon = titleIcon === false ? undefined : titleIcon ?? (primaryAction === 'cancel'
    ? undefined
    : destructive
      ? <TriangleAlert size={20} />
      : <CircleCheck size={20} />)
  const shownConfirmIcon = confirmIcon ?? (destructive ? <Trash2 size={16} /> : undefined)

  const shownError = error || executionError
  return (
    <Dialog
      open={open}
      dirty={dirty}
      contentLayout={contentLayout}
      title={deleteName !== undefined ? deleteConfirmationTitle(deleteName) : isDeleteConfirmation(confirmLabel) ? normalizeDeleteTitle(title) : title}
      description={description}
      tone={destructive ? 'destructive' : 'default'}
      descriptionBand={dangerBand ? 'danger' : warning ? 'warning' : undefined}
      confirmLabel={deleteName !== undefined || isDeleteConfirmation(confirmLabel) ? '削除する' : confirmLabel}
      confirmVariant={confirmVariant}
      confirmRetry={managed && Boolean(executionError)}
      busyLabel={busyLabel}
      cancelLabel={cancelLabel}
      busy={busy || executing}
      confirmDisabled={confirmDisabled || (managed && acknowledged)}
      confirmDisabledReason={confirmDisabledReason}
      confirmLockedReason={confirmLockedReason}
      actionWidthReserve={actionWidthReserve}
      confirmPlacement={confirmPlacement}
      guideSlot={guideSlot}
      error={shownError}
      primaryAction={primaryAction}
      titleIcon={titleIcon !== undefined ? shownTitleIcon : undefined}
      headerIcon={headerIcon ?? (titleIcon === undefined ? shownTitleIcon ?? false : false)}
      confirmIcon={shownConfirmIcon}
      designNode={designNode}
      designHeaderPadding={designHeaderPadding}
      designHeaderHeight={designHeaderHeight}
      size={size}
      designWidth={designWidth ?? (size ? undefined : CONFIRM_WIDTH)}
      designLayout={designLayout}
      footerAlign={footerAlign}
      footerLead={undoHandle ? <Button ref={undoButtonRef} variant="text" size="inline" type="button" onClick={() => undoHandle.undo()}
        onPointerEnter={event => { if (event.pointerType !== 'touch') undoHandle.pause('pointer') }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') undoHandle.resume('pointer') }}
        onFocus={() => undoHandle.pause('focus')} onBlur={() => undoHandle.resume('focus')}>元に戻す</Button> : footerLead}
      designFooterGap={designFooterGap}
      confirmFirst={confirmFirst}
      designTop={designTop}
      confirmation
      compact={!children}
      onConfirm={runConfirm}
      onCancel={() => { if (!lock.current && !busy) onCancel() }}
    >
      {children}
    </Dialog>
  )
}
