'use client'

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { isImeComposing } from './ime'

export const OverlayDepthContext = createContext(0)
const activeOverlays = new Map<object, { depth: number; order: number }>()
let overlayOrder = 0
const openLayers = new Map<object, number>()
/** 窓・引き出しの重なりの基準。後から開いたものほど上（+1 ずつ）。メニューなど上に出す物は 100 以上。 */
export const OVERLAY_LAYER_BASE = 90
export const OVERLAY_DEPTH_STEP = 32
export const OVERLAY_MENU_BASE = 120
/** A newly opened modal closes existing non-modal portal panels such as the notification popover. */
export const OVERLAY_MODAL_OPEN_EVENT = 'overlay:modal-open'
/**
 * 後から開いた窓・引き出しを前に出す。窓の上に引き出しを、引き出しの上に窓を開いても、
 * 新しい方が手前になる（画面ごとの z-index は書かない）。開いている間だけ番号を持つ。
 */
export function useOverlayLayer(open: boolean): number {
  const key = useRef<object>({})
  const depth = useContext(OverlayDepthContext)
  const [layer, setLayer] = useState(OVERLAY_LAYER_BASE + depth * OVERLAY_DEPTH_STEP)
  useEffect(() => {
    if (!open) return
    const self = key.current
    const minimum = OVERLAY_LAYER_BASE + depth * OVERLAY_DEPTH_STEP
    const next = Math.max(minimum, ...[...openLayers.values()].map(value => value + 1))
    setLayer(next)
    openLayers.set(self, next)
    return () => { openLayers.delete(self) }
  }, [open, depth])
  return layer
}
let originalOverflow = ''

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** モーダル系のフォーカス移動・Escape・背景スクロール停止を1か所にまとめる。 */
export function useOverlayFocus<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  closeDisabled = false,
  /**
   * 初回に寄せる要素。未指定なら先頭の操作へ寄せる従来どおり。
   * 未保存の離脱確認のように「残る方」を主にする窓で、主のボタンへ寄せる。
   */
  initialFocus?: () => HTMLElement | null,
): RefObject<T | null> {
  const depth = useContext(OverlayDepthContext)
  const identity = useRef<object>({})
  const containerRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  const initialFocusRef = useRef(initialFocus)
  const closeDisabledRef = useRef(closeDisabled)
  closeDisabledRef.current = closeDisabled

  useEffect(() => {
    onCloseRef.current = onClose
    initialFocusRef.current = initialFocus
  }, [onClose, initialFocus])

  useEffect(() => {
    if (!open) return
    const key = identity.current
    const order = ++overlayOrder
    if (activeOverlays.size === 0) originalOverflow = document.body.style.overflow
    activeOverlays.set(key, { depth, order })
    const isTop = () => {
      const top = [...activeOverlays.entries()].sort((a, b) => b[1].depth - a[1].depth || b[1].order - a[1].order)[0]
      return top?.[0] === key
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'

    /*
     * containerRef.current は効果の中で一度だけ読まず、使うたびに読む。
     * open=true で初回マウントした部品は、最初は通常DOMへ描き、effectで
     * portal へ移す（shared/dialog.tsx 等）。その切替で ref が別の要素へ
     * 付け替わるため、掴んだままの要素は外れたDOMを指してしまう（DEEP-15）。
     */
    const focusable = () =>
      Array.from(containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    // 初回フォーカスの予約は cleanup で取消せるようにしておく。
    const initialFocusFrame = requestAnimationFrame(() => {
      if (isTop() && !containerRef.current?.contains(document.activeElement)) {
        (initialFocusRef.current?.() ?? focusable()[0])?.focus()
      }
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented || isImeComposing(event)) return
      if (event.key === 'Escape' && !closeDisabledRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        containerRef.current?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(initialFocusFrame)
      document.removeEventListener('keydown', onKeyDown)
      const restoreFocus = isTop()
      activeOverlays.delete(key)
      if (activeOverlays.size === 0) {
        document.body.style.overflow = originalOverflow
      }
      if (restoreFocus) previous?.focus()
    }
  }, [open, depth])

  return containerRef
}

/**
 * 動きの変数（--motion-*）の長さを ms で読む。JS のタイマーを CSS の動きと
 * 同じ長さにそろえるため（数字を JS に直書きしない。動きの点検 18 番）。
 */
export function motionMs(name: string, fallback: number): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value
}

/** 動きの曲線（--motion-ease-*）を読む。JS の動きも CSS と同じ曲線にそろえる（曲線を直書きしない）。 */
export function motionEasing(name: '--motion-ease-out' | '--motion-ease-in-out' | '--motion-spring' | '--motion-glide' = '--motion-ease-out'): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return 'ease-out'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease-out'
}

/** 閉じる動きの長さ（--motion-exit）。読めなければ 150ms。 */
function exitMs(): number {
  return motionMs('--motion-exit', 150)
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 閉じる動きを付けてよいか。動きを減らす設定では即時に外す。
 */
/** 画面の中を動かす時の速さ。動きを減らす設定では、なめらかに流さず一度で移る。 */
export function scrollMotion(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

export function shouldAnimateLeave(): boolean {
  return typeof document !== 'undefined'
    && !prefersReducedMotion()
}

/*
 * ★V8 仕上げ（M10）：窓・引き出しの「閉じるときは逆再生」。
 * 閉じの印を残す（--motion-exit ぶん）。開き直したら印を消す。
 *
 * 閉じの印は「描画の中」で立てる（2026-10-07 動きの点検 1 番）。
 * 以前は effect の中で立てていたので、閉じた最初の描画では
 * open=false・leaving=false になり、窓が一度外れてから付け直され
 * （消える→ふわっと出る→消える）とちらついていた。
 * 前の open を state に持ち、変わった描画のうちに leaving を決めると、
 * React はその描画を捨てて同じ描画で leaving=true から描き直す。
 * 動きを減らす設定では逆再生しないので、印も立てずに即時に外す。
 */
export function useV8Leave(open: boolean, ms?: number): boolean {
  const [leaving, setLeaving] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  if (previousOpen !== open) {
    setPreviousOpen(open)
    setLeaving(!open && shouldAnimateLeave())
  }
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(false), ms ?? exitMs())
    return () => clearTimeout(timer)
  }, [leaving, ms])
  return leaving
}

/** 消えかけの1件。`leaving` が true の間は閉じる動きを見せてから外す。 */
export type LeavingEntry<T> = { item: T; leaving: boolean }

/*
 * 並ぶもの（知らせなど）の「消えかけ」（動きの点検 13 番）。
 * `useV8Leave` と同じく、外れた描画のうちに消えかけへ移し、
 * --motion-exit ぶん残してから外す。1件ずつ自分の期限で外すので、
 * 続けて消えても先の1件が長く残らない。
 * 動きを減らす設定では即時に外す。
 */
export function useV8LeaveList<T extends { id: number }>(items: readonly T[], ms?: number): LeavingEntry<T>[] {
  const [previous, setPrevious] = useState(items)
  const [leavingItems, setLeavingItems] = useState<{ item: T; until: number }[]>([])
  if (previous !== items) {
    setPrevious(items)
    const ids = new Set(items.map((item) => item.id))
    // 戻ってきたもの（同じ id）は消えかけから外す。
    const kept = leavingItems.filter((entry) => !ids.has(entry.item.id))
    const gone = shouldAnimateLeave()
      ? previous.filter((item) => !ids.has(item.id) && !kept.some((entry) => entry.item.id === item.id))
      : []
    if (gone.length > 0 || kept.length !== leavingItems.length) {
      const until = Date.now() + (ms ?? exitMs())
      setLeavingItems([...kept, ...gone.map((item) => ({ item, until }))])
    }
  }
  useEffect(() => {
    if (leavingItems.length === 0) return
    const next = Math.min(...leavingItems.map((entry) => entry.until))
    const timer = setTimeout(() => {
      const now = Date.now()
      setLeavingItems((current) => current.filter((entry) => entry.until > now))
    }, Math.max(0, next - Date.now()))
    return () => clearTimeout(timer)
  }, [leavingItems])
  return [
    ...items.map((item) => ({ item, leaving: false })),
    ...leavingItems.map((entry) => ({ item: entry.item, leaving: true })),
  ].sort((a, b) => a.item.id - b.item.id)
}
