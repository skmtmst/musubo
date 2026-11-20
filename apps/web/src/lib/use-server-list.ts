'use client'

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useListSnapshot } from './use-list-snapshot'
import ListState from '@/components/shared/list-state'
import { LIST_REQUEST_TIMEOUT_MS } from '@/lib/request-timeout'
import { classifyApiFailure } from '@/components/shared/api-error-message'
import { readListUrlParam, writeListUrlParam } from '@/components/shared/list-url-state'

export type ServerListSort = ReadonlyArray<Readonly<{
  field: string
  direction: 'asc' | 'desc'
}>>

export type ServerListResponse<T> = Readonly<{
  items: T[]
  total?: number
  nextCursor?: string
  limit: number
  sort: ServerListSort
}>

type LoadState<T> = {
  items: T[]
  total: number
  nextCursor?: string
  limit: number
  sort: ServerListSort
  loaded: boolean
  loading: boolean
  error: Error | null
}

type StateViewInput = Readonly<{
  loaded: boolean
  loading: boolean
  itemCount: number
  error: Error | null
  retry: () => void
}>

const DEFAULT_LIMIT = 50

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('一覧を読み込めませんでした')
}

function initialState<T>(limit: number): LoadState<T> {
  return {
    items: [],
    total: 0,
    limit,
    sort: [],
    loaded: false,
    loading: true,
    error: null,
  }
}

/** 画面が独自の読み込み文言を作らず、共通 ListState をそのまま置けるようにする。 */
export function serverListStateView({
  loaded,
  loading,
  itemCount,
  error,
  retry,
}: StateViewInput): ReactElement | null {
  if (loading && !loaded && itemCount === 0) return createElement(ListState, { kind: 'loading' })
  // m23m: 捕まえた失敗をそのまま渡す。403 は権限の案内・再試行なし、
  // 429 は待ち案内になる（ListState の `error` が言い分ける）。
  if (error) return createElement(ListState, { kind: 'error', error, onRetry: retry })
  if (loaded && itemCount === 0) return createElement(ListState, { kind: 'empty' })
  return null
}

export function serverListPageCount(total: number, limit: number): number {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
  return Math.max(1, Math.ceil(safeTotal / safeLimit))
}

export function useOffsetServerList<T>({
  requestKey,
  load,
  initialLimit = DEFAULT_LIMIT,
  requestTimeoutMs = LIST_REQUEST_TIMEOUT_MS,
  pageUrlKey,
}: {
  /** 絞り込み・アカウント等を直列化したキー。変わると1ページ目へ戻る。 */
  requestKey: string
  load: (request: { page: number; limit: number }, signal: AbortSignal) => Promise<ServerListResponse<T>>
  initialLimit?: number
  /**
   * ページを URL に置く鍵（例 `'page'`。動きの点検 5 番）。渡すと、戻る・
   * 再読み込みで同じページに戻る。渡さなければ今までどおり内側だけで持つ。
   */
  pageUrlKey?: string
  /*
   * #625: 応答しない要求をこの時間で打ち切り、失敗表示＋再試行へ落とす。
   * 検索語の異常な長さや経路の沈黙で「読み込んでいます」が消えない事故を防ぐ。
   */
  requestTimeoutMs?: number
}) {
  const [navigation, setNavigation] = useState({ requestKey, page: 1 })
  const [retryVersion, setRetryVersion] = useState(0)
  const refreshWaiters = useRef<Array<(success: boolean) => void>>([])
  useEffect(() => () => { for (const finish of refreshWaiters.current.splice(0)) finish(false) }, [])
  const page = navigation.requestKey === requestKey ? navigation.page : 1
  const { value: state, setValue: setState } = useListSnapshot<LoadState<T>>(JSON.stringify([requestKey, page, initialLimit]), initialState(initialLimit))
  /*
   * URL のページは最初に描けた一覧にだけ使う。読み込んだ直後は絞り込みの値も
   * URL から入ってきて requestKey が一度変わるので、その切り替えでは
   * 1 ページ目へ戻さず URL のページを使う。一覧が出た後の切り替えは今までどおり 1 へ。
   */
  const urlPageRef = useRef<number | null>(null)
  useEffect(() => {
    if (!pageUrlKey) return
    const fromUrl = Number(readListUrlParam(pageUrlKey, '1'))
    if (!Number.isSafeInteger(fromUrl) || fromUrl <= 1) return
    urlPageRef.current = fromUrl
    setNavigation((current) => ({ ...current, page: fromUrl }))
  }, [pageUrlKey])

  useEffect(() => {
    if (navigation.requestKey !== requestKey) {
      const keep = urlPageRef.current
      setNavigation({ requestKey, page: keep ?? 1 })
      if (pageUrlKey && keep === null) writeListUrlParam(pageUrlKey, '')
      /*
       * 条件の切り替えでは、スナップショットの鍵で旧行と旧件数を隠す。
       * 同じ条件の再取得だけ、いまの行と件数を残して読み直す。
       */
      setState((current) => ({ ...current, loading: true, error: null }))
      return
    }

    const controller = new AbortController()
    const waiters = refreshWaiters.current.splice(0)
    const finishRefresh = (success: boolean) => {
      if (!success) { refreshWaiters.current.push(...waiters.splice(0)); return }
      for (const finish of waiters.splice(0)) finish(true)
    }
    /*
     * 同じ条件で行が出ているときは残し、画面側へ `refreshing` を渡す。
     * 未取得の条件では ListState の読み込み表示を出す。
     */
    setState((current) => ({ ...current, loading: true, error: null }))
    /*
     * #625: 応答なしで「読み込んでいます」が残り続けないよう、時間切れで
     * 失敗状態へ落とす。abort で通信も止める。時間切れ後に遅れて成功しても
     * aborted 判定で捨てるので、失敗表示のまま再試行へ進める。
     * 前の行を残した読み直しでも時間切れは失敗表示へ落とす（残った行の
     * まま「読み込み中」のままにしない）。失敗の案内と再試行を出す。取得済みの行は残す。
     */
    const timeout = setTimeout(() => {
      controller.abort()
      finishRefresh(false)
      setState((current) => (current.loading
        ? { ...current, loading: false, error: new Error('一覧の読み込みが時間切れになりました') }
        : current))
    }, requestTimeoutMs)
    void load({ page, limit: initialLimit }, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        urlPageRef.current = null
        setState({
          items: response.items,
          total: response.total ?? 0,
          nextCursor: undefined,
          limit: response.limit,
          sort: response.sort,
          loaded: true,
          loading: false,
          error: null,
        })
        finishRefresh(true)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        finishRefresh(false)
        // 通信の失敗では前の行を残す。権限を失ったときだけ隠す。
        setState((current) => ({ ...current, ...(classifyApiFailure(error) === 'forbidden' ? { items: [], loaded: false } : {}), loading: false, error: asError(error) }))
      },
    ).finally(() => clearTimeout(timeout))
    return () => {
      clearTimeout(timeout)
      controller.abort()
      finishRefresh(false)
    }
  }, [initialLimit, load, navigation.requestKey, page, requestKey, requestTimeoutMs, retryVersion, setState])

  const setPage = useCallback((nextPage: number) => {
    const safePage = Number.isSafeInteger(nextPage) && nextPage > 0 ? nextPage : 1
    urlPageRef.current = null
    setNavigation((current) => ({ ...current, page: safePage }))
    if (pageUrlKey) writeListUrlParam(pageUrlKey, safePage > 1 ? String(safePage) : '')
  }, [pageUrlKey])
  const retry = useCallback(() => setRetryVersion((version) => version + 1), [])
  const retryAndWait = useCallback(() => new Promise<boolean>((resolve) => {
    refreshWaiters.current.push(resolve)
    setRetryVersion((version) => version + 1)
  }), [])
  const pageCount = serverListPageCount(state.total, state.limit)

  return {
    ...state,
    page,
    pageCount,
    setPage,
    retry,
    retryAndWait,
    /*
     * 同じ条件の行を残した読み直し中。画面側の RefreshCover へ渡す。
     */
    refreshing: state.loading && state.loaded,
    stateView: serverListStateView({
      loaded: state.loaded,
      loading: state.loading,
      itemCount: state.items.length,
      error: state.error,
      retry,
    }),
  }
}

export function useCursorServerList<T>({
  requestKey,
  load,
  initialLimit = DEFAULT_LIMIT,
}: {
  /** 絞り込み・アカウント等を直列化したキー。変わると先頭から読み直す。 */
  requestKey: string
  load: (request: { cursor?: string; limit: number }, signal: AbortSignal) => Promise<ServerListResponse<T>>
  initialLimit?: number
}) {
  const [activeKey, setActiveKey] = useState(requestKey)
  const { value: state, setValue: setState } = useListSnapshot<LoadState<T>>(requestKey, initialState(initialLimit))
  const [retryVersion, setRetryVersion] = useState(0)
  const requestId = useRef(0)
  const activeController = useRef<AbortController | null>(null)
  const lastFailedCursor = useRef<string | undefined>(undefined)

  const request = useCallback(async (cursor: string | undefined, replace: boolean) => {
    activeController.current?.abort()
    const id = requestId.current + 1
    requestId.current = id
    const controller = new AbortController()
    activeController.current = controller
    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }))
    try {
      const response = await load({ cursor, limit: initialLimit }, controller.signal)
      if (requestId.current !== id) return
      lastFailedCursor.current = undefined
      setState((current) => ({
        items: replace ? response.items : [...current.items, ...response.items],
        total: response.total ?? 0,
        nextCursor: response.nextCursor,
        limit: response.limit,
        sort: response.sort,
        loaded: true,
        loading: false,
        error: null,
      }))
    } catch (error) {
      if (controller.signal.aborted || requestId.current !== id) return
      lastFailedCursor.current = cursor
      setState((current) => ({ ...current, ...(classifyApiFailure(error) === 'forbidden' ? { items: [], loaded: false } : { loaded: current.items.length > 0 }), loading: false, error: asError(error) }))
    } finally {
      if (activeController.current === controller) activeController.current = null
    }
  }, [initialLimit, load, setState])

  useEffect(() => () => activeController.current?.abort(), [])

  useEffect(() => {
    if (activeKey !== requestKey) {
      requestId.current += 1
      activeController.current?.abort()
      setActiveKey(requestKey)
      lastFailedCursor.current = undefined
      setState((current) => ({ ...current, loading: true, error: null }))
      return
    }
    void request(undefined, true)
  }, [activeKey, initialLimit, request, requestKey, retryVersion])

  const loadNext = useCallback(() => {
    if (state.loading || !state.nextCursor) return
    void request(state.nextCursor, false)
  }, [request, state.loading, state.nextCursor])
  const retry = useCallback(() => {
    if (lastFailedCursor.current) {
      void request(lastFailedCursor.current, false)
      return
    }
    setRetryVersion((version) => version + 1)
  }, [request])

  return {
    ...state,
    refreshing: state.loading && state.loaded,
    hasNext: Boolean(state.nextCursor),
    loadNext,
    retry,
    stateView: serverListStateView({
      loaded: state.loaded,
      loading: state.loading,
      itemCount: state.items.length,
      error: state.error,
      retry,
    }),
  }
}
