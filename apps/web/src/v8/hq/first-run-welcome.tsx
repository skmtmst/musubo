'use client'

import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import Dialog from '@/components/shared/dialog'
import { prefersReducedMotion } from '@/components/shared/overlay-utils'
import { consumeRegistrationWelcome } from '@/lib/registration-welcome'
import './first-run-welcome-tokens.css'
import styles from './first-run-welcome.module.css'

const WELCOME_TIMING = { enter: 1200, hold: 1800, leave: 800 }
const leaveAt = WELCOME_TIMING.enter + WELCOME_TIMING.hold
const welcomeMotion = {
  '--motion-welcome-enter': `${WELCOME_TIMING.enter}ms`,
  '--motion-welcome-leave-at': `${leaveAt}ms`,
  '--motion-welcome-leave': `${WELCOME_TIMING.leave}ms`,
} as CSSProperties

function FirstRunWelcome({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const delay = prefersReducedMotion() ? WELCOME_TIMING.hold : leaveAt + WELCOME_TIMING.leave
    const id = window.setTimeout(onDone, delay)
    return () => window.clearTimeout(id)
  }, [onDone])

  return <Dialog open title="ようこそ" designNode="t5jY0" designLayout="fullscreen" onCancel={onDone}>
    <div className={styles.screen} style={welcomeMotion} data-registration-welcome>
      <div className={styles.content}>
        {/* 公式ロゴと承認済みの Klee One の字形を静的な画像で配信する。 */}
        <img className={styles.logo} src="/onboarding/first-run-welcome-logo.png" alt="musubo" width={2522} height={385} />
        <picture className={styles.writing}>
          <source media="(max-width: 600px)" srcSet="/onboarding/first-run-welcome-mobile.svg" />
          <img src="/onboarding/first-run-welcome.svg" alt="" />
        </picture>
      </div>
    </div>
  </Dialog>
}

export function RegistrationWelcome() {
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    if (consumeRegistrationWelcome()) setOpen(true)
  }, [])
  const close = useCallback(() => setOpen(false), [])
  return open ? <FirstRunWelcome onDone={close} /> : null
}
