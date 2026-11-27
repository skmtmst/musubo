'use client'

import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import type { StyleExperienceScript } from './script-types'

/*
 * 1 つのタイマーが「今のスタイルと段」を持ち、3 つの画面は段を読むだけ（画面ごとにタイマーを持たない）。
 * 止める条件：［止める］・器が見えない・タブが裏・動きを減らす設定。外れたら同じ段の頭から数え直す。
 * 部品を外す時（窓を閉じる等）は effect の片付けでタイマーを残さない。
 */

export type AutoplayPosition = { style: AccountStyle; index: number }

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return reduced
}

/** 器が少しでも見えているか。IntersectionObserver が無い所は見えている扱い。 */
export function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setInView(entry.isIntersecting && entry.intersectionRatio > 0)
    }, { threshold: [0, 0.01] })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return inView
}

export function useTabVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  return visible
}

export function useStyleExperienceAutoplay({ script, style, onStyleChange, rotation, repeatStyle, rootRef }: {
  script: StyleExperienceScript
  /** 外から渡すと外が持つ。 */
  style?: AccountStyle
  onStyleChange?: (style: AccountStyle) => void
  /** 最後の段の後に進むスタイルの順。 */
  rotation: AccountStyle[]
  /** 同じスタイルをくり返す（切り替えを外が持つ時）。 */
  repeatStyle: boolean
  rootRef: RefObject<HTMLElement | null>
}) {
  const reduced = useReducedMotion()
  const inView = useInView(rootRef)
  const tabVisible = useTabVisible()
  const lastIndex = (name: AccountStyle) => Math.max(0, script.styles[name].scenes.length - 1)
  const clampIndex = useCallback((name: AccountStyle, index: number) => {
    const last = Math.max(0, script.styles[name].scenes.length - 1)
    if (!Number.isFinite(index)) return 0
    return Math.max(0, Math.min(Math.trunc(index), last))
  }, [script])
  const startIndex = (name: AccountStyle) => (reduced ? lastIndex(name) : 0)
  const [position, setPosition] = useState<AutoplayPosition>(() => {
    const first = style ?? rotation[0] ?? script.order[0]
    return { style: first, index: 0 }
  })
  const [userPaused, setUserPaused] = useState(false)
  const [manual, setManual] = useState(false)
  /** 同じスタイルの札をもう一度押した時に数え直すための印。 */
  const [restart, setRestart] = useState(0)

  // 外が持つスタイルが変わったら、そのスタイルの①（動きを減らす設定では最後の段）へ。
  if (style !== undefined && style !== position.style) { setPosition({ style, index: startIndex(style) }); setManual(true) }
  // 動きを減らす設定になったら、今のスタイルの最後の段で止める（その後は Steps を押した時だけ移る）。
  const [reducedSeen, setReducedSeen] = useState(reduced)
  if (reduced !== reducedSeen) {
    setReducedSeen(reduced)
    if (reduced) setPosition({ style: position.style, index: lastIndex(position.style) })
  }

  const running = !userPaused && inView && tabVisible && !reduced
  const safeIndex = clampIndex(position.style, position.index)
  const safePosition: AutoplayPosition = safeIndex === position.index ? position : { style: position.style, index: safeIndex }
  const scene = script.styles[safePosition.style].scenes[safePosition.index]

  useEffect(() => {
    if (!running || !scene) return
    const timer = window.setTimeout(() => {
      setManual(false)
      if (safePosition.index < lastIndex(safePosition.style)) {
        setPosition({ style: safePosition.style, index: safePosition.index + 1 })
        return
      }
      if (repeatStyle || rotation.length === 0) {
        setPosition({ style: safePosition.style, index: 0 })
        return
      }
      const at = rotation.indexOf(safePosition.style)
      const next = rotation[(at + 1) % rotation.length] ?? safePosition.style
      setPosition({ style: next, index: 0 })
      if (next !== safePosition.style) onStyleChange?.(next)
    }, scene.ms)
    return () => window.clearTimeout(timer)
    // 段・スタイル・止める条件・押した印が変わった時だけ数え直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, safePosition.style, safePosition.index, restart, repeatStyle])

  // 押せる段は今の段と違うので、段が変わったことでタイマーが数え直す。
  const goToStep = useCallback((index: number) => {
    setManual(true)
    setPosition((current) => ({ style: current.style, index: clampIndex(current.style, index) }))
  }, [clampIndex])

  const selectStyle = useCallback((next: AccountStyle) => {
    setManual(true)
    setPosition({ style: next, index: prefersReducedMotion() ? Math.max(0, script.styles[next].scenes.length - 1) : 0 })
    setRestart((value) => value + 1)
    onStyleChange?.(next)
  }, [onStyleChange, script])

  return { position: safePosition, scene, running, reduced, manual, userPaused, togglePause: () => setUserPaused((value) => !value), goToStep, selectStyle }
}
