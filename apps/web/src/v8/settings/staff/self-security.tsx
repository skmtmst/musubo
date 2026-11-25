'use client'

import { useState } from 'react'
import Card from '@/components/shared/card'
import SelfMfa from './self-mfa'
import SelfPasskeys from './self-passkeys'
import styles from './staff.module.css'

/** Logged-in member's own second-factor settings, never another member's. */
export default function SelfSecurity({ fullWidth = false, loginPath = '/login' }: { fullWidth?: boolean; loginPath?: '/login' | '/ops/login' }) {
  const [authenticatorEnabled, setAuthenticatorEnabled] = useState<boolean | null>(null)
  return <div className={`${styles.selfSecurityCard}${fullWidth ? ` ${styles.selfSecurityFullWidth}` : ''}`}><Card layout="vertical" contentPadding="var(--tpl-sa-card-pad)" gap="var(--polish-space-row)" aria-label="自分の設定">
    <h2 className={styles.selfSecurityTitle}>二段階認証</h2>
    <SelfPasskeys enabled={authenticatorEnabled} />
    <div className={styles.securityDivider} aria-hidden="true" />
    <SelfMfa compact loginPath={loginPath} onEnabledChange={setAuthenticatorEnabled} />
    <p className={styles.securityHint}>パスキーが使えない場合は認証アプリを使います。両方使えないときは管理者へ連絡してください。</p>
  </Card></div>
}
