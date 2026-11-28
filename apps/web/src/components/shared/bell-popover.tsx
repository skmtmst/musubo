'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Sparkles, TriangleAlert } from 'lucide-react'
import Button from './button'
import MenuPortal, { type MenuPortalRect } from './menu-portal'
import SegmentedControl from './segmented'
import styles from './bell-popover.module.css'

export type BellFilter = 'all' | 'error' | 'update'

export type BellItem = {
  id: string
  title: string
  /** 本文。絵に無いので行の title（指を乗せると出る）に置く。 */
  body?: string
  category: 'error' | 'update'
  unread: boolean
  /** 「5分前」「昨日 18:20」など。 */
  time: string
  /** 元の日時（相対表示に指を乗せて確認する）。 */
  timeTitle?: string
  /** 作成日時を日本時間で分けた日付の組。日時が不正なら不明として残す。 */
  period: 'today' | 'earlier' | 'unknown'
  /** 行き先の言葉（「配信を開く」など。→ は部品が付ける）。 */
  linkLabel: string
}

export type BellPopoverState = 'loading' | 'ready' | 'error' | 'no-account'

export type BellPopoverProps<F extends string = BellFilter> = {
  open: boolean
  onClose: () => void
  /** 開くボタン（ベル）。外を押したかの判定と、Esc で焦点を戻す先。 */
  getAnchor: () => HTMLElement | null
  /** 位置の基準（上の帯の右端から 8 内側・帯の下）。省くとベルに合わせる。 */
  getPositionRect?: () => MenuPortalRect | null
  id?: string
  state: BellPopoverState
  /** 見せる行（呼ぶ側で未読が先・新しい順にし、5件までに切る）。 */
  items: BellItem[]
  unreadCount: number | null
  /** 一部の対象だけ読み込めたときの単一案内。 */
  partialNotice?: ReactNode
  filter: F
  onFilterChange: (filter: F) => void
  /** 種類のタブ。省くと「すべて・エラー・アップデート」。 */
  filters?: { value: F; label: string }[]
  /** 題と読み上げの名前。省くと「お知らせ」。 */
  title?: string
  /** 行が無いときの文。省くと「{題}はまだありません。」。 */
  emptyText?: string
  errorMessage?: string
  onRetry?: () => void
  onSelect: (id: string) => void
  onMarkAllRead?: () => void
  markAllReadDisabled?: boolean
  markAllReadDisabledReason?: string
  markAllReadLockedReason?: string
  onViewAll: () => void
}

const FILTERS: { value: BellFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'error', label: 'エラー' },
  { value: 'update', label: 'アップデート' },
]

const PERIODS: { value: BellItem['period']; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: 'earlier', label: 'それより前' },
  { value: 'unknown', label: '日時不明' },
]

/**
 * ★V8 上の帯のベルを押したときのお知らせの小窓（V8.pen `DIHFx/D2eAyQ`・小窓 `mV28V`）。
 *
 * ページを移らずにベルの下へ出す（role="dialog"・モーダルではない）。
 * 外を押す・Esc で閉じ、Esc のときは焦点をベルへ戻す。
 * 中身（取得・既読）は呼ぶ側が持つ。ここは見た目と開閉だけ。
 * タブ・題・空の文は差し替えられる（通知の小窓は「すべて・未読・システム」）。
 */
export default function BellPopover<F extends string = BellFilter>({
  open,
  onClose,
  getAnchor,
  getPositionRect,
  id,
  state,
  items,
  unreadCount,
  partialNotice,
  filter,
  onFilterChange,
  filters,
  title = 'お知らせ',
  emptyText,
  errorMessage,
  onRetry,
  onSelect,
  onMarkAllRead,
  markAllReadDisabled,
  markAllReadDisabledReason,
  markAllReadLockedReason,
  onViewAll,
}: BellPopoverProps<F>) {
  const panelRef = useRef<HTMLElement>(null)

  // 開いたら小窓へ焦点を移す（読み上げは「{題} ダイアログ」）。
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  // Esc は器（MenuPortal）も閉じる。ここは焦点をベルへ戻す分。
  // 器の閉じる処理より先に動くよう捕捉の段で受ける（後だと小窓が先に消え、
  // この受け手も外れて焦点が body に落ちる。実ブラウザで確認）。
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      getAnchor()?.focus()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose, getAnchor])

  return (
    <MenuPortal open={open} getAnchor={getAnchor} getPositionRect={getPositionRect} align="end" onClose={onClose}>
      <section
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        className={styles.panel}
        data-design-node="mV28V"
      >
        <header className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          {state === 'ready' ? (
            <span className={styles.unread} aria-label={unreadCount === null ? '未読数を確認できません' : `未読 ${unreadCount}`}>
              {unreadCount === null ? '未読 —' : `未読 ${unreadCount}`}
            </span>
          ) : null}
          {onMarkAllRead ? (
            <Button type="button" variant="text" size="inline" className={styles.markAll} onClick={onMarkAllRead}
              disabled={markAllReadDisabled ?? (state !== 'ready' || unreadCount === null || unreadCount === 0)}
              lockedReason={markAllReadLockedReason ?? markAllReadDisabledReason}>
              すべて既読にする
            </Button>
          ) : null}
        </header>

        {state !== 'no-account' ? (
          <div className={styles.filters}>
            <SegmentedControl
              aria-label={`${title}の種類`}
              size="compact"
              options={filters ?? (FILTERS as { value: F; label: string }[])}
              value={filter}
              onChange={onFilterChange}
            />
          </div>
        ) : null}

        {state === 'ready' ? partialNotice : null}
        {state === 'loading' ? (
          <p className={styles.state} role="status">読み込み中…</p>
        ) : state === 'no-account' ? (
          <p className={styles.state}>{`LINEアカウントを選ぶと、そのアカウントの${title}が出ます。`}</p>
        ) : state === 'error' ? (
          <div className={styles.state} role="alert">
            <span>{`${errorMessage || `${title}を読み込めませんでした。`}${markAllReadDisabledReason ? ` ${markAllReadDisabledReason}` : ''}`}</span>
            {onRetry ? <button type="button" className={styles.retry} onClick={onRetry}>もう一度</button> : null}
          </div>
        ) : items.length === 0 ? (
          <p className={styles.state}>{emptyText ?? `${title}はまだありません。`}</p>
        ) : (
          <div>
            {PERIODS.map((period) => {
              const rows = items.filter(item => item.period === period.value)
              if (rows.length === 0) return null
              return <section key={period.value} aria-label={period.label}>
                <h3 className={styles.period}>{period.label}</h3>
                <ul className={styles.list}>
                  {rows.map((item) => (
                    <li key={item.id} className={styles.item} data-unread={item.unread}>
                      <button type="button" className={styles.row} onClick={() => onSelect(item.id)} title={item.body || undefined} >
                        <span className={styles.icon} data-category={item.category} aria-hidden="true">
                          {item.category === 'error' ? <TriangleAlert /> : <Sparkles />}
                        </span>
                        <span className={styles.text}>
                          <span className={styles.itemTitle}>
                            {item.title}
                            {item.unread ? <span className="sr-only">（未読）</span> : null}
                          </span>
                          <span className={styles.meta}>
                            <span className={styles.time} title={item.timeTitle}>{item.time}</span>
                            <span className={styles.go}>{`${item.linkLabel} →`}</span>
                          </span>
                        </span>
                        {item.unread ? <span className={styles.dot} aria-hidden="true" /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            })}
          </div>
        )}

        {/* 下は「すべて見る」だけ。通知設定はその先の一覧の画面にある（オーナー 2026-10-08：押すものが2つ並ぶのはおかしい）。 */}
        <footer className={styles.foot}>
          <button type="button" className={styles.viewAll} onClick={onViewAll}>すべて見る →</button>
        </footer>
      </section>
    </MenuPortal>
  )
}
