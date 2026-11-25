'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motionMs } from './overlay-utils'
import Button from './button'
import styles from './bulk-bar.module.css'

export type BulkBarProps = {
  /** 選んでいる数。0 のときは何も出さない（下がって消える）。 */
  count: number
  total?: number
  onSelectAll?: () => void | Promise<void>
  /** 数の単位。規定は「件」（友だち一覧は「人」、写真は「枚」）。 */
  unit?: string
  /** 件数の右に出す補足（なぜ今この操作が出ているか等）。 */
  hint?: ReactNode
  /**
   * まとめ操作。白地ボタン（`Button variant="secondary"`）を
   * よく使う順に2つまで並べ、残りは「…」のメニューへ入れる。
   */
  children?: ReactNode
  /** 残りの操作を入れる「…」の押し口（メニューを開くボタン）。 */
  overflow?: ReactNode
  /**
   * 帯の下段。1件だけ選んだときの個別操作など、数行要る中身を
   * 帯の中へ横幅いっぱいで置くときに使う。
   */
  below?: ReactNode
  className?: string
  /**
   * 選択を外す。渡すと Esc で選択を外せる（窓・メニューが開いている間は窓側の Esc が先）。
   * 動きの点検 12 番。
   */
  onClear?: () => void
}

/*
 * ★管理画面 仕上げ §2「一括バー」。表・一覧で1件でも選ぶと表の下端から
 * 8px上がって出る帯。0件で下がって消える。
 *
 * 置き場所は「表のすぐ下」。呼び出し側は条件分岐ではなく常に描き、
 * 件数だけを渡す（出る・消えるの動きは部品が持つ）。
 *
 * 動きの根拠:
 *   入る: 下8pxから浮き上がる（motion-base・ease-out）
 *   出る: 下がって消える（motion-fast）
 */
/**
 * 選んでいる間は Esc で選択を外す（動きの点検 12 番）。一括バーを自前で持つ一覧も使う。
 * 窓・メニュー・⌘K が開いている間と、入力欄の中の Esc は奪わない。
 */
export function useEscapeToClearSelection(active: boolean, onClear: (() => void) | undefined): void {
  useEffect(() => {
    if (!active || !onClear) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-menu-portal]')) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      onClear()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, onClear])
}

export default function BulkBar({ count, unit = '件', hint, children, overflow, below, className, onClear, total, onSelectAll }: BulkBarProps) {
  const [selectingAll, setSelectingAll] = useState(false)
  const [selectError, setSelectError] = useState('')
  const selectLock = useRef(false)
  const selectAll = async () => {
    if (selectLock.current || !onSelectAll) return
    selectLock.current = true; setSelectingAll(true); setSelectError('')
    try { await onSelectAll() } catch { setSelectError('すべての対象を読み込めませんでした。もう一度お試しください。') }
    finally { selectLock.current = false; setSelectingAll(false) }
  }
  const visible = count > 0
  const [rendered, setRendered] = useState(visible)

  useEscapeToClearSelection(visible, onClear)

  useEffect(() => {
    if (visible) {
      setRendered(true)
      return
    }
    if (!rendered) return
    // 「下がって消える」を見せるため、出し終わるまで描き続ける。
    const timer = setTimeout(() => setRendered(false), motionMs('--motion-fast', 120))
    return () => clearTimeout(timer)
  }, [visible, rendered])

  if (!rendered) return null

  return (
    <div
      className={[styles.bar, visible ? styles.enter : styles.exit, className].filter(Boolean).join(' ')}
      role="region"
      aria-label="選択中のまとめ操作"
    >
      <strong className={styles.count} aria-live="polite" aria-atomic="true">
        {count}
        {unit}を選択中
      </strong>
      {total !== undefined && count < total && onSelectAll ? <Button size="compact" busy={selectingAll} busyLabel="対象を読み込んでいます…" onClick={() => void selectAll()}>条件に合う{total}{unit}すべてを選択する</Button> : null}
      {onClear ? <Button size="compact" disabled={selectingAll} onClick={onClear}>選択するのをやめる</Button> : null}
      {selectError ? <span role="alert">{selectError}</span> : null}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
      {children || overflow ? (
        <span className={styles.actions}>
          {children}
          {overflow}
        </span>
      ) : null}
      {below ? <span className={styles.below}>{below}</span> : null}
    </div>
  )
}
