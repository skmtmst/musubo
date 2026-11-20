'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Check } from 'lucide-react'
import Button from '@/components/shared/button'
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
  /**
   * いまこの手順の対象がある画面にいるか。
   * その画面にいる間は、対象がまだ描かれていないだけなので一時停止しない。
   * 案内と無関係な画面へ移った時だけ、従来どおり待って一時停止する。
   */
  onTargetScreen?: boolean
  /** 9項目それぞれの済み。実データ計測の値をそのまま渡す（ガイドで済みにしない）。 */
  segments: readonly boolean[]
  /** 「この手順をスキップ」と進行トリガーの両方から呼ぶ、次の手順へ。 */
  onAdvanceProcedure: () => void
  /** 帯の「一時停止」・ESC・対象外画面への移動から呼ぶ。 */
  onPause: () => void
  scripted?: boolean
  nextLabel?: string
}

function readRect(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

export function GuideOverlay({
  active, stepKey, stepLabel, stepOrder, procedureIndex, onTargetScreen = false,
  segments, onAdvanceProcedure, onPause, scripted = true, nextLabel,
}: GuideOverlayProps) {
  const total = scripted ? guideProcedureTotal(stepKey) : 0
  /*
    台本に無い手順番号（古い保存値など）でも案内を消さない。
    台本が分かっている段なら最後の手順に寄せて見せる。段そのものが分からない時だけ何も出さない。
  */
  const safeIndex = total > 0 ? Math.min(Math.max(procedureIndex, 1), total) : procedureIndex
  const procedure = scripted ? guideProcedure(stepKey, safeIndex) : null
  const anchorName = procedure?.anchor ?? null

  const [bottomOffset, setBottomOffset] = useState(0)
  const [inDialog, setInDialog] = useState(false)
  const [target, setTarget] = useState<Rect | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [balloonHeight, setBalloonHeight] = useState(0)
  const balloonRef = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return
    const width = window.innerWidth
    const height = window.innerHeight
    setViewport(previous => previous?.width === width && previous.height === height ? previous : { width, height })
    const saveControls = Array.from(document.querySelectorAll(
      '[data-sticky-actions], [data-guide-anchor="reception.save"], button[form="rs-table-editor"][type="submit"]',
    ))
    const reserved = saveControls.map(readRect).filter(box => box.height > 0 && box.top > height - 160 && box.top < height)
    setBottomOffset(Math.max(0, ...reserved.map(box => height - box.top + 8)))
    const element = anchorName ? document.querySelector(`[data-guide-anchor="${anchorName}"]`) : null
    const dialog = element?.closest('[role=dialog]')
    setInDialog(Boolean(dialog))
    const next = element ? readRect(dialog ?? element) : null
    setTarget(previous => previous && next && previous.left === next.left && previous.top === next.top &&
      previous.width === next.width && previous.height === next.height ? previous : next)
  }, [anchorName])

  /* スクロール追従・リサイズ再計算（枠14 izsr5）。 */
  useEffect(() => {
    if (!active) return
    measure()
    let frame = 0
    const scheduleMeasure = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => { frame = 0; measure() })
    }
    const observer = new MutationObserver(scheduleMeasure)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('scroll', scheduleMeasure, true)
    window.addEventListener('resize', scheduleMeasure)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [active, procedure, onTargetScreen, measure])

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
    if (!active || !stepLabel || (target && onTargetScreen) || (!anchorName && onTargetScreen)) return
    const timer = window.setTimeout(() => {
      if (anchorName && document.querySelector(`[data-guide-anchor="${anchorName}"]`)) { measure(); return }
      /*
        その手順の画面にいる間は止めない（差し戻し R1）。
        接続済みの時のように対象のボタンが出ない画面でも、吹き出しと帯は出したままにして
        操作を続けられるようにする。対象の無い手順と同じ置き方（右下）で見せる。
      */
      if (onTargetScreen) return
      onPause()
    }, MISSING_ANCHOR_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [active, anchorName, target, measure, onPause, onTargetScreen, stepLabel])

  /* ESCで一時停止（枠14 izsr5）。 */
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onPause() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onPause])

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

  if (!active || !stepKey || !viewport) return null

  const ring = target ? spotlightRing(target) : null
  const panels = target ? dimPanels(target, viewport) : []
  const tablesComplete = stepKey === 'attributes' && safeIndex === 3 && Boolean(stepOrder && segments[stepOrder - 1])
  const placement = target
    ? balloonPlacement(target, viewport, balloonHeight)
    // 対象を光らせない手順（枠 04-3）は画面の右下に置く。
    : tablesComplete
      ? { left: Math.max(16, Math.min(1000, viewport.width - 330 - 24)), top: Math.min(300, viewport.height / 3) }
      : { left: Math.max(16, viewport.width - 340 - 24), top: Math.max(16, viewport.height - balloonHeight - 120 - bottomOffset) }

  const order = stepOrder ? ORDER_MARKS[stepOrder - 1] : ''
  const label = order && stepLabel ? `${order} ${stepLabel}` : stepLabel ?? '開店準備'
  const caption = total ? `${label}（手順 ${safeIndex}/${total}）` : label

  return (
    <div className={styles.root} data-guide-dialog={inDialog || undefined} data-guide-table-complete={tablesComplete || undefined} style={{ '--guide-save-clearance': `${bottomOffset}px` } as CSSProperties}>
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

      <div className={styles.stack}>
        {procedure ? <div
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
          <p className={styles.body}>{tablesComplete ? procedure.body : stepKey === 'attributes' && safeIndex === 3 ? '受付中の卓を1件以上用意してください。追加を見送る場合は、この手順をスキップできます。' : procedure.body}</p>
          <div className={styles.balloonFooter}>
            <Button presentation="quiet-text" onClick={onAdvanceProcedure}>この手順をスキップ</Button>
          </div>
        </div> : null}
        {tablesComplete ? (
          <div className={styles.completed} role="status">
            <span className={styles.completeMark} aria-hidden="true"><Check size={14} /></span>
            <div className={styles.completeCopy}>
              <strong>{order} 卓と席の登録が完了しました</strong>
              <span className={styles.caption}>
                開店準備 {segments.filter(Boolean).length}/{segments.length}
                {nextLabel ? ` ・ 次は「${nextLabel}」です` : null}
              </span>
            </div>
            <Button size="compact" variant="primary" onClick={onAdvanceProcedure}>次へ進む</Button>
          </div>
        ) : null}
        <div className={styles.bar} data-guide-bar="">
          <div className={styles.barHeader}>
            <span className={styles.barTitle}>開店準備ガイド</span>
            <Button presentation="quiet-text" onClick={onPause}>一時停止</Button>
          </div>
          <div className={styles.progress}>
            {segments.map((done, index) => (
              <span key={`segment-${index}`} className={done ? `${styles.segment} ${styles.segmentDone}` : styles.segment} />
            ))}
          </div>
          <span className={styles.caption}>{caption}</span>
          {!procedure && stepLabel ? <div className={styles.barHeader}><Button presentation="quiet-text" onClick={onAdvanceProcedure}>この手順をスキップ</Button></div> : null}
        </div>
      </div>
    </div>
  )
}
