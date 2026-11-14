'use client'

import { tokenExpiryNotice, tokenExpirySummary, tokenExpiryBreakdown, tokenExpiryBreakdownText } from '@/lib/line-account-state'

import { notifySaved } from '@/components/shared/toast'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowUpDown, Plus, Cable, CircleCheck, TriangleAlert, Users } from 'lucide-react'
import type { LineAccount } from '@line-crm/shared'
import { ApiError, api, describeSaveFailure } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePageTitle } from '@/components/shell/page-chrome'
import { SettingsPage } from '@/components/templates'
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import AccountOrdering from '@/components/accounts/account-ordering'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import SegmentedControl from '@/components/shared/segmented'
import { TextArea } from '@/components/shared/text-field'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import SearchField from '@/components/shared/search-field'
import StatusBadge from '@/components/shared/status-badge'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { StyleEntry } from '@/v8/onboarding/public/style-entry/index'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import {
  ACCOUNT_FILTERS,
  type AccountFilter,
  type AccountWithStats,
  accountKpis,
  connectionLabel,
  matchesFilter,
  matchesQuery,
  orderAccounts,
  parentName,
  webhookLabel,
} from './view'
import styles from './accounts.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { lockReason, lockMenuItems } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

/*
 * ★V8 LINEアカウント（Pencil ）。
 *
 * 白い板の頭（題・説明・右に「並び順と親子を変える」「LINEアカウントを登録」）→
 * 左に「設定の中のメニュー」→ 右に数の4枚・探す欄と絞り込みの札・表・下の案内。
 * データの口は今の画面（app/accounts/page.tsx）と同じ：
 * 一覧（確かめ直しは live）・アーカイブ（理由・本人確認）・アーカイブから戻す。
 * 「並び順と親子を変える」は今ある並び替えの部品（components/accounts/account-ordering）を窓で開く。
 */

const TITLE = 'LINEアカウント'
const DESCRIPTION = 'musubo でつないでいる LINE 公式アカウントです。既定のアカウントと、親子（本店と支店など）を決めます。'

export default function AccountsV8() {
  usePageTitle(TITLE)
  const router = useRouter()
  const role = useStaffRole()
  const canManage = canManageRole(role)
  const canRegister = canManageRole(role)
  const permissionReason = usePermissionLockReason(canManage, 'manager')
  const blocked = !canManage || Boolean(permissionReason)
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<AccountFilter>('filter', 'all')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<LineAccount | null>(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [restoreTarget, setRestoreTarget] = useState<LineAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [orderingOpen, setOrderingOpen] = useState(false)

  const load = useCallback(async (live: boolean): Promise<boolean> => {
    setStatus('loading')
    try {
      const res = await api.lineAccounts.list(live)
      if (!res.success) { setStatus('error'); return false }
      setAccounts(res.data as AccountWithStats[])
      setStatus('ready')
      return true
    } catch {
      setStatus('error')
      return false
    }
  }, [])

  useEffect(() => { void load(false) }, [load])

  const ordered = useMemo(() => orderAccounts(accounts), [accounts])
  const shown = useMemo(
    () => ordered.filter((a) => matchesFilter(a, filter) && matchesQuery(a, query)),
    [ordered, filter, query],
  )
  const ready = status === 'ready'
  // 未取得（読み込み中・取得失敗）を 0 と出さない。成功した空一覧だけ 0。
  const kpis = ready ? accountKpis(accounts) : null
  const expiredInProblem = ready ? tokenExpiryBreakdown(accounts).inProblem : 0
  const filterCount = (value: AccountFilter) => (ready ? accounts.filter((a) => matchesFilter(a, value)).length : undefined)

  /** このアカウントの接続を、新しく確かめ直す。一覧全体を最新で取り直す。 */
  const recheck = useCallback(async (account: LineAccount) => {
    setOpenMenuId(null)
    setNotice(null)
    const ok = await load(true)
    setNotice(ok
      ? { tone: 'success', text: `「${account.name}」を確かめ直しました。` }
      : { tone: 'error', text: '確かめ直せませんでした。もう一度お試しください。' })
  }, [load])

  const runArchive = useCallback(async (stepUpToken?: string) => {
    if (!archiveTarget || !canManage || lockReason(canManage, 'manager')) return
    setBusy(true)
    setDialogError('')
    try {
      const res = await api.lineAccounts.archive(archiveTarget.id, archiveReason.trim() || undefined, stepUpToken)
      if (!res.success) throw new Error(res.error)
      setArchiveTarget(null)
      setArchiveReason('')
      await load(false)
      notifySaved(`「${archiveTarget.name}」をアーカイブしました。`)
    } catch (caught) {
      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.archive', action: `「${archiveTarget.name}」をアーカイブする`, retry: runArchive })
        return
      }
      setDialogError(archiveFailureMessage(caught))
    } finally {
      setBusy(false)
    }
  }, [archiveTarget, archiveReason, load, canManage])

  /** アーカイブから戻す。戻った直後は「止まっている」状態。 */
  const runRestore = useCallback(async (stepUpToken?: string) => {
    if (!restoreTarget || !canManage || lockReason(canManage, 'manager')) return
    setBusy(true)
    setDialogError('')
    try {
      const res = await api.lineAccounts.restore(restoreTarget.id, stepUpToken)
      if (!res.success) throw new Error(res.error)
      setRestoreTarget(null)
      await load(false)
      notifySaved(`「${restoreTarget.name}」をアーカイブから戻しました。`)
    } catch (caught) {
      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.credentials', action: `「${restoreTarget.name}」をアーカイブから戻す`, retry: runRestore })
        return
      }
      setDialogError(withPermissionFailure(caught, describeSaveFailure(caught), 'store'))
    } finally {
      setBusy(false)
    }
  }, [restoreTarget, load, canManage])

  /** 行の「…」の中身：詳細・接続をもう一度確かめる・引き継ぎ・アーカイブ（戻す）。 */
  const menuItems = (account: LineAccount): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [
      { id: 'detail', label: '詳細', external: false, href: `/accounts/detail?id=${account.id}`, onSelect: () => { setOpenMenuId(null); router.push(`/accounts/detail?id=${account.id}`) } },
      { id: 'recheck', label: '接続をもう一度確かめる', disabled: busy, onSelect: () => void recheck(account) },
    ]
    items.push({ id: 'handover', label: '引き継ぎ', external: false, href: `/accounts/handover?id=${account.id}`, onSelect: () => { setOpenMenuId(null); router.push(`/accounts/handover?id=${account.id}`) } })
    items.push(account.archivedAt
      ? { id: 'restore', label: 'アーカイブから戻す', dividerBefore: true, disabled: busy, onSelect: () => { setOpenMenuId(null); setDialogError(''); setRestoreTarget(account) } }
      : { id: 'archive', label: 'アーカイブ', tone: 'danger', dividerBefore: true, disabled: busy, onSelect: () => { setOpenMenuId(null); setDialogError(''); setArchiveReason(''); setArchiveTarget(account) } })
    const mutations = lockMenuItems(canManage, items, 'manager', (item) => item.id === 'detail' || item.id === 'recheck')
    return role === null ? mutations.map(item => item.id === 'detail' || item.id === 'recheck' ? item : { ...item, lockedReason: undefined, disabled: true }) : mutations
  }

  const headActions = (
    <div className={styles.headActions}>
      <Button variant="secondary" disabled={role === null} lockedReason={permissionReason} onClick={() => { if (!canManage || lockReason(canManage, 'manager')) return; setOrderingOpen(true) }}>
        <ArrowUpDown size={16} aria-hidden="true" />並び順と親子を変える
      </Button>
      <Button variant="primary" lockedReason={permissionReason} {...(role === null ? { disabled: true } : { href: '/accounts/new' })}>
        <Plus size={16} aria-hidden="true" />LINEアカウントを登録
      </Button>
    </div>
  )

  return (
    <>
      <SettingsPage layout="accounts" help={<>{DESCRIPTION}{"行の「…」から 詳細・接続をもう一度確かめる・既定にする・引き継ぎ（UID の移行）・アーカイブ。"}</>} boardId="V7vn3" title={TITLE} notice={role !== null && blocked ? <ReadOnlyNotice need="manager" /> : undefined} actions={headActions} navigation={<SettingsInnerNav inline />}>
        {notice ? (
          <Notice tone={notice.tone === 'success' ? 'success' : 'danger'} message={notice.text} onClose={() => setNotice(null)} />
        ) : null}

        <KpiBand data-design="KPIs">
          <KpiCard title="つないでいる" icon={<Cable size={16} aria-hidden="true" />} value={kpis?.connected} unit="アカウント" detail={null} />
          <KpiCard title="有効" icon={<CircleCheck size={16} aria-hidden="true" />} value={kpis?.active} unit="件" detail={null} />
          <KpiCard title="接続に問題" icon={<TriangleAlert size={16} aria-hidden="true" />} value={kpis?.problem} unit="件" detail={expiredInProblem > 0 ? `うちトークン期限切れ ${expiredInProblem} 件` : null} valueTone={(kpis?.problem ?? 0) > 0 ? 'warning' : 'default'} />
          <KpiCard title="友だちの合計" icon={<Users size={16} aria-hidden="true" />} value={kpis?.friends} unit="人" detail={null} />
        </KpiBand>

        {/* B-335：スタイルを変える入口（今のアカウント）。オーナー・管理者だけ。 */}
        <StyleEntry />

        <div className={styles.toolbar}>
          <SearchField
            className={styles.search}
            placeholder="アカウント名・チャネル ID で探す"
            aria-label="アカウント名・チャネル ID で探す"
            value={query}
            onChange={setQuery}
            onClear={() => setQuery('')}
          />
          <SegmentedControl<AccountFilter>
            aria-label="状態で絞り込む"
            value={filter}
            onChange={setFilter}
            options={ACCOUNT_FILTERS.map((item) => ({ value: item.value, label: item.label, count: filterCount(item.value) }))}
          />
        </div>

        {ready && (tokenExpirySummary(accounts) || tokenExpiryBreakdownText(accounts)) ? <Notice tone="warn" compact message={[tokenExpirySummary(accounts), tokenExpiryBreakdownText(accounts)].filter(Boolean).join('・')} /> : null}
        {status === 'loading' ? (
          <ListState kind="loading" />
        ) : status === 'error' ? (
          <ListState kind="error" onRetry={() => void load(false)} />
        ) : shown.length === 0 ? (
          <div className={styles.table}>
            <ListState
              kind="empty"
              emptyPreset={accounts.length === 0 ? 'createable' : 'filtered'}
              title={accounts.length === 0 ? 'LINEアカウントがありません' : undefined}
              description={accounts.length === 0
                ? (canRegister
                  ? '「＋ LINEアカウントを登録」から、送受信に使うアカウントを登録してください。'
                  : '送受信に使うアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。')
                : undefined}
              action={accounts.length === 0
                ? <Button lockedReason={permissionReason} {...(role === null ? { disabled: true } : { href: '/accounts/new' })} variant="primary"><Plus size={16} aria-hidden="true" />LINEアカウントを登録</Button>
                : <Button type="button" onClick={() => { setQuery(''); setFilter('all') }}>条件を外す</Button>}
            />
          </div>
        ) : (
          <DataTable presentation="account-list" label="LINEアカウントの一覧">
            <thead>
            <TableHeadRow>
              <Th className={styles.colName}>アカウント</Th>
              <Th className={styles.colConn}>接続状態</Th>
              <Th className={styles.colHook}>Webhook</Th>
              <Th className={styles.colFriends}>友だち</Th>
              <Th className={styles.colDefault}>既定</Th>
              <Th className={styles.colParent}>親アカウント</Th>
              <Th className={styles.colMenu}><span className={styles.srOnly}>操作</span></Th>
            </TableHeadRow></thead>
            <tbody>{shown.map((account) => {
              const connection = connectionLabel(account)
              const webhook = webhookLabel(account)
              const parent = parentName(account, accounts)
              const archived = Boolean(account.archivedAt)
              const friends = archived || account.stats?.friendCount == null ? '—' : polishFormatNumber(account.stats.friendCount)
              return (
                <Tr data-row-id={account.id} key={account.id} interactive>
                  <Td className={styles.colName}><span className={styles.name} title={account.name}>{account.name}</span></Td>
                  <Td className={styles.colConn}><StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>
                    {tokenExpiryNotice(account) ? <TruncatedText className={styles.sub} value={tokenExpiryNotice(account)!} /> : null}
                    <TruncatedText className={styles.sub} value={account.channelId ? `チャネル ${account.channelId}` : `チャネル ${emptyValue("unconfigured")}`} />
                  </Td>
                  <Td className={styles.colHook}>
                    {archived ? <EmptyCell /> : <StatusBadge tone={webhook.tone}>{webhook.label}</StatusBadge>}
                  </Td>
                  <Td className={`${styles.colFriends} ${friends === '—' ? styles.faint : ''}`}>{friends}</Td>
                  <Td className={`${styles.colDefault} ${account.isDefault ? '' : styles.faint}`}>
                    {account.isDefault ? <span aria-label="既定のアカウント">★</span> : emptyValue('unknown')}
                  </Td>
                  <Td className={`${styles.colParent} ${parent === '—' ? styles.faint : ''}`} title={parent}>{parent}</Td>
                  <Td className={styles.colMenu}><div className={styles.menuBox}>
                    <RowMenu
                      label={`${account.name}の操作`}
                      items={menuItems(account)}
                      open={openMenuId === account.id}
                      onOpenChange={(next) => setOpenMenuId(next ? account.id : null)}
                    />
                  </div></Td>
                </Tr>
              )
            })}</tbody>
          </DataTable>
        )}
      </SettingsPage>

      {orderingOpen && !blocked ? <AccountOrdering
        onClose={() => { setOrderingOpen(false); void load(false) }}
        onSaved={() => { setOrderingOpen(false); void load(false) }}
      /> : null}

      <ConfirmDialog
        open={archiveTarget !== null && !blocked}
        title={`「${archiveTarget?.name}」をアーカイブしますか？`}
        description="一覧から外します。送受信は止まり、友だちと履歴は残ります。あとから「アーカイブから戻す」で戻せます。動いているアカウント・既定のアカウント・配送中のアカウントはアーカイブできません。"
        confirmLabel="アーカイブする"
        destructive
        busy={busy}
        error={dialogError || undefined}
        onCancel={() => { if (!busy) { setArchiveTarget(null); setArchiveReason(''); setDialogError('') } }}
        onConfirm={() => runArchive()}
      >
        {archiveTarget ? <OperationTargetSummary accounts={[{ id: archiveTarget.id, name: archiveTarget.name }]} /> : null}
        <Field label="アーカイブの理由"><SaveErrorField names={["archiveReason","archive_reason"]}><TextArea
            rows={2}
            maxLength={500}
            placeholder="例：使わなくなった旧店舗のアカウント"
            value={archiveReason}
            onChange={(e) => setArchiveReason(e.target.value)}
            disabled={busy}
          /></SaveErrorField></Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={restoreTarget !== null && !blocked}
        title={`「${restoreTarget?.name}」をアーカイブから戻しますか？`}
        description="一覧へ戻します。戻った直後は「止まっている」状態です。送受信を始めるには、接続を確かめてから「送受信を再開する」を使います。"
        confirmLabel="アーカイブから戻す"
        busy={busy}
        error={dialogError || undefined}
        onCancel={() => { if (!busy) { setRestoreTarget(null); setDialogError('') } }}
        onConfirm={() => runRestore()}
      />
      {stepUp && !blocked ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
    </>
  )
}

/** アーカイブできない理由（API の blockers）を、運用者の言葉で。 */
function archiveFailureMessage(caught: unknown): string {
  if (caught instanceof ApiError && caught.code === 'LINE_ACCOUNT_ARCHIVE_BLOCKED') {
    const blockers = (caught.data as { blockers?: string[] } | undefined)?.blockers ?? []
    const messages = blockers
      .map((key) => ARCHIVE_BLOCKER_MESSAGES[key])
      .filter((message): message is string => Boolean(message))
    if (messages.length > 0) return messages.join(' / ')
    return 'このアカウントはいまアーカイブできません。止まっているか、既定でないかを確かめてください。'
  }
  return withPermissionFailure(caught, describeSaveFailure(caught), 'store')
}

const ARCHIVE_BLOCKER_MESSAGES: Record<string, string> = {
  account_active: '送受信がまだ動いています。先に「送受信を止める」で止めてください',
  default_account: '既定のアカウントです。先にほかのアカウントを既定にしてください',
  delivery_job_running: '予約・送信中の配信があります。終わるか取り消してからアーカイブしてください',
  traffic_pool_member: 'アクセス振り分けの組に入っています。組から外してからアーカイブしてください',
}
