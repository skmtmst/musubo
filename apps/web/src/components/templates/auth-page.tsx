import type { FormHTMLAttributes, ReactNode } from 'react'
import AuthCard from '@/components/auth/auth-card'
import styles from './auth-page.module.css'

/** Login confirmation and enrollment share the login card, its brand and spacing. */
export function AuthPage({ title, help, titleId, boardId, step = { current: 2, total: 2 }, layout = 'admin', wide = false, children }: { title: string; help?: ReactNode; titleId?: string; boardId?: string; step?: { current: number; total: number }; layout?: 'admin' | 'ops'; /** QR と鍵を横に並べる設定の画面など、中身が広い時。 */ wide?: boolean; children: ReactNode }) {
  return <AuthCard variant="totp" title={title} titleId={titleId} description={help} cardNode={boardId} authLayout={layout} step={step} wide={wide}>{children}</AuthCard>
}

export function AuthForm(props: FormHTMLAttributes<HTMLFormElement>) {
  return <form {...props} className={styles.form} />
}

export function AuthStack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>
}

export function AuthActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>
}

/** 認証の主ボタン。入力不足の状態は Button の disabled で示す。 */
export function AuthSubmit({ children }: { children: ReactNode }) {
  return <div className={styles.submit}>{children}</div>
}

export function AuthHelp({ children }: { children: ReactNode }) {
  return <p className={styles.help}>{children}</p>
}

export function AuthDetailRow({ label, value, actions }: { label: string; value: ReactNode; actions?: ReactNode }) {
  return <div className={styles.detailRow}>
    <div className={styles.detailValue}><h3>{label}</h3><strong>{value}</strong></div>
    {actions}
  </div>
}
