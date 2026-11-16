'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { publishSetupChip, useSetupChipReopen } from '@/v8/onboarding/setup-chip'
import { nextFirstStepKey, type FirstStepsSummary } from './first-steps'
import styles from './first-run-popup.module.css'

/*
  「開店準備を始めましょう」の初回ポップアップ。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) ＝ PC、枠 02b (nt3Po) ＝ スマホ（画面下部固定のボトムシート）。

  9項目の済み／未済は実データ計測の summary をそのまま出す。ここで済みにしない。
  閉じたあとは上の帯の「開店準備 N/9」から開き直す（枠 02 の足の注記どおり）。
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
    /* 保存できない端末でも画面は使える。開き直しは帯の札から。 */
  }
}

export type FirstRunPopupControl = {
  open: boolean
  close: () => void
}

/**
 * 出すかどうかの判断と、帯の札への値出し。
 * 初回だけ自動で開き、閉じたあとは札から開き直す。
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

  const [reopened, setReopened] = useState(false)
  useEffect(() => { setReopened(false) }, [accountId])

  /* 帯の札は、出す値がある間だけ置く。 */
  useEffect(() => {
    if (!eligible || !accountId || !summary) { publishSetupChip(null); return }
    publishSetupChip({ accountId, done: summary.done, total: summary.total })
  }, [eligible, accountId, summary])
  useEffect(() => () => { publishSetupChip(null) }, [])

  const reopen = useCallback(() => { setReopened(true) }, [])
  useSetupChipReopen(reopen)

  const open = eligible && guidePhase !== 'active' && guidePhase !== 'paused' && (reopened || !dismissed)

  const close = useCallback(() => {
    setReopened(false)
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

export function FirstRunPopup({ summary, onStartGuide, onClose }: FirstRunPopupProps) {
  const titleId = useId()
  const currentKey = useMemo(() => nextFirstStepKey(summary), [summary])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /* 枠 02 の輪 hvJuA / 帯の札 XzDt5 と同じ「済み/全体」。 */
  const position = `${summary.done}/${summary.total}`

  return (
    <div className={styles.scrim} data-first-run-popup="open" onClick={onClose}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={event => event.stopPropagation()}
      >
        {/* 枠 02b の掴み手。PCでは出さない。 */}
        <div className={styles.grabber}><span className={styles.grabberBar} /></div>

        <div className={styles.header}>
          <span className={styles.ring}><span className={styles.ringText}>{position}</span></span>
          <div className={styles.headerText}>
            <h2 id={titleId} className={styles.title}>開店準備を始めましょう</h2>
            {/*
              枠 02 (C5i3rw) と 枠 02b (nt3Po) で一言が違う。
              スマホは1行に収める短い言い方なので、幅で入れ替える（描き出し後の幅判定を増やさない）。
            */}
            <p className={styles.lead}>
              <span className={styles.leadPc}>上から順に進めると、LINEで予約を受け付けられるようになります。</span>
              <span className={styles.leadSp}>順番に進めるとLINE予約を受け付けられます</span>
            </p>
          </div>
        </div>

        <div className={styles.rows}>
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
                  <button type="button" className={styles.rowAction} onClick={onStartGuide}>
                    <span className={styles.rowActionPc}>ガイドで進める</span>
                    <span className={styles.rowActionMobile}>進める</span>
                  </button>
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

            return (
              <div key={step.key} className={styles.row}>
                {mark}
                {label}
                <span className={styles.chevron} aria-hidden="true">›</span>
              </div>
            )
          })}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.later} onClick={onClose}>
            <span className={styles.laterPc}>あとで</span>
            <span className={styles.laterMobile}>あとで（下にスワイプで閉じる）</span>
          </button>
          <span className={styles.footerSpacer} />
          <span className={styles.note}>
            {`閉じたあとは右上の「開店準備 ${summary.done}/${summary.total}」からいつでも再開できます`}
          </span>
        </div>
      </div>
    </div>
  )
}
