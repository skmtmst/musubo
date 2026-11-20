'use client'

import { useEffect } from 'react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import { prefersReducedMotion } from '@/components/shared/overlay-utils'
import styles from './first-run-welcome.module.css'

export function FirstRunWelcome({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDone, prefersReducedMotion() ? 800 : 3500)
    return () => window.clearTimeout(id)
  }, [onDone])

  return <Dialog open title="ようこそ" designNode="pXnsD" designLayout="fullscreen" headerIcon={false} onCancel={onDone}>
    <div className={styles.screen}>
      <div className={styles.content}>
        <img className={styles.logo} src="/brand/musubo-color.png" alt="musubo" />
        <img className={styles.writing} src="/onboarding/first-run-welcome.svg" alt="" />
      </div>
      <div className={styles.skip}><Button variant="text" size="inline" onClick={onDone}>タップでスキップ</Button></div>
    </div>
  </Dialog>
}
