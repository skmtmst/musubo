'use client'

import { useEffect, type CSSProperties } from 'react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import { prefersReducedMotion } from '@/components/shared/overlay-utils'
import styles from './first-run-welcome.module.css'

const WELCOME_TIMING = { logo: 900, hold: 3000, fade: 500, reduced: 800 }
const welcomeMotion = {
  '--motion-welcome-logo': `${WELCOME_TIMING.logo}ms`,
  '--motion-welcome-hold': `${WELCOME_TIMING.hold}ms`,
  '--motion-welcome-fade': `${WELCOME_TIMING.fade}ms`,
} as CSSProperties

export function FirstRunWelcome({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const delay = prefersReducedMotion() ? WELCOME_TIMING.reduced : WELCOME_TIMING.hold + WELCOME_TIMING.fade
    const id = window.setTimeout(onDone, delay)
    return () => window.clearTimeout(id)
  }, [onDone])

  return <Dialog open title="ようこそ" designNode="pXnsD" designLayout="fullscreen" onCancel={onDone}>
    <div className={styles.screen} style={welcomeMotion}>
      <div className={styles.content}>
        <img className={styles.logo} src="/brand/musubo-color.png" alt="musubo" width={3020} height={890} />
        <img className={styles.writing} src="/onboarding/first-run-welcome.svg" alt="" width={212} height={66} />
      </div>
      <div className={styles.skip}><Button variant="text" size="inline" onClick={onDone}>タップでスキップ</Button></div>
    </div>
  </Dialog>
}
