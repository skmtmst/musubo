'use client'
import { normalizeActionLabel } from './action-words'

import Link, { useListNavigationHref } from './list-navigation'
import { ArrowUpRight, Eye, Pencil, Pause, Trash2 } from 'lucide-react'
import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import MenuPortal, { type MenuPortalAlign } from './menu-portal'
import TooltipBubble from './tooltip-bubble'
import { useV8Leave } from './overlay-utils'
import styles from './action-menu.module.css'

export type ActionMenuGroup = 'view' | 'manage' | 'destructive'

export type ActionMenuItem = {
  /** ：見る／変える・整理する／止める・消す。権限と動きは項目側で保つ。 */
  group?: ActionMenuGroup
  id: string
  label: string
  /** 共通の操作から移した説明と読み上げ名を保つ。 */
  title?: string
  'aria-label'?: string
  'aria-description'?: string
  /** 未指定は種類に応じた印、nullは印なし。 */
  icon?: ReactNode
  /** 自分で結果を表示する共通操作（コピーなど）。 */
  content?: ReactNode
  /** 先頭の主な操作を太字で示す。既存の項目の見た目は変えない。 */
  emphasis?: boolean
  /**
   * 補足（★管理画面）。渡すと項目が2行・高さ52pxになる。
   * 例：「テンプレートを送る」＋「受信箱で選んで送ります」。
   */
  description?: string
  tone?: 'default' | 'danger'
  /**
   * 新しいタブで開くリンクだけに ↗ を出す。href と組にする。
   */
  external?: boolean
  href?: string
  disabled?: boolean
  /**
   * #985 LAY-18: 押せない理由（使用中・公開中など）。無効な項目の下に
   * 小さく出す。理由が書けない操作は無効のまま黙って置かない。
   */
  disabledReason?: string
  /** 権限の理由。焦点と理由の確認を保ち、操作・移動を止める。 */
  lockedReason?: string
  dividerBefore?: boolean
  /**
   * 小さな見出し（★管理画面）。この項目の前に出す。
   * 同じ見出しを2回出さないのは呼ぶ側の責任。
   */
  sectionBefore?: string
  /**
   * 撮影の押し口（`data-qa-open`）。メニューの中の項目を開ける手順の
   * 印にする。1画面に1つだけ。
   */
  qaOpen?: string
  onSelect?: () => void
}

/** ：旧い呼び口も同じ順で表示する。渡された配列と操作は変更しない。 */
export function actionMenuGroup(item: ActionMenuItem): ActionMenuGroup {
  if (item.tone === 'danger' || (!/再開|復元/.test(item.label) && /停止|止める|削除|消す|取り消|取消|取り下げ|保管する/.test(item.label))) return 'destructive'
  if (item.group) return item.group
  return /見る|確認|開く|戻る|履歴|結果|プレビュー|ダウンロード|コピー/.test(item.label) && !/編集|変更|再|更新|複製/.test(item.label) ? 'view' : 'manage'
}

export function orderActionMenuItems(items: ActionMenuItem[]): ActionMenuItem[] {
  const groups: ActionMenuGroup[] = ['view', 'manage', 'destructive']
  const titles = { view: '見る', manage: '変える・整理する', destructive: '止める・消す' }
  let previous: ActionMenuGroup | undefined
  return groups.flatMap(group => items.filter(item => actionMenuGroup(item) === group).map(item => {
    const first = previous !== group
    const dividerBefore = first && previous !== undefined
    previous = group
    const Icon = group === 'view' ? Eye : group === 'manage' ? Pencil : /削除|消す/.test(item.label) ? Trash2 : Pause
    return { ...item, group, tone: group === 'destructive' ? 'danger' as const : item.tone,
      icon: item.icon === undefined ? <Icon size={16} aria-hidden="true" /> : item.icon,
      dividerBefore, sectionBefore: first && items.length >= 5 ? titles[group] : undefined }
  }))
}

export type ActionMenuProps = {
  open: boolean
  items: ActionMenuItem[]
  showGroupHeadings?: boolean
  note?: string
  onClose: () => void
  ariaLabel?: string
  /** 参照画像の固定比較用。 */
  inline?: boolean
  /**
   * 開くボタン。渡すとメニューの位置の基準になり、ボタンの
   * 押し直しで閉じられる。渡さないときは直前のボタン要素を
   * 基準にする（`MoreAction`＋`ActionMenu` の並びが前提）。
   */
  anchorRef?: RefObject<HTMLElement | null>
  /** 器（portal）の横の寄せ。既定は押した物の右端。「〜を足す」のように左から読む押し口は start。 */
  align?: MenuPortalAlign
  /**
   * 操作ではなく「1つ選ぶ」一覧（差し込む欄など・絵 ）。渡すと  の組分け・印を付けず、
   * 渡した順のまま、先頭にこの見出しを出す。
   */
  choiceHeading?: string
}

/** Pencil ★V8 `hnuY9`「その他操作メニュー」を正本にした小型操作メニュー。 */
export default function ActionMenu({ open, items, showGroupHeadings = true, note, onClose, ariaLabel = '操作', inline = false, anchorRef, align = 'end', choiceHeading }: ActionMenuProps) {
  const navigationHref = useListNavigationHref()
  const leaving = useV8Leave(open, 80)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorMarkRef = useRef<HTMLSpanElement>(null)
  const reasonPrefix = useId()
  const focusFrame = useRef(0)
  const [tip, setTip] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null)
  const showReason = (element: HTMLElement, text: string) => {
    const css = getComputedStyle(document.documentElement)
    const edge = parseFloat(css.getPropertyValue('--polish-space-row')) || 8
    const width = parseFloat(css.getPropertyValue('--polish-tooltip-width')) || 288
    const gap = parseFloat(css.getPropertyValue('--polish-tooltip-gap')) || 8
    const rect = element.getBoundingClientRect(), below = rect.top < 48
    setTip({ text, left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)), top: below ? rect.bottom + gap : rect.top - gap, below })
  }
  useEffect(() => {
    const hide = () => setTip(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => { cancelAnimationFrame(focusFrame.current); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide) }
  }, [])
  useEffect(() => { setTip(null) }, [open, items])

  const getAnchor = () => {
    const explicit = anchorRef?.current
    if (explicit) return explicit
    const mark = anchorMarkRef.current
    if (!mark) return null
    // `MoreAction` 等の開くボタンの直後に置く並びが前提。
    // ボタンが無ければ目印自体を基準にする。
    const previous = mark.previousElementSibling
    return previous instanceof HTMLElement ? previous : mark
  }
  /*
   * 戻す先は押せる要素。位置の基準が囲み（右クリックの ContextMenu など）の
   * ときは、その中の開くボタンへ戻す。囲みへ focus しても効かず BODY に落ちる。
   */
  const getFocusTarget = (): HTMLElement | null => {
    const anchor = getAnchor()
    if (!anchor) return null
    if (anchor.matches('button, a[href], [tabindex]:not([tabindex="-1"])')) return anchor
    const buttons = anchor.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')
    return buttons.length > 0 ? buttons[buttons.length - 1] : null
  }
  const getAnchorRef = useRef(getFocusTarget)
  getAnchorRef.current = getFocusTarget

  // 最上層（portal）では外側・Esc の扱いを MenuPortal に任せる。
  // 開くボタンの押し直しはトグル（閉じる）になる。
  useEffect(() => {
    if (!open || !inline) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [inline, onClose, open])

  /*
   * 開いたら最初の項目へフォーカスを入れる（WAI-ARIA のメニューの決まり）。
   * 最上層の器（MenuPortal）は、器が付いて位置を測るまで中身を描かない・
   * 隠しておくので、開いた直後の effect ではまだ項目が無い。描けて見えるまで
   * 数コマ待ってから入れる（以前はここで空振りして、矢印キーが効かなかった）。
   * 閉じたら、フォーカスが行き場を失っていれば開いたボタンへ戻す。
   * 項目から窓を開くときは、選んだ時点で開いたボタンへ戻してあるので、
   * 窓を閉じた後もそのボタンへ帰る（動きの点検 2・3 番）。
   */
  useEffect(() => {
    if (!open || inline) return
    const anchor = getAnchorRef.current()
    let frame = 0
    let tries = 0
    const focusFirst = () => {
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"]),[role="menuitem"][data-permission-locked]')
      const host = menuRef.current?.closest<HTMLElement>('[data-menu-portal]')
      const hidden = !first || (host && host.style.visibility === 'hidden')
      if (!hidden && first) {
        first.focus({ preventScroll: true })
        return
      }
      tries += 1
      if (tries < 10) frame = requestAnimationFrame(focusFirst)
    }
    frame = requestAnimationFrame(focusFirst)
    return () => {
      cancelAnimationFrame(frame)
      const active = typeof document === 'undefined' ? null : document.activeElement
      const lost = !active || active === document.body || !active.isConnected || Boolean(menuRef.current?.contains(active))
      if (lost && anchor?.isConnected) anchor.focus({ preventScroll: true })
    }
  }, [inline, open])

  if (!open && !leaving) return null

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Tab はメニューを閉じて、開いたボタンの次（前）へ進む。既定の動きは止めない。
      getFocusTarget()?.focus({ preventScroll: true })
      onClose()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"]),[role="menuitem"][data-permission-locked]') ?? [])
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length
    buttons[next].focus()
  }

  const orderedItems = choiceHeading === undefined
    ? orderActionMenuItems(items).map((item) => showGroupHeadings ? item : { ...item, sectionBefore: undefined })
    : items.map((item, index) => ({ ...item, sectionBefore: index === 0 ? choiceHeading : undefined }))
  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      data-closing={leaving || undefined}
      aria-label={ariaLabel}
      className={`${styles.menu} ${inline ? styles.inline : styles.menuPortal}`}
      onKeyDown={moveFocus}
      /*
       * R13: メニューは行の中（tr の詳細遷移など）に置く。
       * 中の押下がそのまま行へ伝わると、選んだ操作の代わりに
       * 詳細へ移動してしまう。容器と項目の両方で止める。
       */
      onClick={(event) => event.stopPropagation()}
      data-design-part="action-menu"
      data-design-node="xifuV"
    >
      {orderedItems.map((item, index) => {
        const itemLabel = normalizeActionLabel(item.label.replace(/(?:…|\.{3})\s*$/u, ''))
        const locked = Boolean(item.lockedReason)
        const blocked = item.disabled || locked
        const reason = item.lockedReason ?? item.disabledReason
        const reasonId = `${reasonPrefix}-${index}`
        const Item = item.href && !blocked ? 'a' : 'button'
        return (
        <div key={item.id} data-menu-group={item.group}>
          {item.dividerBefore ? <hr className={styles.divider} /> : null}
          {item.sectionBefore ? (
            <p className={styles.section} role="presentation">
              {item.sectionBefore}
            </p>
          ) : null}
          {item.content && !blocked ? <div className={styles.item}>{item.content}</div> : <Item href={Item === 'a' && item.href ? navigationHref(item.href) : undefined}
            target={Item === 'a' &&item.external ? '_blank' : undefined}
            rel={Item === 'a' && item.external ? 'noopener noreferrer' : undefined}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.description || (!locked && item.disabled && reason) ? styles.itemTall : ''} ${item.tone === 'danger' ? styles.danger : ''}`}
            disabled={Boolean(item.disabled) && !locked}
            aria-disabled={locked || undefined}
            aria-describedby={blocked && reason ? reasonId : undefined}
            aria-label={item['aria-label'] ?? (blocked ? itemLabel : undefined)}
            aria-description={item['aria-description'] ?? (!locked && item.disabled ? item.disabledReason : undefined)}
            data-permission-locked={locked ? '' : undefined}
            title={item.title ?? itemLabel}
            data-qa-open={item.qaOpen}
            onPointerEnter={(event) => { if (locked && event.pointerType !== 'touch') showReason(event.currentTarget, item.lockedReason!) }}
            onPointerLeave={(event) => { if (event.pointerType !== 'touch' && document.activeElement !== event.currentTarget) setTip(null) }}
            onPointerDown={(event) => { if (locked && event.pointerType === 'touch') showReason(event.currentTarget, item.lockedReason!) }}
            onFocus={(event) => {
              if (!locked) return
              const element = event.currentTarget
              showReason(element, item.lockedReason!)
              cancelAnimationFrame(focusFrame.current)
              focusFrame.current = requestAnimationFrame(() => { if (document.activeElement === element) showReason(element, item.lockedReason!) })
            }}
            onBlur={() => { cancelAnimationFrame(focusFrame.current); setTip(null) }}
            onKeyDown={(event) => { if (blocked && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation() } }}
            onClick={(event) => {
              event.stopPropagation()
              if (blocked) { event.preventDefault(); return }
              // 先に開いたボタンへ戻しておく。項目が窓を開くと、窓はこのボタンを
              // 「開く前の場所」として覚え、閉じた後にここへ戻す（消えた項目へは戻れない）。
              if (!inline) getFocusTarget()?.focus({ preventScroll: true })
              if (!item.href) item.onSelect?.()
              onClose()
            }}
          >
            {item.icon ? <span className={styles.icon} aria-hidden="true">{item.icon}</span> : null}
            <span className={styles.itemBody}>
              <span className={styles.label}>{item.emphasis ? <strong>{itemLabel}</strong> : itemLabel}</span>
              {item.description ? (
                <span className={styles.description}>{item.description}</span>
              ) : null}
              {blocked && reason ? (
                <span id={reasonId} className={styles.reason} hidden={locked}>{reason}</span>
              ) : null}
            </span>
            {Item === 'a' &&item.external ? (
              <ArrowUpRight size={16} aria-hidden="true" className={styles.externalIcon} />
            ) : null}
          </Item>}
        </div>
      )})}
      {note ? <p className={styles.note}>{note}</p> : null}
      {open && tip ? <TooltipBubble id={`${reasonPrefix}-tooltip`} {...tip} /> : null}
    </div>
  )

  // 参照画像の固定比較（`inline`）以外は、カード・表・ダイアログ・
  // 固定の帯の中でも切られないよう、最上層（portal）に出す。
  // 下に場所が無ければ上へ、右に無ければ左へ寄せる。
  if (inline) return menu
  return (
    <>
      {anchorRef ? null : <span ref={anchorMarkRef} aria-hidden="true" className={styles.anchor} />}
      <MenuPortal open={open} exitDuration={80} getAnchor={getAnchor} onClose={onClose} align={align}>
        {menu}
      </MenuPortal>
    </>
  )
}

function MenuCommand({ href, external, disabled, children, type, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { href?: string; external?: boolean }) {
  if (href && !disabled) return <Link href={href} role={props.role} className={props.className} title={props.title} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} onClick={props.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}>{children}</Link>
  return <button {...props} type={type} disabled={disabled}>{children}</button>
}
