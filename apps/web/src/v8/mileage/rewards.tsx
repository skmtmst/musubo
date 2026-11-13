'use client'

import StatusBadge from '@/components/shared/status-badge'
import { mileageStatusTone } from './parts'


import { createAccountTracker, createMileageRewardsFetchGuards, createSingleFlightLock } from './redemption-request-guard'
import HeldRedemptions from './held-redemptions'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { jstDate } from '@/lib/jst-datetime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { AlertCircle, ArrowLeftRight, Download, Gift, Plus, RotateCcw, Star } from 'lucide-react'
import type { ApiResponse } from '@line-crm/shared'
import { useAccount } from '@/contexts/account-context'
import {
  ApiError,
  api,
  fetchApi,
  type MileageRewardKind,
  type MileageRewardReachMetric,
  type MileageRewardStatus,
  type MileageRewardSummary,
} from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { csvCell } from '@/lib/presentation'
import { RowMenu } from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import SegmentedControl from '@/components/shared/segmented'
import ManagedFolderPanel, { managedFolderNavRows, useManagedFolders, folderDotFor } from '@/components/shared/managed-folder-panel'
import { useFolderMove } from '@/components/shared/use-folder-move'
import { FolderDotName } from '@/components/shared/folder-dot'
import HelpTip from '@/components/shared/help-tip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { ListPagePagination } from '@/components/templates'
import { formatMileageDate, formatMileageNumber } from './display'
import { MILEAGE_TABLE_LAYOUT, MileageFrame, useMileageShell } from './frame'
import { MileageToolbar, PerPageSelect, RetryButton, SavedSelect, StateCard, ToolbarNotices } from './parts'
import { notifyToast } from '@/components/shared/toast'
import styles from './mileage.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 マイル「使い道」（板 、状態は見本帳 ）。
 *
 * app/mileage/v8-rewards-tab.tsx から動きを写し、見た目を一覧の型で組み直した。
 * 表は「使い道・必要なマイル・交換すると渡るもの・今月交換された・状態・
 * 操作（中身を見る・…）」。止める／出すは行の「…」。頭の CSV は見えている
 * 表の中身を出す。要対応の交換（届かなかった分のやり直し）は表の下に残す。
 *
 * フォルダの列は共通のフォルダ（kind `mileage_reward`）。行の名前の前に色の丸、「…」の「フォルダへ移す」。
 */

const KIND_LABEL: Record<MileageRewardKind, string> = {
  coupon: 'クーポン',
  tag: 'タグ',
  scenario: 'シナリオ',
  template: 'メッセージ',
  early_access: '先にお知らせ',
  rank: 'ランク',
}

const KIND_FOLDER: Record<MileageRewardKind, 'クーポン' | 'タグ・メッセージ' | 'シナリオ' | '先行・ランク'> = {
  coupon: 'クーポン',
  tag: 'タグ・メッセージ',
  template: 'タグ・メッセージ',
  scenario: 'シナリオ',
  early_access: '先行・ランク',
  rank: '先行・ランク',
}

/*
 * 使い道の種類で分けた見え方（保存しない）。作ったフォルダではないので、左のフォルダの列ではなく
 * 上の絞り込み（「種類」の選ぶ欄）に置く（ 2026-10-09）。
 */
const FOLDERS = ['すべて', 'クーポン', 'タグ・メッセージ', 'シナリオ', '先行・ランク', '未分類'] as const
type Folder = (typeof FOLDERS)[number]

function folderOf(reward: MileageRewardSummary): Exclude<Folder, 'すべて'> {
  return KIND_FOLDER[reward.rewardKind] ?? '未分類'
}

function statusPill(status: MileageRewardStatus): { text: string; tone: 'active' | 'neutral' } {
  if (status === 'published') return { text: '出している', tone: 'active' }
  if (status === 'draft') return { text: '下書き', tone: 'neutral' }
  if (status === 'stopped') return { text: '止めています', tone: 'neutral' }
  return { text: '片づけました', tone: 'neutral' }
}

/* 交換すると渡るものの2行目（残り・期限）。 */
function benefitSub(reward: MileageRewardSummary): string | null {
  const version = reward.currentVersion
  if (!version) return null
  const parts: string[] = []
  if (reward.availableCodeCount != null) {
    parts.push(`残り ${formatNumber(reward.availableCodeCount)}`)
  } else if (version.stockLimit !== null) {
    parts.push('残り数は取れていません')
  } else {
    parts.push('残り 制限なし')
  }
  if (version.endsAt) {
    /* 絵は「10/31 まで」。年月日の頭だけ取り、時刻・時差に振られない。 */
    const day = version.endsAt.slice(0, 10).split('-')
    if (day.length === 3) parts.push(`${Number(day[1])}/${Number(day[2])} まで`)
  }
  return parts.join('・')
}

interface FailedRedemption {
  id: string
  rewardName: string
  status: string
  attemptCount: number
  failureCode: string | null
  failureMessage: string | null
  updatedAt: string
}

interface RedemptionHistory {
  items: FailedRedemption[]
  pagination: { total: number; limit: number; offset: number }
}

const REDEMPTIONS_PAGE_SIZE = 20

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

const PRESETS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'よく使う絞り込み' },
  { value: 'published-exchanged', label: '出している・交換が多い順' },
  { value: 'draft', label: '下書きのみ' },
  { value: 'miles-asc', label: '必要なマイルが少ない順' },
]

export default function RewardsTab() {
  const saveErrors = useSaveFormErrors()
  const { readonly: roleReadonly, narrow, setCount, balanceSource } = useMileageShell()
  const readonly = roleReadonly || balanceSource === 'ec'
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const accountId = selectedAccountId
  const router = useRouter()
  const [rewards, setRewards] = useState<MileageRewardSummary[]>([])
  const [reachMetrics, setReachMetrics] = useState<Array<{ rewardId: string; reachableFriendCount: number }>>([])
  const [rankBenefits, setRankBenefits] = useState<MileageRewardReachMetric[]>([])
  const [neverRedeemedFriendCount, setNeverRedeemedFriendCount] = useState<number | null>(null)
  const [redeemedMiles, setRedeemedMiles] = useState<number | null>(null)
  const [exchangedCount, setExchangedCount] = useState<number | null>(null)
  const [popularName, setPopularName] = useState<string | null>(null)
  const [popularCount, setPopularCount] = useState<number | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [failed, setFailed] = useState<FailedRedemption[]>([])
  const [redemptionsVisible, setRedemptionsVisible] = useState(false)
  const [redemptionsLoad, setRedemptionsLoad] = useState<LoadStatus>('loading')
  const [redemptionsPage, setRedemptionsPage] = useListUrlValue('redemptionsPage', 1)
  const [redemptionsTotal, setRedemptionsTotal] = useState(0)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState('')
  const [retryNotice, setRetryNotice] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [testBusyId, setTestBusyId] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)
  const [menuNotice, setMenuNotice] = useState('')
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [folder, setFolder] = useListUrlValue<Folder>('folder', 'すべて')
  const { folders, error: folderError, reload: reloadFolders } = useManagedFolders('mileage_reward', accountId)
  const [folderId, setFolderId] = useListUrlValue('folderId', 'all')
  const [publishedOnly, setPublishedOnly] = useListUrlValue('publishedOnly', false)
  const [draftOnly, setDraftOnly] = useListUrlValue('draftOnly', false)
  const [preset, setPreset] = useState('default')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [fetchGuards] = useState(createMileageRewardsFetchGuards)
  const { overview: overviewGuard, redemptions: redemptionsGuard } = fetchGuards
  const [accountTracker] = useState(createAccountTracker)
  const [retryLock] = useState(createSingleFlightLock)
  const redemptionsPageRef = useRef(1)
  useEffect(() => { redemptionsPageRef.current = redemptionsPage }, [redemptionsPage])
  useEffect(() => {
    accountTracker.track(accountId)
    retryLock.reset()
    setRetryingId(null)
    setRetryError('')
    setRetryNotice('')
    setRedemptionsPage(1)
  }, [accountId, accountTracker, retryLock])

  const load = useCallback(async () => {
    const requestId = overviewGuard.issue()
    if (!accountId) {
      if (!overviewGuard.isCurrent(requestId)) return
      setRewards([])
      setStatus('ready')
      return
    }
    setStatus('loading')
    try {
      const response = await api.mileage.rewards(accountId)
      if (!overviewGuard.isCurrent(requestId)) return
      if (!response.success) throw new Error(response.error)
      if (!Array.isArray(response.data?.rewards)) throw new Error('malformed')
      const list = response.data.rewards
      setRewards(list)
      const overviewSummary = response.data.summary
      setRedeemedMiles(overviewSummary?.redeemedMilesThisMonth ?? null)
      setExchangedCount(list.reduce((sum, r) => sum + r.exchangedThisMonth, 0))
      /* 1回も交換されていないのに名指ししない（回数が0ならまだ誰も使っていない）。 */
      const redeemedCount = overviewSummary?.mostRedeemedRewardCount ?? null
      setPopularName(redeemedCount ? (overviewSummary?.mostRedeemedRewardName ?? null) : null)
      setPopularCount(redeemedCount)
      setReachMetrics(Array.isArray(response.data.reachMetrics) ? response.data.reachMetrics : [])
      setRankBenefits(Array.isArray(response.data.rankBenefits) ? response.data.rankBenefits : [])
      setNeverRedeemedFriendCount(overviewSummary?.neverRedeemedFriendCount ?? null)
      setLoadedAccountId(accountId)
      setStatus('ready')
    } catch (reason) {
      if (!overviewGuard.isCurrent(requestId)) return
      saveErrors.capture(reason)
      setRewards([]);

      setStatus(reason instanceof Error && reason.message === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [accountId, saveErrors, overviewGuard])

  useEffect(() => {
    if (accountLoading) return
    void load()
  }, [accountLoading, load])

  const loadFailed = useCallback(async (pageNumber: number) => {
    const requestId = redemptionsGuard.issue()
    if (!accountId) {
      if (!redemptionsGuard.isCurrent(requestId)) return
      setFailed([])
      setRedemptionsVisible(false)
      setRedemptionsLoad('loading')
      setRedemptionsTotal(0)
      return
    }
    setRedemptionsLoad('loading')
    try {
      const offset = (Math.max(1, pageNumber) - 1) * REDEMPTIONS_PAGE_SIZE
      const response = await fetchApi<ApiResponse<RedemptionHistory>>(
        `/api/mileage/redemptions?accountId=${encodeURIComponent(accountId)}`
        + `&limit=${REDEMPTIONS_PAGE_SIZE}&offset=${offset}`,
      )
      if (!redemptionsGuard.isCurrent(requestId)) return
      if (!response.success) throw new Error(response.error)
      if (!Array.isArray(response.data?.items)) throw new Error('malformed')
      setFailed(response.data.items.filter(
        (item) => item.status === 'delivery_failed' || item.status === 'delivering',
      ))
      const total = response.data.pagination?.total ?? 0
      setRedemptionsTotal(total)
      if (response.data.items.length === 0 && total > 0 && Math.max(1, pageNumber) > 1) {
        setRedemptionsPage(1)
      }
      setRedemptionsVisible(true)
      setRedemptionsLoad('ready')
    } catch (reason) {
      if (!redemptionsGuard.isCurrent(requestId)) return
      saveErrors.capture(reason)
      setFailed([])
      setRedemptionsVisible(true)
      setRedemptionsTotal(0);

      const forbidden = reason instanceof ApiError && (reason.status === 403 || reason.code === 'forbidden')
      setRedemptionsLoad(forbidden ? 'forbidden' : 'error')
    }
  }, [accountId, saveErrors, redemptionsGuard])

  useEffect(() => {
    void loadFailed(redemptionsPage)
  }, [loadFailed, redemptionsPage])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchInput.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const retryRedemption = async (item: FailedRedemption) => {
    if (!accountId || retryingId) return
    if (!retryLock.acquire(item.id)) return
    const startedAccountId = accountId
    const operation = accountTracker.track(startedAccountId)
    setRetryingId(item.id)
    setRetryError('')
    setRetryNotice('')
    const reloadLists = async () => {
      await loadFailed(redemptionsPageRef.current)
      if (!accountTracker.isCurrent(operation)) return
      await load()
    }
    try {
      const response = await fetchApi<{ success: boolean; data?: { message?: string | null; redemption?: { status?: string } }; error?: string }>(
        `/api/mileage/redemptions/${encodeURIComponent(item.id)}/retry-fulfillment`,
        { method: 'POST', body: JSON.stringify({ accountId: startedAccountId }) },
      )
      if (!accountTracker.isCurrent(operation)) return
      const redemptionStatus = response.data?.redemption?.status
      const serverMessage = typeof response.data?.message === 'string' && response.data.message.trim()
        ? response.data.message
        : null
      if (!response.success && redemptionStatus === 'refunded') {
        setRetryNotice(serverMessage ?? '交換したマイルを戻しました。')
      } else if (!response.success && redemptionStatus === 'delivering') {
        setRetryNotice(serverMessage ?? '特典の送信結果を確認しています。確定するまでお待ちください。')
      } else if (!response.success) {
        throw new Error(response.error)
      }
      await reloadLists()
    } catch (saveFailure) {
      if (!accountTracker.isCurrent(operation)) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setRetryError('やり直せませんでした。時間をおいてもう一度お試しください。') }
      await loadFailed(redemptionsPageRef.current)
    } finally {
      retryLock.release(item.id)
      if (accountTracker.isCurrent(operation)) setRetryingId(null)
    }
  }

  const changeState = async (reward: MileageRewardSummary) => {
    if (readonly || !accountId
      || (reward.status !== 'published' && reward.status !== 'draft' && reward.status !== 'stopped')) return
    /*
     * 出すのを止める・また出す：押した瞬間に状態を変え、裏で保存する（触り心地 5 回目）。
     * 失敗したら元に戻してトーストで知らせる。下書きを公開するのは中身の確かめがあるので今までどおり。
     */
    if (reward.status === 'published' || reward.status === 'stopped') {
      const before = reward.status
      const next = before === 'published' ? 'stopped' : 'published'
      const setStatus = (status: MileageRewardSummary['status']) => setRewards((current) => current.map((item) => (
        item.id === reward.id ? { ...item, status } : item
      )))
      setBusyId(reward.id)
      setActionError('')
      setStatus(next)
      try {
        const response = before === 'published'
          ? await api.mileage.stopReward(reward.id, accountId)
          : await api.mileage.resumeReward(reward.id, accountId)
        if (!response.success) throw new Error(response.error)
        const saved = response.data
        if (saved && typeof saved === 'object' && saved.id === reward.id) {
          setRewards((current) => current.map((item) => (item.id === reward.id ? { ...item, ...saved } : item)))
        }
      } catch (saveFailure) {
        const fieldFailure = saveErrors.capture(saveFailure);

        setStatus(before)
        { if (!fieldFailure)
        notifyToast(before === 'published'
          ? `「${reward.name}」を止められませんでした。元に戻しました。`
          : `「${reward.name}」をまた出せませんでした。元に戻しました。`, {
          tone: 'error',
          actionLabel: 'もう一度',
          onAction: () => { void changeState({ ...reward, status: before }) },
        }) }
      } finally {
        setBusyId(null)
      }
      return
    }
    setBusyId(reward.id)
    setActionError('')
    try {
      const response = await api.mileage.publishReward(
        reward.id,
        accountId,
        reward.currentDraftVersionId ?? reward.currentVersion?.id ?? undefined,
        reward.currentVersion?.revision,
      )
      if (!response.success) throw new Error(response.error)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('使い道を公開できませんでした。内容を確認してもう一度お試しください。') }
    } finally {
      setBusyId(null)
    }
  }

  /* 行の「…」の「自分で交換をテスト」。残高・在庫は動かさない。 */
  const runTest = async (reward: MileageRewardSummary) => {
    if (!accountId || testBusyId) return
    setTestBusyId(reward.id)
    setMenuNotice('')
    setActionError('')
    try {
      const response = await api.mileage.testReward(reward.id, accountId)
      if (!response.success) throw new Error(response.error)
      const warning = typeof response.data?.warning === 'string' ? response.data.warning.trim() : ''
      setMenuNotice(response.data?.canDeliver
        ? 'この内容で交換できます。残高・在庫は動いていません。'
        : (warning || 'この内容では交換できません。内容を確認してください。'))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('交換のテストができませんでした。もう一度お試しください。') }
    } finally {
      setTestBusyId(null)
    }
  }

  /* 行の「…」の「複製」。今の内容で下書きを1つ作る（公開はしない）。 */
  const duplicateReward = async (reward: MileageRewardSummary) => {
    if (readonly || !accountId || duplicateId) return
    const version = reward.currentVersion
    if (!version) {
      setActionError('複製する内容が取れませんでした。開き直してもう一度お試しください。')
      return
    }
    setDuplicateId(reward.id)
    setMenuNotice('')
    setActionError('')
    try {
      const response = await api.mileage.createReward(accountId, {
        name: `${reward.name} のコピー`,
        description: reward.description,
        imageUrl: reward.imageUrl,
        rewardKind: reward.rewardKind,
        requiredMiles: version.requiredMiles,
        stockLimit: version.stockLimit,
        perFriendLimit: version.perFriendLimit,
        startsAt: version.startsAt,
        endsAt: version.endsAt,
        benefitExpiresDays: version.benefitExpiresDays,
        commonActionVersionId: version.commonActionVersionId,
        targetConditions: version.targetConditions,
        failurePolicy: version.failurePolicy,
        customerMessage: version.customerMessage,
      })
      if (!response.success) throw new Error(response.error)
      setMenuNotice(`「${reward.name} のコピー」を下書きで作りました。`)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('複製できませんでした。もう一度お試しください。') }
    } finally {
      setDuplicateId(null)
    }
  }

  /* タブの名の横の件数。読み直し中・失敗時は消す。 */
  useEffect(() => {
    if (status === 'loading') return
    setCount('rewards', status !== 'ready' ? null : formatMileageNumber(rewards.length))
  }, [setCount, rewards.length, status])

  const publishedCount = rewards.filter((r) => r.status === 'published').length
  const draftCount = rewards.filter((r) => r.status === 'draft').length
  const shown = useMemo(() => {
    const keyword = search.trim()
    const filtered = rewards.filter((reward) => {
      if (folder !== 'すべて' && folderOf(reward) !== folder) return false
      if (folderId !== 'all' && (folderId === 'unfiled' ? Boolean(reward.folderId) : reward.folderId !== folderId)) return false
      if (publishedOnly && reward.status !== 'published') return false
      if (draftOnly && reward.status !== 'draft') return false
      if (keyword && !reward.name.includes(keyword)) return false
      return true
    })
    if (preset === 'published-exchanged') {
      return [...filtered].filter((r) => r.status === 'published').sort((a, b) => b.exchangedThisMonth - a.exchangedThisMonth)
    }
    if (preset === 'draft') return filtered.filter((r) => r.status === 'draft')
    if (preset === 'miles-asc') {
      return [...filtered].sort((a, b) => (a.currentVersion?.requiredMiles ?? 0) - (b.currentVersion?.requiredMiles ?? 0))
    }
    return [...filtered].sort((a, b) => a.sortOrder - b.sortOrder)
  }, [draftOnly, folder, folderId, preset, publishedOnly, rewards, search])

  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize))
  const visible = shown.slice((page - 1) * pageSize, page * pageSize)
  const resetAll = () => {
    setSearchInput('')
    setSearch('')
    setFolder('すべて')
    setFolderId('all')
    setPublishedOnly(false)
    setDraftOnly(false)
    setPreset('default')
    setPage(1)
  }

  /* 頭の「CSVで書き出す」。使い道の書き出し口は無いので、今見えている表の中身をそのまま出す。 */
  const canExport = !accountLoading && !!accountId && loadedAccountId === accountId && status === 'ready' && shown.length > 0
  const exportCsv = useCallback(() => {
    if (!canExport) return
    setActionError('')
    try {
      const rows = shown.map((reward) => [
        reward.name,
        String(reward.currentVersion?.requiredMiles ?? ''),
        reward.benefitName ? `${KIND_LABEL[reward.rewardKind]}「${reward.benefitName}」` : KIND_LABEL[reward.rewardKind],
        benefitSub(reward) ?? '',
        `${reward.exchangedThisMonth} 件`,
        statusPill(reward.status).text,
      ])
      const csv = [['使い道', '必要なマイル', '交換すると渡るもの', '残り・期限', '今月交換された', '状態'], ...rows]
        .map((row) => row.map((value) => csvCell(value)).join(','))
        .join('\n')
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("マイルの特典")
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('CSVを書き出せませんでした。もう一度お試しください。') }
    }
  }, [canExport, shown, saveErrors]);


  const ready = status === 'ready'
  const failedReason = failed[0] ? (failed[0].failureMessage || failed[0].rewardName) : null

  const stats = (
    <KpiBand>
      <KpiCard
        presentation="band"
        title="使い道"
        icon={<Gift size={16} aria-hidden="true" />}
        value={ready ? rewards.length : null}
        unit="件"
        detail={<span title={neverRedeemedFriendCount == null ? '1回も使っていない人の数は未取得' : `1回も使っていない人 ${formatNumber(neverRedeemedFriendCount)} 人`}>{ready ? `出している ${formatMileageNumber(publishedCount)}・下書き ${formatMileageNumber(draftCount)}` : emptyValue('unknown')}</span>}
      />
      <KpiCard
        presentation="band"
        title="今月 交換"
        icon={<ArrowLeftRight size={16} aria-hidden="true" />}
        value={ready ? exchangedCount ?? 0 : null}
        unit="件"
        detail={ready ? `${formatMileageNumber(redeemedMiles ?? 0)} マイル` : emptyValue('unknown')}
      />
      <KpiCard
        presentation="band"
        title="いちばん人気"
        icon={<Star size={16} aria-hidden="true" />}
        /* 大きい数字の場所には今月の交換の件数、名前は下の段（：数の場所に名前を入れない）。 */
        value={ready && popularName && popularCount != null ? popularCount : null}
        unit="件"
        detail={ready ? (popularCount == null ? '交換の回数は未取得' : popularCount === 0 ? 'まだ交換されていません' : popularName ? `今月いちばん：${popularName}` : '使い道の名前は未取得') : emptyValue('unknown')}
      />
      <KpiCard
        presentation="band"
        title="渡せなかった"
        icon={<AlertCircle size={16} aria-hidden="true" />}
        value={redemptionsLoad === 'ready' ? redemptionsTotal : null}
        unit="件"
        detail={failedReason ? '理由を確認してください' : '要対応の交換はありません'}
        description={failedReason ?? undefined}
      />
    </KpiBand>
  )

  /* 主ボタンは素の Button で渡し、題の右の自動整列（副→主）に載せる。 */
  const createButton = (full: boolean) => (
    readonly ? null : (
      <Button variant="primary" className={full ? 'v8-folder-create w-full' : undefined} href="/mileage/rewards/edit">
        <Plus size={16} aria-hidden="true" /> 使い道を作る
      </Button>
    )
  )

  const chooseFolder = (id: string) => { setPage(1); setFolderId(id) }
  const folderPanel = (
    <ManagedFolderPanel kind="mileage_reward" accountId={accountId} folders={folders}
      onChanged={async () => { await reloadFolders(); await load() }} canManage={!readonly} createAction={createButton(true)}
      reserveCreateSpace={false} itemLabel="使い道" activeId={folderId} onSelect={chooseFolder}
      allCount={status === 'ready' ? rewards.length : null} error={folderError}
      unfiledCount={status === 'ready' ? rewards.filter((reward) => !reward.folderId).length : null}
      countOf={(item) => status === 'ready' ? rewards.filter((reward) => reward.folderId === item.id).length : null}
      onDeleted={(id) => { if (folderId === id) chooseFolder('all'); void load() }} />
  )
  const folderMove = useFolderMove({ accountId, canEdit: !readonly, items: visible, folders,
    move: async (reward, targetId) => {
      if (!accountId) throw new Error('アカウントを選んでください')
      const result = await api.mileage.moveRewardToFolder(reward.id, accountId, targetId)
      if (!result.success) throw new Error('使い道をフォルダへ移せませんでした')
    },
    onChanged: async () => { await load(); await reloadFolders() },
  })

  const chips = (
    <SegmentedControl
      aria-label="状態で絞り込む"
      value={publishedOnly ? 'published' : draftOnly ? 'draft' : 'all'}
      onChange={(next) => {
        setPage(1)
        setPublishedOnly(next === 'published')
        setDraftOnly(next === 'draft')
      }}
      options={[
        { value: 'all', label: 'すべて' },
        { value: 'published', label: '出している', count: publishedCount },
        { value: 'draft', label: '下書き', count: draftCount },
      ]}
    />
  )

  const toolbar = (
    <MileageToolbar
      narrow={narrow}
      notices={<ToolbarNotices
        error={actionError}
        success={menuNotice}
      />}
      search={{
        placeholder: '使い道の名前で探す',
        value: searchInput,
        onChange: (value) => {
          setSearchInput(value)
          if (!value) { setSearch(''); setPage(1) }
        },
      }}
      chips={chips}
      narrowLead={createButton(false)}
      trailing={<>
        <SavedSelect
          value={preset}
          options={PRESETS}
          onChange={(value) => {
            setPage(1)
            setPreset(value)
            if (value === 'draft') {
              setDraftOnly(true)
              setPublishedOnly(false)
            } else if (value === 'published-exchanged') {
              setPublishedOnly(true)
              setDraftOnly(false)
            } else {
              setPublishedOnly(false)
              setDraftOnly(false)
            }
          }}
        />
        <PerPageSelect value={pageSize} onChange={(next) => { setPage(1); setPageSize(next) }} />
      </>}
    />
  )

  const rowMenu = (reward: MileageRewardSummary) => {
    if (balanceSource === 'ec') return null
    const operable = !readonly && (reward.status === 'published' || reward.status === 'draft' || reward.status === 'stopped')
    return (
      <div className={styles.menuBox}>
        <RowMenu
          label={`${reward.name}の操作`}
          open={menuId === reward.id}
          onOpenChange={(next) => setMenuId(next ? reward.id : null)}
          items={[
            {
              id: 'open',
              label: readonly ? '中身を見る' : '編集',
              external: false,
              href: `/mileage/rewards/edit?id=${encodeURIComponent(reward.id)}`, onSelect: () => router.push(`/mileage/rewards/edit?id=${encodeURIComponent(reward.id)}`),
            },
            /* 閲覧のみの人には、変える操作を出さない（押せない形で残さない）。 */
            ...(readonly ? [] : [
              {
                id: 'test',
                label: '自分で交換をテスト',
                disabled: testBusyId === reward.id,
                disabledReason: 'テストを実行しています',
                onSelect: () => void runTest(reward),
              },
              ...(operable ? [{
                id: 'toggle',
                label: reward.status === 'published' ? '出すのを止める' : reward.status === 'stopped' ? 'また出す' : '出す',
                disabled: busyId === reward.id,
                disabledReason: '反映しています',
                onSelect: () => void changeState(reward),
              }] : []),
              { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(reward) },
              {
                id: 'duplicate',
                label: '複製',
                disabled: duplicateId === reward.id || !reward.currentVersion,
                disabledReason: duplicateId === reward.id ? '複製しています' : '複製する内容が取れていません',
                onSelect: () => void duplicateReward(reward),
              },
            ]),
          ]}
        />
      </div>
    )
  }

  const table = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={MILEAGE_TABLE_LAYOUT}>
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>使い道</Th>
            <Th align="right" className={styles.colNeed}>必要なマイル</Th>
            <Th collapseAt="narrow" className={styles.colGives} title={rankBenefits.length === 0 ? 'ランクの使い道はまだありません' : rankBenefits.map((rank) => `${rank.rewardName}・${formatNumber(rank.requiredMiles)} マイルから・今すぐ届く人 ${formatNumber(rank.reachableFriendCount)} 人・交換済み ${formatNumber(rank.redeemedFriendCount)} 人`).join('／')}>交換すると渡るもの</Th>
            <Th align="right" collapseAt="narrow" className={styles.colMonth}>今月 交換された</Th>
            <Th className={styles.colRewardState}>状態</Th>
            <Th className={styles.colRewardOps}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {visible.map((reward) => {
            const pill = statusPill(reward.status)
            const reach = reachMetrics.find((metric) => metric.rewardId === reward.id)
            const sub = benefitSub(reward)
            return (
              <Tr key={reward.id} data-table-layout="columns" data-row-id={reward.id}>
                <Td grow>
                  {/* 名前の前にフォルダの丸（左のフォルダの列と同じ分け方。未分類は輪）。補足は名前の頭にそろえる。 */}
                  <FolderDotName folder={folderDotFor(folders, reward.folderId)}>
                    <span title={reach ? `今すぐ届く人 ${formatNumber(reach.reachableFriendCount)} 人` : '届く人数は未取得'}><TruncatedText value={String(reward.name ?? '')} /></span>
                  </FolderDotName>

                </Td>
                <Td align="right" className={styles.colNeed}>
                  <span className={styles.cellMain}>{formatMileageNumber(reward.currentVersion?.requiredMiles)}</span>
                </Td>
                <Td collapseAt="narrow" className={styles.colGives}>
                  <TruncatedText className={styles.cellMain} value={reward.benefitName ? `${KIND_LABEL[reward.rewardKind]}「${reward.benefitName}」` : KIND_LABEL[reward.rewardKind]} />
                  {sub ? <span className={styles.cellSub}>{sub}</span> : null}
                </Td>
                <Td align="right" collapseAt="narrow" className={styles.colMonth}>
                  <span className={styles.cellMain}>{`${formatMileageNumber(reward.exchangedThisMonth)} 件`}</span>
                </Td>
                <Td className={styles.colRewardState}>
                  <StatusBadge tone={mileageStatusTone(pill.tone)}>{pill.text}</StatusBadge>
                </Td>
                <Td className={styles.colRewardOps}>
                  <span className={styles.rowActions}>
                    {rowMenu(reward)}
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const failedSection = redemptionsVisible && (failed.length > 0 || redemptionsLoad === 'error' || redemptionsLoad === 'forbidden') ? (
    <section aria-label="要対応の交換" className={styles.subSection}>
      <p className={styles.subTitle}>要対応の交換</p>
      <p className={styles.subDesc}>マイルは減ったまま、特典が届いていないか、届いたか分からない交換です。やり直してもマイルはもう減りません。</p>
      {retryNotice ? <Notice tone="success" message={retryNotice} /> : null}
      {retryError ? <Notice tone="danger" message={retryError} /> : null}
      {redemptionsLoad === 'error' || redemptionsLoad === 'forbidden' ? (
        <ListState
          kind={redemptionsLoad}
          description={redemptionsLoad === 'forbidden'
            ? permissionDeniedMessage('store')
            : '要対応の交換を読み込めませんでした。'}
          onRetry={redemptionsLoad === 'error' ? () => void loadFailed(redemptionsPage) : undefined}
        />
      ) : (
        <DataTable columnLayout={MILEAGE_TABLE_LAYOUT}>
          <thead>
            <TableHeadRow data-table-layout="columns">
              <Th grow>使い道</Th>
              <Th className={styles.colStateWide}>状態</Th>
              <Th collapseAt="narrow" className={styles.colGives}>届かなかった理由</Th>
              <Th align="right" collapseAt="narrow" className={styles.colMonth}>試した回数</Th>
              <Th collapseAt="narrow" className={styles.colGives}>最後の更新</Th>
              <Th className={styles.colRewardOps}>操作</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {failed.map((item) => (
              <Tr data-row-id={item.id} key={item.id} data-table-layout="columns">
                <Td grow><FolderDotName><span className={styles.cellMain} title={item.rewardName}>{item.rewardName}</span></FolderDotName></Td>
                <Td className={styles.colStateWide}>
                  {item.status === 'delivering' ? (
                    <span className={styles.stateWithHelp}>
                      確認中
                      <HelpTip label="確認中の説明">
                        送った結果が分からず、確定を確認しています。二重に送らないよう自動では動かしていません。
                      </HelpTip>
                    </span>
                  ) : (
                    <span className={styles.cellMain}>届いていない</span>
                  )}
                </Td>
                <Td collapseAt="narrow" className={styles.colGives}><TruncatedText className={styles.cellMain} value={item.failureMessage || item.failureCode || '理由を確認できませんでした'} /></Td>
                <Td align="right" collapseAt="narrow" className={styles.colMonth}><span className={styles.cellMain}>{`${formatNumber(item.attemptCount)} 回`}</span></Td>
                <Td collapseAt="narrow" className={styles.colGives}><span className={styles.cellMain}>{formatMileageDate(item.updatedAt)}</span></Td>
                <Td className={styles.colRewardOps}>
                  {/* 行の右端は「…」1つ（B-253）。もう一度届けるはその中。閲覧のみの人には置かない。 */}
                  {!readonly ? (
                    <div className={styles.menuBox}>
                        <RowMenu
                          label={`${item.rewardName}の交換の操作`}
                          items={[{
                            id: 'retry',
                            label: retryingId === item.id ? 'やり直しています' : 'もう一度届ける',
                            icon: <RotateCcw size={16} aria-hidden="true" />,
                            disabled: retryingId !== null,
                            onSelect: () => void retryRedemption(item),
                          }]}
                        />
                    </div>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {Math.ceil(redemptionsTotal / REDEMPTIONS_PAGE_SIZE) > 1 ? (
        <div className={styles.subPager}>
          <span className={styles.pagerCount}>{`要対応の交換 ${formatNumber(redemptionsTotal)} 件`}</span>
          <Pagination
            page={redemptionsPage}
            pageCount={Math.ceil(redemptionsTotal / REDEMPTIONS_PAGE_SIZE)}
            onPageChange={(next) => setRedemptionsPage(next)}
            ariaLabel="要対応の交換のページ送り"
          />
        </div>
      ) : null}
    </section>
  ) : null

  const body = status === 'loading' ? (
    <ListState kind="loading" title="使い道を読み込んでいます" />
  ) : status === 'forbidden' ? (
    <StateCard title="使い道を見る権限がありません" description={permissionDeniedMessage('store')} />
  ) : status === 'error' ? (
    <StateCard tone="error" title="使い道を読み込めませんでした" description="数の帯は「—」にしています。道具はそのまま使えます。" action={<RetryButton onRetry={() => void load()} />} />
  ) : visible.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      icon={<Gift aria-hidden="true" />}
      title="まだ使い道がありません"
      description="たまったマイルと交換できる特典を出します。"
      create={{ label: '最初の使い道を作る', href: '/mileage/rewards/edit' }}
      canCreate={!readonly}
      filtered={rewards.length > 0}
      onClearFilters={resetAll}
      filteredDescription="名前の検索や絞り込みを外すと、すべて出ます"
    />
  ) : (
    <>
      {table}
    </>
  )

  const pager = ready && visible.length > 0 && pageCount > 1 ? (
    <ListPagePagination>
      <span className={styles.pagerCount}>{`${formatNumber(shown.length)} 件中 ${(page - 1) * pageSize + 1}〜${Math.min(page * pageSize, shown.length)} 件`}</span>
      <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
    </ListPagePagination>
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><MileageFrame
      help={readonly ? '使い道と交換に必要なマイルを確認できます。' : '行の「…」から 編集・自分で交換をテスト・出すのを止める・フォルダへ移す・複製。'}
      /* 案内は「この画面の説明」の帯（題の右の口で開け閉めする。・）。 */
      explanation="交換は、お客さまの LINE（マイルの画面）から。渡せなかったときは、決めておいた方法（マイルを戻す など）で処理します"
      actions={
        <Button variant="secondary" onClick={exportCsv} disabled={!canExport}>
          <Download size={16} aria-hidden="true" /> CSVで書き出す
        </Button>
      }
      stats={stats}
      folders={folderPanel}
      folderNav={{ rows: managedFolderNavRows('mileage_reward', folders), activeId: folderId, onSelect: chooseFolder, createAction: readonly ? undefined : createButton(false) }}
      toolbar={toolbar}
      pagination={pager}
    >
      {body}
      {!failedSection && retryNotice ? <Notice tone="success" message={retryNotice} /> : null}
      {balanceSource === 'ec' && accountId ? <HeldRedemptions accountId={accountId} /> : null}
      {failedSection}
      {folderMove.overlays}
    </MileageFrame></SaveErrorScope>
  )
}
