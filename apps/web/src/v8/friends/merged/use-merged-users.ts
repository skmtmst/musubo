'use client'

/*
 * ★V8 の写し（v8/users/use-merged-users.ts から。src/v8 は @/app を読めない）。
 * 違いは1ページの人数を選べることだけ。API・CSV・再計算は同じ。
 *
 * 統合ユーザー一覧（`users/page.tsx` から移したロジックの正本）。
 * 管理画面 の画面と ★V8 の画面（`users-v8.tsx`）が同じ口を使う。
 * 絞り込み・ページ・再計算・CSV はここでだけ変える。
 */
import { useListUrlState, useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { csvCell } from '@/lib/presentation'
import type { UserRowData } from '@/components/users/users-types'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select'

export const USERS_PAGE_SIZE = 50
/** ★V8：1ページの人数を選べる（既定は今と同じ 50）。 */
export const USERS_PAGE_SIZES = STANDARD_PAGE_SIZES

export interface UsersAccountOption {
  id: string
  name: string
}

export function useMergedUsers(memberAccountId: string | null) {
  const scope = useMemo(() => ({ memberAccountId }), [memberAccountId])
  const currentScope = useRef<typeof scope | null>(scope)
  const exportControllerRef = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
      exportControllerRef.current?.abort()
      exportControllerRef.current = null
    }
  }, [scope])
  const [loadedScope, setLoadedScope] = useState<typeof scope | null>(null)
  const summaryRequestRef = useRef(0)
  const [summary, setSummary] = useState<{ scope: typeof scope; total: number | null; status: 'loading' | 'ready' | 'error' } | null>(null)
  const loadSummary = useCallback(async (forceRefresh = false) => {
    if (currentScope.current !== scope) return
    const seq = ++summaryRequestRef.current
    if (!memberAccountId) { setSummary(null); return }
    setSummary({ scope, total: null, status: 'loading' })
    try {
      const res = await api.usersGrouped.list({ memberAccountId, page: 1, pageSize: 1, forceRefresh: forceRefresh || undefined })
      if (seq !== summaryRequestRef.current || currentScope.current !== scope) return
      if (!res.success || res.data.memberAccountId !== memberAccountId || !Number.isFinite(res.data.total)) throw new Error('summary unavailable')
      setSummary({ scope, total: res.data.total, status: 'ready' })
    } catch {
      if (seq === summaryRequestRef.current && currentScope.current === scope) setSummary({ scope, total: null, status: 'error' })
    }
  }, [memberAccountId, scope])
  useEffect(() => {
    void loadSummary()
    return () => { summaryRequestRef.current += 1 }
  }, [loadSummary])
  const [rows, setRows] = useState<UserRowData[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useListUrlValue('page', 1)
  const [urlScope, setUrlScope] = useListUrlState({ memberAccount: '', page: '1' })
  // 引き継ぎ確認で本文が作り直されても、ページと店舗の組を照合する。
  useEffect(() => {
    if (!memberAccountId || urlScope.memberAccount === memberAccountId) return
    setUrlScope({ memberAccount: memberAccountId, page: urlScope.memberAccount ? '1' : String(page) })
  }, [memberAccountId, urlScope.memberAccount, page, setUrlScope])
  const previousMemberAccount = useRef(memberAccountId)
  useEffect(() => {
    if (!memberAccountId) return
    if (previousMemberAccount.current && previousMemberAccount.current !== memberAccountId) setPage(1)
    previousMemberAccount.current = memberAccountId
  }, [memberAccountId, setPage])
  const [pageSize, setPageSizeState] = useListUrlValue<number>('pageSize', USERS_PAGE_SIZE)
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size)
    setPage(1)
  }, [])
  const [q, setQ] = useState('')
  const [onlyDups, setOnlyDups] = useState(false)
  const [account, setAccount] = useState('')
  const [uid, setUid] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountOptions, setAccountOptions] = useState<UsersAccountOption[]>([])
  const [accountOptionsLoading, setAccountOptionsLoading] = useState(true)
  const [accountOptionsError, setAccountOptionsError] = useState(false)
  const accountOptionsSeqRef = useRef(0)
  const accountOptionsInFlightRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      accountOptionsSeqRef.current += 1
      accountOptionsInFlightRef.current = null
    }
  }, [])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedQ, setDebouncedQ] = useState('')
  // フィルタ変更 / ページ移動で複数リクエストが in-flight になり、
  // 古い応答が後着で UI を上書きする事故を防ぐ。
  const requestSeqRef = useRef(0)
  // 次の load で最新状態を取り直すフラグ。
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQ(q), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [q])

  const filterKey = JSON.stringify([debouncedQ, onlyDups, account, uid])
  const previousFilters = useRef(filterKey)
  useEffect(() => {
    if (previousFilters.current !== filterKey) setPage(1)
    previousFilters.current = filterKey
  }, [filterKey, setPage])

  // アカウント候補は LINE アカウント API から取得（ページ依存させない）。
  // /api/users-grouped は inactive を除外して集計するので、候補も active のみ。
  const loadAccountOptions = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && accountOptionsInFlightRef.current !== null) return
    const seq = ++accountOptionsSeqRef.current
    accountOptionsInFlightRef.current = seq
    setAccountOptionsLoading(true)
    setAccountOptionsError(false)
    try {
      const res = await api.lineAccounts.list()
      if (!mountedRef.current || seq !== accountOptionsSeqRef.current) return
      if (res.success && Array.isArray(res.data)) {
        setAccountOptions(
          res.data
            .filter((a) => a.isActive)
            .map((a) => ({ id: a.id, name: a.name }))
            .sort((x, y) => x.name.localeCompare(y.name)),
        )
        setAccountOptionsError(false)
      } else {
        setAccountOptionsError(true)
      }
    } catch {
      if (mountedRef.current && seq === accountOptionsSeqRef.current) {
        setAccountOptionsError(true)
      }
    } finally {
      if (accountOptionsInFlightRef.current === seq) accountOptionsInFlightRef.current = null
      if (mountedRef.current && seq === accountOptionsSeqRef.current) setAccountOptionsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccountOptions({ force: true })
  }, [loadAccountOptions])

  const load = useCallback(async () => {
    if (currentScope.current !== scope) return
    const seq = ++requestSeqRef.current
    if (!memberAccountId) {
      setRows([]); setTotal(0); setError(''); setLoading(false); setLoadedScope(scope)
      return
    }
    setLoading(true)
    setError('')
    const force = pendingForceRefresh
    if (force) { setRefreshing(true); void loadSummary(true) }
    try {
      const res = await api.usersGrouped.list({
        q: debouncedQ || undefined,
        onlyDups: onlyDups || undefined,
        account: account || undefined,
        memberAccountId: memberAccountId || undefined,
        // FRIEND-09: UID絞り込みはサーバーへ渡し、全件へ適用する。
        uid: uid === 'linked' || uid === 'unlinked' ? uid : undefined,
        page,
        pageSize,
        forceRefresh: force || undefined,
      })
      if (seq !== requestSeqRef.current || currentScope.current !== scope) return // stale 応答は無視
      if (res.success && (res.data.memberAccountId !== memberAccountId || res.data.rows.some(row => !row.accounts.some(account => account.accountId === memberAccountId)))) throw new Error('member scope unavailable')
      setLoadedScope(scope)
      if (res.success) {
        setRows(res.data.rows)
        setTotal(res.data.total)
      } else {
        // 失敗時に古い rows を残すと、新しいフィルタ条件で古いデータが見えて誤誘導するのでクリア。
        setRows([])
        setTotal(0)
        setError('取得に失敗しました。もう一度読み込んでください。')
      }
    } catch {
      if (seq !== requestSeqRef.current || currentScope.current !== scope) return
      setLoadedScope(scope)
      setRows([])
      setTotal(0)
      setError('取得に失敗しました。もう一度読み込んでください。')
    } finally {
      if (seq === requestSeqRef.current && currentScope.current === scope) {
        setLoading(false)
        if (force) {
          setRefreshing(false)
          setPendingForceRefresh(false)
        }
      }
    }
  }, [debouncedQ, onlyDups, account, uid, page, pageSize, pendingForceRefresh, memberAccountId, scope, loadSummary])

  useEffect(() => {
    void load()
    return () => { requestSeqRef.current += 1 }
  }, [load])

  /*
   * FRIEND-09/10: CSV は「表示中の条件」に合う全件を対象にする。
   * 以前は表示中ページの50行だけを出していたため、UID条件を掛けた画面と
   * 書き出しの対象がずれていた。1回の応答上限（200件）で順に取り、
   * 件数と同じだけ集まるまで続ける。
   * セル整形は共通の csvCell（先頭 = + - @ への ' 付け + 引用符の二重化）。
   */
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  useEffect(() => { setExporting(false); setExportError('') }, [scope])
  const exportCsv = async () => {
    if (exportControllerRef.current || !memberAccountId || currentScope.current !== scope || loadedScope !== scope || loading) return
    const exportScope = scope
    const controller = new AbortController()
    exportControllerRef.current = controller
    setExporting(true)
    setExportError('')
    try {
      const filters = {
        q: debouncedQ || undefined,
        onlyDups: onlyDups || undefined,
        account: account || undefined,
        memberAccountId: memberAccountId || undefined,
        uid: uid === 'linked' || uid === 'unlinked' ? uid : undefined,
      } as const
      const all: UserRowData[] = []
      let exportTotal = total
      // 上限は途中で件数が増えても無限に追い続けないための安全弁。
      for (let p = 1; all.length < exportTotal && p <= 500; p += 1) {
        const res = await api.usersGrouped.list({ ...filters, page: p, pageSize: 200, signal: controller.signal })
        if (controller.signal.aborted || currentScope.current !== exportScope) return
        if (!res.success || res.data.memberAccountId !== memberAccountId || res.data.rows.some(row => !row.accounts.some(account => account.accountId === memberAccountId))) throw new Error('fetch failed')
        all.push(...res.data.rows)
        exportTotal = res.data.total
        if (res.data.rows.length === 0 && all.length < exportTotal) throw new Error('incomplete export')
      }
      if (controller.signal.aborted || currentScope.current !== exportScope) return
      if (all.length < exportTotal) throw new Error('incomplete export')
      const lines = [
        ['統合ユーザー', '連絡先', '紐付くアカウント', 'UID', '最終接触'].map(csvCell).join(','),
        ...all.map((row) => [
          row.displayName ?? '', row.emails[0] ?? row.phones[0] ?? '',
          row.accounts.map((item) => item.accountName).join('・'),
          row.identityKeyKind === 'uid' ? '連携済み' : row.identityKeyKind === 'url_token' ? '要確認' : '未連携',
          row.lastActivityAt,
        ].map(csvCell).join(',')),
      ]
      const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }))
      // 先頭は UTF-8 BOM（Excel で開いても文字化けしないため）。管理画面 と同じ。
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'merged-users.csv'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      if (!controller.signal.aborted && currentScope.current === exportScope) setExportError('CSVを書き出せませんでした。時間をおいてやり直してください。')
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null
        if (currentScope.current === exportScope) setExporting(false)
      }
    }
  }

  return {
    rows: loadedScope === scope ? rows : [],
    total: loadedScope === scope ? total : 0,
    memberTotal: summary?.scope === scope && summary.status === 'ready' ? summary.total : null,
    summaryStatus: !memberAccountId ? 'idle' : summary?.scope === scope ? summary.status : 'loading',
    loadSummary,
    page,
    setPage,
    pageSize,
    setPageSize,
    q,
    setQ,
    onlyDups,
    setOnlyDups,
    account,
    setAccount,
    uid,
    setUid,
    loading: loadedScope === scope ? loading : Boolean(memberAccountId),
    error: loadedScope === scope ? error : '',
    accountOptions,
    accountOptionsLoading,
    accountOptionsError,
    loadAccountOptions,
    refreshing,
    setPendingForceRefresh,
    load,
    exporting,
    exportError,
    exportCsv,
  }
}

export type MergedUsersData = ReturnType<typeof useMergedUsers>
