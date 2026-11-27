'use client'
import { knownValue } from '@/lib/known-value'
import { useRunningVersion } from '@/lib/use-running-version'

/*
 * ★V8 運用状態 更新履歴（板 ）。
 *
 * 並び：数のマス3つ（いまの版・この30日の更新・失敗した更新）→ 1回の更新＝1枚の並び（新しい順）→
 * 下の行に自動更新の記録への案内と「アップデート履歴を見る」（管理画面の /updates へ。外の手引きへのリンクは置かない）。
 * 1枚には、日付・版・配備の結果・種類の数・3行のまとめ・［すべて見る］。区切りと3行の決め方は
 * history-updates.ts。止めた・戻した記録は緊急コントロールの表で見る。
 * 版と行は更新履歴ファイル（release-log の要約）、結果は配備の記録（運用の履歴の deployment）から引く。
 * 記録が無い値は出さない（0 や成功とは言わない）。
 */
import { useEffect, useMemo, useState } from 'react'
import { CircleX, GitBranch, History, RefreshCw } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import SearchField from '@/components/shared/search-field'
import Disclosure from '@/components/shared/disclosure'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import SectionHeader from '@/components/shared/section-header'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import releaseLog from '@/generated/release-log-summary.json'
import { api, type OperationHistoryEntry } from '@/lib/api'
import { formatCount, formatDate } from '@/lib/format'
import styles from './history.module.css'
import { buildUpdateCards, searchUpdateCards, latestDeploymentPhases, missingLineCount, toTime, type Deployment, type ReleaseSummary, type UpdateCard, type UpdateKind } from './history-updates'

export { latestDeploymentPhases } from './history-updates'

const HISTORY_FETCH_LIMIT = 200
const DAY = 24 * 60 * 60 * 1000
/** 一度に出す枚数。続きは［もっと見る］で足す。 */
const CARD_PAGE = 10

/** 配備した人が仕組み（自動の配備）かどうか。 */
function isAutomatic(deployment: Deployment): boolean {
  return /github|actions|bot|auto|system/i.test(deployment.actor)
}

const RESULT: Record<Deployment['phase'], { label: string; tone: StatusBadgeTone }> = {
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  rolled_back: { label: '戻した', tone: 'warning' },
  queued: { label: '待っている', tone: 'neutral' },
  deploying: { label: '入れている', tone: 'neutral' },
  verifying: { label: '確かめている', tone: 'neutral' },
}

const ENVIRONMENT: Record<string, string> = { staging: '検証', production: '本番' }

const KIND_LABEL: Record<UpdateKind, string> = { added: '追加', changed: '変更', fixed: '修正' }
const KIND_ORDER: UpdateKind[] = ['added', 'changed', 'fixed']

/** WEB194：配備の記録が無い・読めないときに「反映済み（成功）」と言わない。 */
export function releaseResult(deployment: Deployment | null, historyState: 'loading' | 'ready' | 'error'): { label: string; tone: StatusBadgeTone } | null {
  if (deployment) return RESULT[deployment.phase]
  if (historyState === 'error') return { label: '確認できません', tone: 'neutral' }
  return null
}

function CardDate({ at }: { at: string | null }) {
  if (!at) return <>日時の記録なし</>
  return <time dateTime={at}>{formatDate(at, { style: 'detail' })}</time>
}

function UpdateCardView({ card, historyState }: { card: UpdateCard; historyState: 'loading' | 'ready' | 'error' }) {
  const result = card.source === 'deployment' ? releaseResult(card.deployment, historyState) : null
  const environment = card.deployment ? ENVIRONMENT[card.deployment.environment] ?? card.deployment.environment : null
  const counts = KIND_ORDER.filter((kind) => card.counts[kind] > 0)
  const title = card.source === 'pending' ? 'これから入る変更' : <CardDate at={card.at} />
  const note = card.source === 'pending'
    ? formatCount(card.entryCount, '行')
    : [card.version ? `${card.version}` : null, environment ? `${environment}へ${card.deployment && isAutomatic(card.deployment) ? '自動' : '手動'}で配備` : null].filter(Boolean).join('・') || undefined
  const badges = <>
    {card.latest ? <StatusBadge tone="info" dot={false}>最新</StatusBadge> : null}
    {card.source === 'archive' ? <StatusBadge tone="neutral" dot={false}>{`前の版のまとめ（${formatCount(card.entryCount, '行')}）`}</StatusBadge> : null}
    {result ? <StatusBadge tone={result.tone}>{result.label}</StatusBadge> : null}
  </>
  const hasMore = card.entries.length > card.highlights.length
  return (
    <Card as="article" padding="default" gap="tight" aria-label={card.source === 'pending' ? 'これから入る変更' : `${card.at ? formatDate(card.at, { style: 'detail' }) : '日時の記録なし'}の更新`} data-update-card={card.source} data-update-latest={card.latest ? '' : undefined}>
      <SectionHeader title={title} note={note} actions={badges} />
      {counts.length > 0 ? (
        <ul className={styles.counts} aria-label="種類ごとの数">
          {counts.map((kind) => <li key={kind}><StatusBadge tone="neutral" dot={false}>{`${KIND_LABEL[kind]} ${formatCount(card.counts[kind], '').trim()}`}</StatusBadge></li>)}
        </ul>
      ) : null}
      {card.source === 'pending' ? (
        <p className={styles.note}>次の版に入る予定の変更です。版に入ると、ここから日付の1枚へ移ります。</p>
      ) : card.source === 'archive' && card.entries.length === 0 ? (
        <p className={styles.note}>この版の行は前の版のまとめに集めてあり、この画面には出していません。</p>
      ) : card.highlights.length > 0 ? (
        <ul className={styles.lines} aria-label={card.highlightSource === 'written' ? 'この回のまとめ' : 'この回のおもな変更'}>
          {card.highlights.map((line, index) => <li key={`${index}|${line}`} className={styles.line}>{line}</li>)}
        </ul>
      ) : (
        <p className={styles.note}>この回の変更の行は記録にありません。</p>
      )}
      {hasMore || (card.source === 'pending' && card.entries.length > 0) ? (
        <Disclosure size="compact" appearance="inset" title={`すべて見る（${formatCount(card.entryCount, '行')}）`}>
          <ul className={styles.lines} aria-label="この回のすべての変更">
            {card.entries.map((entry, index) => (
              <li key={`${index}|${entry.text}`} className={styles.line}>
                <span className={styles.kind}>{knownValue(KIND_LABEL, entry.kind as UpdateKind, '変更')}</span>{entry.text}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Card>
  )
}

export default function UpdateHistoryV8({ hqOrigin = false }: { hqOrigin?: boolean } = {}) {
  usePageTitle('更新履歴')
  usePageCrumbs([{ label: '運用状態', href: '/emergency' }])
  const runningVersion = useRunningVersion()
  const [history, setHistory] = useState<OperationHistoryEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retryToken, setRetryToken] = useState(0)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [fullReleases, setFullReleases] = useState<NonNullable<ReleaseSummary['releases']> | null>(null)
  const [searchError, setSearchError] = useState(false)
  const [searchRetryToken, setSearchRetryToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    api.operations.history(HISTORY_FETCH_LIMIT)
      .then((response) => {
        if (cancelled) return
        if (response.success && Array.isArray(response.data)) { setHistory(response.data); setState('ready') } else setState('error')
      })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [retryToken])

  const summary = releaseLog as ReleaseSummary
  const releases = useMemo(() => (summary.releases ?? []).filter((item) => item.released), [summary])
  const deployments = useMemo(() => latestDeploymentPhases(history.flatMap((item) => (item.historyKind === 'deployment' && item.deployment ? [item.deployment] : []))), [history])

  const now = Date.now()
  const recent = deployments.filter((d) => now - toTime(d.occurredAt) <= 30 * DAY)
  const recentReleases = releases.filter((r) => now - toTime(r.released) <= 30 * DAY)
  const current = runningVersion.detail?.version.replace(/^v/, '')
  const currentAt = runningVersion.detail?.released_at
  const auto = recent.filter(isAutomatic).length
  const failed = recent.filter((d) => d.phase === 'failed' || d.phase === 'rolled_back').length
  const ready = state === 'ready'

  useEffect(() => {
    if (!query.trim() || fullReleases !== null) return
    let cancelled = false
    setSearchError(false)
    // 本文の大きい記録は検索するときだけ読み、初期表示は小さい要約を使う。
    void import('@/generated/release-log.json').then((loaded) => {
      if (!cancelled) setFullReleases(loaded.default.releases)
    }).catch(() => { if (!cancelled) setSearchError(true) })
    return () => { cancelled = true }
  }, [query, fullReleases, searchRetryToken])
  const searchableSummary = useMemo(() => fullReleases === null ? summary : {
    ...summary, releases: fullReleases,
  }, [summary, fullReleases])
  const allCards = useMemo(() => buildUpdateCards({ summary: query.trim() ? searchableSummary : summary, deployments, runningVersion: current, includeArchivedEntries: Boolean(query.trim()) }), [summary, searchableSummary, query, deployments, current])
  const cards = useMemo(() => searchUpdateCards(allCards, query), [allCards, query])
  const missing = query.trim() ? 0 : missingLineCount(summary)
  const pageCount = Math.max(1, Math.ceil(cards.length / CARD_PAGE))
  const shownPage = Math.min(page, pageCount)
  const first = (shownPage - 1) * CARD_PAGE + 1
  const last = Math.min(cards.length, shownPage * CARD_PAGE)

  return (
    <div className={styles.board}>
      <KpiBand aria-label="更新の集計">
        <KpiCard title="いまの版" icon={<GitBranch size={16} />} value={null} valueText={current ? `${current}` : '—'} unit="" detail={currentAt ? `${formatDate(currentAt, { style: 'list' })} に更新` : runningVersion.statusText} />
        <KpiCard title="この30日の更新" icon={<RefreshCw size={16} />} value={ready ? Math.max(recent.length, recentReleases.length) : null} unit="回" detail={ready ? (recent.length > 0 ? `自動 ${auto}・手動 ${recent.length - auto}` : '配備の記録なし（版の記録から）') : state === 'error' ? '読み込めませんでした' : '読み込み中'} />
        <KpiCard title="失敗した更新" icon={<CircleX size={16} aria-hidden="true" />} value={ready ? failed : null} unit="回" valueTone={failed > 0 ? 'danger' : 'default'} detail="この30日" />
      </KpiBand>

      {state === 'error' ? (
        <ListState kind="error" title="更新の記録を読み込めませんでした" description="版の一覧は出しています。配備の結果は読み直すと出ます。" onRetry={() => setRetryToken((count) => count + 1)} />
      ) : null}

      <SearchField aria-label="変更内容を探す" placeholder="変更内容を探す" value={query}
        onChange={(value) => { setQuery(value); setPage(1) }} onClear={() => { setQuery(''); setPage(1) }} />
      <p className={styles.footText}>これから入る変更と、前の版のまとめを含む公開済みの本文を検索します。</p>

      {query.trim() && fullReleases === null ? searchError
        ? <ListState kind="error" title="変更の本文を読み込めませんでした" description="画面にある要約だけを検索しています。検索語を入れ直すと再試行します。" onRetry={() => setSearchRetryToken((count) => count + 1)} />
        : <ListState kind="loading" title="変更の本文を読み込んでいます" /> : null}
      {cards.length === 0 ? (
        query.trim() && fullReleases === null && !searchError ? null : <ListState kind="empty" title={query.trim() ? "一致する変更はありません" : "更新の記録はまだありません"} />
      ) : (
        <section className={styles.cards} aria-label="管理画面の更新">
          {cards.slice(first - 1, last).map((card) => <UpdateCardView key={card.key} card={card} historyState={state} />)}
          {pageCount > 1 ? (
            <div className={styles.more}>
              <Pagination page={shownPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="更新履歴のページ送り" range={{ total: cards.length, first, last, unit: '回' }} />
            </div>
          ) : null}
          {shownPage === pageCount && missing > 0 ? (
            <p className={styles.footText}>{`これより前の ${formatCount(missing, '行')}は、この画面には出していません。`}</p>
          ) : null}
        </section>
      )}

      <div className={styles.foot}>
        <p className={styles.footText}>自動で更新した記録は、アップデート履歴で見られます。</p>
        <Button href={hqOrigin ? '/updates?from=hq' : '/updates'}><History size={16} aria-hidden="true" />アップデート履歴を見る</Button>
      </div>
    </div>
  )
}
