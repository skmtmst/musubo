'use client'

import MusuboLogo from './shared/musubo-logo'
import styles from './auth-pending-shell.module.css'

/** 認証と利用開始状況が確定するまで、通常画面のメニューを一切描画しない。 */
export default function AuthPendingShell() {
  return (
    <div className={styles.pending} data-auth-pending="" role="status" aria-busy="true" aria-label="利用状況を確認しています">
      <div className={styles.brand}><MusuboLogo /></div>
      <div className={styles.progress} aria-hidden="true" />
    </div>
  )
}
