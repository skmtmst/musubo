'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import TooltipBubble from './tooltip-bubble'

/** 名前の吹き出しを出す相手。文字を持たず aria-label だけで名前を伝える押せるもの。 */
const TARGET = 'button[aria-label], a[href][aria-label], [role="button"][aria-label]'
const HOVER_DELAY_MS = 400

/** 見える文字を持たない（印だけの）押せるものか。 */
export function isIconOnlyAction(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.closest('[data-no-name-tip]')) return false
  if (!el.getAttribute('aria-label')?.trim()) return false
  return !(el.textContent ?? '').trim()
}

/**
 * アイコンだけのボタンに、aria-label と同じ文の吹き出しを出す。
 * 画面ごとに吹き出しを書かず、全画面で1つだけ置く（ToastHost と同じ置き方）。
 * 指を乗せて 0.4 秒、またはキーボードで移った時に出し、離す・押す・Esc・送ると消す。
 */
export default function NameTipHost() {
  const id = useId()
  const [tip, setTip] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const current = useRef<HTMLElement | null>(null)
  const savedTitle = useRef<string | null>(null)
  const observer = useRef<MutationObserver | null>(null)

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    observer.current?.disconnect()
    observer.current = null
    const el = current.current
    if (el) {
      if (savedTitle.current !== null && !el.hasAttribute('title') && isIconOnlyAction(el)) el.setAttribute('title', savedTitle.current)
      if (el.getAttribute('aria-describedby') === id) el.removeAttribute('aria-describedby')
    }
    current.current = null
    savedTitle.current = null
    setTip(null)
  }, [id])

  const show = useCallback((el: HTMLElement) => {
    const text = el.getAttribute('aria-label')?.trim()
    if (!text || !el.isConnected || !isIconOnlyAction(el)) return
    const rect = el.getBoundingClientRect()
    const css = getComputedStyle(document.documentElement)
    const edge = Number.parseFloat(css.getPropertyValue('--polish-space-row')) || 8
    const width = Number.parseFloat(css.getPropertyValue('--polish-tooltip-width')) || 288
    const gap = Number.parseFloat(css.getPropertyValue('--polish-tooltip-gap')) || 8
    const below = rect.top < 48
    // 同じ名前の title があるとブラウザの吹き出しが重なるので、出している間だけ外す。
    const title = el.getAttribute('title')
    if (title !== null) { savedTitle.current = title; el.removeAttribute('title') }
    if (!el.getAttribute('aria-describedby')) el.setAttribute('aria-describedby', id)
    setTip({ text, left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)), top: below ? rect.bottom + gap : rect.top - gap, below })
  }, [id])

  useEffect(() => {
    const target = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.(TARGET)
      return el && isIconOnlyAction(el) ? el : null
    }
    const begin = (el: HTMLElement, delay: number) => {
      if (current.current === el) return
      hide()
      current.current = el
      const name = el.getAttribute('aria-label')?.trim()
      observer.current = new MutationObserver(() => {
        if (current.current === el && (!isIconOnlyAction(el) || el.getAttribute('aria-label')?.trim() !== name || el.matches(':disabled, [aria-disabled="true"]'))) hide()
      })
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
        observer.current.observe(parent, { attributes: true, attributeFilter: ['data-no-name-tip', 'aria-label', 'aria-disabled', 'disabled'] })
      }
      timer.current = setTimeout(() => show(el), delay)
    }
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const el = target(event)
      if (el) begin(el, HOVER_DELAY_MS)
    }
    const out = (event: PointerEvent) => {
      const el = current.current
      if (el && !el.contains(event.relatedTarget as Node | null)) hide()
    }
    const focusIn = (event: FocusEvent) => {
      const el = target(event)
      let keyboard = false
      try { keyboard = Boolean(el?.matches(':focus-visible')) } catch { keyboard = false }
      if (el && keyboard) begin(el, 0)
    }
    const focusOut = (event: FocusEvent) => { if (current.current && event.target === current.current) hide() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && current.current) hide() }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      hide()
    }
  }, [hide, show])

  return tip ? <TooltipBubble id={id} text={tip.text} left={tip.left} top={tip.top} below={tip.below} /> : null
}
