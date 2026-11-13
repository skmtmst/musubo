'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowLeft, CircleCheck, Copy, List, MessageCircle, MessageSquare, Star, Workflow, Zap } from 'lucide-react'
import Avatar from '@/components/shared/avatar'
import Button from '@/components/shared/button'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useCustomerDeletion } from '@/lib/use-customer-deletion'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import TargetMissing from '@/components/shared/target-missing'
import { Tabs } from '@/components/shared/tabs'
import { FeatureDisabledScreen } from '@/components/feature-disabled-gate'
import { PageFrame } from '@/components/templates/page-frame'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { formatDay } from '@/lib/format'
import { useFriendDetail } from './use-friend-detail'
import { useFriendDetailPermissions } from './permissions'
import { useScenarioPicker, useSupportEditor } from './dialogs'
import { inboxHrefForFriend } from './timeline'
import { SUPPORT_LABELS, SUPPORT_TONES } from './support'
import OverviewTab, { FriendSummaryRail } from './overview-tab'
import HistoryTab from './history-tab'
import InfoTab, { ALL_GROUP } from './info-tab'
import FormsTab from './forms-tab'
import ScenarioTab from './scenario-tab'
import BookingsTab from './bookings-tab'
import RemindersTab from './reminders-tab'
import { friendFilterHref } from '@/components/shared/friend-filter-band'
import ActionsTab from './actions-tab'
import MilesTab from './miles-tab'
import RichMenuTab from './rich-menu-tab'
import styles from './detail.module.css'
import { PageHeading } from '@/components/templates/page-frame'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import ReadOnlyNotice from '@/components/shared/read-only-notice'


/*
 * ★V8 友だち詳細（Pencil「★P1-4 友だち詳細」・概要は ）。
 *
 * 入口は app/friends/detail/page.tsx（V8 のときだけこの画面）。
 * データの口・権限・失敗の扱いは今の画面と同じ（BEHAVIOR.md）。見せ方だけ絵どおり：
 * 板の頭（顔・名前・札・補足／…・個別操作・受信箱で開く）→ タブ → タブの中身。
 * タブの中身はタブごとのファイルに分けた。
 */

/** 直接開くURLも含めたタブの定義。 */
export const FRIEND_DETAIL_TABS = [
  { key: 'timeline', label: '概要' },
  { key: 'history', label: '履歴' },
  { key: 'info', label: '情報欄' },
  { key: 'forms', label: '回答フォーム' },
  { key: 'scenario', label: '配信・シナリオ' },
  { key: 'orders', label: '回数券・月謝' },
  { key: 'reminders', label: 'リマインダ' },
  { key: 'actions', label: 'アクション' },
  { key: 'miles', label: 'マイル' },
  { key: 'richmenu', label: 'リッチメニュー' },
] as const
type TabKey = (typeof FRIEND_DETAIL_TABS)[number]['key']
const LINK_ONLY_TABS: readonly TabKey[] = ['scenario', 'reminders', 'actions', 'richmenu']

function FriendDetailV8Inner() {
  const params = useSearchParams()
  const router = useRouter()
  const friendId = params.get('id') ?? ''
  const rawTab = params.get('tab')
  const tab: TabKey = (FRIEND_DETAIL_TABS.find((t) => t.key === rawTab)?.key ?? 'timeline') as TabKey
  const group = params.get('group') ?? ALL_GROUP
  const { selectedAccountId, selectedAccount } = useAccount()
  // 情報欄タブは friend_fields の画面。オフのアカウントではタブごと出さない。
  const visibility = useFeatureVisibility(selectedAccountId)
  const fieldsEnabled = visibility.enabled('friend_fields')
  const bookingEnabled = visibility.enabled('booking')
  const visibleTabs = FRIEND_DETAIL_TABS.filter((t) =>
    (fieldsEnabled || t.key !== 'info') && (bookingEnabled || t.key !== 'orders') && !LINK_ONLY_TABS.includes(t.key))
  const activeLinkOnlyTab = FRIEND_DETAIL_TABS.find((t) => t.key === tab && LINK_ONLY_TABS.includes(t.key))
  const data = useFriendDetail(friendId, selectedAccountId, tab)
  const perms = useFriendDetailPermissions()
  const { friend } = data
  const deletion = useCustomerDeletion(() => { router.push('/friends') })
  const deletionScope = useRef({ friendId, accountId: selectedAccountId, generation: 0 })
  if (deletionScope.current.friendId !== friendId || deletionScope.current.accountId !== selectedAccountId) {
    deletionScope.current = { friendId, accountId: selectedAccountId, generation: deletionScope.current.generation + 1 }
  }
  const currentScope = deletionScope.current
  const [deletionContext, setDeletionContext] = useState<{ scope: typeof currentScope; ticket: object; targetAccountId: string; friendName: string } | null>(null)
  const deletionTicket = useRef<object | null>(null)
  const deletionMounted = useRef(false)
  const canDelete = useRef(perms.manage); canDelete.current = perms.manage
  useEffect(() => { deletionMounted.current = true; return () => { deletionMounted.current = false } }, [])
  useEffect(() => {
    if (deletion.error && deletionContext && deletionContext.scope === deletionScope.current && deletion.target) deletionTicket.current = deletionContext.ticket
  }, [deletion.error, deletion.target, deletionContext])
  usePageTitle(friend?.displayName ?? '友だち詳細')
  usePageCrumbs([{ label: '友だち', href: '/friends' }])

  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [supportAlert, setSupportAlert] = useState('')
  const [scenarioNotice, setScenarioNotice] = useState('')

  const support = useSupportEditor(
    friendId,
    (notice) => { setSupportAlert(''); notifyToast(notice, { tone: 'success' }); void data.loadFriend() },
    (message) => { setSupportAlert(message); void data.loadFriend() },
    selectedAccountId,
  )
  const scenario = useScenarioPicker(friendId, friend?.displayName ?? '', selectedAccountId, (notice) => {
    setScenarioNotice(notice)
    // 登録は履歴に現れうるので、取り済みなら取り直す。
    if (data.historyStatus === 'ready') void data.loadHistory()
  })

  const inbox = inboxHrefForFriend(friendId)
  // 「個別操作」＝この友だちへの操作。権限が無い操作は出さない（絵 2.）。
  const primaryActions: ActionMenuItem[] = [
    ...(perms.editSupport ? [{ id: 'support', label: '対応状況を編集', icon: <CircleCheck size={16} />, onSelect: () => void support.openEditor() }] : []),
    ...(fieldsEnabled && perms.saveFields
      ? [{ id: 'fields', label: '情報欄を編集', icon: <List size={16} />, onSelect: () => router.push(`/friends/detail?id=${encodeURIComponent(friendId)}&tab=info`) }]
      : []),
    ...(perms.manage ? [{ id: 'scenario-enroll', label: 'シナリオに登録する', icon: <Workflow size={16} />, onSelect: () => void scenario.openPicker() }] : []),
    {
      id: 'send-template',
      label: 'テンプレートを送る',
      icon: <MessageSquare size={16} />,
      dividerBefore: perms.editSupport || perms.manage || (fieldsEnabled && perms.saveFields),
      onSelect: () => router.push(inbox),
    },
  ]
  // 「…」＝関連する画面を開く。別の画面へ移るものは ↗（external）。
  const secondaryActions: ActionMenuItem[] = [
    { id: 'templates', label: 'テンプレート一覧を見る', icon: <List size={16} />, external: false, href: '/templates', onSelect: () => router.push('/templates') },
    { id: 'scenarios', label: 'シナリオ一覧を見る', icon: <List size={16} />, external: false, href: '/scenarios', onSelect: () => router.push('/scenarios') },
    { id: 'reminders', label: 'この友だちのリマインダを見る', icon: <List size={16} />, external: false, href: friendFilterHref('/reminders', friendId), onSelect: () => router.push(friendFilterHref('/reminders', friendId)) },
    { id: 'mileage', label: 'マイルを確認', icon: <Star size={16} />, external: false, href: '/mileage', onSelect: () => router.push('/mileage') },
    { id: 'duplicates', label: '重複候補を確認', icon: <Copy size={16} />, external: false, href: '/duplicates', onSelect: () => router.push('/duplicates') },
    ...(perms.manage ? [{ id: 'delete-friend-data', label: '友だちのデータを削除する', tone: 'danger' as const, onSelect: () => {
      if (!deletionMounted.current || !canDelete.current || deletion.busy || currentScope !== deletionScope.current || data.loading || !friend || friend.id !== friendId) return
      const ticket = {}; deletionTicket.current = ticket
      setDeletionContext({ scope: currentScope, ticket, targetAccountId: friend.lineAccountId ?? '', friendName: friend.displayName })
      deletion.open({ id: friendId, name: 'この友だちのデータ', kind: 'friend_data', path: `/api/friends/${encodeURIComponent(friendId)}/data` })
    } }] : []),
    { id: 'back-to-list', label: '友だち一覧へ戻る', icon: <ArrowLeft size={16} />, dividerBefore: true, onSelect: () => router.push('/friends') },
  ]

  // ---- 開けないとき（白い板の中に1つだけ。題・タブは出さない） ----
  if (!friendId) {
    return <TargetMissing kind="unspecified" title="見る友だちが指定されていません" description="友だちの一覧から、見たい人を選び直してください。" backHref="/friends" backLabel="友だち一覧へ戻る" />
  }
  if (!data.loading && data.loadForbidden) {
    // 403 は見つからない案内より先に分ける（監査 228-003）。押しても直らないので再試行は出さない。
    return <TargetMissing kind="error" title="この友だちを見る権限がありません" description={permissionDeniedMessage('store')} backHref="/friends" backLabel="友だち一覧へ戻る" />
  }
  if (!data.loading && (data.friendMissing || (!data.error && !friend))) {
    return <TargetMissing kind="not-found" title="この友だちは見つかりません" description="削除されたか、別の LINE アカウントの人です。一覧から選び直してください。" accountName={selectedAccount?.name} backHref="/friends" backLabel="友だち一覧へ戻る" />
  }
  if (!data.loading && !friend) {
    return <TargetMissing kind="error" title="友だちを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void data.loadFriend()} />
  }

  const status = friend?.support?.status
  const subtitle = friend
    ? `LINE 表示名：${friend.displayName || emptyValue('unknown')}・${friend.createdAt ? `${formatDay(friend.createdAt).replace(/（.）$/, '')}に友だち追加` : emptyValue('unknown')}・担当 ${friend.support?.operatorName ?? '未割り当て'}`
    : '読み込んでいます…'
  const realName = data.fields.find((f) => f.fixedKey === 'name')?.value ?? data.friend?.realName ?? ''

  return (
    <PageFrame kind="detail" boardId="Q5F2QE">
      <PageHeading title={friend?.displayName ?? '友だち詳細'}
        help={<>{subtitle}</>}
        leading={<Avatar name={friend?.displayName} src={friend?.pictureUrl} size={52} />}
        titleAccessory={status ? <StatusBadge tone={SUPPORT_TONES[status]}>{SUPPORT_LABELS[status]}</StatusBadge> : friend ? <span className={styles.faint}>やり取りなし</span> : null}
        actions={<><span className={styles.menuAnchor}>
          <RowMenu
            label="その他の操作"
            menuLabel="関連する画面を開く"
            items={secondaryActions}
            open={moreMenuOpen}
            onOpenChange={(next) => { setMoreMenuOpen(next); setActionMenuOpen(false) }}
          />
        </span><span className={styles.menuAnchor}>
          <Button
            aria-haspopup="menu"
            aria-expanded={actionMenuOpen}
            onClick={() => { setActionMenuOpen((v) => !v); setMoreMenuOpen(false) }}
          >
            <Zap aria-hidden />個別操作
          </Button>
          <ActionMenu open={actionMenuOpen} items={primaryActions} ariaLabel="この友だちへの個別操作" onClose={() => setActionMenuOpen(false)} />
        </span><Button href={inbox} variant="primary"><MessageCircle aria-hidden />受信箱で開く</Button></>} />

      {perms.viewOnly ? (
        <div className={styles.band}>
          <ReadOnlyNotice >閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice>
        </div>
      ) : null}

      <div className={styles.tabs}>
        <Tabs
          label="友だち詳細の中身"
          items={[...visibleTabs, ...(activeLinkOnlyTab ? [activeLinkOnlyTab] : [])].map((t) => ({
            label: t.label,
            href: `/friends/detail?id=${encodeURIComponent(friendId)}&tab=${t.key}${group === ALL_GROUP ? '' : `&group=${encodeURIComponent(group)}`}`,
            current: tab === t.key,
          }))}
        />
      </div>

      {data.error && friend ? (
        <div className={styles.notice}><Notice tone="danger" message={data.error} onClose={() => data.setError('')} /></div>
      ) : null}
      {supportAlert ? (
        <div className={styles.notice}>
          <Notice tone="warn" message={supportAlert} onClose={() => setSupportAlert('')} />
        </div>
      ) : null}

      {data.loading || !friend ? (
        <div className={styles.pane}><DetailLoading /></div>
      ) : tab === 'timeline' ? (
        <OverviewTab
          friend={friend}
          friendId={friendId}
          data={data}
          perms={perms}
          fields={data.fields}
          values={data.values}
          realName={realName}
          onEditSupport={() => void support.openEditor()}
          onEnrollScenario={() => void scenario.openPicker()}
          scenarioNotice={scenarioNotice}
        />
      ) : tab === 'history' ? (
        <HistoryTab friend={friend} friendId={friendId} data={data} />
      ) : tab === 'info' ? (
        fieldsEnabled ? (
          /* ：情報欄タブも左に概要と同じ要点（顧客情報・対応・タグ・マイル・メモ）を置く。 */
          <div className={styles.overview}>
            <FriendSummaryRail friend={friend} friendId={friendId} data={data} perms={perms} fields={data.fields} values={data.values} realName={realName} onEditSupport={() => void support.openEditor()} />
            <InfoTab friendId={friendId} group={group} data={data} perms={perms} />
          </div>
        ) : <FeatureDisabledScreen featureId="friend_fields" />
      ) : tab === 'forms' ? (
        <FormsTab data={data} />
      ) : tab === 'scenario' ? (
        <ScenarioTab canEnroll={perms.manage} onEnroll={() => void scenario.openPicker()} />
      ) : tab === 'orders' ? (
        bookingEnabled ? <BookingsTab accountId={selectedAccountId} friendId={friendId} friendName={realName || friend?.displayName || ''} canEdit={perms.manage} />
          : visibility.status === 'ready' ? <FeatureDisabledScreen featureId="booking" />
          : visibility.status === 'error' ? <ListState kind="error" title="機能の設定を確認できませんでした" />
          : <ListState kind="loading" title="機能の設定を確認しています" />
      ) : tab === 'reminders' ? (
        <RemindersTab friendId={friendId} />
      ) : tab === 'actions' ? (
        <ActionsTab friendId={friendId} />
      ) : tab === 'miles' ? (
        <MilesTab friendId={friendId} balanceSource={data.mileageStatus === 'ready' ? data.mileage?.balanceSource ?? 'musubo' : null} />
      ) : (
        <RichMenuTab />
      )}

      {tab !== 'timeline' && scenarioNotice ? <div className={styles.notice}><Notice tone="success" message={scenarioNotice} onClose={() => setScenarioNotice('')} /></div> : null}
      {support.dialog}
      {scenario.dialog}
      <ConfirmDialog open={deletion.target !== null && deletionContext?.scope === currentScope} title="友だちのデータを削除しますか？" deleteName="この友だちのデータ"
        description="お客さまから削除の依頼を受けた場合に実行してください。次の顧客データを削除します。元に戻せません。監査・支払・審査の記録と外部サービスのデータは残ります。"
        destructive confirmDisabled={deletion.blocked} busy={deletion.busy} busyLabel="削除中…" error={deletion.error}
        onConfirm={() => {
          if (!deletionMounted.current || !canDelete.current || !deletionContext || deletionContext.scope !== deletionScope.current || deletionContext.ticket !== deletionTicket.current) return
          deletionTicket.current = null
          void deletion.confirm()
        }} onCancel={() => {
          if (!deletionContext || deletionContext.ticket !== deletionTicket.current) return
          deletionTicket.current = null; deletion.close()
        }}>
        {deletionContext ? <OperationTargetSummary accounts={[{ id: deletionContext.targetAccountId }]} externalTarget={{ label: '友だち', name: deletionContext.friendName }} /> : null}
        <ul>
          <li>プロフィール・情報欄・タグとの紐付け・メモ</li>
          <li>トークと送信待ち・配信・予約などの顧客記録</li>
          <li>回答と添付した写真・PDF・本人確認書類</li>
          <li>未添付の書類・登録した写真など</li>
        </ul>
      </ConfirmDialog>
    </PageFrame>
  )
}

export default function FriendDetailV8() {
  return (
    <Suspense fallback={<div className={styles.pane}><DetailLoading /></div>}>
      <FriendDetailV8Inner />
    </Suspense>
  )
}
