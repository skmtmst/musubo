'use client'

/*
 * ★V8 運用状態（Pencil：健全性チェック ・更新履歴 ・緊急コントロール ）。
 *
 * 外側（型・中のメニュー）とタブ、健全性チェックはここで描く。更新履歴と緊急コントロールは
 * 今の部品を入口（app/emergency/page.tsx）から差し込む。動き（手動確認の連打止め N-458・
 * アカウント一覧の失敗を黙らせない #518）は今の画面と同じ。動きの一覧は同じ場所の BEHAVIOR.md。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'next/navigation'
import { OctagonPause, RefreshCw } from 'lucide-react'
import type { LineAccount } from '@line-crm/shared'
import Button from '@/components/shared/button'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { Tabs } from '@/components/shared/tabs'
import { useMergedTab } from '@/components/layout/merged-tabs'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import type { OperationSeverity } from '@/lib/operation-status'
import { canManageRole, effectiveStaffRole, useStaffIdentity } from '@/lib/staff-role'
import { readSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import { HealthPanelV8 } from './health'
import UpdateHistoryV8 from './history'
import styles from './screen.module.css'
import { RowActions } from '@/components/shared/row-actions'
import HistoryDetails, { type HistoryDetail } from './history-details'
import Notice from '@/components/shared/notice'
import { SecurityMonitorPanel } from './security-monitor'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import type { EmergencyControlAccess } from '@/v8/emergency'

/** 板  の並び。健全性チェック・更新履歴・緊急コントロール。 */
const BASE_TABS = [
  { key: 'health', label: '健全性チェック' },
  { key: 'history', label: '更新履歴' },
  { key: 'control', label: '緊急コントロール' },
]
const TAB_HREF: Record<string, string> = {
  health: '/emergency',
  history: '/emergency?tab=history',
  control: '/emergency?tab=control',
  security: '/emergency?tab=security',
}
const SECURITY_TAB = { key: 'security', label: 'セキュリティの見張り' }
const unknownSession = () => null
function subscribeSession(callback: () => void) {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, callback)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, callback)
}

export type EmergencyControlHandle = { openStop: () => void }

export default function EmergencyScreen({
  renderHistory,
  renderControl,
}: {
  renderHistory?: () => ReactNode
  renderControl?: (accounts: LineAccount[], controlRef: RefObject<EmergencyControlHandle | null>, onAccessChange: (access: EmergencyControlAccess) => void) => ReactNode
}) {
  const identity = useStaffIdentity()
  const canReadSecurity = Boolean(identity && canManageRole(identity.role))
  const tabs = canReadSecurity ? [...BASE_TABS, SECURITY_TAB] : BASE_TABS
  const tab = useMergedTab(tabs)
  const hqOrigin = useSearchParams()?.get('from') === 'hq'
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail>(null)
  const { selectedAccountId } = useAccount()
  const staffRole = effectiveStaffRole(identity)
  const canManage = canManageRole(staffRole)
  const manualLockReason = usePermissionLockReason(canManage, 'manager')
  const session = useSyncExternalStore(subscribeSession, readSessionSnapshot, unknownSession)
  const canReviewSecurity = canManage && session !== null && !session.impersonation
  const [, setSeverity] = useState<OperationSeverity>('unknown')
  const [manualRunRequest, setManualRunRequest] = useState(0)
  /* 手動確認の連打・同時実行を止める（N-458）。終わったら外す。 */
  const [manualBusy, setManualBusy] = useState(false)
  const manualRunLock = useRef(false)
  const requestManualRun = useCallback(() => {
    if (manualRunLock.current) return
    manualRunLock.current = true
    setManualBusy(true)
    setManualRunRequest((current) => current + 1)
  }, [])
  const settleManualRun = useCallback(() => {
    manualRunLock.current = false
    setManualBusy(false)
  }, [])
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [accountsFailed, setAccountsFailed] = useState(false)
  /* 対象アカウント欄の元。失敗しても黙らせない（#518 9）。 */
  const loadAccounts = useCallback(() => {
    setAccountsFailed(false)
    api.health.accounts()
      .then((response) => {
        if (response.success) setAccounts(response.data)
        else setAccountsFailed(true)
      })
      .catch(() => setAccountsFailed(true))
  }, [])
  useEffect(() => { loadAccounts() }, [loadAccounts])
  const controlRef = useRef<EmergencyControlHandle | null>(null)
  const [controlAccess, setControlAccess] = useState<EmergencyControlAccess>({ allowed: null, stopDisabled: true })

  const actions = tab === 'health'
    // 確かめ直しはオーナー・管理者だけ（Worker も owner/admin）。閲覧のみ等には灰色＋理由で出す。
    ? <Button variant="secondary" type="button" onClick={requestManualRun} lockedReason={canManage ? undefined : manualLockReason} disabled={!selectedAccountId || manualBusy || (!canManage && !manualLockReason)} busy={manualBusy} busyLabel="確認中…">
        <RefreshCw className={styles.btnIcon} aria-hidden="true" />いますぐ確かめる
      </Button>
    : tab === 'control'
      // 止める操作は赤（中の［選んだものを止める］と同じ・絵 ）。
      ? <Button variant="danger" type="button" icon={<OctagonPause size={16} />} disabled={controlAccess.stopDisabled} lockedReason={controlAccess.lockedReason} onClick={() => controlRef.current?.openStop()}>緊急停止する</Button>
      : tab === 'history' ? <RowActions subjectName="履歴" menuItems={[
        { id: 'incidents', label: '止めた・戻した記録を見る', onSelect: () => setHistoryDetail('incidents') },
        { id: 'updates', label: '更新内容を見る', onSelect: () => setHistoryDetail('updates') },
      ]} /> : undefined
  const description = tab === 'health'
    ? `musubo とつながる先が動いているかを、9 つの項目を5分ごとに自動で確かめます。おかしいときはここから止められます。`
    : tab === 'control'
      ? '止める配信を選び、理由を入力して緊急停止します。'
      : tab === 'security'
        ? '記録に残る不審な操作の増加と、見張りが動いているかを確認できます。'
      : 'エラー、緊急停止、システム更新、設定変更を時間順に確認できます。'

  return (
    <SbSettingsScreen
      boardId={tab === 'health' ? 'Y4LkX1' : tab === 'history' ? 'I2V65v' : tab === 'security' ? 'Bsc2d' : 'OHwbU'}
      layout="narrow-nav"
      title="運用状態"
      help={description}
      actions={actions}
      notice={tab === 'control' && controlAccess.lockedReason ? <ReadOnlyNotice need="feature" /> : undefined}
    >
      <Tabs size="compact" spacing="settings" label="運用状態の中の切り替え" items={tabs.map((item) => ({ label: item.label, href: hqOrigin ? `${TAB_HREF[item.key]}${TAB_HREF[item.key].includes('?') ? '&' : '?'}from=hq` : TAB_HREF[item.key], current: tab === item.key }))} />
      {accountsFailed ? (
        <Notice tone="danger" action={<> <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => loadAccounts()}>もう一度読み込む</Button> </>} >アカウント一覧を読み込めませんでした。{tab === 'security' ? '安全監視は選んだアカウントだけを確認します。選べないときは、一覧を読み直してください。' : '個別のアカウントを選べず、全体が対象になります。'}</Notice>
      ) : null}
      {tab === 'health' ? (
        <HealthPanelV8
          accountId={selectedAccountId}
          manualRunRequest={manualRunRequest}
          onSeverity={setSeverity}
          onManualRunSettled={settleManualRun}
          accountCount={accountsFailed ? null : accounts.length}
          canManage={canManage}
        />
      ) : null}
      {tab === 'control' ? renderControl?.(accounts, controlRef, setControlAccess) : null}
      {tab === 'security' && canReadSecurity ? <SecurityMonitorPanel accountId={selectedAccountId} canOperate={canReviewSecurity} /> : null}
      {tab === 'history' ? (renderHistory ? renderHistory() : <UpdateHistoryV8 hqOrigin={hqOrigin} />) : null}
      <HistoryDetails panel={historyDetail} onClose={() => setHistoryDetail(null)} />
    </SbSettingsScreen>
  )
}
