'use client'

import { useRouter } from 'next/navigation'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MENU_SECTIONS } from '@/lib/menu'
import { useV8Leave } from './overlay-utils'
import styles from './command-palette.module.css'
import { isImeComposing } from './ime'
import { requestUnsavedAction } from '@/lib/unsaved-action'

export type PaletteItem = {
  href: string
  label: string
  section?: string
}

/** 左メニューに出ている行き先を拾う（見えている機能だけ出す）。 */
function collectVisibleItems(): PaletteItem[] {
  if (typeof document === 'undefined') return []
  const anchors = document.querySelectorAll('nav[data-design-node="J33xq"] a[href]')
  const seen = new Set<string>()
  const items: PaletteItem[] = []
  anchors.forEach((anchor) => {
    const href = anchor.getAttribute('href')
    if (!href || seen.has(href)) return
    seen.add(href)
    const label = anchor.getAttribute('title')?.trim() || anchor.textContent?.trim() || href
    items.push({ href, label })
  })
  return items
}

function menuFallback(): PaletteItem[] {
  return MENU_SECTIONS.flatMap((section) =>
    section.items.map((item) => ({ href: item.href, label: item.label, section: section.title })),
  )
}

/**
 * ② どこからでも探す窓（V8「サクサク感」F）。
 * ⌘K（Ctrl+K）で開く。機能は左メニューに出ているものだけ、
 * 友だちとメッセージのテンプレートは、それぞれの一覧の `?q=` の受け口へ送る。
 * 帯（top-bar）に探す欄は置かない（外枠の決まり）。
 */
export default function CommandPalette({ items }: { items?: PaletteItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [menuItems, setMenuItems] = useState<PaletteItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  /* 閉じたら、開く前にいた場所へフォーカスを戻す（動きの点検 2 番）。 */
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  /* 閉じるときも窓と同じく薄く消す（動きの点検 13 番）。 */
  const leaving = useV8Leave(open)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.altKey && !event.shiftKey && !isImeComposing(event)) {
        event.preventDefault()
        if (!openRef.current) {
          const active = document.activeElement
          returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null
        }
        setMenuItems(collectVisibleItems())
        setQuery('')
        setActive(0)
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    return () => {
      const back = returnFocusRef.current
      returnFocusRef.current = null
      const active = document.activeElement
      // 窓の中（入力・候補）にいたら、閉じる動きの後に消えるので戻す。
      const lost = !active || active === document.body || !active.isConnected || Boolean(backdropRef.current?.contains(active))
      if (lost && back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [open ])

  const base = items ?? (menuItems.length > 0 ? menuItems : menuFallback())
  const canSearchTemplates = (items ?? menuItems).some((item) => item.href.split('?')[0] === '/templates')
  const trimmed = query.trim()
  const hits = useMemo(() => {
    const lower = trimmed.toLowerCase()
    return base.filter(
      (item) =>
        lower === '' ||
        item.label.toLowerCase().includes(lower) ||
        (item.section ?? '').toLowerCase().includes(lower),
    )
  }, [base, trimmed])
  const rows: PaletteItem[] = useMemo(
    () =>
      trimmed === ''
        ? hits
        : [...hits, { href: `/friends?q=${encodeURIComponent(trimmed)}`, label: `友だちを探す「${trimmed}」` },
          ...(canSearchTemplates ? [{ href: `/templates?q=${encodeURIComponent(trimmed)}`, label: `メッセージのテンプレートを探す「${trimmed}」` }] : [])],
    [hits, trimmed, canSearchTemplates],
  )

  if ((!open && !leaving) || typeof document === 'undefined') return null

  const go = (href: string) => {
    setOpen(false)
    // 書きかけの画面があれば、左メニューのリンクと同じ「保存せずに移りますか」を通す。
    // 直接 router.push すると未保存の入力が確認なしで消える（監査 WEB-008）。
    requestUnsavedAction(() => {
      // 同じ一覧では router.push だけだと一覧の URL 購読に検索語が届かない。
      if (window.location.pathname === '/templates' && href.startsWith('/templates?q=')) {
        window.history.pushState(null, '', href)
        window.dispatchEvent(new PopStateEvent('popstate'))
      } else router.push(href)
    })
  }

  return createPortal(
    <div ref={backdropRef} className={styles.backdrop} data-closing={leaving || undefined} aria-hidden={leaving || undefined} onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="機能と友だちを探す"
        className={styles.panel}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (leaving) return
          // 変換中の Enter（確定）で行き先へ飛ばない・上下で行を動かさない。
          if (isImeComposing(event)) return
          if (event.key === 'Escape') setOpen(false)
          else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((prev) => (rows.length === 0 ? 0 : (prev + 1) % rows.length))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((prev) => (rows.length === 0 ? 0 : (prev - 1 + rows.length) % rows.length))
          } else if (event.key === 'Enter' && rows[active]) {
            go(rows[active].href)
          }
        }}
      >
        {canSearchTemplates ? <span id={hintId} className="sr-only">メッセージのテンプレートも検索できます。</span> : null}
        <input
          ref={inputRef}
          aria-describedby={canSearchTemplates ? hintId : undefined}
          aria-label="機能と友だちを探す"
          placeholder={canSearchTemplates ? '機能・友だち・メッセージのテンプレートを探す' : '機能・友だちの名前で探す'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          className={styles.input}
        />
        <ul className={styles.list} role="listbox" aria-label="探した結果">
          {rows.map((row, index) => (
            <li key={`${row.href}-${row.label}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={`${styles.row} ${index === active ? styles.rowActive : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(row.href)}
              >
                <span className={styles.rowLabel}>{row.label}</span>
                {row.section ? <span className={styles.rowSection}>{row.section}</span> : null}
              </button>
            </li>
          ))}
          {rows.length === 0 ? <li className={styles.empty}>見つかりませんでした</li> : null}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
