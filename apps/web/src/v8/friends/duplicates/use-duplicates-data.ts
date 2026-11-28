'use client'

/** 重複候補の読み込み・絞り込み・再検出の正本。URLの条件と新しい応答だけを使う。 */
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { IdentityCandidateListItem, IdentityCandidateStatus } from '@line-crm/shared'
import { formatNumber } from '@/lib/format'
import { formatElapsedMinutes } from '@/lib/format-duration'

export interface PerAccountStat {
  accountId: string
  accountName: string
  friends: number
  dups: number
  dupRate: number
}

export interface PairwiseOverlap {
  fromAccountId: string
  toAccountId: string
  overlap: number
}

export interface DuplicatesStatsData {
  totalFollowing: number
  uniquePeople: number
  friendDups: number
  duplicateGroups: number
  // 旧Workerの省略・実績取得不能を0通にしない。
  overlappingDeliveryCount?: number | null
  // friendDups × 単価の見積り。実送信数の代わりには使わない。
  wastedPerBroadcastYen: number
  msgUnitYen: number
  perAccount: PerAccountStat[]
  // Optional: an older worker deployment (mid-rollout) may not include this
  // field. Guarded at every access site below; do not assume non-empty.
  pairwiseOverlap?: PairwiseOverlap[]
  // Optional during rolling deploys.
  computedAt?: string
}

export function formatRelative(iso: string): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return '確認できません'
  const elapsedMs = Date.now() - timestamp
  if (elapsedMs < 0) return 'たった今'
  const sec = Math.floor(elapsedMs / 1000)
  // E33：秒だけここで言い、分以上は共通の関数へ（1282時間前→53日前）。
  if (sec < 60) return `${sec}秒前`
  return formatElapsedMinutes(Math.floor(sec / 60))
}

export const CANDIDATE_PAGE_SIZE = 50

export function useDuplicatesData() {
  const [data, setData] = useState<DuplicatesStatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  // R598: 集計だけ失敗しても候補一覧は残す。集計欄の失敗表示に使うため、
  // 捕まえた失敗をそのまま残す（403は権限の案内・再試行なしに言い分ける）。
  const [statsFailure, setStatsFailure] = useState<unknown>(null)
  const [candidates, setCandidates] = useState<IdentityCandidateListItem[]>([])
  const [candidateTotal, setCandidateTotal] = useState(0)
  // statusCounts / lowConfidenceCount は旧Workerとの互換で省かれることがある。
  // 省かれたときは null のまま残し、空の集計で0組と誤案内しない。
  const [statusCounts, setStatusCounts] = useState<Partial<Record<IdentityCandidateStatus, number>> | null>(null)
  const [lowConfidenceCount, setLowConfidenceCount] = useState<number | null>(null)
  const [query, setQuery] = useListUrlValue('q', '')
  // FRIEND-11: 検索はサーバーへ渡して全件へかける。入力中の逐次送信を避けるため debounce。
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidateError, setCandidateError] = useState('')
  // 表の中の失敗表示（403の言い分けつき）に渡すため、捕まえた失敗を残す。
  const [candidateFailure, setCandidateFailure] = useState<unknown>(null)
  /*
   * FRIEND-12: 状態切替で先行した要求の応答が後から届いても採用しない。
   * 番号の新しい要求だけを採用し、検索キー（状態・検索語・ページ）も
   * 照合して「選んだ条件」と「出ている結果」がずれないようにする。
   */
  const candidatesReqRef = useRef(0)
  const candidatesKeyRef = useRef('')
  const statsReqRef = useRef(0)
  const mountedRef = useRef(true)
  const detectingRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      candidatesReqRef.current += 1
      statsReqRef.current += 1
      candidatesKeyRef.current = ''
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(timer)
  }, [query])

  // 条件を変えたら1ページ目へ戻す（FRIEND-11）。
  useEffect(() => {
    setPage(1)
  }, [debouncedQuery, status])

  const loadStats = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (opts?.forceRefresh) setRefreshing(true)
    const req = ++statsReqRef.current
    try {
      const statsRes = await api.duplicates.stats(opts)
      if (req !== statsReqRef.current) return
      if (statsRes.success) {
        setData(statsRes.data)
        setStatsFailure(null)
        setError('')
      } else {
        // success:false には状態が付かないので汎用（再試行あり）扱いにする。
        setStatsFailure(new Error('集計を読み込めませんでした'))
        setError('読み込めませんでした')
      }
    } catch (err) {
      if (req !== statsReqRef.current) return
      setStatsFailure(err)
      setError('読み込めませんでした')
    } finally {
      if (req === statsReqRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  const loadCandidates = useCallback(async () => {
    const req = ++candidatesReqRef.current
    const safePage = Number.isInteger(page) && page >= 1 ? page : 1
    const key = JSON.stringify({ status, q: debouncedQuery.trim(), page: safePage })
    candidatesKeyRef.current = key
    setCandidatesLoading(true)
    setCandidateError('')
    try {
      const res = await api.identityCandidates.list({
        kind: 'friend_duplicate',
        // FRIEND-11: 「すべて」は本当に全状態を見る（従来は pending だけだった）。
        status: (status || 'all') as IdentityCandidateStatus | 'all',
        q: debouncedQuery.trim() || undefined,
        limit: CANDIDATE_PAGE_SIZE,
        offset: (safePage - 1) * CANDIDATE_PAGE_SIZE,
      })
      // 古い応答・別条件の応答は捨てる（FRIEND-12）。
      if (req !== candidatesReqRef.current || candidatesKeyRef.current !== key) return
      const validList = res.success
        && Array.isArray(res.data?.items)
        && typeof res.data?.total === 'number'
        && Number.isInteger(res.data.total)
        && res.data.total >= 0
      if (validList) {
        setCandidates(res.data.items)
        setCandidateTotal(res.data.total)
        setStatusCounts(res.data.statusCounts ?? null)
        setLowConfidenceCount(res.data.lowConfidenceCount ?? null)
        setCandidateFailure(null)
      } else {
        // FRIEND-12: 失敗を「新しい条件の0件」と誤認させない。
        setCandidates([])
        setCandidateTotal(0)
        setCandidateError('候補一覧を読み込めませんでした')
        setCandidateFailure(new Error('候補一覧を読み込めませんでした'))
      }
    } catch (err) {
      if (req !== candidatesReqRef.current || candidatesKeyRef.current !== key) return
      setCandidates([])
      setCandidateTotal(0)
      setCandidateError('候補一覧を読み込めませんでした')
      setCandidateFailure(err)
    } finally {
      if (req === candidatesReqRef.current) setCandidatesLoading(false)
    }
  }, [status, debouncedQuery, page])

  const load = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    await Promise.all([loadStats(opts), loadCandidates()])
  }, [loadStats, loadCandidates])

  const detect = useCallback(async () => {
    if (detectingRef.current) return
    detectingRef.current = true
    setRefreshing(true)
    setError('')
    try {
      const result = await api.identityCandidates.detectFriendDuplicates({ limit: 100 })
      if (!mountedRef.current) return
      if (!result?.success) throw new Error('failed')
      await load({ forceRefresh: true })
    } catch {
      if (mountedRef.current) {
        setError('重複候補を再検出できませんでした。表示中の候補は前回の結果です。')
        setRefreshing(false)
      }
    } finally {
      detectingRef.current = false
    }
  }, [load])

  const clearFilters = useCallback(() => {
    setQuery('')
    setStatus('')
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    void loadCandidates()
  }, [loadCandidates])

  // 開いたまま放置する画面なので「○分前に計算」を1分ごとに言い直す。
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(interval)
  }, [])

  /*
   * R598の件数矛盾の修正：statusCounts が無い（旧Worker）とき合計を0組と
   * 誤案内しない。絞り込み無しなら一覧の total が全体の総数と確実に等しい
   * のでそれを出し、内訳（確認待ち・確認済み・根拠不足）は「—」にする。
   * 絞り込み中は全体が分からないので合計も「—」（一覧の下に絞り込み後の
   * 件数が出ている）。読み込み待ちの0も出さない（FRIEND-12）。
   */
  const unfilteredCandidates = status === '' && debouncedQuery.trim() === ''
  const validStatusCounts =
    !candidateError
    && statusCounts !== null
    && typeof statusCounts === 'object'
    && Object.values(statusCounts).every((n) => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0))
  const duplicateTotalText =
    validStatusCounts
      ? `${formatNumber(Object.values(statusCounts).reduce((sum, n) => sum + (n ?? 0), 0))}組`
      : !unfilteredCandidates || candidateError || (candidatesLoading && candidateTotal === 0)
        ? '—'
        : `${formatNumber(candidateTotal)}組`
  const duplicateDetail =
    validStatusCounts
      ? `${formatNumber(statusCounts.pending ?? 0)}組を確認待ち`
      : !unfilteredCandidates || candidateError
        ? '読み込めませんでした'
        : '内訳は読み込めませんでした'

  return {
    data,
    loading,
    refreshing,
    error,
    statsFailure,
    candidates,
    candidateTotal,
    statusCounts,
    lowConfidenceCount,
    query,
    setQuery,
    status,
    setStatus,
    page,
    setPage,
    candidatesLoading,
    candidateError,
    candidateFailure,
    load,
    loadStats,
    loadCandidates,
    detect,
    clearFilters,
    unfilteredCandidates,
    duplicateTotalText,
    duplicateDetail,
  }
}

export type DuplicatesData = ReturnType<typeof useDuplicatesData>
