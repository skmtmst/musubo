'use client'

import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { requestSetupChipReopen, useSetupChipState } from '@/v8/onboarding/public/setup-chip/index'
import styles from './setup-chip.module.css'

/*
  上の帯の「開店準備 N/9」の札。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) の札 IJocF は薄い主色の丸い地、文字 XzDt5 は主色の太字。
  押すと初回ポップアップを開き直す（枠 02 の足の注記どおり）。
*/

export function SetupChip() {
  const popup = useSetupChipState()
  const shared = useSharedGuide()
  const guide = shared?.guide
  const state = guide?.phase === 'active' || guide?.phase === 'paused' ? shared?.summary ?? popup : popup
  if (!state) return null
  const count = `開店準備 ${state.done}/${state.total}`
  if (guide?.phase === 'active') return <span className={styles.chip}>{count}</span>
  const paused = guide?.phase === 'paused'
  return (
    <button
      type="button"
      className={styles.chip}
      onClick={paused ? guide.resume : requestSetupChipReopen}
      data-setup-chip="open"
      aria-label={`${count}。${paused ? 'ガイドを再開する' : 'はじめにやることを開く'}`}
    >
      {count}
    </button>
  )
}
