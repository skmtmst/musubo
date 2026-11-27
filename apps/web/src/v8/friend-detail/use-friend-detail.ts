'use client'

/*
 * 友だち詳細のデータの読み書き。今の画面（app/friends/detail/page.tsx）と
 * 同じ口・同じ順番・同じ失敗の扱いを写した（src/v8 からは @/app を読めない）。
 *
 * - 本体・情報欄・分類・マイル・リッチメニュー・次の予定は別々に読む（NEXT-11）
 * - 履歴は概要・履歴タブ、回答は回答フォームタブを開いたときだけ読む（PERF-13）
 * - 友だち・アカウントを切り替えたあとに届いた遅い返事は捨てる（#496-20・#964）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse, FriendField, Folder } from '@line-crm/shared'
import {
  api,
  ApiError,
  fetchApi,
  type FriendDetail,
  type FriendFormSubmission,
  type FriendUpcoming,
  type MileageConnectedAccount,
  type MileageSelfInsights,
  type MileageSummary,
} from '@/lib/api'
import { timelineKey, type FriendTimelineItem } from './timeline'

/** 補助パネルそれぞれの読み込み状態。0件と取り損ねを分けるために持つ。 */
export type PanelStatus = 'idle' | 'loading' | 'ready' | 'error'

/** M012：403 は権限不足（押しても直らないので再試行口を出さない）。 */
export function loadFailureKind(error: unknown): 'forbidden' | 'error' {
  if (error instanceof ApiError && error.status === 403) return 'forbidden'
  return 'error'
}

export function useFriendDetail(friendId: string, selectedAccountId: string | null, tab: string) {
  const [friend, setFriend] = useState<FriendDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [friendMissing, setFriendMissing] = useState(false)
  const [loadForbidden, setLoadForbidden] = useState(false)

  const [upcoming, setUpcoming] = useState<FriendUpcoming | null>(null)
  const [upcomingStatus, setUpcomingStatus] = useState<PanelStatus>('idle')

  const [fields, setFields] = useState<FriendField[]>([])
  const [hiddenPersonalCount, setHiddenPersonalCount] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [fieldsStatus, setFieldsStatus] = useState<PanelStatus>('idle')
  const [fieldFolders, setFieldFolders] = useState<Folder[]>([])
  const [fieldFoldersStatus, setFieldFoldersStatus] = useState<PanelStatus>('idle')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  /** FRIEND-25: 保存に送った版。応答待ちの間の追記を、保存後の再取得で上書きしない。 */
  const saveSnapshotRef = useRef<Record<string, string> | null>(null)

  const [mileage, setMileage] = useState<MileageSummary | null>(null)
  const [mileageInsights, setMileageInsights] = useState<MileageSelfInsights | null>(null)
  const [mileageConnections, setMileageConnections] = useState<MileageConnectedAccount[]>([])
  const [mileageStatus, setMileageStatus] = useState<PanelStatus>('idle')
  const [richMenu, setRichMenu] = useState<{ name: string | null; isDefault: boolean } | null>(null)
  const [richMenuStatus, setRichMenuStatus] = useState<PanelStatus>('idle')

  const [historyItems, setHistoryItems] = useState<FriendTimelineItem[]>([])
  const [historyStatus, setHistoryStatus] = useState<PanelStatus>('idle')
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyMoreError, setHistoryMoreError] = useState(false)

  const [submissions, setSubmissions] = useState<FriendFormSubmission[]>([])
  const [submissionsStatus, setSubmissionsStatus] = useState<PanelStatus>('idle')
  const [submissionsTotal, setSubmissionsTotal] = useState<number | null>(null)
  const [submissionsNextCursor, setSubmissionsNextCursor] = useState<string | null>(null)
  const [submissionsLoadingMore, setSubmissionsLoadingMore] = useState(false)
  const [submissionsMoreError, setSubmissionsMoreError] = useState(false)

  // 読込・保存の関数も作成時の対象と世代へ固定する。
  // A→B→A でも、最初の A の完了は新しい A に採用しない。
  const scopeRef = useRef({ friendId, selectedAccountId, generation: 0 })
  if (scopeRef.current.friendId !== friendId || scopeRef.current.selectedAccountId !== selectedAccountId) {
    scopeRef.current = { friendId, selectedAccountId, generation: scopeRef.current.generation + 1 }
  }
  const generation = scopeRef.current.generation
  const [renderedScope, setRenderedScope] = useState(scopeRef.current)
  const savingRef = useRef(false)
  const fieldsReqRef = useRef(0)
  const foldersReqRef = useRef(0)
  const mileageReqRef = useRef(0)
  const richMenuReqRef = useRef(0)
  const upcomingReqRef = useRef(0)
  const historyReqRef = useRef(0)
  const submissionsReqRef = useRef(0)
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId

  /** 世代とアカウントの両方が今の画面と合うときだけ応答を採用する。 */
  const isStale = useCallback(
    (generation: number, requestedAccountId: string | null) =>
      generation !== scopeRef.current.generation || requestedAccountId !== accountRef.current,
    [],
  )

  const loadFriend = useCallback(async () => {
    if (!friendId) {
      setLoading(false)
      return
    }
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    setLoading(true)
    setError('')
    setFriendMissing(false)
    setLoadForbidden(false)
    try {
      // PERF-13: 回答本文は初期応答に載せない。総数だけ返る。
      const res = await api.friends.get(friendId, { includeSubmissions: false })
      if (isStale(generation, requestedAccountId)) return
      if (res.success) setFriend(res.data)
      else setError(res.error)
    } catch (err) {
      if (isStale(generation, requestedAccountId)) return
      setFriend(null)
      if (err instanceof ApiError && err.status === 404) {
        setFriendMissing(true)
      } else if (loadFailureKind(err) === 'forbidden') {
        setLoadForbidden(true)
      } else {
        setError('読み込みに失敗しました。もう一度読み込んでください。')
      }
    } finally {
      if (!isStale(generation, requestedAccountId)) setLoading(false)
    }
  }, [friendId, selectedAccountId, generation, isStale])

  const loadUpcoming = useCallback(async () => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++upcomingReqRef.current
    setUpcomingStatus('loading')
    try {
      const res = await api.friends.upcoming(friendId)
      if (req !== upcomingReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        setUpcoming(res.data)
        setUpcomingStatus('ready')
      } else {
        setUpcomingStatus('error')
      }
    } catch {
      if (req !== upcomingReqRef.current || isStale(generation, requestedAccountId)) return
      setUpcomingStatus('error')
    }
  }, [friendId, selectedAccountId, generation, isStale])

  const loadFields = useCallback(async () => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++fieldsReqRef.current
    setFieldsStatus('loading')
    try {
      const res = await api.friendFields.forFriend(friendId, { suppressFeatureDisabledEvent: true })
      if (req !== fieldsReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        setFields(res.data.items)
        setHiddenPersonalCount(res.data.hiddenPersonalCount)
        // FRIEND-25: 送った版から変わっていない欄だけ最新の値へ置き換える。
        const sent = saveSnapshotRef.current
        saveSnapshotRef.current = null
        setValues((prev) => {
          const next: Record<string, string> = {}
          for (const f of res.data.items) {
            const serverValue = f.value ?? ''
            next[f.id] = sent && prev[f.id] !== undefined && prev[f.id] !== sent[f.id] ? prev[f.id] : serverValue
          }
          return next
        })
        setFieldsStatus('ready')
      } else {
        setFieldsStatus('error')
      }
    } catch {
      if (req !== fieldsReqRef.current || isStale(generation, requestedAccountId)) return
      setFieldsStatus('error')
    }
  }, [friendId, selectedAccountId, generation, isStale])

  const loadFieldFolders = useCallback(async () => {
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++foldersReqRef.current
    setFieldFoldersStatus('loading')
    try {
      const res = await api.folders.list('friend_field')
      if (req !== foldersReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        setFieldFolders(res.data)
        setFieldFoldersStatus('ready')
      } else {
        setFieldFoldersStatus('error')
      }
    } catch {
      if (req !== foldersReqRef.current || isStale(generation, requestedAccountId)) return
      setFieldFoldersStatus('error')
    }
  }, [selectedAccountId, generation, isStale])

  const loadMileage = useCallback(async () => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++mileageReqRef.current
    setMileageStatus('loading')
    try {
      // accountId を渡すと、別アカウントの友だちでは 404（サーバ側でも照合）。
      const res = await api.friends.mileage(friendId, { limit: 1, accountId: requestedAccountId || undefined })
      if (req !== mileageReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        setMileage(res.data.summary)
        setMileageInsights(res.data.insights)
        setMileageConnections(res.data.connections)
        setMileageStatus('ready')
      } else {
        setMileageStatus('error')
      }
    } catch {
      if (req !== mileageReqRef.current || isStale(generation, requestedAccountId)) return
      setMileageStatus('error')
    }
  }, [friendId, selectedAccountId, generation, isStale])

  const loadRichMenu = useCallback(async () => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++richMenuReqRef.current
    setRichMenuStatus('loading')
    try {
      const res = await api.friends.richMenu(friendId)
      if (req !== richMenuReqRef.current || isStale(generation, requestedAccountId)) return
      // 失敗と「未設定」は出し分ける（#496-13）。
      if (res.success) {
        setRichMenu(res.data)
        setRichMenuStatus('ready')
      } else {
        setRichMenuStatus('error')
      }
    } catch {
      if (req !== richMenuReqRef.current || isStale(generation, requestedAccountId)) return
      setRichMenuStatus('error')
    }
  }, [friendId, selectedAccountId, generation, isStale])

  /** 履歴。cursor を渡すと続きを足す（「さらに読み込む」）。 */
  const loadHistory = useCallback(async (cursor?: string) => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++historyReqRef.current
    if (cursor) setHistoryLoadingMore(true)
    else setHistoryStatus('loading')
    setHistoryMoreError(false)
    try {
      const query = new URLSearchParams({ limit: cursor ? '50' : '8' })
      if (cursor) query.set('cursor', cursor)
      const res = await fetchApi<ApiResponse<{ items: FriendTimelineItem[]; nextCursor: string | null }>>(
        `/api/friends/${encodeURIComponent(friendId)}/timeline?${query}`,
        { suppressFeatureDisabledEvent: true },
      )
      if (req !== historyReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        if (!Array.isArray(res.data?.items) || res.data.items.some(item => !item || typeof item.id !== 'string' || typeof item.type !== 'string' || typeof item.occurredAt !== 'string' || typeof item.summary !== 'string')) throw new Error('invalid history')
        setHistoryItems((prev) => {
          if (!cursor) return res.data.items
          // IDEA-03「重複なし」: 同じ元の行は足さない。
          const seen = new Set(prev.map(timelineKey))
          return [...prev, ...res.data.items.filter((item) => !seen.has(timelineKey(item)))]
        })
        setHistoryNextCursor(res.data.nextCursor)
        setHistoryStatus('ready')
      } else if (cursor) {
        // FRIEND-26: 続きの取り損ねは末尾だけ。読めていた行とカーソルは残す。
        setHistoryMoreError(true)
      } else {
        setHistoryStatus('error')
      }
    } catch {
      if (req !== historyReqRef.current || isStale(generation, requestedAccountId)) return
      if (cursor) setHistoryMoreError(true)
      else setHistoryStatus('error')
    } finally {
      if (req === historyReqRef.current && !isStale(generation, requestedAccountId)) setHistoryLoadingMore(false)
    }
  }, [friendId, selectedAccountId, generation, isStale])

  /** 回答。cursor を渡すと続きを足す。 */
  const loadSubmissions = useCallback(async (cursor?: string) => {
    if (!friendId) return
    const requestedAccountId = selectedAccountId
    if (isStale(generation, requestedAccountId)) return
    const req = ++submissionsReqRef.current
    if (cursor) setSubmissionsLoadingMore(true)
    else setSubmissionsStatus('loading')
    setSubmissionsMoreError(false)
    try {
      const res = await api.friends.formSubmissions(friendId, { cursor: cursor ?? null, limit: 10 })
      if (req !== submissionsReqRef.current || isStale(generation, requestedAccountId)) return
      if (res.success) {
        setSubmissions((prev) => {
          if (!cursor) return res.data.items
          const seen = new Set(prev.map((item) => item.id))
          return [...prev, ...res.data.items.filter((item) => !seen.has(item.id))]
        })
        setSubmissionsTotal(res.data.total)
        setSubmissionsNextCursor(res.data.nextCursor)
        setSubmissionsStatus('ready')
      } else if (cursor) {
        setSubmissionsMoreError(true)
      } else {
        setSubmissionsStatus('error')
      }
    } catch {
      if (req !== submissionsReqRef.current || isStale(generation, requestedAccountId)) return
      if (cursor) setSubmissionsMoreError(true)
      else setSubmissionsStatus('error')
    } finally {
      if (req === submissionsReqRef.current && !isStale(generation, requestedAccountId)) setSubmissionsLoadingMore(false)
    }
  }, [friendId, selectedAccountId, generation, isStale])

  /** 情報欄の保存。変わった欄だけ送る（見ただけの欄に更新の記録を付けない）。 */
  const saveFields = useCallback(async () => {
    const requestedAccountId = selectedAccountId
    if (!friendId || savingRef.current || isStale(generation, requestedAccountId)) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    setSaveNotice('')
    setWarnings([])
    try {
      const changed: Record<string, string | null> = {}
      for (const f of fields) {
        const before = f.value ?? ''
        const after = values[f.id] ?? ''
        if (before !== after) changed[f.id] = after === '' ? null : after
      }
      if (Object.keys(changed).length === 0) {
        setSaveNotice('変更はありません')
        return
      }
      saveSnapshotRef.current = { ...values }
      const res = await api.friendFields.saveForFriend(friendId, changed)
      if (isStale(generation, requestedAccountId)) return
      if (!res.success) {
        saveSnapshotRef.current = null
        setSaveError(res.error)
        return
      }
      if (res.warnings?.length) setWarnings(res.warnings)
      setSaveNotice(`${res.data.updated} 件を保存しました`)
      void loadFields()
    } catch {
      if (isStale(generation, requestedAccountId)) return
      saveSnapshotRef.current = null
      setSaveError('保存に失敗しました。通信を確かめて、もう一度お試しください。')
    } finally {
      if (!isStale(generation, requestedAccountId)) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }, [fields, values, friendId, selectedAccountId, generation, isStale, loadFields])

  // 切替時は、次の描画を確定する前に旧データを捨てる。
  // effect だけで空にすると、最初の B の描画には A の情報と保存入力が残る。
  if (renderedScope !== scopeRef.current) {
    setRenderedScope(scopeRef.current)
    setFriendMissing(false)
    setLoadForbidden(false)
    setFriend(null)
    setError('')
    setLoading(!!friendId)
    setUpcoming(null)
    setUpcomingStatus('idle')
    setFields([])
    setHiddenPersonalCount(0)
    setValues({})
    setFieldsStatus('idle')
    saveSnapshotRef.current = null
    savingRef.current = false
    setSaving(false)
    setSaveError('')
    setSaveNotice('')
    setWarnings([])
    setFieldFolders([])
    setFieldFoldersStatus('idle')
    setMileage(null)
    setMileageInsights(null)
    setMileageConnections([])
    setMileageStatus('idle')
    setRichMenu(null)
    setRichMenuStatus('idle')
    setHistoryItems([])
    setHistoryStatus('idle')
    setHistoryNextCursor(null)
    setHistoryLoadingMore(false)
    setHistoryMoreError(false)
    setSubmissions([])
    setSubmissionsStatus('idle')
    setSubmissionsTotal(null)
    setSubmissionsNextCursor(null)
    setSubmissionsLoadingMore(false)
    setSubmissionsMoreError(false)
  }

  /** 本体と補助パネルを新しい対象で取り直す。 */
  useEffect(() => {
    void loadFriend()
    void loadUpcoming()
    void loadFields()
    void loadFieldFolders()
    void loadMileage()
    void loadRichMenu()
  }, [friendId, loadFriend, loadUpcoming, loadFields, loadFieldFolders, loadMileage, loadRichMenu])

  // 履歴は「概要」「履歴」タブを開いたときにだけ取る。
  useEffect(() => {
    if ((tab === 'timeline' || tab === 'history') && historyStatus === 'idle') void loadHistory()
  }, [tab, historyStatus, loadHistory])

  // 回答は「回答フォーム」タブを開いたときにだけ取る。
  useEffect(() => {
    if (tab === 'forms' && submissionsStatus === 'idle') void loadSubmissions()
  }, [tab, submissionsStatus, loadSubmissions])

  return {
    friend, loading, error, setError, friendMissing, loadForbidden, loadFriend,
    upcoming, upcomingStatus, loadUpcoming,
    fields, hiddenPersonalCount, values, setValues, fieldsStatus, loadFields,
    fieldFolders, fieldFoldersStatus,
    saving, saveError, saveNotice, warnings, saveFields,
    mileage, mileageInsights, mileageConnections, mileageStatus, loadMileage,
    richMenu, richMenuStatus, loadRichMenu,
    historyItems, historyStatus, historyNextCursor, historyLoadingMore, historyMoreError, loadHistory,
    submissions, submissionsStatus, submissionsTotal, submissionsNextCursor, submissionsLoadingMore, submissionsMoreError, loadSubmissions,
  }
}

export type FriendDetailState = ReturnType<typeof useFriendDetail>
