'use client'

/*
 * 統合ユーザー一覧（`users/page.tsx` から移したロジックの正本）。
 * 管理画面 の画面と ★V8 の画面（`users-v8.tsx`）が同じ口を使う。
 * 絞り込み・ページ・再計算・CSV はここでだけ変える。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { csvCell } from '@/lib/presentation'
import type { UserRowData } from '@/components/users/users-types'
import { formatNumber } from '@/lib/format'

export const USERS_PAGE_SIZE = 50

export interface UsersAccountOption {
  id: string
  name: string
}

/** CSV は200人ずつ読む。これを超えて続きがあれば書き出さない（WEB323）。 */
export const USERS_CSV_MAX_PAGES = 500

export function useMergedUsers() {
  const [rows, setRows] = useState<UserRowData[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [onlyDups, setOnlyDups] = useState(false)
  const [account, setAccount] = useState('')
  const [uid, setUid] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountOptions, setAccountOptions] = useState<UsersAccountOption[]>([])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedQ, setDebouncedQ] = useState('')
  // フィルタ変更 / ページ移動で複数リクエストが in-flight になり、
  // 古い応答が後着で UI を上書きする事故を防ぐ。
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)
  const exportingRef = useRef(false)
  // 次の load で最新状態を取り直すフラグ。
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestSeqRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQ(q), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [q])

  useEffect(() => {
    // FRIEND-09: UID条件も含めて条件変更時は1ページへ戻す。
    setPage(1)
  }, [debouncedQ, onlyDups, account, uid])

  // アカウント候補は LINE アカウント API から取得（ページ依存させない）。
  // /api/users-grouped は inactive を除外して集計するので、候補も active のみ。
  useEffect(() => {
    let active = true
    api.lineAccounts.list().then((res) => {
      if (!active || !mountedRef.current) return
      if (res.success) {
        setAccountOptions(
          res.data
            .filter((a) => a.isActive)
            .map((a) => ({ id: a.id, name: a.name }))
            .sort((x, y) => x.name.localeCompare(y.name)),
        )
      }
    }).catch(() => {
      // アカウント候補の取得失敗でも、統合ユーザー一覧の表示は続ける。
    })
    return () => {
      active = false
    }
  }, [])

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError('')
    const force = pendingForceRefresh
    if (force) setRefreshing(true)
    try {
      const res = await api.usersGrouped.list({
        q: debouncedQ || undefined,
        onlyDups: onlyDups || undefined,
        account: account || undefined,
        // FRIEND-09: UID絞り込みはサーバーへ渡し、全件へ適用する。
        uid: uid === 'linked' || uid === 'unlinked' ? uid : undefined,
        page,
        pageSize: USERS_PAGE_SIZE,
        forceRefresh: force || undefined,
      })
      if (seq !== requestSeqRef.current) return // stale 応答は無視
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
      if (seq !== requestSeqRef.current) return
      setRows([])
      setTotal(0)
      setError('取得に失敗しました。もう一度読み込んでください。')
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false)
        if (force) {
          setRefreshing(false)
          setPendingForceRefresh(false)
        }
      }
    }
  }, [debouncedQ, onlyDups, account, uid, page, pendingForceRefresh])

  useEffect(() => {
    load()
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
  const exportCsv = async () => {
    if (exporting || exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    setExportError('')
    try {
      const filters = {
        q: debouncedQ || undefined,
        onlyDups: onlyDups || undefined,
        account: account || undefined,
        uid: uid === 'linked' || uid === 'unlinked' ? uid : undefined,
      } as const
      const all: UserRowData[] = []
      /*
       * WEB323：画面の件数（total）は読めていないと 0 のまま。それを信じて
       * 1件も読まずに見出しだけの CSV を出さない。件数は書き出し側で必ず
       * 1ページ目から読み直し、最後まで集まったかを確かめる。
       */
      let exportTotal: number | null = null
      let complete = false
      // 上限は途中で件数が増えても無限に追い続けないための安全弁。
      for (let p = 1; p <= USERS_CSV_MAX_PAGES; p += 1) {
        if (!mountedRef.current) return
        const res = await api.usersGrouped.list({ ...filters, page: p, pageSize: 200 })
        if (!mountedRef.current) return
        if (!res.success) throw new Error('fetch failed')
        all.push(...res.data.rows)
        exportTotal = res.data.total
        if (res.data.rows.length === 0 || all.length >= exportTotal) {
          complete = true
          break
        }
      }
      if (!mountedRef.current) return
      if (!complete) {
        setExportError(`人数が多すぎるため、CSVに書き出せませんでした（${formatNumber(all.length)}人より先があります）。条件で絞ってからやり直してください。`)
        return
      }
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
      if (mountedRef.current) setExportError('CSVを書き出せませんでした。時間をおいてやり直してください。')
    } finally {
      exportingRef.current = false
      if (mountedRef.current) setExporting(false)
    }
  }

  return {
    rows,
    total,
    page,
    setPage,
    q,
    setQ,
    onlyDups,
    setOnlyDups,
    account,
    setAccount,
    uid,
    setUid,
    loading,
    error,
    accountOptions,
    refreshing,
    setPendingForceRefresh,
    load,
    exporting,
    exportError,
    exportCsv,
  }
}

export type MergedUsersData = ReturnType<typeof useMergedUsers>
