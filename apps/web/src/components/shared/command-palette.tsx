'use client'

import { usePathname, useRouter } from 'next/navigation'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isHqShellPath } from '@/lib/menu'
import { useOptionalAccount } from '@/contexts/account-context'
import { resolveLineAccountEntry } from '@/lib/line-account-entry'
import { useV8Leave } from './overlay-utils'
import styles from './command-palette.module.css'
import { isImeComposing } from './ime'
import { requestUnsavedAction } from '@/lib/unsaved-action'

export type PaletteItem = {
  href: string
  label: string
  section?: string
  accountId?: string
}

const TEMPLATE_SEARCH_TYPES = [
  ['message', 'メッセージ'], ['card_message', 'カルーセル'], ['rich_message', 'リッチメッセージ'],
  ['rich_video', 'リッチビデオ'], ['question', '質問'], ['coupon', 'クーポン'], ['research', 'リサーチ'],
] as const

/** 左メニューに出ている行き先を拾う（見えている機能だけ出す）。 */
function collectVisibleItems(): PaletteItem[] {
  if (typeof document === 'undefined') return []
  const anchors = document.querySelectorAll('nav[data-design-node="J33xq"] a[href]')
  const seen = new Set<string>()
  const items: PaletteItem[] = []
  anchors.forEach((anchor) => {
    let ancestor: Element | null = anchor
    while (ancestor) {
      if (ancestor.matches('[hidden], [aria-hidden="true"], [inert]') && !ancestor.matches('[data-group-open="false"]')) return
      ancestor = ancestor.parentElement
    }
    if (anchor.getAttribute('aria-disabled') === 'true') return
    const href = anchor.getAttribute('href')
    if (!href || seen.has(href)) return
    seen.add(href)
    const label = anchor.getAttribute('title')?.trim() || anchor.textContent?.trim() || href
    items.push({ href, label })
  })
  return items
}

/**
 * ② どこからでも探す窓（V8「サクサク感」F）。
 * ⌘K（Ctrl+K）で開く。機能は左メニューに出ているものだけ、
 * 友だちとテンプレートは、それぞれの一覧の `?q=` の受け口へ送る。
 * 帯（top-bar）に探す欄は置かない（外枠の決まり）。
 */
export default function CommandPalette({ items }: { items?: PaletteItem[] }) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const hqShell = isHqShellPath(pathname)
  const account = useOptionalAccount()
  const accountEntryRequest = useRef(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [menuItems, setMenuItems] = useState<PaletteItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const hintId = useId()
  /* 閉じたら、開く前にいた場所へフォーカスを戻す（動きの点検 2 番）。 */
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => () => { accountEntryRequest.current += 1 }, [pathname])
  /* 閉じるときも窓と同じく薄く消す（動きの点検 13 番）。 */
  const leaving = useV8Leave(open)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.repeat && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.altKey && !event.shiftKey && !isImeComposing(event)) {
        if (!openRef.current && [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(dialog => !dialog.closest('[hidden], [aria-hidden="true"], [inert]'))) return
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

  const visibleItems = items ?? menuItems
  const base = useMemo(() => [...visibleItems, ...(account?.accounts ?? []).filter(item => (hqShell || item.id !== account?.selectedAccountId) && !item.archivedAt).map(item => ({ href: '', accountId: item.id, label: item.displayName || item.name, section: 'アカウント切替' }))], [visibleItems, account?.accounts, account?.selectedAccountId, hqShell])
  const hasRoute = (route: string) => visibleItems.some((item) => item.href.split('?')[0] === route)
  const canSearchTemplates = hasRoute('/templates')
  const canSearchFriends = hasRoute('/friends')
  const canSearchChats = hasRoute('/chats')
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
        : [...hits, ...(canSearchFriends ? [{ href: `/friends?q=${encodeURIComponent(trimmed)}`, label: `友だちを探す「${trimmed}」` }] : []),
          ...(canSearchChats ? [{ href: `/chats?q=${encodeURIComponent(trimmed)}`, label: `トークの相手を探す「${trimmed}」` }] : []),
          ...(canSearchTemplates ? TEMPLATE_SEARCH_TYPES.map(([tab, label]) => ({ href: `/templates?q=${encodeURIComponent(trimmed)}&tab=${tab}`, label: `${label}のテンプレートを探す「${trimmed}」` })) : [])],
    [hits, trimmed, canSearchFriends, canSearchChats, canSearchTemplates],
  )

  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  if ((!open && !leaving) || typeof document === 'undefined') return null

  const go = (row: PaletteItem) => {
    setOpen(false)
    if (row.accountId && account) {
      const id = row.accountId
      requestUnsavedAction(async () => {
        const request = ++accountEntryRequest.current
        if (hqShell) {
          try {
            const entry = await resolveLineAccountEntry(id)
            if (request !== accountEntryRequest.current) return
            if ('href' in entry || entry.destination === 'unavailable') { router.push('href' in entry ? entry.href : `/accounts/new?resume=${encodeURIComponent(id)}`); return }
          } catch { if (request === accountEntryRequest.current) router.push(`/accounts/new/handover?accountId=${encodeURIComponent(id)}`); return }
          account.setSelectedAccountId(id)
          router.push('/')
        } else {
          account.setSelectedAccountId(id)
          if (pathname === '/' && account.selectedAccountId !== id) {
            const params = new URLSearchParams(window.location.search)
            const keys = ['setup', 'setupReturn', 'qr', 'guide']
            if (keys.some(key => params.has(key))) {
              keys.forEach(key => params.delete(key))
              router.replace(params.size ? `/?${params}` : '/')
            }
          }
        }
      })
      return
    }
    const href = row.href
    // 書きかけの画面があれば、左メニューのリンクと同じ「保存せずに移りますか」を通す。
    // 直接 router.push すると未保存の入力が確認なしで消える（監査 WEB-008）。
    requestUnsavedAction(() => {
      // 同じ一覧では router.push だけだと一覧の URL 購読に検索語が届かない。
      if ((window.location.pathname === '/templates' && href.startsWith('/templates?q=')) || (window.location.pathname === '/chats' && href.startsWith('/chats?q='))) {
        window.history.pushState(null, '', href)
        window.dispatchEvent(new PopStateEvent('popstate'))
        if (window.location.pathname === '/chats') window.dispatchEvent(new CustomEvent('musubo:command-palette-chat-search', { detail: new URLSearchParams(window.location.search).get('q') ?? '' }))
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
          // 開いた窓の単独キーは受信箱など背景のショートカットに渡さない。
          if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation()
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
            go(rows[active])
          }
        }}
      >
        {canSearchTemplates ? <span id={hintId} className="sr-only">種類ごとにテンプレートも検索できます。</span> : null}
        <input
          ref={inputRef}
          aria-describedby={canSearchTemplates ? hintId : undefined}
          aria-label="機能と友だちを探す"
          placeholder={canSearchTemplates ? '機能・友だち・テンプレートを探す' : '機能・友だちの名前で探す'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          className={styles.input}
        />
        <ul ref={listRef} className={styles.list} role="listbox" aria-label="探した結果">
          {rows.map((row, index) => (
            <li key={`${row.accountId ?? row.href}-${row.label}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={`${styles.row} ${index === active ? styles.rowActive : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(row)}
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
