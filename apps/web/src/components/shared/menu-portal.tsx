'use client'

import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type HTMLAttributes } from 'react'
import { isImeComposing } from './ime'
import { OVERLAY_MODAL_OPEN_EVENT, useV8Leave } from './overlay-utils'
import styles from './menu-portal.module.css'

const openPanels: HTMLDivElement[] = []
const panelAnchors = new WeakMap<HTMLElement, HTMLElement>()

/** bodyへ移した選択欄も、その押し元をたどって現在の窓の内側か確かめる。 */
function belongsToModal(anchor: HTMLElement | null, modal: Element): boolean {
  const seen = new Set<HTMLElement>()
  while (anchor && !seen.has(anchor)) {
    if (modal.contains(anchor)) return true
    seen.add(anchor)
    const portal = anchor.closest<HTMLElement>('[data-menu-portal]')
    anchor = portal ? panelAnchors.get(portal) ?? null : null
  }
  return false
}
function topModal(): Element | undefined {
  const layer = (el: Element) => {
    let highest = 0
    for (let parent: Element | null = el; parent; parent = parent.parentElement) highest = Math.max(highest, Number(getComputedStyle(parent).zIndex) || 0)
    return highest
  }
  return [...document.querySelectorAll('[aria-modal="true"]')]
    .filter(el => !el.closest('[hidden],[inert],[aria-hidden="true"],[data-closing]'))
    .sort((a, b) => layer(a) - layer(b)).at(-1)
}

export function SavedSearchMenuSurface({ children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'className'>) {
  return <div {...props} className={styles.savedSearchSurface}>{children}</div>
}

export type MenuPortalAlign = 'start' | 'end'
export type MenuPortalPlacement = 'down' | 'up'

export type MenuPortalProps = {
  /** 絞り込みの窓など、開いた面の最初の操作へ焦点を移して戻す。 */
  focusPanel?: boolean
  keepOpenOnModal?: boolean
  /** 操作メニューの閉じる時間（提案Fは80ms）。候補欄の既定は変えない。 */
  exitDuration?: number
  /** 開いている間だけ body へ出す。閉じたら何も描かない。 */
  open: boolean
  /** 位置の基準（開くボタン）。開くたび・動くたびに測り直す。 */
  getAnchor: () => HTMLElement | null
  /** 横の寄せ。既定は `end`（今までの `right-0` と同じく右寄せ）。 */
  align?: MenuPortalAlign
  /**
   * 開く向きの固定（E21：窓の下帯に被せない色の板）。渡さなければ今までどおり
   * 下に入るか・下の余地が広いときに下へ開く（自動判定は変えない）。
   */
  placement?: MenuPortalPlacement
  /** ボタンとのすき間。★管理画面 メニューは4px。既定は 4。 */
  gap?: number
  /**
   * 欄の幅に合わせる（候補つき入力・単一選択）。
   * `true` は幅をそろえ、`'min'` は欄の幅を下限にする。既定は中身の幅。
   */
  matchWidth?: boolean | 'min'
  /** 外を押した・Esc で閉じるとき。開くボタンの押下は含まない。 */
  onClose: () => void
  /** 位置を測り、子が見える状態になってから焦点を移す。開くごとに1回。 */
  onReady?: () => void
  /**
   * 位置だけ別の箱に合わせるとき（ベルの小窓は上の帯の右端から 8 内側・帯の下）。
   * 外を押したかの判定は getAnchor のまま（開くボタンの押下は外にしない）。
   */
  getPositionRect?: () => MenuPortalRect | null
  /**
   * 器そのものに見た目（白地・角丸・浮きの影）を付けるとき（select-menu）。
   * 子に影を付けると器の overflow に切られるので、影ごと器に持たせる。
   * 渡したときは続きの影を `--menu-portal-more` で渡す（続きがある間だけ。
   * class は `[data-has-more='true']` のときに浮きの影と重ねる）。
   */
  className?: string
  /**
   * Esc で閉じずに別のことをするとき（フォルダを選ぶ欄の「名前を入れる」板から一覧へ戻る）。
   * 渡さなければ Esc は onClose。
   */
  onEscape?: () => void
  children: ReactNode
}

export type MenuPortalRect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>

/**
 * 開く向き。上・下の指定があればそれに従い、無ければ下に中身が入るか・
 * 下の余地が広いときに下へ開く（今までの自動判定そのまま）。
 */
export function resolveMenuPlacement(forced: MenuPortalPlacement | undefined, contentHeight: number, spaceBelow: number, spaceAbove: number): MenuPortalPlacement {
  if (forced) return forced
  if (contentHeight <= spaceBelow || spaceBelow >= spaceAbove) return 'down'
  return 'up'
}

type Geometry = {
  origin: 'left' | 'right'
  top: number
  left: number
  width: number | undefined
  minWidth: number | undefined
  placement: MenuPortalPlacement
  /** 開く方向に使える高さ（画面 − ボタン − 余白8px）。器の最大の高さ。 */
  maxHeight: number
}

/** 下に続きがあるときの下端の影。 */
const MORE_SHADOW = 'inset 0 -16px 12px -12px rgb(0 0 0 / 22%)'

/** 画面端の余白。上下左右とも 8px。 */
export const MENU_PORTAL_MARGIN = 8

/** 下に続きがあるか（1px の誤差は無視）。 */
export function hasMoreBelow({
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): boolean {
  return scrollHeight - scrollTop - clientHeight > 1
}

/**
 * メニュー・候補を画面の最上層（`document.body` 直下・`position: fixed`）
 * に出す器。
 *
 * カード・表・ダイアログ・固定の帯の中にあっても、親の
 * `overflow: hidden` や重なり順（`z-index`）に切られない。
 * 下に場所が無ければ上へ開き、右に無ければ左へ寄せる。
 * 高さは開く方向に使える分（画面 − ボタン − 余白8px）まで使い、
 * 入るなら全部出し、入りきらない時だけ器の中でスクロールする。
 * その時は下端に影（続きの目印）を付ける。
 *
 * 見た目は持たない。白地・角丸・浮きの影は子が持つ。
 * （下端の続きの影だけは器が付ける。）
 */
export default function MenuPortal({
  open,
  getAnchor,
  align = 'end',
  gap = 4,
  matchWidth = false,
  onClose,
  getPositionRect,
  className,
  onEscape,
  onReady,
  children,
  exitDuration,
  focusPanel = false,
  keepOpenOnModal = false,
  placement: forcedPlacement,
}: MenuPortalProps) {
  const leaving = useV8Leave(open, exitDuration)
  const [mounted, setMounted] = useState(false)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const readyRef = useRef(false)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor

  useEffect(() => {
    if (!open) return
    const modal = topModal()
    if (modal && !belongsToModal(anchorRef.current(), modal)) { closeRef.current(); return }
    const closeForModal = () => { if (!keepOpenOnModal) closeRef.current() }
    document.addEventListener(OVERLAY_MODAL_OPEN_EVENT, closeForModal)
    return () => document.removeEventListener(OVERLAY_MODAL_OPEN_EVENT, closeForModal)
  }, [open, keepOpenOnModal])
  const positionRef = useRef(getPositionRect)
  positionRef.current = getPositionRect

  const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)
      || openPanels.at(-1) !== panelRef.current) return
    event.preventDefault()
    if (escapeRef.current) escapeRef.current()
    else {
      const panel = panelRef.current
      const restoreFocus = focusPanel || panel?.contains(event.target as Node) || panel?.contains(document.activeElement)
      closeRef.current()
      const anchor = anchorRef.current()
      const target = anchor?.matches('button, input, a[href], [tabindex]')
        ? anchor : anchor?.querySelector<HTMLElement>('input, button, [tabindex="0"]')
      if (restoreFocus) target?.focus({ preventScroll: true })
    }
  }

  useLayoutEffect(() => {
    setMounted(true)
  }, [])

  useLayoutEffect(() => {
    if (!open || !mounted) return
    let closeRequested = false
    const measure = () => {
      if (closeRequested) return
      const anchor = anchorRef.current()
      const panel = panelRef.current
      if (!anchor || !panel) return
      const triggerRect = anchor.getBoundingClientRect()
      const anchorRect = positionRef.current?.() ?? triggerRect
      const minWidth = matchWidth === 'min' ? anchorRect.width : undefined
      // 'min' は欄の幅を下限にする。位置は下限を当てた後の幅で決める。
      const panelWidth = matchWidth === true
        ? anchorRect.width
        : Math.max(panel.offsetWidth, minWidth ?? 0)
      // 上限で切った後の高さではなく中身の全部の高さで開く向きを決める。
      const contentHeight = panel.scrollHeight || panel.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const margin = MENU_PORTAL_MARGIN
      const dialogContent = anchor?.closest<HTMLElement>('[data-dialog-content]')
      const contentRect = dialogContent?.getBoundingClientRect()
      if (contentRect && contentRect.height > 0 && triggerRect.height > 0 && (triggerRect.bottom <= contentRect.top || triggerRect.top >= contentRect.bottom)) { closeRequested = true; closeRef.current(); return }
      // 本文内に入る小さいパレットは本文へ収める。短い本文で選択肢を潰す場合はportal本来の画面内の余地を使う。
      const contentTop = Math.max(margin, contentRect?.top ?? margin)
      const contentBottom = Math.min(viewportHeight - margin, contentRect?.bottom ?? viewportHeight - margin)
      const fitsContent = Math.max(contentBottom - anchorRect.bottom - gap, anchorRect.top - gap - contentTop) >= contentHeight
      const upperBoundary = fitsContent ? contentTop : margin
      const lowerBoundary = fitsContent ? contentBottom : viewportHeight - margin
      const spaceBelow = lowerBoundary - anchorRect.bottom - gap
      const spaceAbove = anchorRect.top - gap - upperBoundary
      const placement = resolveMenuPlacement(forcedPlacement, contentHeight, spaceBelow, spaceAbove)
      // 開く方向に使える高さまで使う。入るなら全部、足りなければここで切る。
      const maxHeight = Math.max(0, placement === 'down' ? spaceBelow : spaceAbove)
      const shownHeight = Math.min(contentHeight || maxHeight, maxHeight)
      const top =
        placement === 'down'
          ? anchorRect.bottom + gap
          : Math.max(upperBoundary, anchorRect.top - gap - shownHeight)
      // 寄せた側で画面の端を越えるときは、反対側の端にそろえる（左寄せ→右端・右寄せ→左端）。
      let rawLeft = align === 'end' ? anchorRect.right - panelWidth : anchorRect.left
      if (align === 'start' && rawLeft + panelWidth > viewportWidth - margin) rawLeft = anchorRect.right - panelWidth
      if (align === 'end' && rawLeft < margin) rawLeft = anchorRect.left
      const left = Math.max(margin, Math.min(rawLeft, viewportWidth - panelWidth - margin))
      setGeometry({
        origin: triggerRect.left + triggerRect.width / 2 - left > panelWidth / 2 ? 'right' : 'left',
        top,
        left,
        width: matchWidth === true ? Math.max(0, panelWidth) : undefined,
        minWidth,
        placement,
        maxHeight,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    // 表の中・ダイアログの中など、入れ物のスクロールにも追従する。
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, mounted, align, gap, matchWidth, children])

  useLayoutEffect(() => {
    if (!open) { readyRef.current = false; return }
    // ref が付いた時点では測定中の visibility:hidden。表示後にだけ通知する。
    if (!mounted || !geometry || readyRef.current) return
    const panel = panelRef.current
    if (!panel) return
    const origin = document.activeElement
    let active = true
    const cancel = () => {
      active = false
      panel.removeEventListener('transitionend', onTransitionEnd)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('pointerdown', cancelByUser, true)
      document.removeEventListener('keydown', cancelByUser, true)
    }
    const cancelByUser = () => {
      // 利用者が先へ進んだ後は再測定でも初期焦点を取り直さない。
      readyRef.current = true
      cancel()
    }
    const onFocus = () => {
      if (document.activeElement !== origin && document.activeElement !== document.body) cancelByUser()
    }
    const notifyWhenVisible = () => {
      if (!active || readyRef.current || !panel.isConnected) return
      const target = panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
      const visibility = getComputedStyle(target ?? panel).visibility
      // 親が表示済みでも、子は継承した visibility の遷移中のことがある。
      const hidden = visibility === 'hidden' || visibility === 'collapse'
      if (hidden) {
        const transitioning = panel.getAnimations?.({ subtree: true }).some(animation => {
          const end = animation.effect?.getComputedTiming().endTime
          const owner = (animation.effect as KeyframeEffect | null)?.target
          return 'transitionProperty' in animation && animation.transitionProperty === 'visibility'
            && animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end)
            && owner instanceof Element && owner.contains(target ?? panel)
        }) ?? false
        // 元から隠れた操作や別の演出は、準備通知の完了条件にしない。
        if (transitioning) {
          document.addEventListener('focusin', onFocus, true)
          document.addEventListener('pointerdown', cancelByUser, true)
          document.addEventListener('keydown', cancelByUser, true)
          return
        }
      }
      readyRef.current = true
      cancel()
      onReadyRef.current?.()
      if (focusPanel && !hidden) target?.focus()
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === 'visibility') notifyWhenVisible()
    }
    panel.addEventListener('transitionend', onTransitionEnd)
    notifyWhenVisible()
    return cancel
  }, [open, mounted, geometry, focusPanel])

  // 下に続きがある間だけ下端の影を出す。入りきる時は影なし。
  useLayoutEffect(() => {
    if (!open || !mounted) return
    const panel = panelRef.current
    if (!panel) return
    const update = () => {
      setHasMore(
        hasMoreBelow({
          scrollHeight: panel.scrollHeight,
          scrollTop: panel.scrollTop,
          clientHeight: panel.clientHeight,
        }),
      )
    }
    update()
    panel.addEventListener('scroll', update, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (observer) observer.observe(panel)
    window.addEventListener('resize', update)
    return () => {
      panel.removeEventListener('scroll', update)
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [open, mounted, geometry?.maxHeight, children])

  useLayoutEffect(() => {
    if (!open || !mounted) return
    const panel = panelRef.current
    if (!panel) return
    const anchor = anchorRef.current()
    openPanels.push(panel)
    if (anchor) panelAnchors.set(panel, anchor)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current()?.contains(target)) return
      /*
       * R251: 別の器（MenuPortal）の中への押下は外側扱いにしない。
       * 時刻ダイアログの中の時・分 Select の候補は、body 直下の別の器に
       * 描かれる。外側扱いで先に閉じると click が届かず値が入らない。
       * 重なった器同士は、それぞれ自分の外への押下だけで閉じる。
       */
      const element = target as Partial<HTMLElement>
      if (typeof element.closest === 'function' && element.closest('[data-menu-portal]')) return
      closeRef.current()
    }
    const onKeyDown = dismissOnEscape
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openPanels.splice(openPanels.indexOf(panel), 1)
      panelAnchors.delete(panel)
      if (focusPanel && (panel.contains(document.activeElement) || document.activeElement === document.body)) anchor?.focus({ preventScroll: true })
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, mounted, focusPanel])

  if ((!open && (!exitDuration || !leaving)) || !mounted || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={panelRef}
      // 静的に読める形にする（直書き借金の見張り）。重なりの数字と
      // 画面端の上限は style へ。見た目（白地・角丸・浮きの影）は子が持つ。
      // 高さの上限と続きの影だけは器が持つ（子は自分の上限を外す）。
      className={`fixed min-w-0 ${styles.motion}${className ? ` ${className}` : ''}`}
      data-menu-portal=""
      data-ready={Boolean(geometry)}
      data-origin={geometry?.origin}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        // PortalのReactイベントは元の道具の段へも届く。外のdetails等を一緒に閉じない。
        event.stopPropagation()
        dismissOnEscape(event.nativeEvent)
      }}
      data-closing={leaving || undefined}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      data-placement={geometry?.placement ?? 'down'}
      // 開く動きの起点（押した角）を部品の CSS が決めるための印。
      data-align={align}
      data-has-more={hasMore ? 'true' : 'false'}
      style={{
        ...(className && hasMore ? ({ '--menu-portal-more': MORE_SHADOW } as CSSProperties) : null),
        top: geometry?.top ?? 0,
        left: geometry?.left ?? 0,
        width: geometry?.width,
        minWidth: geometry?.minWidth,
        zIndex: 120,
        maxWidth: 'calc(100vw - 16px)',
        // 開く方向に使える高さまで。入るなら全部、足りなければ中でスクロール。
        maxHeight: geometry?.maxHeight,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        // 下に続きがある間だけ下端の影（続きの目印）。
        // 見た目を器に持たせたとき（className）は、class が --menu-portal-more を重ねる。
        boxShadow: className ? undefined : hasMore ? MORE_SHADOW : undefined,
        // 測る前の一瞬だけ隠す（左上へのちらつき防止）。
        visibility: geometry ? undefined : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
