'use client'

import { automationWaitLabel } from '@line-crm/shared'

import { CONSUMER_LABELS } from './version-consumer-labels'

/*
 * ★V8 共通アクションの版と使われている場所（Pencil ）。
 *
 * 2026-10-06 オーナー決定で src/v8 に一から書いた。データの口・動きは今までの V8
 * （共通アクションの既存API）と同じ（版の履歴・公開・前の版から新版・
 * 利用先の版切り替え・月次集計・読めないときの扱い）。違いは見せ方だけ——
 * 型（DetailPage）に、戻る道・題・説明・右上の操作・4つの数のマス・版の履歴・呼び出し元の表を渡す。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { BookOpen, GitBranch, History, Link2, Pencil, Upload, Zap } from 'lucide-react'
import { api, ApiError, type CommonActionDetail, type CommonActionStep, type CommonActionSummary } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatNumber } from '@/lib/format'
import { DetailPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import Card, { CardHeader } from '@/components/shared/card'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { DataTable, TableHeadRow, Th, Tr, Td, ActionCell } from '@/components/shared/table'
import { useAutomationManage } from './shell'
import { describeVersionChanges } from './version-diff'
import styles from './versions.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import Notice from '@/components/shared/notice'
import { useManualHref } from '@/lib/use-manual-href'

/** 処理の短い名前（版の履歴の1行：「タグ → 待つ 1日 → メッセージ「お礼」」）。 */
const STEP_SHORT: Record<string, string> = {
  add_tag: 'タグ', remove_tag: 'タグを外す', set_metadata: '友だち情報を書く',
  start_scenario: 'シナリオ', stop_scenario: 'シナリオを止める', resume_scenario: 'シナリオを再開',
  send_message: 'メッセージ', send_webhook: '外部連携', switch_rich_menu: 'メニュー切替',
  remove_rich_menu: 'メニューを外す', common_action: '共通アクション', branch: '条件で分ける',
  notify_staff: '担当へ知らせる', add_mileage: 'マイル',
}

/** 版の処理の並びを1行にする。 */
export function stepChain(actions: CommonActionStep[]): string {
  if (actions.length === 0) return '処理はありません'
  return actions.map((step) => {
    if (step.type === 'wait') return automationWaitLabel(step.params)
    const base = STEP_SHORT[step.type] ?? '処理'
    const name = typeof step.params.templateName === 'string' ? step.params.templateName : ''
    return step.type === 'send_message' && name ? `${base}「${name}」` : base
  }).join(' → ')
}

/** 「オートメーション 3・シナリオ 1」。 */
export function consumerBreakdown(bindings: Array<{ consumerType: string }>): string {
  if (bindings.length === 0) return 'まだどこからも呼ばれていません'
  const counts = new Map<string, number>()
  for (const binding of bindings) counts.set(binding.consumerType, (counts.get(binding.consumerType) ?? 0) + 1)
  return [...counts].map(([kind, count]) => `${CONSUMER_LABELS[kind] ?? 'ほか'} ${count}`).join('・')
}

/** 「9/24」（日本時間）。 */
function monthDay(iso: string | null): string {
  return polishFormatDate(iso, { style: 'list-day', fallback: '—' })
}

function VersionsInner() {
  usePageTitle('版と使われている場所')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'オートメーション', href: '/automations' }])
  const canManage = useAutomationManage()
  const canEdit = canManage === true
  const searchParams = useSearchParams()
  const id = searchParams.get('id') ?? ''
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const targetKey = JSON.stringify([id, selectedAccountId, canEdit])
  const targetScope = useRef({ key: targetKey })
  if (targetScope.current.key !== targetKey) targetScope.current = { key: targetKey }
  const bindingScope = useRef<typeof targetScope.current | null>(null)
  const bindingTicket = useRef<object | null>(null)
  const renderedBindingTicket = bindingTicket.current
  useEffect(() => () => { bindingTicket.current = null }, [])
  /* 画面のマニュアル（正本表の画面キー）。URL がある時だけ出す。 */
  const manualHref = useManualHref()
  const [detail, setDetail] = useState<CommonActionDetail | null>(null)
  const [summary, setSummary] = useState<CommonActionSummary | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [summaryRetrying, setSummaryRetrying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [loadFailure, setLoadFailure] = useState<'missing' | 'forbidden' | 'error' | null>(null)
  const [pendingBindingId, setPendingBindingId] = useState<string | null>(null)
  const pendingSnapshot = useRef<{ binding: CommonActionDetail['bindings'][number]; target: CommonActionDetail['versions'][number] } | null>(null)
  const [dialogError, setDialogError] = useState('')
  useEffect(() => { setWorking(''); setPendingBindingId(null); setDialogError('') }, [targetKey])
  const requestSeq = useRef(0)
  const lastTargetKey = useRef('')

  /* 月次の件数は一覧の口から読む（版の口には無い）。読めなくても版と利用先は出す。 */
  const readSummary = useCallback(async (my: number) => {
    if (!selectedAccountId) return
    try {
      const listResponse = await api.commonActions.list({ accountId: selectedAccountId })
      if (requestSeq.current !== my) return
      if (listResponse.success) {
        setSummary(listResponse.data.find((item) => item.id === id) ?? null)
        setSummaryError('')
      } else {
        setSummary(null)
        setSummaryError(listResponse.error || '月次件数を読み込めませんでした。通信の状態を確認してください。')
      }
    } catch {
      if (requestSeq.current !== my) return
      setSummary(null)
      setSummaryError('月次件数を読み込めませんでした。通信の状態を確認してください。')
    }
  }, [id, selectedAccountId])

  const reloadSummary = async () => {
    const my = ++requestSeq.current
    setSummaryRetrying(true)
    await readSummary(my)
    if (requestSeq.current === my) setSummaryRetrying(false)
  }

  const load = useCallback(async () => {
    if (!selectedAccountId || !id) {
      setDetail(null); setSummary(null); setSummaryError(''); setLoading(false)
      return
    }
    const targetKey = `${selectedAccountId}\u0000${id}`
    if (lastTargetKey.current !== targetKey) {
      lastTargetKey.current = targetKey
      setDetail(null); setSummary(null); setSummaryError(''); setPendingBindingId(null)
    }
    const my = ++requestSeq.current
    setLoading(true)
    setError('')
    setLoadFailure(null)
    try {
      const response = await api.commonActions.get(id, selectedAccountId)
      if (requestSeq.current !== my) return
      if (response.success) setDetail(response.data)
      else { setDetail(null); setError(response.error); setLoadFailure('error') }
    } catch (caught) {
      if (requestSeq.current !== my) return
      setDetail(null)
      if (caught instanceof ApiError && caught.status === 404) {
        setError('この共通アクションは削除されたか、別のLINEアカウントのものです。')
        setLoadFailure('missing')
      } else if (caught instanceof ApiError && caught.status === 403) {
        setError(permissionDeniedMessage('store'))
        setLoadFailure('forbidden')
      } else {
        setError(describeApiFailure(caught, '読み込み'))
        setLoadFailure('error')
      }
    }
    await readSummary(my)
    if (requestSeq.current === my) setLoading(false)
  }, [id, selectedAccountId, readSummary])

  useEffect(() => { if (!accountLoading) void load() }, [accountLoading, load])

  const published = useMemo(() => detail?.versions.find((version) => version.id === detail.currentPublishedVersionId) ?? null, [detail])
  const draft = useMemo(() => detail?.versions.find((version) => version.id === detail.currentDraftVersionId) ?? null, [detail])
  const pendingBinding = pendingBindingId ? pendingSnapshot.current?.binding ?? null : null
  const pendingVersion = useMemo(() => detail?.versions.find((version) => version.id === pendingBinding?.versionId) ?? null, [detail, pendingBinding])
  /* 版は新しい順（下書き → いまの版 → 古い版）。 */
  const versions = useMemo(() => [...(detail?.versions ?? [])].sort((a, b) => b.versionNumber - a.versionNumber), [detail])

  const run = async (key: string, task: () => Promise<unknown>): Promise<true | string> => {
    if (working) return '操作を実行できませんでした'
    if (!selectedAccountId) {
      setError('LINEアカウントを選び直してください。')
      return 'LINEアカウントを選び直してください。'
    }
    const scope = targetScope.current
    setWorking(key)
    setError('')
    try {
      await task()
      if (scope !== targetScope.current) return '操作対象が変わりました'
      await load()
      return true
    } catch (caught) {
      if (scope !== targetScope.current) return '操作対象が変わりました'
      const message = describeApiFailure(caught, '保存')
      setError(message)
      return message
    } finally {
      if (scope === targetScope.current) setWorking('')
    }
  }

  if (!id) {
    return <TargetMissing kind="unspecified" title="版を確認する共通アクションが指定されていません" description="一覧から共通アクションを選び直してください。" backHref="/common-actions" backLabel="共通アクション一覧へ戻る" />
  }
  if (loading && !detail) return <ListState kind="loading" title="版と利用先を読み込んでいます" />
  if (!selectedAccountId && !detail) {
    return <ListState kind="empty" title="LINE公式アカウントを選んでください" description="選ぶと版と利用先を確認できます。" action={<Button href="/common-actions">共通アクション一覧へ戻る</Button>} />
  }
  if (!detail && loadFailure === 'missing') {
    return <TargetMissing kind="not-found" title="この共通アクションは見つかりません" description="削除されたか、別のLINEアカウントのものです。一覧から選び直してください。" backHref="/common-actions" backLabel="共通アクション一覧へ戻る" />
  }
  if (!detail && loadFailure === 'forbidden') {
    return <ListState kind="forbidden" title="この共通アクションを表示する権限がありません" description="権限のある人に確認するか、別のLINEアカウントを選んでください。" action={<Button href="/common-actions">共通アクション一覧へ戻る</Button>} />
  }
  if (!detail) {
    return <TargetMissing kind="error" title="版と利用先を読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void load()} />
  }

  const outdatedCount = detail.bindings.filter((binding) => binding.hasNewerVersion).length
  const editHref = `/common-actions/edit?id=${encodeURIComponent(detail.id)}`

  return (
    <DetailPage
      boardId="ziSgL"
      headingSize="regular"
      title={`${detail.name}（版と使われている場所）`}
      help="公開した版は書き換えられません。公開しても、呼び出し元は自動で変わりません。使う場所ごとに新しい版へ更新します。更新しても、実行中・待機中の処理は変えず、次に始まる処理から新版を使います。"
      stats={<PageContent layout="stats"><KpiBand aria-label="版と利用先の集計">
        <KpiCard presentation="band" title="いまの版" icon={<GitBranch size={16} aria-hidden="true" />} value={null} valueText={published ? `第${published.versionNumber}版` : emptyValue('unknown')} unit="" detail={published?.publishedAt ? `${monthDay(published.publishedAt)} 公開` : 'まだ公開していません'} />
        <KpiCard presentation="band" title="呼び出し元" icon={<Link2 size={16} aria-hidden="true" />} value={detail.bindings.length} unit="か所" detail={consumerBreakdown(detail.bindings)} />
        <KpiCard presentation="band" title="古い版のまま" icon={<History size={16} aria-hidden="true" />} value={outdatedCount} unit="か所" detail={outdatedCount > 0 ? '新版あり' : 'すべて最新の版です'} />
        <KpiCard presentation="band" title="今月 動いた回数" icon={<Zap size={16} aria-hidden="true" />} value={summary?.executionCountThisMonth ?? null} unit="回" detail={`失敗 ${summary ? formatNumber(summary.failureCountThisMonth) : emptyValue('unknown')}`} />
      </KpiBand></PageContent>}
      actions={<>
        {manualHref ? <Button external href={manualHref}><BookOpen size={16} aria-hidden="true" />マニュアル</Button> : null}
        {canEdit && draft ? (
          <Button href={editHref}><Pencil size={16} aria-hidden="true" />下書きの中身を編集</Button>
        ) : canEdit && published ? (
          <Button
            disabled={Boolean(working)}
            onClick={() => void run('draft', () => api.commonActions.createDraft(detail.id, selectedAccountId!, published.id))}
          >
            <Pencil size={16} aria-hidden="true" />前の版から新版を作る
          </Button>
        ) : null}
      </>}
    >

      {summaryError ? (
        <Notice tone="danger" ><span>月次件数を読み込めませんでした。版と利用先は表示しています。</span><Button variant="secondary" disabled={summaryRetrying} onClick={() => void reloadSummary()}>月次件数をもう一度読み込む</Button></Notice>
      ) : null}



      {error ? <Notice tone="danger" >{error}</Notice> : null}

      <Card variant="form" aria-labelledby="versions-history-title">
        <CardHeader size="stacked" titleId="versions-history-title" title="版の履歴" />
        <p className={styles.cardLead}>公開しても、使っている所は今の版のまま。使う所ごとに新しい版へ切り替えます。</p>
        <ul className={styles.versionList}>
          {versions.map((version) => {
            const isDraft = version.status === 'draft'
            const isCurrent = version.id === detail.currentPublishedVersionId
            const label = isDraft ? '下書き' : isCurrent ? '公開中' : '古い版'
            return (
              <li key={version.id} className={styles.versionRow}>
                <span className={styles.versionName}>{`第${version.versionNumber}版`}</span>
                <StatusBadge tone={isCurrent ? 'success' : 'neutral'}>{label}</StatusBadge>
                <span className={styles.versionChain} title={stepChain(version.actions)}>{stepChain(version.actions)}</span>
                {!canEdit ? null : isDraft ? (
                  <Button
                    variant="primary"
                    disabled={Boolean(working)}
                    onClick={() => void run(`publish:${version.id}`, () => api.commonActions.publish(detail.id, selectedAccountId!, version.id, version.draftRevision))
                      .then((result) => {
                        if (result !== true) void (async () => { await load(); setError((current) => current || result) })()
                      })}
                  >
                    <Upload size={16} aria-hidden="true" />公開する
                  </Button>
                ) : (
                  /* 下書きがある間は新しい版を作れない（サーバも draft_exists で断る）。押せない理由を添える。 */
                  <Button
                    disabled={Boolean(working) || Boolean(draft)}
                    title={draft ? '下書きを公開すると、この版から新しい版を作れます' : undefined}
                    onClick={() => void run(`copy:${version.id}`, () => api.commonActions.createDraft(detail.id, selectedAccountId!, version.id))}
                  >
                    この版から新しい版
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      <section className={styles.usage} aria-labelledby="versions-usage-title">
        <CardHeader size="stacked" titleId="versions-usage-title" title="どこから呼ばれているか" />
        {detail.bindings.length === 0 ? (
          <p className={styles.cardLead}>まだどこからも呼ばれていません。</p>
        ) : (
          <Card padding="none" overflow="hidden"><DataTable columnLayout={{ headHeight: 'var(--tpl-thead-h)', rowHeight: 'var(--polish-table-row)', gap: 'var(--space-16)', padding: '0 var(--tpl-list-inset)', bodyTextSize: 'var(--text-caption)' }}>
              <thead>
                <TableHeadRow data-table-layout="columns">
                  <Th grow>利用先</Th>
                  <Th className={styles.colPinned}>固定中の版</Th>
                  <Th className={styles.colNum} align="right">実行中</Th>
                  <Th className={styles.colNum} align="right">待機中</Th>
                  <Th className={styles.colState}>状態</Th>
                  <Th className={styles.colOps} showActionLabel>操作</Th>
                </TableHeadRow>
              </thead>
              <tbody>
                {detail.bindings.map((binding) => (
                  <Tr key={binding.id} data-table-layout="columns" data-row-id={binding.id}>
                    <Td grow>
                      <TruncatedText value={binding.consumerPath || '全体'} />
                      <span className={styles.whereSub}>{CONSUMER_LABELS[binding.consumerType] ?? binding.consumerType}</span>
                    </Td>
                    <Td className={styles.colPinned}><span className={styles.cell}>{`第${binding.versionNumber}版`}</span></Td>
                    <Td className={styles.colNum}>
                      <span className={styles.cell} title={binding.runningCount === null ? '未取得' : undefined}>{binding.runningCount ?? emptyValue('unknown')}</span>
                      {binding.olderRunningCount ? <span className={styles.whereSub}>{`旧版 ${binding.olderRunningCount}`}</span> : null}
                    </Td>
                    <Td className={styles.colNum}>
                      <span className={styles.cell} title={binding.waitingCount === null ? '未取得' : undefined}>{binding.waitingCount ?? emptyValue('unknown')}</span>
                      {binding.olderWaitingCount ? <span className={styles.whereSub}>{`旧版 ${binding.olderWaitingCount}`}</span> : null}
                    </Td>
                    <Td className={styles.colState}>
                      <StatusBadge tone={binding.hasNewerVersion ? 'info' : 'success'}>{binding.hasNewerVersion ? '新版あり' : '最新'}</StatusBadge>
                    </Td>
                    <ActionCell className={styles.colOps}>
                      {canEdit && binding.hasNewerVersion && published ? (
                        <Button disabled={Boolean(working)} onClick={() => { if (!published) return; bindingScope.current = targetScope.current; bindingTicket.current = {}; pendingSnapshot.current = { binding, target: published }; setPendingBindingId(binding.id); setDialogError('') }}>

                          {`第${published.versionNumber}版へ更新する`}
                        </Button>
                      ) : <EmptyCell />}
                    </ActionCell>
                  </Tr>
                ))}
              </tbody>
            </DataTable></Card>
        )}
      </section>
      {/* 決まり2: 新版の効き目の説明は帯にせず、題の横の「？」へ入れる。 */}

      <Dialog
        open={Boolean(pendingBinding && published && bindingScope.current === targetScope.current)}
        title={`この利用先を第${pendingSnapshot.current?.target.versionNumber ?? ''}版へ更新しますか`}
        description="実行中・待機中の処理は変えず、次に始まる処理から新版を使います。"
        confirmLabel={`第${pendingSnapshot.current?.target.versionNumber ?? ''}版へ更新`}
        busy={working.startsWith('binding:')}
        onCancel={() => { bindingTicket.current = null; setPendingBindingId(null); setDialogError('') }}
        onConfirm={() => {
          if (!pendingBinding || !published || !pendingSnapshot.current || !Number.isSafeInteger(pendingBinding.confirmationRevision) || !selectedAccountId || !renderedBindingTicket || bindingTicket.current !== renderedBindingTicket || bindingScope.current !== targetScope.current) return

          const scope = targetScope.current
          const targetVersionId = pendingSnapshot.current.target.id
          setDialogError('')
          return run(`binding:${pendingBinding.id}`, () => api.commonActions.updateBinding(detail.id, selectedAccountId, {
            bindingId: pendingBinding.id,
            versionId: targetVersionId,
            expectedVersionId: pendingBinding.versionId,
            expectedConfirmationRevision: pendingBinding.confirmationRevision,
          })).then((result) => {
            if (scope !== targetScope.current) return
            if (result === true) { bindingTicket.current = null; setPendingBindingId(null); setDialogError('') }
            else { setDialogError(result); void load() }
          })
        }}
      >
        <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} />
        <div className={styles.compare}>
          <section>
            <p className={styles.compareLabel}>現在の版</p>
            <p className={styles.compareValue}>{`第${pendingBinding?.versionNumber ?? emptyValue('unknown')}版・${pendingVersion?.actions.length ?? emptyValue('unknown')}個の処理`}</p>
            <p className={styles.cardLead}>{pendingVersion ? stepChain(pendingVersion.actions) : '未取得'}</p>
          </section>
          <section>
            <p className={styles.compareLabel}>更新後</p>
            <p className={styles.compareValue}>{`第${published?.versionNumber ?? emptyValue('unknown')}版・${published?.actions.length ?? emptyValue('unknown')}個の処理`}</p>
            <p className={styles.cardLead}>{published ? stepChain(published.actions) : '未取得'}</p>
          </section>
        </div>
        {pendingVersion && published ? (
          <section>
            <p className={styles.compareLabel}>変わった点</p>
            <ul className={styles.changeList}>
              {describeVersionChanges(pendingVersion.actions, published.actions).map((line) => <li key={line}>{line}</li>)}
            </ul>
          </section>
        ) : null}
        <p className={styles.cardLead}>
          {`影響：実行中 ${pendingBinding?.runningCount ?? emptyValue('unknown')}件、待機中 ${pendingBinding?.waitingCount ?? emptyValue('unknown')}件は現在の版のまま完了します。`}
        </p>
        {dialogError ? <Notice tone="danger" >{dialogError}</Notice> : null}
      </Dialog>
    </DetailPage>
  )
}

export default function CommonActionVersionsV8() {
  return (
    <Suspense fallback={<ListState kind="loading" title="版と利用先を読み込んでいます" />}>
      <VersionsInner />
    </Suspense>
  )
}
