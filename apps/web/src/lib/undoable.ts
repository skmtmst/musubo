'use client'

import { notifyToast } from '@/components/shared/toast'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { ApiError } from '@/lib/api'

/* 軽い操作はすぐ保存し、失敗時は表示を戻す。確認中の操作は窓で結果を管理する。 */

/** 「元に戻す」の猶予（toast の UNDO_DURATION と揃える）。 */
const UNDO_WINDOW_MS = 5000

type Commit = () => Promise<{ success: boolean; error?: string } | void> | void

/** 確認中の操作は窓で結果を待ち、通常の操作はすぐ保存する。 */
export type ConfirmedUndoResult = { status: 'committed' | 'undone' } | { status: 'failed'; error: unknown; message?: string }
export type ConfirmedUndoHandle = {
  finished: Promise<ConfirmedUndoResult>
  /** 取消または送信開始で決着する。送信中の取消操作を残さない。 */
  undoWindowClosed: Promise<void>
  undo: () => void
  pause: (reason: 'pointer' | 'focus') => void
  resume: (reason: 'pointer' | 'focus') => void
}

type UndoableOptions = {
  message: string
  commit: Commit
  undo: () => void
  /** commit が失敗したときの画面の復元。省略すると undo を呼ぶ。 */
  onCommitError?: () => void
  /** 失敗の知らせの文面。 */
  failureMessage?: string
  /** commit が通ったあとに呼ぶ（一覧の読み直しなど）。 */
  onCommitted?: () => void
}

export function runUndoable(options: UndoableOptions & { confirmation: true }): ConfirmedUndoHandle
export function runUndoable(options: UndoableOptions): void
export function runUndoable(options: UndoableOptions & { confirmation?: boolean }): ConfirmedUndoHandle | void {
  if (!options.confirmation) {
    void Promise.resolve().then(() => options.commit()).then((res) => {
      if (res && res.success === false) throw new Error(res.error ?? '')
      notifyToast(options.message)
      void Promise.resolve().then(() => options.onCommitted?.()).catch(() => {
        notifyToast('保存しました。表示を読み直してください。', { tone: 'error' })
      })
    }).catch(() => {
      ;(options.onCommitError ?? options.undo)()
      notifyToast(options.failureMessage ?? 'できませんでした。もう一度お試しください。', { tone: 'error' })
    })
    return
  }
  let finish: ((result: ConfirmedUndoResult) => void) | undefined
  const finished = options.confirmation ? new Promise<ConfirmedUndoResult>(resolve => { finish = resolve }) : undefined
  let closeUndoWindow: (() => void) | undefined
  const undoWindowClosed = options.confirmation ? new Promise<void>(resolve => { closeUndoWindow = resolve }) : undefined
  /*
   * 送信期限は知らせの期限と一つのもの（R623）。知らせの hover/focus で
   * 止まったら送信も止まり、離したら一緒に動く。期限が来る・戻すの
   * どちらかが先に決まったら `settled` になり、遅れた方は何もしない。
   * 送信を始めたあとの取り消しは画面だけ戻さない。
   */
  let settled = false
  let remaining = UNDO_WINDOW_MS
  let deadline = Date.now() + remaining
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = () => {
    if (settled) return
    settled = true
    closeUndoWindow?.()
    timer = null
    // 期限が来たら知らせを消す。残った取り消し操作は効かない。
    dismiss()
    void Promise.resolve()
      .then(() => options.commit())
      .then((res) => {
        if (res && res.success === false) throw new Error(res.error ?? '')
        if (options.confirmation) {
          // 保存の返事と読み直しの失敗を分け、保存済みの操作を再送しない。
          finish?.({ status: 'committed' })
          void Promise.resolve().then(() => options.onCommitted?.()).catch(() => {
            notifyToast('保存しました。表示を読み直してください。', { tone: 'error' })
          })
        } else options.onCommitted?.()
      })
      .catch((error: unknown) => {
        if (!options.confirmation) {
          ;(options.onCommitError ?? options.undo)()
          notifyToast(options.failureMessage ?? 'できませんでした。もう一度お試しください。', { tone: 'error' })
          return
        }
        try { (options.onCommitError ?? options.undo)() }
        catch { /* 保存の失敗を保ち、表示の復元が失敗しても窓の鍵を外す。 */ }
        finally { finish?.({ status: 'failed', error, message: options.failureMessage }) }
      })
  }
  const arm = (ms: number) => {
    deadline = Date.now() + ms
    timer = setTimeout(fire, ms)
  }
  const pauseCommit = () => {
    if (settled || timer === null) return
    clearTimeout(timer)
    timer = null
    remaining = Math.max(0, deadline - Date.now())
  }
  const resumeCommit = () => {
    if (settled || timer !== null) return
    arm(remaining)
  }
  arm(remaining)

  const undo = () => {
    if (settled) return
    settled = true
    closeUndoWindow?.()
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!options.confirmation) { options.undo(); return }
    try { options.undo() }
    catch (error) {
      notifyToast('操作は取り消しました。表示を読み直してください。', { tone: 'error' })
    } finally { finish?.({ status: 'undone' }) }
  }
  const dismiss = () => {}
  if (finished && undoWindowClosed) {
    const holds = new Set<'pointer' | 'focus'>()
    return {
      finished, undoWindowClosed, undo,
      pause: reason => { holds.add(reason); pauseCommit() },
      resume: reason => { holds.delete(reason); if (!holds.size) resumeCommit() },
    }
  }

}

/**
 * 軽い操作を「押した瞬間」に画面へ反映し、裏で保存する（★管理画面 sTJsh §1）。
 *
 * `apply` で先に画面を変えてから呼ぶ。`request` が失敗したら `revert`
 * で戻し、「もう一度」で同じ操作をやり直せる知らせを出す。
 * 保存できたときは何も出さない（静かに終わる）。
 */
export function runOptimistic(options: {
  isCurrent?: () => boolean
  request: Commit
  revert: () => void
  /** 失敗の知らせの文面（例「タグを付けられませんでした」）。 */
  failureMessage: string
  /** 「もう一度」のやり直し。省略すると失敗の知らせは文だけ。 */
  retry?: () => void
  /** 保存が通ったあとに呼ぶ（一覧の読み直しなど）。 */
  onSuccess?: () => void
}): void {
  void Promise.resolve()
    .then(() => options.request())
    .then((res) => {
      if (options.isCurrent?.() === false) return
      if (res && res.success === false) throw new Error(res.error ?? '')
      options.onSuccess?.()
    })
    .catch(() => {
      if (options.isCurrent?.() === false) return
      options.revert()
      notifyToast(options.failureMessage, {
        tone: 'error',
        actionLabel: options.retry ? 'もう一度' : undefined,
        onAction: options.retry ? () => { if (options.isCurrent?.() !== false) options.retry?.() } : undefined,
      })
    })
}

/** 失敗の理由（口が返した日本語）。機械の文（API error: 500 など）・空は出さない。 */
const failureReason = (error: unknown): string => japaneseDetailOf(error)

/** 先に表示を変えた操作を保存し、失敗時は表示と再試行を提供する。 */
export function runOptimisticWithUndo(options: {
  request: Commit
  /** 対象や同じ項目の後続操作が変わったら、表示・再試行・取り消しを失効させる。 */
  isCurrent?: () => boolean
  revert: () => void
  /** 成功の知らせ（例「対応状況を対応中にしました」）。 */
  successMessage: string
  /** 失敗の知らせの頭（例「対応状況を変えられませんでした。」）。後ろに理由が付く。 */
  failureMessage: string
  retry: () => void
  /** 元に戻すときに送る。省略すると［元に戻す］を出さない。 */
  undoRequest?: Commit
  /** 元に戻したあと、もう一度戻す（元に戻すが失敗したときの画面の当て直し）。 */
  reapply?: () => void
  onSuccess?: (res: unknown) => void
  onFailure?: (error: unknown) => void
  /** 成功の文を保存の結果で変えるとき（メモの同時編集など）。渡すと successMessage より勝つ。 */
  successMessageOf?: () => string
}): { dismiss: () => void } {
  let dismissCurrent: () => void = () => {}
  const handle = { dismiss: () => dismissCurrent() }
  const current = () => options.isCurrent?.() ?? true
  const fail = (error: unknown) => {
    if (!current()) return
    options.revert()
    options.onFailure?.(error)
    const reason = failureReason(error)
    dismissCurrent = notifyToast(`${options.failureMessage}${reason ? reason : '通信を確かめて、もう一度お試しください。'}`, {
      tone: 'error',
      actionLabel: 'もう一度試す',
      onAction: () => { if (current()) options.retry() },
    })
  }
  void Promise.resolve()
    .then(() => options.request())
    .then((res) => {
      if (!current()) return
      if (res && res.success === false) throw new ApiError(400, res.error ?? '')
      options.onSuccess?.(res)
      const message = options.successMessageOf?.() ?? options.successMessage
      if (message) dismissCurrent = notifyToast(message)
    })
    .catch(fail)
  return handle
}
