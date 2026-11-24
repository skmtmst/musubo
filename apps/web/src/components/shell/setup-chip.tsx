'use client'

import Link from 'next/link'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { requestSetupChipReopen, useSetupChipState } from '@/v8/onboarding/public/setup-chip/index'
import styles from './setup-chip.module.css'

/*
  上の帯と左メニューの「開店準備 N/M」の札。残りがある間はどの画面にも出し、はじめの設定へ移る。
  初回ポップアップを出せる画面（ダッシュボード）では、閉じたポップアップをこの札から開き直す。
  案内中・一時停止中はポップアップを重ねないので、そのときも、はじめの設定へ移る。
*/
export function SetupChip() {
  const shared = useSharedGuide()
  const popup = useSetupChipState()
  const summary = shared?.summary
  if (!summary || shared?.dismissed !== false || summary.total === 0 || summary.done >= summary.total) return null
  const count = `開店準備 ${summary.done}/${summary.total}`
  const phase = shared?.guide.phase
  if (popup && phase !== 'active' && phase !== 'paused') {
    return <button type="button" className={styles.chip} onClick={requestSetupChipReopen} data-setup-chip="open" aria-label={`${count}。はじめにやることを開く`}>{count}</button>
  }
  return <Link href="/getting-started" className={styles.chip} data-setup-chip="open" aria-label={`${count}。はじめの設定を開く`}>{count}</Link>
}
