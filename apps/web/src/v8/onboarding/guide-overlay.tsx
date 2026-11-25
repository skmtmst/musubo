'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import Button from '@/components/shared/button'
import { scrollMotion } from '@/components/shared/overlay-utils'
import { balloonPlacement, dimPanels, isOffScreen, spotlightRing, type Rect } from './guide-overlay-geometry'
import { guideProcedure, guideProcedureTotal, receptionGuideCopy } from './guide-script'
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
const NARROW_GUIDE_WIDTH = 480
const TABLE_GUIDE_WIDTH = 316
const TABLE_GUIDE_GAP = 27
const TABLE_GUIDE_TOP = 91

export type GuideOverlayProps = {
  /** 案内中だけ出す。一時停止・未開始・完了では何も出さない。 */
  active: boolean
  showOverlay?: boolean
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
  onAdvanceProcedure: (skipRemainingProcedures?: boolean) => void
  /** 帯の「一時停止」・ESC・対象外画面への移動から呼ぶ。 */
  onPause: () => void
  scripted?: boolean
  nextLabel?: string
  showProcedure?: boolean
}

function readRect(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

function readVisibleRect(element: Element, container: Element): Rect | null {
  const box = element.getBoundingClientRect()
  const area = container.getBoundingClientRect()
  const left = Math.max(box.left, area.left)
  const top = Math.max(box.top, area.top)
  const width = Math.min(box.right, area.right) - left
  const height = Math.min(box.bottom, area.bottom) - top
  return width > 0 && height > 0 ? { left, top, width, height } : null
}

export function GuideOverlay({
  active, showOverlay = true, stepKey, stepLabel, stepOrder, procedureIndex, onTargetScreen = false,
  segments, onAdvanceProcedure, onPause, scripted = true, nextLabel, showProcedure = true,
}: GuideOverlayProps) {
  const total = scripted ? guideProcedureTotal(stepKey) : 0
  /*
    台本に無い手順番号（古い保存値など）でも案内を消さない。
    台本が分かっている段なら最後の手順に寄せて見せる。段そのものが分からない時だけ何も出さない。
  */
  const courseEditorStep = scripted && stepKey === 'friendAdd' && procedureIndex >= 2
  const safeIndex = total > 0 ? Math.min(Math.max(procedureIndex, 1), total) : procedureIndex
  const procedure = scripted && showProcedure ? guideProcedure(stepKey, safeIndex) : null
  const anchorName = procedure?.anchor ?? null

  const [bottomOffset, setBottomOffset] = useState(0)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [inDialog, setInDialog] = useState(false)
  const [actionLabel, setActionLabel] = useState<string | null>(null)
  const [applyingHours, setApplyingHours] = useState(false)
  const [receptionMode, setReceptionMode] = useState<string | null>(null)
  const [receptionSeats, setReceptionSeats] = useState<string | null>(null)
  const [inputReady, setInputReady] = useState(false)
  const [tableDialog, setTableDialog] = useState<Rect | null>(null)
  const [tableConditions, setTableConditions] = useState(false)
  const [target, setTarget] = useState<Rect | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [balloonHeight, setBalloonHeight] = useState(0)
  const balloonRef = useRef<HTMLDivElement | null>(null)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const scrolledTarget = useRef<{ element: Element; anchor: string; narrow: boolean } | null>(null)

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return
    const width = window.innerWidth
    const height = window.innerHeight
    setViewport(previous => previous?.width === width && previous.height === height ? previous : { width, height })
    const saveControls = Array.from(document.querySelectorAll(
      '[data-sticky-actions], [data-guide-anchor="reception.save"], button[form="rs-table-editor"][type="submit"]',
    ))
    const narrow = width <= NARROW_GUIDE_WIDTH
    const reserved = saveControls.map(element =>
      readRect(narrow ? element.closest('[data-shared-part="sticky-bar"]') ?? element : element),
    ).filter(box => box.height > 0 && box.top < height &&
      (narrow ? box.top + box.height >= height - (courseEditorStep ? 240 : 32) : box.top > height - 160))
    setBottomOffset(Math.max(0, ...reserved.map(box => height - box.top + 8)))
    const selector = `[data-guide-anchor="${anchorName}"]`
    const slotSelector = `[data-guide-slot="${anchorName}"]${width >= 1152 ? ':not([data-guide-narrow])' : ''}`
    const nextSlot = anchorName ? Array.from(document.querySelectorAll<HTMLElement>(slotSelector)).at(-1) ?? null : null
    const panel = nextSlot?.closest('[role=dialog], [role=alertdialog]')
    const element = anchorName ? (panel ?? document).querySelector(selector) : null
    const dialog = panel ?? element?.closest('[role=dialog]')
    setSlot(nextSlot)
    const guideLabel = element?.getAttribute('data-guide-action-label')
    if (anchorName === 'menu.save' && element && !guideLabel) {
      if (element.getAttribute('aria-busy') !== 'true') setActionLabel(element.textContent?.trim() || null)
    } else {
      setActionLabel(guideLabel ?? null)
    }
    setApplyingHours(element?.hasAttribute('data-guide-hours-apply') ?? false)
    setReceptionMode(element?.hasAttribute('data-guide-hours-setup') ? 'hours' : element?.getAttribute('data-guide-reception-state') ?? null)
    setReceptionSeats(element?.getAttribute('data-guide-reception-count') ?? null)
    const courseMenuOpen = anchorName?.startsWith('menu.') && element?.querySelector('[aria-expanded="true"]')
    setInputReady(Boolean(element?.hasAttribute('data-guide-ready') && !courseMenuOpen))
    setInDialog(Boolean(dialog))
    const editingConditions = anchorName === 'tables.form' && Boolean(element?.querySelector('[data-table-conditions][aria-expanded="true"]'))
    setTableConditions(editingConditions)
    const tableSave = anchorName === 'tables.form' && !editingConditions ? dialog?.querySelector('[data-guide-table-save=ready]') : null
    const tableBox = anchorName === 'tables.form' && dialog ? readRect(dialog) : null
    setTableDialog(previous => previous && tableBox && previous.left === tableBox.left && previous.top === tableBox.top &&
      previous.width === tableBox.width && previous.height === tableBox.height ? previous : tableBox)
    const highlight = tableSave ?? (anchorName === 'tables.form' ? dialog ?? element : element)
    const clippingContainer = anchorName === 'followup.body' ? highlight?.closest('[data-dialog-content]') : null
    const next = highlight && (clippingContainer ? readVisibleRect(highlight, clippingContainer) : readRect(highlight))
    setTarget(previous => previous && next && previous.left === next.left && previous.top === next.top &&
      previous.width === next.width && previous.height === next.height ? previous : next)
  }, [anchorName, courseEditorStep])

  /* スクロール追従・リサイズ再計算（枠14 izsr5）。 */
  useEffect(() => {
    if (!active) return
    measure()
    let frame = 0
    const scheduleMeasure = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => { frame = 0; measure() })
    }
    const onDialogTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === 'transform' && event.target instanceof Element && event.target.matches('[role=dialog]')) {
        scheduleMeasure()
      }
    }
    const observer = new MutationObserver(scheduleMeasure)
    observer.observe(document.body, { childList: true, subtree: true, attributeFilter: [
      'data-guide-table-save', 'data-guide-ready', 'aria-expanded', 'data-guide-reception-state', 'data-guide-reception-count',
    ] })
    window.addEventListener('scroll', scheduleMeasure, true)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('transitionend', onDialogTransitionEnd, true)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('transitionend', onDialogTransitionEnd, true)
    }
  }, [active, procedure, onTargetScreen, measure])

  const fixedNarrowGuide = active && showOverlay && Boolean(stepKey) && !slot &&
    viewport !== null && viewport.width <= NARROW_GUIDE_WIDTH

  // 下部ガイドの分だけスクロールできる余白を持たせ、最後の入力や操作も手前に出せるようにする。
  useLayoutEffect(() => {
    const stack = stackRef.current
    const main = document.getElementById('main-content')
    if (!fixedNarrowGuide || !stack || !main || !viewport) return
    const reserveSpace = () => {
      const inset = Math.max(0, viewport.height - stack.getBoundingClientRect().top)
      main.style.setProperty('--guide-scroll-clearance', `${Math.ceil(inset)}px`)
    }
    main.setAttribute('data-guide-scroll-reserved', '')
    reserveSpace()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserveSpace)
    observer?.observe(stack)
    return () => {
      observer?.disconnect()
      main.removeAttribute('data-guide-scroll-reserved')
      main.style.removeProperty('--guide-scroll-clearance')
    }
  }, [fixedNarrowGuide, viewport, bottomOffset])

  // 対象を初めに表示する。あとから写真や別の欄へスクロールしたときは引き戻さない。
  useEffect(() => {
    if (!active || !showOverlay || !anchorName || !target || !viewport || slot) {
      scrolledTarget.current = null
      return
    }
    const element = document.querySelector(`[data-guide-anchor="${anchorName}"]`)
    if (!element) return
    const previous = scrolledTarget.current
    if (previous?.element === element && previous.anchor === anchorName && previous.narrow === fixedNarrowGuide) return
    const stack = stackRef.current
    const overlap = fixedNarrowGuide && stack !== null && target.top + target.height > stack.getBoundingClientRect().top
    scrolledTarget.current = { element, anchor: anchorName, narrow: fixedNarrowGuide }
    if (fixedNarrowGuide && anchorName === 'menu.save') {
      element.closest('main')?.scrollTo({ top: 0, behavior: scrollMotion() })
    } else if (overlap || isOffScreen(target, viewport)) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: scrollMotion() })
    }
  }, [active, showOverlay, anchorName, target, viewport, slot, fixedNarrowGuide])

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onPause()
    }
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

  const hasViewport = viewport !== null
  useLayoutEffect(() => {
    const balloon = balloonRef.current
    if (!balloon) return
    const measureHeight = () => setBalloonHeight(balloon.getBoundingClientRect().height)
    measureHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureHeight)
    observer.observe(balloon)
    return () => observer.disconnect()
  }, [active, procedure, slot, hasViewport])

  if (!active || !showOverlay || !stepKey || !viewport) return null

  const desktopTable = slot && tableDialog && tableDialog.left + tableDialog.width + TABLE_GUIDE_GAP + TABLE_GUIDE_WIDTH + 16 <= viewport.width &&
    tableDialog.top + TABLE_GUIDE_TOP + balloonHeight + 16 <= viewport.height ? tableDialog : null
  const inlineGuide = Boolean(slot && !desktopTable)
  const compactCourseGuide = fixedNarrowGuide && courseEditorStep && Boolean(procedure)
  const compactTableGuide = inlineGuide && anchorName === 'tables.form' && viewport.width <= NARROW_GUIDE_WIDTH
  const tableSaveTarget = tableDialog && target && target.width < tableDialog.width
  const ring = target && (!compactTableGuide || tableSaveTarget)
    ? spotlightRing(target, tableDialog ? 4 : undefined) : null
  const tableRing = desktopTable && tableSaveTarget ? spotlightRing(desktopTable, 4) : null
  const panels = target && !slot ? dimPanels(target, viewport) : []
  const tablesComplete = stepKey === 'attributes' && safeIndex === 3 && Boolean(stepOrder && segments[stepOrder - 1])
  const courseBasics = courseEditorStep && anchorName !== 'menu.save' && viewport.width >= 1280
  const placement = target
    ? desktopTable
      ? { left: desktopTable.left + desktopTable.width + TABLE_GUIDE_GAP, top: desktopTable.top + TABLE_GUIDE_TOP }
      : anchorName === 'hours.confirm' && !applyingHours && !slot && viewport.width >= 1152
        ? { left: Math.min(viewport.width - 366, Math.max(760, target.left + target.width + 26)),
            top: Math.max(16, Math.min(target.top - 47, viewport.height - balloonHeight - 16)) }
        : balloonPlacement(target, viewport, balloonHeight, courseBasics ? 246 : undefined)
    : tablesComplete
      ? { left: Math.max(16, Math.min(1000, viewport.width - 330 - 24)), top: Math.min(300, viewport.height / 3) }
      : { left: Math.max(16, viewport.width - 340 - 24), top: Math.max(16, viewport.height - balloonHeight - 120 - bottomOffset) }

  const order = stepOrder ? ORDER_MARKS[stepOrder - 1] : ''
  const label = order && stepLabel ? `${order} ${stepLabel}` : stepLabel ?? '開店準備'
  const caption = total ? `${label}（手順 ${safeIndex}/${total}）` : label
  const receptionCopy = stepKey === 'scenario' ? receptionGuideCopy(receptionMode, receptionSeats) : null

  const overlay = (
    <div className={styles.root} data-guide-dialog={inDialog || undefined}
      data-inline-guide={inlineGuide || undefined} data-guide-table-editor={Boolean(desktopTable) || undefined}
      data-guide-table-compact={compactTableGuide || undefined}
      data-guide-course-compact={compactCourseGuide || undefined}
      data-guide-followup-editor={inlineGuide && (anchorName === 'followup.body' || anchorName === 'followup.confirm') || undefined}
      data-guide-course-basics={courseBasics || undefined} data-guide-table-complete={tablesComplete || undefined}
      style={{ '--guide-save-clearance': `${bottomOffset}px`, '--guide-table-balloon-width': `${TABLE_GUIDE_WIDTH}px` } as CSSProperties}>
      {panels.map((panel, index) => (
        <div
          key={`dim-${index}`}
          className={styles.dim}
          style={{ left: panel.left, top: panel.top, width: panel.width, height: panel.height }}
        />
      ))}
      {tableRing ? <div aria-hidden="true" className={`${styles.ring} ${styles.tableRing}`} style={{ left: tableRing.left, top: tableRing.top, width: tableRing.width, height: tableRing.height }} /> : null}
      {ring ? (
        <div
          className={styles.ring}
          data-guide-spotlight={anchorName ?? ''}
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
        />
      ) : null}

      <div ref={stackRef} className={styles.stack}>
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
            <span className={styles.title}>{tableConditions ? '席の条件を確認する' : anchorName === 'menu.save' && compactCourseGuide ? '保存して追加する' : receptionCopy?.title ?? procedure.title}</span>
            {compactCourseGuide ? <Button presentation="quiet-text" size="compact" onClick={onPause}>一時停止</Button> : null}
          </div>
          <p className={styles.body}>{tableConditions ? desktopTable ? '条件を確認して、必要に応じて変更できます。' : '席の条件を選び、プレビューへ戻れます。'
            : tablesComplete ? procedure.body
            : stepKey === 'attributes' && safeIndex === 3 ? '受付中の卓を1件以上用意してください。追加を見送る場合は、この手順をスキップできます。'
            : anchorName === 'menu.save' && actionLabel && inDialog ? `内容を確認して「${actionLabel}」を押します。`
            : anchorName === 'menu.save' && actionLabel ? `「${actionLabel}」を押すと、次の設定へ進みます。`
            : inlineGuide && (anchorName === 'followup.start' || anchorName === 'followup.save') && actionLabel === '今は使わない' ? '使わない場合は「今は使わない」を押します。'
            : inlineGuide && anchorName === 'hours.confirm' && inDialog ? '営業時間を見直して「変更内容を確認」を押します。'
            : anchorName === 'hours.confirm' && applyingHours ? '変更内容を確かめて、「Googleに反映する」または「設定を保存する」を押します。'
            : receptionCopy ? receptionCopy.body
            : viewport.width <= NARROW_GUIDE_WIDTH ? procedure.mobileBody ?? procedure.body : procedure.body}</p>
          <div className={styles.balloonFooter}>
            <Button presentation="quiet-text" onClick={() => {
              if (courseEditorStep || (stepKey === 'followup' && safeIndex !== 2)) onAdvanceProcedure(true)
              else onAdvanceProcedure()
            }}>この手順をスキップ</Button>
            {compactTableGuide ? <Button presentation="quiet-text" onClick={onPause}>一時停止</Button> : null}
            {procedure.trigger === 'confirm-input' ? <Button variant="primary" size="compact" disabled={!inputReady} onClick={() => onAdvanceProcedure()}>次へ</Button> : null}
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
            <Button size="compact" variant="primary" onClick={() => onAdvanceProcedure()}>次へ進む</Button>
          </div>
        ) : null}
        {!compactCourseGuide && !compactTableGuide ? <div className={styles.bar} data-guide-bar="">
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
          {!procedure && stepLabel ? <div className={styles.barHeader}><Button presentation="quiet-text" onClick={() => onAdvanceProcedure()}>この手順をスキップ</Button></div> : null}
        </div> : null}
      </div>
    </div>
  )
  return slot ? createPortal(overlay, slot) : overlay
}
