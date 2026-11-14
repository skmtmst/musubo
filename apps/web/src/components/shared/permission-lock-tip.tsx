'use client'

import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type KeyboardEvent, type PointerEvent } from 'react'
import TooltipBubble from './tooltip-bubble'

/** 素の操作の形を保ったまま、権限の理由を焦点・マウス・タッチで伝える。 */
export function usePermissionLockTip<T extends HTMLElement>(reason: string | null | undefined, describedBy?: string) {
  const reasonId = useId()
  const tipId = useId()
  const ref = useRef<T | null>(null)
  const frame = useRef(0)
  const [tip, setTip] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const previousReason = useRef(reason)
  const show = useCallback(() => {
    const element = ref.current
    if (!element || !reason) return
    const rect = element.getBoundingClientRect(), css = getComputedStyle(document.documentElement)
    const edge = parseFloat(css.getPropertyValue('--polish-space-row')) || 8
    const width = parseFloat(css.getPropertyValue('--polish-tooltip-width')) || 288
    const gap = parseFloat(css.getPropertyValue('--polish-tooltip-gap')) || 8
    const below = rect.top < 48
    setTip({ left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)), top: below ? rect.bottom + gap : rect.top - gap, below })
  }, [reason])
  const hide = useCallback(() => setTip(null), [])
  useEffect(() => {
    if (previousReason.current === reason) return
    previousReason.current = reason
    cancelAnimationFrame(frame.current)
    hide()
  }, [reason, hide])
  useEffect(() => {
    if (!reason) return
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { cancelAnimationFrame(frame.current); hide() } }
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => { cancelAnimationFrame(frame.current); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide) }
  }, [reason, hide])
  const block = (event: MouseEvent<T>) => { event.preventDefault(); event.stopPropagation() }
  const handlers = reason ? {
    disabled: false,
    'aria-disabled': true as const,
    'aria-describedby': [describedBy, reasonId].filter(Boolean).join(' '),
    'data-permission-locked': '',
    'data-no-name-tip': '',
    onPointerEnter: (event: PointerEvent<T>) => { if (event.pointerType !== 'touch') show() },
    onPointerLeave: (event: PointerEvent<T>) => { if (event.pointerType !== 'touch' && document.activeElement !== event.currentTarget) hide() },
    onPointerDown: (event: PointerEvent<T>) => { if (event.pointerType === 'touch') show() },
    onFocus: () => {
      show()
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => { if (document.activeElement === ref.current) show() })
    },
    onBlur: () => { cancelAnimationFrame(frame.current); hide() },
    onClick: block,
    onDoubleClick: block,
    onKeyDown: (event: KeyboardEvent<T>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation() } },
  } : undefined
  const node = reason ? <><span id={reasonId} hidden>{reason}</span>{tip ? <TooltipBubble id={tipId} text={reason} {...tip} /> : null}</> : null
  return { ref, handlers, node }
}
