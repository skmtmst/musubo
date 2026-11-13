'use client'

/*
 * ★V8 LINEアカウントの詳細（Pencil ）。
 *
 * 白い板の頭（題・状態の1行・右に「編集する」「乗り換え」）→ 左に「設定の中のメニュー」→
 * 中央に登録の内容・つづき・資格情報・Webhook、右にできること・気をつけること・つながる先・
 * 送受信を止める／アーカイブ。窓（止める ・資格情報 ・アーカイブ ・
 * 編集 ）は dialogs.tsx。データの口は今の画面（app/accounts/detail）と同じ。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArchiveRestore, ArrowLeftRight, Pause, Pencil, Play, QrCode } from 'lucide-react';
import type { LineAccount } from '@line-crm/shared';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { SettingsPage } from '@/components/templates';
import SettingsInnerNav from '@/components/layout/settings-inner-nav';
import Button from '@/components/shared/button';
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason';
import SendersCard from './senders-card';
import Card, { CardHeader } from '@/components/shared/card';
import TruncatedText from '@/components/shared/truncated-text';
import TextLink from '@/components/shared/text-link';
import StatusBadge from '@/components/shared/status-badge';
import TargetMissing from '@/components/shared/target-missing';
import { ArchiveDialog, CredentialsDialog, EditDialog, RestoreDialog, StopDialog, TestRecipientsDialog, type CredentialKind } from './dialogs';
import { archiveBlockedReason, capacityDetails, credentialLine, friendsLine, shortDateTime, skippedKindLabel, stateBadge, summaryLine, webhookMatch, webhookUse, type AccountDetailView } from './view';
import styles from './detail.module.css';
import { emptyValue } from '@/components/shared/empty-value';
import { DetailLoading } from '@/components/templates/detail-page';
import ReadOnlyNotice from '@/components/shared/read-only-notice';
import { Row, ActionValue } from "./detail-gap-parts"
type Skipped = Array<{ id: string; kind: string; title: string | null; skippedAt: string }>

const CAN_DO = ['・友だち追加URLとQRはここに出ます', '・人ごとの既定のアカウントはここで決めます', '・接続の異常や停止は、ここで見張ります'].join('\n')
const CAREFUL = ['・停止しても、友だちと履歴は消えません', '・アーカイブした記録はあとから戻せます', '・資格情報を差し替えたら、接続の表示を確かめます'].join('\n')
const LINKS = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/friends', label: '友だち' },
  { href: '/staff', label: 'ログインユーザー' },
  { href: '/emergency', label: '運用状態' },
] as const

export default function AccountDetailV8() {
  const archiveReasonId = useId()
  const search = useSearchParams()
  const id = search?.get('id') ?? ''
  const role = useStaffRole()
  // 変える操作はオーナー・管理者だけ。役割が分かるまでは出さない（今の画面と同じ）。
  const canManage = role !== null && canManageRole(role)
  const manageLockReason = usePermissionLockReason(canManage, 'manager')
  const viewer = role !== null && !canManage

  const [account, setAccount] = useState<AccountDetailView | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [missing, setMissing] = useState(false)
  // 親の名前用の一覧は補助。取れなくても詳細は出し、その欄だけ取り直せる（R521）。
  const [all, setAll] = useState<LineAccount[]>([])
  const [allState, setAllState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [recipients, setRecipients] = useState<string[] | null | 'error'>(null)
  const [skipped, setSkipped] = useState<Skipped | null | 'error'>(null)

  const [stopTarget, setStopTarget] = useState<LineAccount | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<LineAccount | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<LineAccount | null>(null)
  const [editing, setEditing] = useState(false)
  const [credentials, setCredentials] = useState<CredentialKind | null>(null)
  const [recipientsOpen, setRecipientsOpen] = useState(false)

  const loadAll = useCallback(async () => {
    setAllState('loading')
    try {
      const list = await api.lineAccounts.list()
      if (!list.success) { setAllState('error'); return }
      setAll(list.data)
      setAllState('ready')
    } catch {
      setAllState('error')
    }
  }, [])

  /*
   * 読込の世代（WEB132）。同じ画面のまま ?id= が A→B と変わったとき、A の遅い応答で B の画面・
   * 「送らなかった」一覧・テスト送信先を上書きしない。最後に出した要求の応答だけを使う。
   */
  const loadSeq = useRef(0)
  const recipientsSeq = useRef(0)

  const loadRecipients = useCallback(async () => {
    if (!id) return
    const seq = ++recipientsSeq.current
    try {
      const res = await api.accountSettings.getTestRecipients(id)
      if (seq !== recipientsSeq.current) return
      setRecipients(res.success && Array.isArray(res.data) ? res.data.map((r) => r.displayName) : 'error')
    } catch {
      if (seq !== recipientsSeq.current) return
      setRecipients('error')
    }
  }, [id])

  const load = useCallback(async () => {
    if (!id) return
    const seq = ++loadSeq.current
    setMissing(false)
    try {
      const one = await api.lineAccounts.get(id)
      if (seq !== loadSeq.current) return
      if (!one.success) { setStatus('error'); return }
      const data = one.data as AccountDetailView
      setAccount(data)
      // 止まっているアカウントでは「送らなかった」一覧も読む（X-1）。
      if (!data.isActive && !data.archivedAt) {
        api.lineAccounts.skippedDeliveries(id)
          .then((res) => { if (seq === loadSeq.current) setSkipped(res.success && Array.isArray(res.data) ? res.data : 'error') })
          .catch(() => { if (seq === loadSeq.current) setSkipped('error') /* 一覧が読めなくても詳細は使える。 */ })
      } else {
        setSkipped(null)
      }
      setStatus('ready')
    } catch (caught) {
      if (seq !== loadSeq.current) return
      if (caught instanceof ApiError && caught.status === 404) {
        setMissing(true)
        setStatus('ready')
        return
      }
      setStatus('error')
    }
  }, [id])

  /*
   * 見るアカウントが変わったら、前のアカウントの表示と開いていた窓を捨てる（WEB132）。
   * A で開いた差し替え・編集・止めるの窓を B の画面に残さない。
   */
  const shownId = useRef(id)
  useEffect(() => {
    if (shownId.current === id) return
    shownId.current = id
    setAccount(null)
    setStatus('loading')
    setMissing(false)
    setRecipients(null)
    setSkipped(null)
    setStopTarget(null)
    setArchiveTarget(null)
    setRestoreTarget(null)
    setEditing(false)
    setCredentials(null)
    setRecipientsOpen(false)
  }, [id])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadAll() }, [loadAll])
  useEffect(() => { void loadRecipients() }, [loadRecipients])
  usePageTitle(account?.name ?? 'LINEアカウント')
  usePageCrumbs([{ label: '設定' }, { label: 'LINEアカウント', href: '/accounts' }])

  /*
   * `?tab=`（今の画面のタブ：overview・connection・credentials・handover）は読まない。V8 は1枚の画面で、
   * 資格情報・Webhook も最初の画面に出ている。動かすと窓の撮影の位置がずれる（BEHAVIOR.md）。
   */

  const frame = (children: ReactNode, title = 'LINEアカウント') => (
    <div className={styles.screen}>
      <SettingsPage layout="account-detail" boardId="ihjfd" title={title} navigation={<SettingsInnerNav inline />}>{children}</SettingsPage>
    </div>
  )

  if (!id) {
    return frame(
      <TargetMissing
        kind="unspecified"
        title="見るアカウントが指定されていません"
        description="LINEアカウントの一覧から、見るアカウントを選び直してください。"
        backHref="/accounts"
        backLabel="LINEアカウントの一覧へ戻る"
      />,
    )
  }
  if (status === 'loading' || (account !== null && account.id !== id)) return frame(<DetailLoading />)
  if (missing || (status === 'ready' && !account)) {
    return frame(
      <TargetMissing
        kind="not-found"
        title="このアカウントは見つかりません"
        description="削除されたか、別の記録です。一覧から選び直してください。"
        backHref="/accounts"
        backLabel="LINEアカウントの一覧へ戻る"
      />,
    )
  }
  if (status === 'error' || !account) {
    return frame(
      <TargetMissing
        kind="error"
        title="アカウントを読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void load()}
      />,
    )
  }

  const parent = account.parentLineAccountId ? all.find((a) => a.id === account.parentLineAccountId) ?? null : null
  const state = stateBadge(account)
  const use = webhookUse(account)
  const match = webhookMatch(account)
  const blocked = archiveBlockedReason(account)
  const lastReceived = account.connection?.lastReceivedAt ?? account.lastWebhookReceivedAt ?? null

  const parentValue = !account.parentLineAccountId
    ? emptyValue('none')
    : allState === 'ready'
      ? parent?.name ?? emptyValue('unknown')
      : allState === 'loading'
        ? '読み込んでいます'
        : null

  const recipientValue = recipients === null
    ? '読み込んでいます'
    : recipients === 'error'
      ? '読み込めませんでした'
      : recipients.length === 0 ? emptyValue('unconfigured') : recipients.join('、')

  const headActions = (
    <div className={styles.headActions}>
      {/* 閲覧のみでも隠さず、灰色＋理由の吹き出し（2026-10-26 オーナー・全画面）。押しても Button が止める。 */}
      <Button type="button" lockedReason={canManage ? undefined : manageLockReason} disabled={!canManage && !manageLockReason} onClick={() => setEditing(true)}>
        <Pencil size={16} aria-hidden="true" />編集する
      </Button>
      <Button href={`/accounts/handover?id=${account.id}`}>
        <ArrowLeftRight size={16} aria-hidden="true" />乗り換え
      </Button>
    </div>
  )

  return (
    <div className={styles.screen}>
      <SettingsPage layout="account-detail"
        boardId="ihjfd"
        title={account.name}
        help={summaryLine(account, parent?.name ?? null)}
        actions={headActions}
        navigation={<SettingsInnerNav inline />}
      >
        {viewer ? (
          <ReadOnlyNotice role="status"></ReadOnlyNotice>
        ) : null}
        <div className={styles.columns}>
          <div className={styles.main}>
            <Card variant="form" aria-labelledby="acd-basic">
              <CardHeader size="stacked" headingLevel={3} titleId="acd-basic" title="登録の内容" />
              <Row label="表示名">{account.name}</Row>
              <Row label="チャネルID">{account.channelId}</Row>
              <Row label="親アカウント">
                {parentValue ?? (
                  <span className={styles.inline}>
                    読み込めませんでした
                    <Button type="button" variant="text" presentation="account-inline" onClick={() => loadAll()} busyLabel="処理中…">もう一度読み込む</Button>
                  </span>
                )}
              </Row>
              <Row label="タイムゾーン">{account.timezone ?? 'Asia/Tokyo'}</Row>
              <Row label="テスト送信先">
                <ActionValue value={recipientValue} action={canManage ? <Button type="button" variant="text" presentation="account-inline" onClick={() => setRecipientsOpen(true)}>変える</Button> : <Button type="button" variant="text" presentation="account-inline" lockedReason={manageLockReason} disabled={!manageLockReason}>変える</Button>} />
              </Row>
              {/* 登録の内容は1枚のカードにまとめる（つづきで割らない）。 */}
              <Row label="友だち数"><span title={capacityDetails(account)}>{friendsLine(account)}</span></Row>
              <Row label="状態"><span className={styles.end}><StatusBadge tone={state.tone}>{state.label}</StatusBadge></span></Row>
              <Row label="国・地域">{account.country ?? emptyValue('unconfigured')}</Row>
              <Row label="役割メモ"><TruncatedText value={account.role ?? emptyValue('unconfigured')} /></Row>
            </Card>

            <SendersCard accountId={account.id} accountName={account.name} />
            <Card variant="form" aria-labelledby="acd-credentials">
              <CardHeader size="stacked" headingLevel={3} titleId="acd-credentials" title="資格情報" meta="秘密値そのものは表示しません。差し替えるときは、新しい値を入れて保存し直します。" />
              <Row label="チャネルシークレット">
                <ActionValue
                  value={credentialLine({ configured: account.channelSecretConfigured, last4: account.channelSecretLast4, updatedAt: null, checkedAt: account.connection?.lastTestAt ?? null })}
                  action={canManage ? <Button type="button" onClick={() => setCredentials('messaging')}>差し替える</Button> : <Button type="button" lockedReason={manageLockReason} disabled={!manageLockReason}>差し替える</Button>}
                />
              </Row>
              <Row label="Loginチャネルシークレット">
                <ActionValue
                  value={credentialLine({ configured: account.loginChannelSecretConfigured, last4: account.loginChannelSecretLast4, updatedAt: account.loginChannelSecretUpdatedAt })}
                  action={canManage ? <Button type="button" onClick={() => setCredentials('login')}>差し替える</Button> : <Button type="button" lockedReason={manageLockReason} disabled={!manageLockReason}>差し替える</Button>}
                />
              </Row>
              <div className={styles.wide}>
                <span className={styles.wideLabel}>チャネルアクセストークン</span>
                <span className={styles.wideValue}>
                  {credentialLine({ configured: account.channelAccessTokenConfigured, last4: account.channelAccessTokenLast4, updatedAt: account.channelAccessTokenUpdatedAt })}
                </span>
                {canManage ? <Button type="button" onClick={() => setCredentials('messaging')}>差し替える</Button> : <Button type="button" lockedReason={manageLockReason} disabled={!manageLockReason}>差し替える</Button>}
              </div>
              <Row label="Webhookの利用" id="acd-webhook">
                <span className={styles.inline}>
                  <StatusBadge tone={use.tone}>{use.label}</StatusBadge>
                  {lastReceived ? <span className={styles.faint}>最後の受信 {shortDateTime(lastReceived)}</span> : null}
                </span>
              </Row>
              <Row label="このシステムが待っているURL">
                <span className={styles.truncate} title={account.webhook?.expectedUrl ?? undefined}>{account.webhook?.expectedUrl ?? emptyValue('unknown')}</span>
              </Row>
              <Row label="LINE側に登録したURL">
                <span className={styles.inline}>
                  <span className={styles.muted} title={match.value}>{match.value}</span>
                  <StatusBadge tone={match.tone}>{match.badge}</StatusBadge>
                </span>
              </Row>
            </Card>

            {!account.isActive && !account.archivedAt ? (
              <Card variant="form" aria-labelledby="acd-skipped">
                <div className={styles.cardHead}>
                  <CardHeader size="stacked" headingLevel={3} titleId="acd-skipped" title="止まっている間に送らなかったもの" />
                  {account.inactivatedAt ? (
                    <p className={styles.cardSub}>
                      {formatDateTime(account.inactivatedAt)} から止まっています{account.inactiveReasonDetail ? `（理由: ${account.inactiveReasonDetail}）` : ''}
                    </p>
                  ) : null}
                </div>
                {skipped === null ? (
                  <DetailLoading />
                ) : skipped === 'error' ? (
                  <p className={styles.muted}>送らなかった配信の一覧を読み込めませんでした。詳細のほかの欄はそのまま使えます。</p>
                ) : skipped.length === 0 ? (
                  <p className={styles.muted}>送らなかった配信はありません。</p>
                ) : (
                  <ul className={styles.skippedList}>
                    {skipped.map((row) => (
                      <li key={row.id} className={styles.skippedRow}>
                        <span className={styles.truncate} title={row.title ?? row.kind}>{row.title ?? skippedKindLabel(row.kind)}</span>
                        <span className={styles.faint}>{skippedKindLabel(row.kind)}・{formatDateTime(row.skippedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={styles.faint}>再開しても、ここに並んだ配信は自動では送り直しません。</p>
              </Card>
            ) : null}
          </div>

          <aside className={styles.side}>
            <Card variant="aside" aria-labelledby="acd-cando">
              <CardHeader size="stacked" headingLevel={3} titleId="acd-cando" title="このアカウントでできること" />
              <p className={styles.bullets}>{CAN_DO}</p>
              <Button href="/?qr=base" className={styles.fit}><QrCode size={16} aria-hidden="true" />友だち追加URLとQRを見る</Button>
            </Card>
            <Card variant="aside" aria-labelledby="acd-careful">
              <CardHeader size="stacked" headingLevel={3} titleId="acd-careful" title="気をつけること" />
              <p className={styles.bullets}>{CAREFUL}</p>
            </Card>
            <Card variant="aside" aria-labelledby="acd-links">
              <CardHeader size="stacked" headingLevel={3} titleId="acd-links" title="つながる先" />
              <p className={styles.links}>
                {LINKS.map((link, index) => (
                  <span key={link.href}>{index > 0 ? '　' : ''}<TextLink href={link.href}>{link.label}</TextLink></span>
                ))}
              </p>
            </Card>
            <div className={styles.actions}>
              {account.archivedAt ? (
                <Button type="button" lockedReason={canManage ? undefined : manageLockReason} disabled={!canManage && !manageLockReason} onClick={() => setRestoreTarget(account)}>
                  <ArchiveRestore size={16} aria-hidden="true" />アーカイブから戻す
                </Button>
              ) : (
                <>
                  <Button type="button" lockedReason={canManage ? undefined : manageLockReason} disabled={!canManage && !manageLockReason} onClick={() => setStopTarget(account)}>
                    {account.isActive ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                    {account.isActive ? '送受信を止める' : '送受信を再開する'}
                  </Button>
                  <Button type="button" variant="danger" lockedReason={canManage ? undefined : manageLockReason} disabled={blocked !== null || (!canManage && !manageLockReason)} title={blocked ?? undefined} aria-describedby={blocked ? archiveReasonId : undefined} onClick={() => setArchiveTarget(account)}>
                    アーカイブする
                  </Button>
                  {blocked ? <p id={archiveReasonId} className={styles.note}>{blocked}</p> : null}
                </>
              )}
            </div>
          </aside>
        </div>
      </SettingsPage>

      <StopDialog account={stopTarget} onClose={() => setStopTarget(null)} onDone={load} />
      <ArchiveDialog account={archiveTarget} onClose={() => setArchiveTarget(null)} onDone={load} />
      <RestoreDialog account={restoreTarget} onClose={() => setRestoreTarget(null)} onDone={load} />
      <EditDialog account={editing ? account : null} canEditTimezone={role === 'owner'} onClose={() => setEditing(false)} onSaved={() => void load()} />
      <CredentialsDialog account={credentials ? account : null} kind={credentials ?? 'messaging'} onClose={() => setCredentials(null)} onSaved={() => void load()} />
      <TestRecipientsDialog accountId={account.id} open={recipientsOpen} onClose={() => { setRecipientsOpen(false); void loadRecipients() }} />
    </div>
  )
}
