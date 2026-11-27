'use client'

import { useEffect, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import ListState from '@/components/shared/list-state'
import Button from '@/components/shared/button'
import { RowStatusActions } from '@/components/shared/row-actions'
import StatusBadge from '@/components/shared/status-badge'
import { useAccount } from '@/contexts/account-context'
import { styleApi } from '@/lib/api/helpers/styles'
import { styleLabel } from './model'
import styles from './style-entry.module.css'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

/*
 * スタイルを変える入口（ (1)・設定 › アカウント）。今のアカウントのスタイルを出し、
 * ［スタイルを変える］でダッシュボードのスタイル選びの窓（xxpM9）を開く。変えられるのはオーナー・管理者だけ。閲覧の代理ログインは変更しない。
 * スタイルが読めないときは失敗と再読込を出し、分からない値を「標準」と言わない。
 */
export default function StyleEntry() {
  const role = useStaffRole()
  const lockedReason = usePermissionLockReason(canManageRole(role), 'manager')
  const { selectedAccountId, selectedAccount } = useAccount()
  const [style, setStyle] = useState<{ accountId: string; style: AccountStyle; selected: boolean } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setStyle(null); setError(null)
    if (!selectedAccountId) return
    let cancelled = false
    void styleApi.get(selectedAccountId).then((res) => {
      if (!res.success) throw new Error('スタイルを読み込めませんでした')
      if (!cancelled) setStyle({ accountId: selectedAccountId, style: res.data.style, selected: res.data.styleSelected })
    }).catch((error: unknown) => { if (!cancelled) setError(error) })
    return () => { cancelled = true }
  }, [selectedAccountId, tick])
  if (error) return <ListState kind="error" title="使い方のスタイルを確認できませんでした" error={error} onRetry={() => setTick((n) => n + 1)} />
  if (!style || style.accountId !== selectedAccountId) return null
  return (
    <section className={styles.row} aria-label="使い方のスタイル">
      <span className={styles.text}>
        <span className={styles.title}>{`使い方のスタイル（${selectedAccount?.name ?? 'このアカウント'}）`}</span>
        <span className={styles.note}>ダッシュボード・はじめの質問・初期セットが、このスタイルに合わせて変わります。</span>
      </span>
      <RowStatusActions status={<StatusBadge tone={style.selected ? 'info' : 'neutral'} dot>{style.selected ? styleLabel(style.style) : 'まだ選んでいません'}</StatusBadge>}>
        <Button presentation="row-action" lockedReason={lockedReason} {...(role === null ? { disabled: true } : { href: '/?setup=0&setupReturn=accounts' })}>スタイルを変更する</Button>
      </RowStatusActions>
    </section>
  )
}
