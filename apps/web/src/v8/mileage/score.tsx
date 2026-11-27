'use client'
import { knownValue } from '@/lib/known-value'

import StatusBadge from '@/components/shared/status-badge'
import ScoreValue from './score-value'
import { mileageStatusTone } from './parts'
import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  reason: requiredText("理由を入力してください。"),
}

import { FolderDotName } from '@/components/shared/folder-dot'
import { useListUrlValue } from '@/components/shared/list-url-state'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Activity, Bookmark, ChevronDown, ChevronUp, Download, Minus, Plus, Send, Settings2, Star, TrendingDown, Upload, UserRound } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import {
  ApiError,
  api,
  type ActionScoreBand,
  type ActionScoreBandPreview,
  type ActionScoreFilter,
  type ActionScoreOverview,
  type ActionScoreRule,
  type ActionScoreRuleConfiguration,
  type ActionScoreSort,
  type FriendScoreDetail,
} from '@/lib/api'
import { csvCell } from '@/lib/presentation'
import { RowMenu } from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import { DialogFormRow } from '@/components/shared/dialog-form-row'
import SegmentedControl from '@/components/shared/segmented'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Card from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import { DataTable, DateCell, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import {
  actionScoreReasonLabel,
  formatMileageChange,
  formatMileageDate,
  formatMileageMonthDay,
  formatMileageNumber,
} from './display'
import { MILEAGE_TABLE_LAYOUT, MileageFrame, useMileageShell } from './frame'
import { MileageToolbar, PerPageSelect, RetryButton, SavedSelect, StateCard, ToolbarNotices } from './parts'
import { mileagePaginationTotal } from './display'
import styles from './mileage.module.css'
import { useFormErrors } from '@/lib/use-form-errors'
import { FieldError } from '@/components/shared/form-controls'
import { formatDate as polishFormatDate } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { permissionDeniedMessage, describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'

/*
 * ★V8 マイル「行動スコア」（板 、点数を手で直す 、
 * 点数の変化の明細 、状態は見本帳 ）。
 *
 * app/mileage/v8-score-tab.tsx から動きを写し、見た目を一覧の型で組み直した。
 * 絵  の並び：数の帯 → 案内 → 道具（探す・札 … 何人入るか・件数・送る・作る）→
 * 友だちの表（友だち・いまの点数・帯・30日間の変化・最後の反応・操作）。
 * できごとの決めごと（探す・足す点／引く点・止める・外す・足す）は表の下に
 * 開け閉めの段で残す（表の下の案内どおり、操作を落とさない）。
 * 決めごとの編集の器（試す・保存・公開の手順）は /mileage/score-rules の画面。
 */

const BAND_LABELS: Record<ActionScoreBand, string> = {
  high: '点が高い',
  normal: '中くらい',
  low: '低い',
}

/* 友だちの表の帯の札（絵は「高い・ふつう・低い」）。 */
const FRIEND_BAND_LABELS: Record<ActionScoreBand, string> = {
  high: '高い',
  normal: 'ふつう',
  low: '低い',
}

export const scoreBandCsvWord = (band: string) => knownValue(BAND_LABELS, band, '状態を確認できません')

export const friendBandWord = (band: string) => knownValue(FRIEND_BAND_LABELS, band, '状態を確認できません')


function bandName(band: ActionScoreBand, highMin: number, normalMin: number) {
  if (band === 'high') return `点が高い（${formatMileageNumber(highMin)} 点〜）`
  if (band === 'normal') return `中くらい（${formatMileageNumber(normalMin)}〜${formatMileageNumber(highMin - 1)} 点）`
  return `低い（〜${formatMileageNumber(normalMin - 1)} 点）`
}

function bandOf(score: number, highMin: number, normalMin: number): ActionScoreBand {
  if (score >= highMin) return 'high'
  if (score >= normalMin) return 'normal'
  return 'low'
}

/* できごとの数え方の1行（板：1日1回まで・14日で消える）。 */
function frequencyText(rule: ActionScoreRule): string {
  const limit = rule.frequency.limit
  switch (rule.frequency.kind) {
    case 'unlimited': return '何回でも'
    case 'per_day': return `1日${limit} 回まで`
    case 'per_subject': return '同じ対象は1回'
    case 'per_subject_per_day': return '同じ対象は1日1回'
    case 'once_per_period': return '期間中1回'
    default: return '数え方を確認できません'
  }
}

function ruleValueText(rule: ActionScoreRule): string {
  if (rule.operation === 'set') return `${formatMileageNumber(rule.value)} 点にする`
  return `${rule.value > 0 ? '+' : ''}${formatMileageNumber(rule.value)}`
}

/* 公開版と下書きの差（IDごとに中身比べ）。 */
function ruleChanged(rule: ActionScoreRule, published: ActionScoreRule | undefined): boolean {
  if (!published) return true
  return rule.name !== published.name
    || rule.eventType !== published.eventType
    || rule.operation !== published.operation
    || rule.value !== published.value
    || rule.enabled !== published.enabled
    || rule.frequency.kind !== published.frequency.kind
    || rule.frequency.limit !== published.frequency.limit
}

type FriendsItem = ActionScoreOverview['items'][number]

/** 手で直すときの失敗の言葉（現役の調整窓で使う）。 */
function actionScoreAdjustmentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return japaneseDetailOf(error) || describeApiFailure(error, '入力内容の確認')
    if (error.status === 403) return permissionDeniedMessage('store')
    if (error.status === 404) return '対象の友だちまたはLINEアカウントを確認できませんでした。'
    if (error.status === 405) return 'この環境では点数を変更できません。'
    if (error.status === 409) return '同じ操作がすでに記録されています。画面を読み直してからやり直してください。'
    if (error.status === 422) return '点数は帯の下限〜上限の範囲でしか動かせません。点数を変えてやり直してください。'
    if (error.status === 428) return '確認手順が完了していません。画面を閉じずに、もう一度内容を確認してください。'
    return '点数を変更できませんでした。時間をおいてもう一度お試しください。'
  }
  return error instanceof Error ? '通信に失敗しました。接続を確認してもう一度お試しください。' : '通信に失敗しました。接続を確認してもう一度お試しください。'
}

export default function ScoreTab() {
  const saveErrors = useSaveFormErrors()
  const { readonly, narrow } = useMileageShell()
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const accountId = selectedAccountId ?? ''
  const scope = useRef({ id: accountId, generation: 0 })
  if (scope.current.id !== accountId) scope.current = { id: accountId, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const friendsLoadedScope = useRef(-1)
  const readonlyRef = useRef(readonly)
  readonlyRef.current = readonly
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const latestAccountRef = useRef(accountId)
  useEffect(() => {
    latestAccountRef.current = accountId
  }, [accountId])
  const [overview, setOverview] = useState<ActionScoreOverview | null>(null)
  const [filter, setFilter] = useListUrlValue<ActionScoreFilter>('filter', 'all')
  const [sort, setSort] = useListUrlValue<ActionScoreSort>('sort', 'score_desc')
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [adjustTarget, setAdjustTarget] = useState<FriendsItem | null>(null)
  const [adjustScope, setAdjustScope] = useState<{ id: string; generation: number } | null>(null)
  const [historyTarget, setHistoryTarget] = useState<FriendsItem | null>(null)
  /* できごとの決めごと。 */
  const [config, setConfig] = useState<ActionScoreRuleConfiguration | null>(null)
  const [rulesLoading, setRulesLoading] = useState(true)
  const [rulesError, setRulesError] = useState(false)
  const [ruleSearchInput, setRuleSearchInput] = useListUrlValue('ruleSearch', '')
  const [ruleSearch, setRuleSearch] = useListUrlValue('ruleSearch', '')
  const [gainOnly, setGainOnly] = useListUrlValue('gainOnly', false)
  const [loseOnly, setLoseOnly] = useListUrlValue('loseOnly', false)
  const [ruleMenuId, setRuleMenuId] = useState<string | null>(null)
  const [rulesActionError, setRulesActionError] = useState('')
  const [rulesBusy, setRulesBusy] = useState(false)
  const [stopConfirm, setStopConfirm] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ActionScoreRule | null>(null)
  const [publishConfirm, setPublishConfirm] = useState(false)
  const [confirmScope, setConfirmScope] = useState<{ id: string; generation: number } | null>(null)
  const openConfirm = (open: () => void) => {
    if (!accountId || readonlyRef.current || loadedScope.current !== scope.current.generation) return
    setPublishConfirm(false)
    setStopConfirm(false)
    setRemoveTarget(null)
    setConfirmScope({ id: accountId, generation: scope.current.generation })
    open()
  }
  const canConfirm = () => alive.current && !readonlyRef.current && confirmScope !== null && confirmScope.id === scope.current.id && confirmScope.generation === scope.current.generation
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<ActionScoreBandPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [rulesOpen, setRulesOpen] = useState(false)

  const loadFriends = useCallback(async () => {
    const accountAtRequest = accountId
    const requestScope = scope.current.generation
    if (!accountAtRequest) {
      setOverview(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(false)
    try {
      const response = await api.actionScores.friends({
        accountId: accountAtRequest,
        search: search || undefined,
        filter,
        sort,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      if (accountAtRequest !== latestAccountRef.current || requestScope !== scope.current.generation) return
      if (!response.success) throw new Error(response.error)
      friendsLoadedScope.current = requestScope
      setOverview(response.data)
    } catch (saveFailure) {
      if (accountAtRequest !== latestAccountRef.current || requestScope !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setOverview(null)
      { if (!fieldFailure)
      setLoadError(true) }
    } finally {
      if (accountAtRequest === latestAccountRef.current && requestScope === scope.current.generation) setLoading(false)
    }
  }, [accountId, filter, page, pageSize, search, sort, saveErrors])

  /* この頁の行動スコアを CSV（6列：友だち・いまの点数・帯・30日間の変化・最後に点数が変わった理由・最終変動）。 */
  const exportCurrentPage = () => {
    if (!overview?.items.length) return
    const rows = overview.items.map((item) => [
      item.displayName,
      item.currentScore ?? '',
      scoreBandCsvWord(item.band),
      item.change30d ?? '',
      actionScoreReasonLabel(item.lastReason),
      formatMileageDate(item.lastChangedAt),
    ])
    const csv = [['友だち', 'いまの点数', '帯', '30日間の変化', '最後に点数が変わった理由', '最終変動'], ...rows]
      .map((row) => row.map((value) => csvCell(value)).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("行動の点数")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const loadRules = useCallback(async () => {
    const accountAtRequest = accountId
    const requestScope = scope.current.generation
    if (!accountAtRequest) {
      setConfig(null)
      setRulesLoading(false)
      return
    }
    setRulesLoading(true)
    setRulesError(false)
    try {
      const response = await api.actionScores.rules(accountAtRequest)
      if (accountAtRequest !== latestAccountRef.current || requestScope !== scope.current.generation) return
      if (!response.success) throw new Error(response.error)
      loadedScope.current = requestScope
      setConfig(response.data)
    } catch (saveFailure) {
      if (accountAtRequest !== latestAccountRef.current || requestScope !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setConfig(null)
      { if (!fieldFailure)
      setRulesError(true) }
    } finally {
      if (accountAtRequest === latestAccountRef.current && requestScope === scope.current.generation) setRulesLoading(false)
    }
  }, [accountId, saveErrors])

  useEffect(() => {
    if (accountLoading) return
    void loadFriends()
    void loadRules()
  }, [accountLoading, loadFriends, loadRules])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchInput.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const timer = window.setTimeout(() => setRuleSearch(ruleSearchInput.trim()), 0)
    return () => window.clearTimeout(timer)
  }, [ruleSearchInput])

  const summary = overview?.summary
  const highMin = summary?.highMin ?? 30
  const normalMin = summary?.normalMin ?? 10
  const total = mileagePaginationTotal(overview)
  const pageCount = Math.max(1, Math.ceil((total ?? 0) / pageSize))

  const rangeQuery = useMemo(() => {
    if (filter !== 'high' && filter !== 'normal' && filter !== 'low') return null
    const query = new URLSearchParams()
    if (filter === 'high') query.set('scoreMin', String(highMin))
    if (filter === 'normal') {
      query.set('scoreMin', String(normalMin))
      query.set('scoreMax', String(highMin - 1))
    }
    if (filter === 'low') query.set('scoreMax', String(normalMin - 1))
    query.set('scoredOnly', '1')
    return query.toString()
  }, [filter, highMin, normalMin])
  const broadcastHref = rangeQuery ? `/broadcasts/new?${rangeQuery}` : '/broadcasts/new'

  const editable = config?.editableVersion ?? null
  const publishedRules = useMemo(() => {
    const map = new Map<string, ActionScoreRule>()
    for (const rule of config?.publishedVersion?.rules ?? []) map.set(rule.id, rule)
    return map
  }, [config])
  const rules = useMemo(() => {
    const keyword = ruleSearch.trim()
    return (editable?.rules ?? []).filter((rule) => {
      if (gainOnly && rule.value <= 0) return false
      if (loseOnly && rule.value >= 0) return false
      if (keyword && !rule.name.includes(keyword) && !rule.eventType.includes(keyword)) return false
      return true
    })
  }, [editable, gainOnly, loseOnly, ruleSearch])
  const publishedVersionNo = config?.publishedVersion?.versionNumber ?? null
  const hasDraftChanges = useMemo(() => {
    if (!editable) return false
    const published = [...publishedRules.values()]
    if (editable.rules.length !== published.length) return true
    return editable.rules.some((rule) => ruleChanged(rule, publishedRules.get(rule.id)))
  }, [editable, publishedRules])
  const draftVersionId = config?.currentDraftVersionId ?? null

  const publishDraft = async () => {
    if (readonly || !accountId || !draftVersionId) return
    setRulesBusy(true)
    setRulesActionError('')
    try {
      const response = await api.actionScores.publishRules({ accountId, draftVersionId })
      if (!response.success) throw new Error(response.error)
      setPublishConfirm(false)
      setConfig(response.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setRulesActionError(caught instanceof ApiError && caught.status === 409
        ? 'ほかの人が先に公開しています。読み直してからやり直してください。'
        : '公開できませんでした。もう一度お試しください。') }
    } finally {
      setRulesBusy(false)
    }
  }

  const stopPublished = async () => {
    if (readonly || !accountId) return
    setRulesBusy(true)
    setRulesActionError('')
    try {
      const response = await api.actionScores.stopRules(accountId)
      if (!response.success) throw new Error(response.error)
      setStopConfirm(false)
      setConfig(response.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setRulesActionError('公開中のルールを止められませんでした。もう一度お試しください。') }
    } finally {
      setRulesBusy(false)
    }
  }

  const removeRule = async (rule: ActionScoreRule) => {
    if (readonly || !accountId || !editable || !draftVersionId) return
    setRulesBusy(true)
    setRulesActionError('')
    try {
      const response = await api.actionScores.saveDraft({
        accountId,
        expectedDraftVersionId: draftVersionId,
        configuration: {
          rules: editable.rules.map((item) => (item.id === rule.id ? { ...item, enabled: false } : item)),
          bands: editable.bands,
        },
      }, { idempotencyKey: crypto.randomUUID() })
      if (!response.success) throw new Error(response.error)
      setRemoveTarget(null)
      setConfig(response.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setRulesActionError(caught instanceof ApiError && caught.status === 409
        ? 'ほかの人が先に変えています。読み直してからやり直してください。'
        : '外せませんでした。もう一度お試しください。') }
    } finally {
      setRulesBusy(false)
    }
  }

  const openPreview = async () => {
    if (!accountId || !editable || previewBusy) return
    setPreviewOpen(true)
    setPreview(null)
    setPreviewError('')
    setPreviewBusy(true)
    try {
      const response = await api.actionScores.previewBands({ accountId, bands: editable.bands })
      if (!response.success) throw new Error(response.error)
      setPreview(response.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setPreviewError('試算できませんでした。もう一度お試しください。') }
    } finally {
      setPreviewBusy(false)
    }
  }

  const resetFriendFilters = () => {
    setSearchInput('')
    setSearch('')
    setFilter('all')
    setSort('score_desc')
    setPage(1)
  }
  const resetRuleFilters = () => {
    setRuleSearchInput('')
    setRuleSearch('')
    setGainOnly(false)
    setLoseOnly(false)
  }

  const ready = !loading && !loadError

  /* 数の帯：帯ごとの人数（押すとその帯だけ見る）と公開中のルール。 */
  const bandCard = (band: ActionScoreBand, value: number | undefined, detail: string, icon: React.ReactNode) => (
    <KpiCard
      presentation="band"
      title={bandName(band, highMin, normalMin)}
      icon={icon}
      value={ready ? value ?? null : null}
      unit="人"
      detail={detail}
      onRetry={ready ? () => { setPage(1); setFilter(filter === band ? 'all' : band) } : undefined}
      retryLabel={filter === band ? 'すべてに戻す' : 'この帯だけ見る'}
    />
  )
  const stats = (
    <KpiBand>
      {bandCard('high', summary?.high, 'よく動く', <Star size={16} aria-hidden="true" />)}
      {bandCard('normal', summary?.normal, 'ふつう', <Activity size={16} aria-hidden="true" />)}
      {bandCard('low', summary?.low, 'しばらく動いていない', <TrendingDown size={16} aria-hidden="true" />)}
      <KpiCard
        presentation="band"
        title="公開中のルール"
        icon={<Settings2 size={16} aria-hidden="true" />}
        value={rulesLoading || rulesError ? null : 0}
        valueText={rulesLoading || rulesError ? undefined : publishedVersionNo === null ? emptyValue('none') : `版 ${formatMileageNumber(publishedVersionNo)}`}
        unit=""
        detail={rulesLoading ? emptyValue('unknown') : hasDraftChanges ? '下書きの変更あり' : '下書きとの差はありません'}
      />
    </KpiBand>
  )

  /* 帯・下がっているで絞る（数の帯の「この帯だけ見る」と同じ絞り込み）。札にすると道具の段が2段になるので選ぶ欄にまとめる。 */
  const chips = (
    <SavedSelect
      value={`${filter}:${sort}`}
      options={[
        { value: 'all:score_desc', label: 'よく使う絞り込み' },
        { value: 'all:score_asc', label: '点数が低い順' },
        { value: 'decreased:change_asc', label: '下がっている・下がり幅が大きい順' },
        { value: 'high:score_desc', label: '点が高い帯のみ' },
        { value: 'normal:score_desc', label: '中くらいの帯のみ' },
        { value: 'low:score_desc', label: '低い帯のみ' },
        ...(['all:score_desc', 'all:score_asc', 'decreased:change_asc', 'high:score_desc', 'normal:score_desc', 'low:score_desc'].includes(`${filter}:${sort}`)
          ? []
          : [{ value: `${filter}:${sort}`, label: 'いまの絞り込み' }]),
      ]}
      onChange={(value) => {
        const [nextFilter, nextSort] = value.split(':')
        setPage(1)
        setFilter(nextFilter as ActionScoreFilter)
        setSort(nextSort as ActionScoreSort)
      }}
    />
  )

  const toolbar = (
    <MileageToolbar
      narrow={narrow}
      notices={<ToolbarNotices error={rulesActionError} />}
      search={{
        placeholder: '友だちの名前で探す',
        value: searchInput,
        onChange: (value) => {
          setSearchInput(value)
          if (!value) { setSearch(''); setPage(1) }
        },
      }}
      chips={chips}
      trailing={<>
        <Button onClick={() => void openPreview()} disabled={!editable} busy={Boolean(previewBusy)} busyLabel="処理中…">
          <Bookmark size={16} aria-hidden="true" /> この分けかただと何人入るか
        </Button>
        <PerPageSelect value={pageSize} onChange={(next) => { setPage(1); setPageSize(next) }} />
        <Button href={broadcastHref} title={rangeQuery ? '点数がついている人のみ' : undefined}>
          <Send size={16} aria-hidden="true" /> この帯の人に送る
        </Button>
        {!readonly ? (
          <Button href="/mileage/score-rules">
            <Settings2 size={16} aria-hidden="true" /> スコアのルールを作る
          </Button>
        ) : null}
      </>}
    />
  )

  const friendsTable = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={MILEAGE_TABLE_LAYOUT}>
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>友だち</Th>
            <Th align="right" className={styles.colScore}>いまの点数</Th>
            <Th className={styles.colBand}>帯</Th>
            <Th align="right" className={styles.colTrend}>30日間の変化</Th>
            <Th collapseAt="narrow" className={styles.colReact}>最後の反応</Th>
            <Th className={styles.colOpsBalance}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {(overview?.items ?? []).map((item) => {
            const change = typeof item.change30d === 'number' && Number.isFinite(item.change30d) ? item.change30d : null
            const day = formatMileageMonthDay(item.lastChangedAt)
            const reason = actionScoreReasonLabel(item.lastReason)
            return (
              <Tr data-row-id={item.friendId} key={item.friendId} data-table-layout="columns">
                <Td grow><FolderDotName><span  title={item.displayName}>{item.displayName}</span></FolderDotName></Td>
                <Td align="right" className={styles.colScore}><span className={styles.scoreNum}>{formatMileageNumber(item.currentScore)}</span></Td>
                <Td className={styles.colBand}>
                  <StatusBadge tone={item.band === 'high' ? 'success' : item.band === 'low' ? 'warning' : 'neutral'}>{friendBandWord(item.band)}</StatusBadge>
                </Td>
                <Td align="right" className={styles.colTrend}>
                  <span className={styles.scoreNum}><ScoreValue change={change} negativeTone="danger">{change === null ? emptyValue('unknown') : formatMileageChange(change)}</ScoreValue></span>
                </Td>
                <Td collapseAt="narrow" className={styles.colReact}>
                  <span className={styles.cellMain} title={reason}>{day === '—' ? reason : `${day} ${reason}`}</span>
                </Td>
                <Td className={styles.colOpsBalance}>
                  <span className={styles.rowActions}>
                    <Button onClick={() => setHistoryTarget(item)}>点数の変化</Button>
                    <div className={styles.menuBox}>
                      <RowMenu
                        label={`${item.displayName}の操作`}
                        open={menuId === item.friendId}
                        onOpenChange={(next) => setMenuId(next ? item.friendId : null)}
                        items={[
                          /* 閲覧のみの人には「点数を直す」を出さない。 */
                          ...(readonly ? [] : [{ id: 'adjust', label: '点数を直す', onSelect: () => { if (accountId && !readonlyRef.current && friendsLoadedScope.current === scope.current.generation) { setAdjustScope({ id: accountId, generation: scope.current.generation }); setAdjustTarget(item) } } }]),
                          {
                            id: 'friend',
                            label: 'この人を見る',
                            external: false,
                            href: `/friends/detail?id=${encodeURIComponent(item.friendId)}`, onSelect: () => router.push(`/friends/detail?id=${encodeURIComponent(item.friendId)}`),
                          },
                        ]}
                      />
                    </div>
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const friendsBody = loading ? (
    <ListState kind="loading" title="行動スコアを読み込んでいます" />
  ) : loadError ? (
    <StateCard tone="error" title="行動スコアを読み込めませんでした" description="数の帯は「—」にしています。道具はそのまま使えます。" action={<RetryButton onRetry={() => void loadFriends()} />} />
  ) : !overview?.items.length ? (
    <StateCard title="条件に合う友だちがいません" description="帯または検索条件を変えてください。" action={<Button type="button" onClick={resetFriendFilters}>条件を外す</Button>} />
  ) : friendsTable

  /* できごとの決めごと（開け閉め）。行の「…」から 編集・外す、表の下の「＋ できごとを足す」。 */
  const rulesSection = (
    <div className={styles.subSection}>
      <button
        type="button"
        className={styles.rulesToggle}
        aria-expanded={rulesOpen}
        aria-controls="ml-score-rules"
        onClick={() => setRulesOpen((open) => !open)}
      >
        <span className={styles.rulesToggleTitle}>{`できごとの決めごと${editable ? ` ${formatMileageNumber(editable.rules.length)} 件` : ''}`}</span>
        <span className={styles.rulesToggleHint}>{publishedVersionNo === null ? '公開中のルールはありません' : `公開中 版 ${formatMileageNumber(publishedVersionNo)}`}</span>
        {rulesOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {/* 閉じている間は中身を描かない（開くまで読み上げにも出さない）。 */}
      {rulesOpen ? <div id="ml-score-rules" className={styles.rulesBody}>
        <div className={styles.rulesTools}>
          <div className={styles.narrowSearch}>
            <SearchField
              aria-label="できごとで探す"
              placeholder="できごとで探す"
              value={ruleSearchInput}
              onChange={setRuleSearchInput}
              onClear={() => { setRuleSearchInput(''); setRuleSearch('') }}
            />
          </div>
          <SegmentedControl
            aria-label="点の増減で絞り込む"
            value={gainOnly ? 'gain' : loseOnly ? 'lose' : 'all'}
            onChange={(next) => {
              setGainOnly(next === 'gain')
              setLoseOnly(next === 'lose')
            }}
            options={[
              { value: 'all', label: 'すべて' },
              { value: 'gain', label: '足す点' },
              { value: 'lose', label: '引く点' },
            ]}
          />
          <span className={styles.spacer} aria-hidden="true" />
          {!readonly && publishedVersionNo !== null ? (
            <div className={styles.menuBox}>
              <RowMenu
                label="公開中のルールの操作"
                open={ruleMenuId === '__head'}
                onOpenChange={(next) => setRuleMenuId(next ? '__head' : null)}
                items={[
                  { id: 'edit', label: '決めごとの編集画面を開く', external: false, href: '/mileage/score-rules', onSelect: () => router.push('/mileage/score-rules') },
                  {
                    id: 'stop',
                    label: '公開中のルールを止める',
                    tone: 'danger',
                    dividerBefore: true,
                    disabled: rulesBusy,
                    disabledReason: '反映しています',
                    onSelect: () => openConfirm(() => setStopConfirm(true)),
                  },
                ]}
              />
            </div>
          ) : null}
        </div>
        {rulesLoading ? (
          <ListState kind="loading" title="できごとの決めごとを読み込んでいます" />
        ) : rulesError || !editable ? (
          <StateCard tone="error" title="できごとの決めごとを読み込めませんでした" action={<RetryButton onRetry={() => void loadRules()} />} />
        ) : rules.length === 0 ? (
          <StateCard title="条件に合うできごとはありません" description="検索や絞り込みを外すと、すべて出ます" action={<Button type="button" onClick={resetRuleFilters}>条件を外す</Button>} />
        ) : (
          <DataTable columnLayout={MILEAGE_TABLE_LAYOUT}>
            <thead>
              <TableHeadRow data-table-layout="columns">
                <Th grow>できごと（数え方）</Th>
                <Th className={styles.colGives}>点・今月当てはまった人</Th>
                <Th className={styles.colStateWide}>状態</Th>
                <Th className={styles.colOpsMenu}>操作</Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const changed = ruleChanged(rule, publishedRules.get(rule.id))
                const stopped = !rule.enabled
                return (
                  <Tr data-row-id={rule.id} key={rule.id} data-table-layout="columns">
                    <Td grow><FolderDotName>
                      <span  title={rule.name}>{rule.name}</span>

                    </FolderDotName></Td>
                    <Td className={styles.colGives}><span className={styles.cellMain}>{ruleValueText(rule)}</span></Td>
                    <Td className={styles.colStateWide}>
                      <StatusBadge tone={mileageStatusTone(stopped ? 'neutral' : changed ? 'warn' : 'active')}>{stopped ? '停止中' : changed ? '下書きで変更' : '公開中'}</StatusBadge>
                    </Td>
                    <Td className={styles.colOpsMenu}>
                      {!readonly ? (
                        <div className={styles.menuBox}>
                          <RowMenu
                            label={`${rule.name}の操作`}
                            open={ruleMenuId === rule.id}
                            onOpenChange={(next) => setRuleMenuId(next ? rule.id : null)}
                            items={[
                              { id: 'edit', label: '編集', external: false, href: '/mileage/score-rules', onSelect: () => router.push('/mileage/score-rules') },
                              {
                                id: 'remove',
                                label: '外す',
                                tone: 'danger',
                                dividerBefore: true,
                                disabled: rulesBusy || stopped,
                                disabledReason: stopped ? 'すでに外しています' : '反映しています',
                                onSelect: () => openConfirm(() => setRemoveTarget(rule)),
                              },
                            ]}
                          />
                        </div>
                      ) : null}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
        {!readonly ? (
          <div>
            <Button href="/mileage/score-rules"><Plus size={16} aria-hidden="true" /> できごとを足す</Button>
          </div>
        ) : null}
      </div> : null}
    </div>
  )

  const footer = ready && total !== null && total > 0 ? (
    <>
      <div className={styles.pagerRow}>
        <span className={styles.pagerCount}>
          {`${formatMileageNumber(total)} 件中 ${(page - 1) * pageSize + 1}〜${Math.min(page * pageSize, total)} 件`}
        </span>
        <span className={styles.chipGroup}>
          <Button onClick={exportCurrentPage} disabled={!overview?.items.length}>
            <Download size={16} aria-hidden="true" /> この頁の行動スコアをCSVで書き出す
          </Button>
          {pageCount > 1 ? <Pagination page={page} pageCount={pageCount} onPageChange={setPage} /> : null}
        </span>
      </div>
    </>
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><MileageFrame
      explanation="点数は、オートメーション（点が下がったら動かす）・シナリオ／一斉配信の宛先（帯で選ぶ）・分析（帯ごとの成果）で使えます。下書きの変更は、公開するまで使われません。"
      help={<>
        行の「…」から、点数の手直し・この人を見る。表の下の「できごとの決めごと」を開くと、できごとの編集・外す・＋ できごとを足す（30日間反応がない、も選べる）。公開中のルールを止めるときは、その題の横の「…」から。
        スコアはマイルではありません。お客様には見せず、交換もできません。マイル残高はスコアで増えも減りもしません。
        {rangeQuery ? <Button variant="text" href={`/friends?${rangeQuery}`}>この帯の友だちを見る（点数がついている人のみ）</Button> : null}
      </>}
      actions={readonly ? undefined : <div className={styles.headActions}>
        <Button href="/mileage/score-rules" title="決めごとの編集画面で1人分を試します">
          <UserRound size={16} aria-hidden="true" /> 1人で試す
        </Button>
        <Button href="/mileage/score-rules" title="決めごとの編集画面で保存します">下書きを保存</Button>
        {draftVersionId ? (
          <Button variant="primary" onClick={() => openConfirm(() => setPublishConfirm(true))}>
            <Upload size={16} aria-hidden="true" /> スコアのルールを公開
          </Button>
        ) : (
          <Button variant="primary" href="/mileage/score-rules" title="決めごとの編集画面で公開します">
            <Upload size={16} aria-hidden="true" /> スコアのルールを公開
          </Button>
        )}
      </div>}
      stats={stats}
      toolbar={toolbar}
      pagination={footer}
      overlays={<>
        {adjustTarget && adjustScope?.generation === scope.current.generation && !readonly ? (
          <ScoreAdjustDialog
            accountId={adjustScope.id}
            friendId={adjustTarget.friendId}
            friendName={adjustTarget.displayName}
            currentScore={adjustTarget.currentScore}
            highMin={highMin}
            normalMin={normalMin}
            band={adjustTarget.band}
            onCancel={() => setAdjustTarget(null)}
            onCompleted={async () => { await loadFriends() }}
          />
        ) : null}
        {historyTarget ? (
          <ScoreHistoryDialog
            friendId={historyTarget.friendId}
            friendName={historyTarget.displayName}
            currentScore={historyTarget.currentScore}
            band={historyTarget.band}
            highMin={highMin}
            normalMin={normalMin}
            onCancel={() => setHistoryTarget(null)}
          />
        ) : null}
        <ConfirmDialog
          open={publishConfirm && confirmScope?.generation === scope.current.generation}
          title="下書きの決めごとを公開しますか？"
          description="公開すると、いまの点数の分けかたと決めごとが友だちの点数に使われます。取り消せません。"
          confirmLabel="公開する"
          destructive
          busy={rulesBusy}
          error={rulesActionError || undefined}
          onCancel={() => { if (!rulesBusy) setPublishConfirm(false) }}
          onConfirm={() => { if (canConfirm()) void publishDraft() }}
        >{confirmScope ? <OperationTargetSummary accounts={[{ id: confirmScope.id }]} /> : null}</ConfirmDialog>
        <ConfirmDialog
          open={stopConfirm && confirmScope?.generation === scope.current.generation}
          title="公開中のルールを止めますか？"
          description="止めている間は、できごとがあっても点数は動きません。下書きは残ります。"
          confirmLabel="止める"
          destructive
          busy={rulesBusy}
          error={rulesActionError || undefined}
          onCancel={() => { if (!rulesBusy) setStopConfirm(false) }}
          onConfirm={() => { if (canConfirm()) void stopPublished() }}
        >{confirmScope ? <OperationTargetSummary accounts={[{ id: confirmScope.id }]} /> : null}</ConfirmDialog>
        <ConfirmDialog
          open={removeTarget !== null && confirmScope?.generation === scope.current.generation}
          title={removeTarget ? `「${removeTarget.name}」を外しますか？` : 'できごとを外しますか？'}
          description="決めごとの一覧から外します（無効にします）。記録そのものは残ります。"
          confirmLabel="外す"
          destructive
          busy={rulesBusy}
          error={rulesActionError || undefined}
          onCancel={() => { if (!rulesBusy) setRemoveTarget(null) }}
          onConfirm={() => { if (canConfirm() && removeTarget) void removeRule(removeTarget) }}
        >{confirmScope ? <OperationTargetSummary accounts={[{ id: confirmScope.id }]} /> : null}</ConfirmDialog>
        <Dialog
          open={previewOpen}
          title="この分けかただと何人入るか"
          description="いまの下書きの分けかたで、点数がついている友だちがどの帯に入るかを数えます。公開も点数の変更もしません。"
          confirmLabel="閉じる"
          onConfirm={() => setPreviewOpen(false)}
          onCancel={() => setPreviewOpen(false)}
          busy={previewBusy}
        >
          {previewError ? (
            <Notice tone="danger" message={previewError} />
          ) : preview ? (
            <div className={styles.delta3}>
              {(['high', 'normal', 'low'] as const).map((band) => (
                <div key={band} className={styles.deltaCell}>
                  <p className={styles.deltaLabel}>{BAND_LABELS[band]}</p>
                  <p className={styles.deltaValue}>{`${formatMileageNumber(preview.counts[band])} 人`}</p>
                </div>
              ))}
            </div>
          ) : (
            <ListState kind="loading" title="数えています" description="点数の変更は行いません。" />
          )}
        </Dialog>
      </>}
    >
      {friendsBody}
      {rulesSection}
    </MileageFrame></SaveErrorScope>
  )
}

/*
 * 点数を手で直す（板 ）。
 * 口と約束（理由必須・追記だけ・再送しても二重反映しない）は今と同じ。見せ方だけ V8。
 * 窓の幅・位置は絵どおり（designWidth 560・designTop 184）。
 */
export function ScoreAdjustDialog({
  accountId,
  friendId,
  friendName,
  currentScore,
  highMin,
  normalMin,
  band,
  onCancel,
  onCompleted,
}: {
  accountId: string
  friendId: string
  friendName: string
  currentScore: number
  highMin: number
  normalMin: number
  band: ActionScoreBand
  onCancel: () => void
  onCompleted: () => Promise<void>
}) {
  const saveErrors = useSaveFormErrors()

  const initialTarget = useRef({ accountId, friendId, changed: false })
  if (initialTarget.current.accountId !== accountId || initialTarget.current.friendId !== friendId) initialTarget.current.changed = true
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease')
  const [amountText, setAmountText] = useState('10')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const idempotencyKey = useRef(crypto.randomUUID())
  const amount = Number(amountText)
  const validAmount = Number.isInteger(amount) && amount > 0 && amount <= 1_000_000
  const delta = direction === 'decrease' ? -amount : amount
  const scoreAfter = validAmount ? currentScore + delta : currentScore
  const bandAfter = bandOf(scoreAfter, highMin, normalMin)
  const bandChanges = validAmount && bandAfter !== band
  /* 確定で落ちた欄は、その欄の真下に理由を出して移る。 */
  const fields = useFormErrors()
  fields.define('amount', '点数', () => (validAmount ? null : '1以上1000000以下の整数で点数を入力してください'), { required: true })
  fields.define('reason', '理由', () => ((FIELD_REQUIREMENTS.reason.check(reason) !== null) ? '理由を入力してください。' : reason.trim().length > 500 ? '理由は500文字以内で入力してください' : null), { required: true })

  const submit = async () => {
    if (!alive.current || initialTarget.current.changed) return
    if (fields.submit().length > 0) {
      setError('')
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await api.actionScores.adjust(
        { accountId, friendId, direction, amount, reason: reason.trim() },
        idempotencyKey.current,
      )
      if (!response.success) throw new Error(response.error)
      await onCompleted()
      onCancel()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(actionScoreAdjustmentErrorMessage(caught)) }
    } finally {
      setBusy(false)
    }
  }

  const confirmLabel = validAmount
    ? direction === 'decrease'
      ? `${formatMileageNumber(amount)} 点減らす`
      : `${formatMileageNumber(amount)} 点増やす`
    : '点数を変更する'

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open
      designNode="Nv7An"
      designWidth={560}
      designTop={184}
      title="点数を手で直す"
      description="記録に残ります。お客様には見えない運用メモとして、あとから理由をたどれるようにしてください。"
      confirmLabel={confirmLabel}
      confirmIcon={validAmount ? (direction === 'decrease' ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />) : undefined}
      cancelLabel="キャンセル"
      busy={busy}
      error={error || undefined}
      onConfirm={() => submit()}
      onCancel={() => { if (!busy) onCancel() }}
    >
      {/* 絵 Nv7An：縦に間 14 の1列。ラベルと入れ物の間は 6。 */}
      <div className={styles.dlgBody}>
        <OperationTargetSummary accounts={[{ id: initialTarget.current.accountId }]} />
        <p className={styles.dlgCaption}>だれの点数を動かしますか</p>
        <div className={styles.dlgPerson}>
          <span className={styles.dlgAvatar} aria-hidden="true">{friendName.slice(0, 1)}</span>
          <div className={styles.dlgPersonText}>
            <span className={styles.dlgPersonName}>{friendName}</span>
            <span className={styles.dlgPersonSub}>{`いま ${formatMileageNumber(currentScore)} 点・${bandName(band, highMin, normalMin)}`}</span>
          </div>
        </div>

        <div className={styles.dlgGroup}>
          <p className={styles.dlgCaption}>増やすか減らすか</p>
          <div className={styles.seg} role="group" aria-label="増やすか減らすか">
            {(['increase', 'decrease'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.segButton}
                aria-pressed={direction === value}
                onClick={() => setDirection(value)}
              >
                {value === 'increase' ? '増やす' : '減らす'}
              </button>
            ))}
          </div>
        </div>

        <DialogFormRow><Field label="点数" htmlFor="ml-score-amount" requirement={fields.requirement('amount')}><SaveErrorField names={["amountText","amount_text"]}><NumberInput numericText
            id="ml-score-amount"
            className={styles.dlgInput}
            inputMode="numeric"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value.replace(/[^0-9]/g, ''))}
            {...fields.bind('amount')}
            aria-invalid={fields.invalid('amount') || undefined}
            aria-describedby={fields.invalid('amount') ? 'ml-score-amount-error' : undefined}
          /></SaveErrorField>
<FieldError id="ml-score-amount-error">{fields.error('amount')}</FieldError></Field></DialogFormRow>

        <DialogFormRow><Field label="理由" htmlFor="ml-score-reason" requirement={FIELD_REQUIREMENTS.reason}><SaveErrorField names={["reason"]}><SharedTextArea
            id="ml-score-reason"
            className={styles.dlgTextarea}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            {...fields.bind('reason')}
            aria-invalid={fields.invalid('reason') || undefined}
            aria-describedby={fields.invalid('reason') ? 'ml-score-reason-error' : undefined}
          /></SaveErrorField>
<FieldError id="ml-score-reason-error">{fields.error('reason')}</FieldError></Field></DialogFormRow>

        <p className={styles.dlgCaption} title="既存の履歴は書き換えず、理由と実行者を持つ新しい調整行を追加します。同じ操作を再送しても二重反映しません。">この変更で起きること</p>
        <div className={styles.delta3}>
          <div className={styles.deltaCell}>
            <p className={styles.deltaLabel}>変更前</p>
            <p className={styles.deltaValue}>{`${formatMileageNumber(currentScore)} 点`}</p>
          </div>
          <div className={styles.deltaCell}>
            <p className={styles.deltaLabel}>変更量</p>
            <p className={styles.deltaValue}><ScoreValue change={validAmount ? delta : null}>{validAmount ? `${formatMileageChange(delta)} 点` : emptyValue('unknown')}</ScoreValue></p>
          </div>
          <div className={styles.deltaCell}>
            <p className={styles.deltaLabel}>変更後</p>
            <p className={styles.deltaValue}><ScoreValue change={validAmount ? delta : null}>{validAmount ? `${formatMileageNumber(scoreAfter)} 点` : emptyValue('unknown')}</ScoreValue></p>
          </div>
        </div>

        {/* 帯の行は常に出す（点数を打ち変えても窓の下が上下に動かない。絵 Nv7An は帯が変わる時の形）。 */}
        <Notice tone="warn" data-tone={bandChanges ? 'warn' : 'neutral'} role="note">
          {bandChanges
            ? `帯が「${BAND_LABELS[band]}」から「${bandName(bandAfter, highMin, normalMin)}」に変わります。帯で選んでいる配信・オートメーションの宛先から外れることがあります。`
            : `帯は「${bandName(bandAfter, highMin, normalMin)}」のまま変わりません。`}
        </Notice>
      </div>
    </Dialog></SaveErrorScope>
  )
}

/* 明細の日時（絵は「9/02 19:20」。日・時を2桁にそろえ、行の幅をそろえる）。日本時間で出す。 */
function formatScoreHistoryTime(value: string): string {
  return polishFormatDate(value, { style: 'detail', fallback: '—' })
}

/*
 * 点数の変化の明細（板 ）。
 * いつ・できごと・点・合計（新しい順。合計は上から足し引きが合う）。
 */
function ScoreHistoryDialog({
  friendId,
  friendName,
  currentScore,
  band,
  highMin,
  normalMin,
  onCancel,
}: {
  friendId: string
  friendName: string
  currentScore: number | null
  band: ActionScoreBand
  highMin: number
  normalMin: number
  onCancel: () => void
}) {
  const [detail, setDetail] = useState<FriendScoreDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    setDetail(null)
    setError(false)
    setLoading(true)
    void api.scoring.friendScore(friendId)
      .then((response) => {
        if (!current) return
        if (!response.success) throw new Error(response.error)
        setDetail(response.data)
      })
      .catch(() => {
        if (!current) return
        setDetail(null)
        setError(true)
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => { current = false }
  }, [friendId, retry])

  const items = useMemo(
    () => [...(detail?.history ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    [detail],
  )
  const score = detail?.currentScore ?? currentScore

  return (
    <Dialog
      open
      designNode="R8NNi"
      designWidth={600}
      designTop={204}
      title="点数の変化の明細"
      description="いつ・何で点数が変わったかを新しい順に並べています。スコアは配信や対応の順番を決める目安で、お客様には見えず、マイル残高は増えも減りもしません。"

      onCancel={onCancel}
      busy={loading}
    >
      <div className={`${styles.dlgBody} ${styles.historyBody}`}>
      <div className={styles.dlgPerson}>
        <span className={styles.dlgAvatar} aria-hidden="true">{friendName.slice(0, 1)}</span>
        <div className={styles.dlgPersonText}>
          <span className={styles.dlgPersonName}>{friendName}</span>
          <span className={styles.dlgPersonSub}>{`いま ${score != null ? formatMileageNumber(score) : emptyValue('unknown')} 点・${bandName(band, highMin, normalMin)}`}</span>
        </div>
      </div>

      {loading ? (
        <ListState kind="loading" title="点数の変化を読み込んでいます" />
      ) : error ? (
        <ListState kind="error" title="点数の明細を表示できませんでした" description="登録した点数は変わっていません。" onRetry={() => setRetry((value) => value + 1)} />
      ) : items.length === 0 ? (
        <ListState kind="empty" title="点数が変わった記録はありません" description="メッセージへの返信やリンクのクリックなど、決めたきっかけがあると記録されます。" />
      ) : (
        <Card variant="records" contentPadding="0" aria-label="点数の変化の明細の一覧"><DataTable columnSizing="content" aria-label="点数の変化の明細" columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-section)', padding: '0 var(--tpl-list-inset)', bodyTextSize: 'var(--polish-text-body)' }}>
          <thead>
            <TableHeadRow data-table-layout="columns">
              <Th>いつ</Th>
              <Th>できごと</Th>
              <Th align="right">点</Th>
              <Th align="right">合計</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {items.map((item) => (
              <Tr key={item.id} data-table-layout="columns">
                <DateCell><time data-list-date-time dateTime={item.occurredAt}>{formatScoreHistoryTime(item.occurredAt)}</time></DateCell>
                <Td grow title={`${actionScoreReasonLabel(item.reason?.trim() ? item.reason : null)}・${item.scoreBefore == null || item.scoreAfter == null ? '前後の点数は未取得' : `${formatMileageNumber(item.scoreBefore)} 点 → ${formatMileageNumber(item.scoreAfter)} 点`}・${item.mode === 'manual' ? `手で変更（${item.executedByStaffName ?? '担当者は未取得'}）` : '自動で加算'}`}><TruncatedText value={actionScoreReasonLabel(item.reason?.trim() ? item.reason : null)} /></Td>
                <Td align="right">
                  <ScoreValue change={item.scoreChange}>{formatMileageChange(item.scoreChange)}</ScoreValue>
                </Td>
                <Td align="right">{item.scoreAfter === null ? emptyValue('unknown') : formatMileageNumber(item.scoreAfter)}</Td>
              </Tr>
            ))}
          </tbody>
        </DataTable></Card>
      )}
      </div>
    </Dialog>
  )
}
