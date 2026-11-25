'use client'

import Link from 'next/link'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import styles from './setup-chip.module.css'

export function SetupChip() {
  const shared = useSharedGuide()
  const summary = shared?.summary
  if (!summary || shared?.dismissed !== false || summary.total === 0 || summary.done >= summary.total) return null
  const count = `開店準備 ${summary.done}/${summary.total}`
  return <Link href="/getting-started" className={styles.chip} data-setup-chip="open" aria-label={`${count}。はじめの設定を開く`}>{count}</Link>
}
