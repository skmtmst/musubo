'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react'
import { createPortal } from 'react-dom'
import Button from '@/components/shared/button'
import SheetDialog from '@/components/shared/sheet-dialog'
import { nextFirstStepKey, type FirstStepsSummary } from './first-steps'
import styles from './first-run-popup.module.css'

/*
  「開店準備を始めましょう」の初回ポップアップ。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) ＝ PC、枠 02b (nt3Po) ＝ スマホ（画面下部固定のボトムシート）。

  9項目の済み／未済は実データ計測の summary をそのまま出す。ここで済みにしない。
  閉じたあとは、上の帯の札からはじめの設定へ移る。
*/

export function firstRunPopupDismissedKey(accountId: string): string {
  return `lh:v8:first-run-popup-dismissed:${accountId}`
}

function readDismissed(accountId: string | null): boolean {
  if (!accountId || typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(firstRunPopupDismissedKey(accountId)) === '1'
  } catch {
    return false
  }
}

function writeDismissed(accountId: string): void {
  try {
    window.localStorage.setItem(firstRunPopupDismissedKey(accountId), '1')
  } catch {
    /* 保存できない端末でも画面は使える。 */
  }
}

export type FirstRunPopupControl = {
  open: boolean
  close: () => void
}

/**
 * 出すかどうかの判断と、帯の札への値出し。
 * 初回だけ自動で開く。
 */
export function useFirstRunPopup(options: {
  accountId: string | null
  canManage: boolean
  summary: FirstStepsSummary | null
  /** ガイド案内中・一時停止中は重ねない。 */
  guidePhase: string
}): FirstRunPopupControl {
  const { accountId, canManage, summary, guidePhase } = options
  const remaining = Boolean(summary && summary.done < summary.total)
  const eligible = Boolean(accountId) && canManage && remaining

  const [dismissed, setDismissed] = useState(true)
  useEffect(() => { setDismissed(readDismissed(accountId)) }, [accountId])

  const open = eligible && guidePhase !== 'active' && guidePhase !== 'paused' && !dismissed

  const close = useCallback(() => {
    setDismissed(true)
    if (accountId) writeDismissed(accountId)
  }, [accountId])

  return { open, close }
}

export type FirstRunPopupProps = {
  summary: FirstStepsSummary
  /** 現在の行の「ガイドで進める」。枠 02 の pdn85。 */
  onStartGuide: () => void
  onClose: () => void
}

/** 掴み手を下に引いて閉じる距離（枠 02b の足「あとで（下にスワイプで閉じる）」）。 */
const SWIPE_CLOSE_PX = 80

export function FirstRunPopup({ summary, onStartGuide, onClose }: FirstRunPopupProps) {
  const titleId = useId()
  const currentKey = useMemo(() => nextFirstStepKey(summary), [summary])

  /*
    スマホのボトムシートを指で下に引いて閉じる。
    足の文言で閉じられると書いているので、ふるまいを合わせる（差し戻し R2）。
    PCは指で触らないので、この処理は何もしない。
  */
  const dragStart = useRef<number | null>(null)
  const [dragY, setDragY] = useState(0)

  const onTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch) return
    /* 一覧を読んでいる途中（下までスクロール済み）は引っ張りと取り違えない。 */
    const scroller = (event.target as HTMLElement | null)?.closest(`.${styles.rows}`)
    if (scroller && scroller.scrollTop > 0) { dragStart.current = null; return }
    dragStart.current = touch.clientY
    setDragY(0)
  }, [])

  const onTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (dragStart.current === null || !touch) return
    setDragY(Math.max(0, touch.clientY - dragStart.current))
  }, [])

  const onTouchEnd = useCallback(() => {
    const moved = dragY
    dragStart.current = null
    setDragY(0)
    if (moved >= SWIPE_CLOSE_PX) onClose()
  }, [dragY, onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /* 枠 02 の輪 hvJuA / 帯の札 XzDt5 と同じ「済み/全体」。 */
  const position = `${summary.done}/${summary.total}`

  /*
    窓は body 直下に出す（shared/dialog と同じ持ち方）。
    枠は画面の真ん中に重ねる作りで、scrim は position:fixed なので見た目は変わらない。
    画面の中に置いたままだと、本文の囲み（app-shell の main）の overflow に
    カードの影が掛かっている判定になる。重なりの持ち主を body に揃えて直す。
  */
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const overlay = (
    <div className={styles.scrim} data-first-run-popup="open" onClick={onClose}>
      <SheetDialog
        className={styles.card}
        titleId={titleId}
        title="開店準備を始めましょう"
        /* 枠 02 の輪 cohVt（スマホは K4fHC）。印は画面が作って持ち主に渡す。 */
        mark={<span className={styles.ring}><span className={styles.ringText}>{position}</span></span>}
        /*
          枠 02 (C5i3rw) と 枠 02b (nt3Po) で一言が違う。
          スマホは1行に収める短い言い方なので、幅で入れ替える（描き出し後の幅判定を増やさない）。
        */
        description={(
          <>
            <span className={styles.leadPc}>上から順に進めると、LINEで予約を受け付けられるようになります。</span>
            <span className={styles.leadSp}>順番に進めるとLINE予約を受け付けられます</span>
          </>
        )}
        onClick={event => event.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        {/* 枠 02b の「最終行の直下に『あとで』」を実測で見張るための目印（差し戻し R3）。 */}
        <div className={styles.rows} data-first-run-rows={summary.steps.length}>
          {summary.steps.map((step, index) => {
            const current = !step.done && step.key === currentKey
            const mark = step.done
              ? <span className={`${styles.mark} ${styles.markDone}`} aria-hidden="true">✓</span>
              : <span className={`${styles.mark} ${current ? styles.markCurrent : styles.markTodo}`} aria-hidden="true">{index + 1}</span>
            const label = (
              <span className={current ? `${styles.label} ${styles.labelCurrent}` : styles.label}>{step.label}</span>
            )

            if (step.done) {
              return (
                <div key={step.key} className={`${styles.row} ${styles.rowDone}`}>
                  {mark}
                  {label}
                  <span className={styles.badge}>完了</span>
                </div>
              )
            }

            if (current) {
              return (
                <div key={step.key} className={`${styles.row} ${styles.rowCurrent}`}>
                  {mark}
                  {label}
                  <Button presentation="first-run-start" onClick={onStartGuide}>
                    <span className={styles.rowActionPc}>ガイドで進める</span>
                    <span className={styles.rowActionMobile}>進める</span>
                  </Button>
                </div>
              )
            }

            if (step.href) {
              return (
                <Link key={step.key} href={step.href} className={styles.row} onClick={onClose}>
                  {mark}
                  {label}
                  <span className={styles.chevron} aria-hidden="true">›</span>
                </Link>
              )
            }

            return <div key={step.key} className={styles.row}>{mark}{label}</div>
          })}
        </div>

        <div className={styles.footer}>
          <Button presentation="quiet-text" onClick={onClose}>
            <span className={styles.laterPc}>あとで</span>
            <span className={styles.laterMobile}>あとで（下にスワイプで閉じる）</span>
          </Button>
          <span className={styles.footerSpacer} />
          <span className={styles.note}>
            {`閉じたあとは右上の「開店準備 ${summary.done}/${summary.total}」からいつでも再開できます`}
          </span>
        </div>
      </SheetDialog>
    </div>
  )

  if (!mounted || typeof document === 'undefined') return overlay
  return createPortal(overlay, document.body)
}
