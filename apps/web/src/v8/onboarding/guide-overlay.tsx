'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { scrollMotion } from '@/components/shared/overlay-utils'
import { balloonPlacement, dimPanels, isOffScreen, spotlightRing, type Rect } from './guide-overlay-geometry'
import { guideProcedure, guideProcedureTotal } from './guide-script'
import styles from './guide-overlay.module.css'

/*
  手順別の案内（スポットライト＋吹き出し＋ガイド帯）。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 04-1 (dQfu4) の見た目と、枠 14 (orKSi) の共通ルール izsr5 のふるまいに従う。

  文面は guide-script.ts（Penの承認済みの語）だけから出す。ここで作らない。
*/

const ORDER_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'] as const

/** 対象が見つからない時に待つ長さ。画面の移り変わりの間に一時停止させないための猶予。 */
const MISSING_ANCHOR_WAIT_MS = 1500

export type GuideOverlayProps = {
  /** 案内中だけ出す。一時停止・未開始・完了では何も出さない。 */
  active: boolean
  stepKey: string | null
  stepLabel: string | null
  /** 9項目の何番目か（1から）。帯の見出し「④ 卓と席を登録する」に使う。 */
  stepOrder: number | null
  procedureIndex: number
  /** 9項目それぞれの済み。実データ計測の値をそのまま渡す（ガイドで済みにしない）。 */
  segments: readonly boolean[]
  /** 「この手順をスキップ」と進行トリガーの両方から呼ぶ、次の手順へ。 */
  onAdvanceProcedure: () => void
  /** 帯の「一時停止」・ESC・対象外画面への移動から呼ぶ。 */
  onPause: () => void
}

function readRect(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

export function GuideOverlay({
  active, stepKey, stepLabel, stepOrder, procedureIndex, segments, onAdvanceProcedure, onPause,
}: GuideOverlayProps) {
  const total = guideProcedureTotal(stepKey)
  /*
    台本に無い手順番号（古い保存値など）でも案内を消さない。
    台本が分かっている段なら最後の手順に寄せて見せる。段そのものが分からない時だけ何も出さない。
  */
  const safeIndex = total > 0 ? Math.min(Math.max(procedureIndex, 1), total) : procedureIndex
  const procedure = guideProcedure(stepKey, safeIndex)
  const anchorName = procedure?.anchor ?? null

  const [target, setTarget] = useState<Rect | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [balloonHeight, setBalloonHeight] = useState(0)
  const balloonRef = useRef<HTMLDivElement | null>(null)
  /** 対象がすぐ見つからない時に一度だけ待つ。描き途中で一時停止にしない。 */
  const missingSince = useRef<number | null>(null)

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return
    setViewport({ width: window.innerWidth, height: window.innerHeight })
    if (!anchorName) { setTarget(null); return }
    const element = document.querySelector(`[data-guide-anchor="${anchorName}"]`)
    if (!element) { setTarget(null); return }
    missingSince.current = null
    setTarget(readRect(element))
  }, [anchorName])

  /* スクロール追従・リサイズ再計算（枠14 izsr5）。 */
  useEffect(() => {
    if (!active || !procedure) return
    measure()
    const onScroll = () => measure()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [active, procedure, measure])

  /* 対象が画面外なら自動スクロール（枠14 izsr5）。 */
  useEffect(() => {
    if (!active || !anchorName || !target || !viewport) return
    if (!isOffScreen(target, viewport)) return
    document.querySelector(`[data-guide-anchor="${anchorName}"]`)
      ?.scrollIntoView({ block: 'center', behavior: scrollMotion() })
  }, [active, anchorName, target, viewport])

  /*
    ガイド対象外の画面へ移動したら自動で一時停止（枠14 izsr5）。
    対象を持つ手順で、待っても対象が現れない時だけ止める。
  */
  useEffect(() => {
    if (!active || !anchorName || target) return
    if (missingSince.current === null) missingSince.current = 1
    /*
      画面を移った直後は対象がまだ描かれていない。
      描き足されるのを見張って、現れたらその場で測る（ここで測り直さないと光らないままになる）。
    */
    const observer = new MutationObserver(() => {
      if (document.querySelector(`[data-guide-anchor="${anchorName}"]`)) measure()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setTimeout(() => {
      if (document.querySelector(`[data-guide-anchor="${anchorName}"]`)) { measure(); return }
      onPause()
    }, MISSING_ANCHOR_WAIT_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [active, anchorName, target, measure, onPause])

  /* ESCで一時停止（枠14 izsr5）。 */
  useEffect(() => {
    if (!active || !procedure) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onPause() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, procedure, onPause])

  /*
    対象を押した時に進む手順（trigger 'click'）。
    保存や入力で進む手順（'event' / 'valid'）は画面側が onAdvanceProcedure を呼ぶ。
  */
  useEffect(() => {
    if (!active || !anchorName || procedure?.trigger !== 'click') return
    const element = document.querySelector(`[data-guide-anchor="${anchorName}"]`)
    if (!element) return
    const onClick = () => onAdvanceProcedure()
    element.addEventListener('click', onClick)
    return () => element.removeEventListener('click', onClick)
  }, [active, anchorName, procedure?.trigger, target, onAdvanceProcedure])

  useLayoutEffect(() => {
    const height = balloonRef.current?.getBoundingClientRect().height ?? 0
    if (height && height !== balloonHeight) setBalloonHeight(height)
  }, [procedure, balloonHeight, target])

  if (!active || !procedure || !viewport) return null

  const ring = target ? spotlightRing(target) : null
  const panels = target ? dimPanels(target, viewport) : []
  const placement = target
    ? balloonPlacement(target, viewport, balloonHeight)
    // 対象を光らせない手順（枠 04-3）は画面の右下に置く。
    : { left: Math.max(16, viewport.width - 340 - 24), top: Math.max(16, viewport.height - balloonHeight - 120), side: 'below' as const }

  const caption = stepLabel && stepOrder
    ? `${ORDER_MARKS[stepOrder - 1] ?? ''} ${stepLabel}（手順 ${safeIndex}/${total}）`
    : `手順 ${safeIndex}/${total}`

  return (
    <div className={styles.root}>
      {panels.map((panel, index) => (
        <div
          key={`dim-${index}`}
          className={styles.dim}
          style={{ left: panel.left, top: panel.top, width: panel.width, height: panel.height }}
        />
      ))}
      {ring ? (
        <div
          className={styles.ring}
          data-guide-spotlight={anchorName ?? ''}
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
        />
      ) : null}

      {/* 読み上げに乗せる（枠14 izsr5「吹き出しはaria-liveで読み上げ」）。 */}
      <div
        ref={balloonRef}
        className={styles.balloon}
        style={{ left: placement.left, top: placement.top }}
        role="status"
        aria-live="polite"
        data-guide-balloon={`${stepKey ?? ''}:${safeIndex}`}
      >
        <div className={styles.balloonHeader}>
          <span className={styles.pill}>{`手順 ${safeIndex}/${total}`}</span>
          <span className={styles.title}>{procedure.title}</span>
        </div>
        <p className={styles.body}>{procedure.body}</p>
        <div className={styles.balloonFooter}>
          <button type="button" className={styles.skip} onClick={onAdvanceProcedure}>この手順をスキップ</button>
        </div>
      </div>

      <div className={styles.bar} data-guide-bar="" style={{ left: 264, top: Math.max(16, viewport.height - 84) }}>
        <div className={styles.barHeader}>
          <span className={styles.barTitle}>開店準備ガイド</span>
          <button type="button" className={styles.barPause} onClick={onPause}>一時停止</button>
        </div>
        <div className={styles.progress}>
          {segments.map((done, index) => (
            <span key={`segment-${index}`} className={done ? `${styles.segment} ${styles.segmentDone}` : styles.segment} />
          ))}
        </div>
        <span className={styles.caption}>{caption}</span>
      </div>
    </div>
  )
}
