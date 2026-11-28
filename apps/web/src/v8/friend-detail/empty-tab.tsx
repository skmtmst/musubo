'use client'

/*
 * まだ中身が無いタブの見せ方（ の 6.・oLls9）。6つのタブで共通。
 * 説明で行き止まりにせず、この友だちを引き継ぐ操作か関連する一覧への行き先を添える（FRIEND-27）。
 */
import type { ReactNode } from 'react'
import Button from '@/components/shared/button'
import styles from './detail.module.css'

export type EmptyTabAction =
  | { label: string; href: string; primary?: boolean }
  | { label: string; onClick: () => void; primary?: boolean }

const SAFE_ORIGIN = 'https://same.invalid'

function safeTabHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.startsWith('/')) {
    if (trimmed.length >= 2 && (trimmed[1] === '/' || trimmed[1] === '\\')) return null
    try {
      const resolved = new URL(trimmed, SAFE_ORIGIN)
      return resolved.origin === SAFE_ORIGIN ? trimmed : null
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

export default function EmptyTab({ icon, title, text, actions }: { icon: ReactNode; title: string; text: string; actions: EmptyTabAction[] }) {
  const safeActions = Array.isArray(actions)
    ? actions.flatMap((action): EmptyTabAction[] => {
        if (!action || typeof action !== 'object') return []
        if ('href' in action) {
          const href = safeTabHref(action.href)
          return href ? [{ ...action, href }] : []
        }
        return typeof action.onClick === 'function' ? [action] : []
      })
    : []
  return (
    <div className={styles.pane}>
      <div className={styles.empty}>
        <span className={styles.emptyIcon} aria-hidden>{icon}</span>
        <p className={styles.emptyTitle}>{title}</p>
        <p className={styles.emptyText}>{text}</p>
        {safeActions.length ? (
          <div className={styles.emptyActions}>
            {safeActions.map((a) => ('href' in a
              ? <Button key={a.label} href={a.href} variant={a.primary ? 'primary' : undefined}>{a.label}</Button>
              : <Button key={a.label} onClick={a.onClick} variant={a.primary ? 'primary' : undefined}>{a.label}</Button>))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
