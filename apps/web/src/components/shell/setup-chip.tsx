'use client'

import { requestSetupChipReopen, useSetupChipState } from '@/v8/onboarding/public/setup-chip/index'
import styles from './setup-chip.module.css'

/*
  上の帯の「開店準備 N/9」の札。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) の札 IJocF は薄い主色の丸い地、文字 XzDt5 は主色の太字。
  押すと初回ポップアップを開き直す（枠 02 の足の注記どおり）。
*/

export function SetupChip() {
  const state = useSetupChipState()
  if (!state) return null
  return (
    <button
      type="button"
      className={styles.chip}
      onClick={requestSetupChipReopen}
      data-setup-chip="open"
      aria-label={`開店準備 ${state.done}/${state.total}。はじめにやることを開く`}
    >
      {`開店準備 ${state.done}/${state.total}`}
    </button>
  )
}
