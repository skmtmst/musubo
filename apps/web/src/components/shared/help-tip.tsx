'use client'

/*
 * 見出し・ラベル横の「？」（Pencil ★V8 `KjC1z`「？」）。
 *
 * 定義・分母・計算のしかた・単位・いつ時点の数か・言葉の意味だけを入れる。
 * 失敗・警告・操作の結果・必須の印・入力の直し方・数字そのものは入れない
 * （帯や欄の下の文で見せる）。
 */
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import styles from './help-tip.module.css'

const CLOSE_OTHERS_EVENT = 'help-tip-open'

/**
 * 補足の「？」。押す・タップ・Tab＋Enter で開く。ホバーだけでは開かない。
 * Esc や外を押すと閉じ、1つ開くと他は閉じる。
 */
export default function HelpTip({
  label,
  className,
  icon,
  trigger,
  hover = false,
  placement = 'below',
  reserveSpace = false,
  children,
}: {
  /** 読み上げ名（例：「今月の完了率の説明」）。吹き出しとは aria-describedby でつなぐ。 */
  label: string
  className?: string
  icon?: ReactNode
  /** 印を増やさず、題そのものから説明を開く場合。 */
  trigger?: ReactNode
  hover?: boolean
  placement?: 'above' | 'below'
  /** 開いた説明が次の本文を覆わないよう高さを確保する。 */
  reserveSpace?: boolean
  /**
   * 1〜2文の補足。長い説明がある場所への「くわしく」リンクも
   * ここへ一緒に渡す（`<a href="...">くわしく</a>`）。
   */
  children: ReactNode
}) {
  // 乗せた・焦点で読む状態と、押して開いた状態を分ける。
  const [openSource, setOpenSource] = useState<'automatic' | 'activation' | null>(null)
  const open = openSource !== null
  const tipId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const restoringFocus = useRef(false)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const [reservedHeight, setReservedHeight] = useState(0)

  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const place = () => {
      const anchor = buttonRef.current?.getBoundingClientRect()
      const tip = tipRef.current?.getBoundingClientRect()
      if (!anchor || !tip) return
      if (reserveSpace) setReservedHeight(tip.height + 12)
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - tip.width - 12))
      const preferredTop = placement === 'above' ? anchor.top - tip.height - 4 : anchor.bottom + 4
      const top = Math.max(12, Math.min(preferredTop, window.innerHeight - tip.height - 12))
      setPosition(previous => previous?.left === left && previous.top === top ? previous : { left, top })
    }
    const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) }
    place()
    window.addEventListener('resize', queue)
    window.addEventListener('scroll', queue, true)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', queue); window.removeEventListener('scroll', queue, true) }
  }, [open, children, placement, reserveSpace])

  // 1つ開くと他は閉じる。開いた側が合図し、違う持ち主だけ閉じる。
  useEffect(() => {
    if (!open) return
    const closeOthers = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tipId) setOpenSource(null)
    }
    window.addEventListener(CLOSE_OTHERS_EVENT, closeOthers)
    return () => window.removeEventListener(CLOSE_OTHERS_EVENT, closeOthers)
  }, [open, tipId])

  // Esc や外を押すと閉じる。Escでは押した？へ戻る。
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenSource(null)
      restoringFocus.current = true
      try { buttonRef.current?.focus() } finally { restoringFocus.current = false }
    }
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpenSource(null)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open ])

  const toggle = () => {
    setOpenSource((current) => {
      if (!current) window.dispatchEvent(new CustomEvent(CLOSE_OTHERS_EVENT, { detail: tipId }))
      if (hover && current === 'automatic') return 'activation'
      return current ? null : 'activation'
    })
  }

  return (
    <span
      ref={wrapRef}
      data-help-reserving={reserveSpace && open ? '' : undefined}
      style={reserveSpace && open ? { marginBottom: reservedHeight, alignSelf: 'flex-start' } : undefined}
      onMouseEnter={hover ? () => { window.dispatchEvent(new CustomEvent(CLOSE_OTHERS_EVENT, { detail: tipId })); setOpenSource(current => current ?? 'automatic') } : undefined}
      onPointerLeave={hover ? event => { if (event.pointerType !== 'touch') setOpenSource(current => current === 'automatic' ? null : current) } : undefined}
      onFocus={hover ? () => { if (restoringFocus.current) return; window.dispatchEvent(new CustomEvent(CLOSE_OTHERS_EVENT, { detail: tipId })); setOpenSource(current => current ?? 'automatic') } : undefined}
      className={[styles.wrap, className].filter(Boolean).join(' ')}
      onBlur={(event) => {
        if (!wrapRef.current?.contains(event.relatedTarget as Node)) setOpenSource(current => current === 'automatic' ? null : current)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={toggle}
        className={styles.button}
        data-help-trigger={trigger ? 'text' : undefined}
      >
        {/*
          ★V7 `LYs5d`「？ 補足の印」：18px の正円の中に「?」。
          角丸の正方形・楕円・枠なしは使わない（2026-09-28 オーナー指示）。
        */}
        {trigger ?? <span aria-hidden="true">{icon ? <span className={styles.sourceMark}>{icon}</span> : <CircleHelp className={styles.markIcon} strokeWidth={1.75} aria-hidden="true" data-help-mark="" />}</span>}
      </button>
      {open ? (
        <span ref={tipRef} role="note" id={tipId} className={styles.tip} style={position}>
          {children}
        </span>
      ) : null}
    </span>
  )
}
