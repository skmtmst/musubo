'use client'

import { useCallback, useMemo, useState } from 'react'
import { runUndoable } from './undoable'

/* 確認済みの削除を保存し、失敗時には行を戻す。 */
export type DeferredDelete = {
  /** 隠している（保存中の）行か。一覧はこれで行を外して描く。 */
  isHidden: (id: string) => boolean
  /** 隠している行の数（件数の表示を合わせるとき）。 */
  hiddenCount: number
  /** 行を隠して commit を送る。 */
  schedule: (options: {
    ids: readonly string[]
    /** 知らせの文（例「テンプレート「A」を削除しました」）。 */
    message: string
    /** 本当に消す。失敗は throw か { success: false }。 */
    commit: () => Promise<{ success: boolean; error?: string } | void>
    /** 消せた後の読み直し。終わってから隠した印を外す（行が一瞬戻らないように）。 */
    onCommitted?: () => Promise<unknown> | void
    failureMessage?: string
  }) => void
}

export function useDeferredDelete(): DeferredDelete {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())

  const show = useCallback((ids: readonly string[]) => {
    setHidden((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const schedule = useCallback<DeferredDelete['schedule']>((options) => {
    const ids = [...options.ids]
    setHidden((current) => new Set([...current, ...ids]))
    runUndoable({
      message: options.message,
      commit: options.commit,
      undo: () => show(ids),
      failureMessage: options.failureMessage,
      onCommitted: () => {
        void Promise.resolve()
          .then(() => options.onCommitted?.())
          .catch(() => undefined)
          .finally(() => show(ids))
      },
    })
  }, [show])

  const isHidden = useCallback((id: string) => hidden.has(id), [hidden])

  return useMemo(() => ({ isHidden, hiddenCount: hidden.size, schedule }), [isHidden, hidden, schedule])
}
