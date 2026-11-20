'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

/*
 * 一覧の絞り込み・検索語・並び順・ページを URL に置く口（動きの点検 5 番）。
 *
 * 以前は各一覧が useState だけで持っていたので、詳細へ行って「戻る」と
 * フォルダの絞り込みも検索語も消えていた。URL に置けば、戻る・再読み込み・
 * リンクの共有でも同じ一覧に戻れる。
 *
 * 使い方（画面側は useState をこれに替えるだけ）：
 *   const [view, setView] = useListUrlState({ folder: '', q: '', page: '1' })
 *   setView({ folder: 'abc', page: '1' })
 *
 * - 値は文字列だけ。既定値と同じ値は URL から消す（何もしていない一覧は ?なし）。
 * - URL は置き換え（replaceState）で直す。絞るたびに「戻る」の段が増えない。
 * - 知らない鍵（?id= など）は残す。
 * - 静的書き出しの最初の描画（サーバー側）は既定値。読み込んだ直後に URL の値へ替わる。
 *   useSearchParams を使わないので、画面を Suspense で包む必要はない。
 */

const LOCAL_EVENT = 'lh:list-url-state'

function subscribe(onChange: () => void): () => void {
  if (typeof window.addEventListener !== 'function') return () => {}
  window.addEventListener('popstate', onChange)
  window.addEventListener(LOCAL_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(LOCAL_EVENT, onChange)
  }
}

/*
 * 押した瞬間は手元の値（pending）を先に描き、URL への書き込みは描いた後へ回す。
 * Next.js の router は replaceState を受けると画面の木を描き直すので、押した処理の中で
 * 書くと、絞り込みの見た目が変わるまでが 50ms から 90ms へ延びていた（動きの点検で計測）。
 */
let pending: { pathname: string; search: string } | null = null
let scheduled = false

export function currentListLocation(): { pathname: string; search: string; hash: string } {
  if (typeof window === 'undefined' || !window.location) return { pathname: '', search: '', hash: '' }
  const { pathname, hash } = window.location
  const search = pending && pending.pathname === pathname ? pending.search : window.location.search
  return { pathname, search, hash }
}

const readSearch = () => currentListLocation().search

function flushPending(): void {
  scheduled = false
  const next = pending
  pending = null
  if (!next || next.pathname !== window.location.pathname) return
  if (next.search === window.location.search) return
  // Next.js（14.1 以降）は history.replaceState を受け取って router と同期する。
  window.history.replaceState(null, '', `${next.pathname}${next.search}${window.location.hash}`)
}

function commitUrl(url: string): void {
  const parsed = new URL(url, window.location.origin)
  pending = { pathname: parsed.pathname, search: parsed.search }
  window.dispatchEvent(new Event(LOCAL_EVENT))
  if (scheduled) return
  scheduled = true
  // 描いた後（次のコマの後）に書く。rAF が無い環境ではすぐ後。
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(flushPending, 0))
  else setTimeout(flushPending, 0)
}

/** 書きかけの URL をすぐ書く（離れる直前・試験用）。 */
export function flushListUrlState(): void {
  flushPending()
}

/**
 * 書きかけの URL を捨てる（試験用）。
 * 画面では popstate が pending を消すが、試験の replaceState は popstate を発火しない。
 * 先送り（rAF→setTimeout）が試験の境界までに流れ終わらないと、
 * 絞り込みが次の試験へ持ち越される。試験ごとの初期化で呼ぶ。
 */
export function resetListUrlState(): void {
  pending = null
  scheduled = false
}

if (typeof window !== 'undefined') {
  // 別の画面へ移る・戻るときは、書きかけを先に書いてから。
  window.addEventListener('popstate', () => { pending = null })
  window.addEventListener('pagehide', flushListUrlState)
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest?.('a[href]')) flushListUrlState()
  }, true)
}
const readServerSearch = () => ''

export function parseListUrlState<T extends Record<string, string>>(search: string, defaults: T): T {
  const params = new URLSearchParams(search)
  const out = { ...defaults }
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = params.get(key)
    if (value !== null) out[key] = value as T[typeof key]
  }
  return out
}

/** 今の URL に patch を重ねた次の URL（既定値と同じ鍵は消す）。 */
export function nextListUrl<T extends Record<string, string>>(
  location: { pathname: string; search: string; hash: string },
  defaults: T,
  patch: Partial<T>,
): string {
  const params = new URLSearchParams(location.search)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === '' || value === defaults[key]) params.delete(key)
    else params.set(key, value)
  }
  const isPagination = (key: string) => /(?:page|cursors?|offset)$/i.test(key)
  const changedFilter = Object.entries(patch).some(([key, value]) => !isPagination(key) && !['highlight', 'id'].includes(key) && value !== undefined && value !== (new URLSearchParams(location.search).get(key) ?? defaults[key] ?? ''))
  if (changedFilter && patch.page === undefined) params.delete('page')
  if (changedFilter && patch.cursor === undefined) params.delete('cursor')
  if (changedFilter && patch.offset === undefined) params.delete('offset')
  if (changedFilter && !Object.keys(patch).every(key => key === 'tab')) for (const key of Array.from(params.keys())) {
    if (isPagination(key) && patch[key] === undefined) params.delete(key)
  }
  const query = params.toString()
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`
}

export function useListUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const search = useSyncExternalStore(subscribe, readSearch, readServerSearch)
  // 呼ぶ側が毎回 {…} を書いても同じ値として扱う。
  const defaultsKey = JSON.stringify(defaults)
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => parseListUrlState(search, defaultsRef.current), [search, defaultsKey])
  const set = useCallback((patch: Partial<T>) => {
    const location = currentListLocation()
    const url = nextListUrl(location, defaultsRef.current, patch)
    if (url === `${location.pathname}${location.search}${location.hash}`) return
    commitUrl(url)
  }, [])
  return [state, set]
}

/**
 * 1 つの鍵だけを URL に置く（useState('') の置き換え）。
 * 既存の画面は `const [q, setQ] = useState('')` を
 * `const [q, setQ] = useListUrlParam('q')` に替えるだけでよい。
 */
export function useListUrlParam(key: string, fallback = ''): [string, (next: string) => void] {
  const search = useSyncExternalStore(subscribe, readSearch, readServerSearch)
  const value = useMemo(() => new URLSearchParams(search).get(key) ?? fallback, [fallback, key, search])
  const set = useCallback((next: string) => writeListUrlParam(key, next === fallback ? '' : next), [fallback, key])
  return [value, set]
}

/** 入/切の絞り込み（「停止中だけ」など）。入のときだけ `?鍵=1` を置く。 */
export function useListUrlFlag(key: string): [boolean, (next: boolean) => void] {
  const [raw, setRaw] = useListUrlParam(key)
  const set = useCallback((next: boolean) => setRaw(next ? '1' : ''), [setRaw])
  return [raw === '1', set]
}

/** 1 つの鍵をその場で URL に書く（空なら消す）。フックの外（ページ送りなど）から使う。 */
export function writeListUrlParam(key: string, value: string): void {
  if (typeof window === 'undefined') return
  const location = currentListLocation()
  const url = nextListUrl(location, { [key]: '' }, { [key]: value })
  if (url === `${location.pathname}${location.search}${location.hash}`) return
  commitUrl(url)
}

/**
 * 今の URL の値をその場で読む（描画に出さない初期値用：検索の送り遅れの元など）。
 * サーバー側では既定値。
 */
export function readListUrlParam(key: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback
  return new URLSearchParams(currentListLocation().search).get(key) ?? fallback
}

/* ── スクロール位置を戻す ─────────────────────────────── */

let lastPopstateAt = -Infinity
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    lastPopstateAt = performance.now()
  })
}

/** 戻る・進む・再読み込みで来たときだけ位置を戻す（左メニューから来たら先頭）。 */
function cameBackOrReloaded(): boolean {
  if (performance.now() - lastPopstateAt < 3000) return true
  const entry = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined
  return entry?.type === 'reload' || entry?.type === 'back_forward'
}

function scrollerOf(start: HTMLElement | null): HTMLElement {
  /*
   * 目印が無いときは本文の入れ物から探す。V8 の PC 幅は外枠が画面の高さで止まり、
   * 送るのは白い板（#main-content）の中なので、ページ全体（document）を見ても位置は 0 のまま。
   */
  let element = start?.parentElement ?? (typeof document !== 'undefined' ? document.getElementById('main-content') : null)
  while (element) {
    const style = getComputedStyle(element)
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) return element
    element = element.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

const scrollKey = (path: string) => `lh:list-scroll:${path}`

/**
 * 一覧のスクロール位置を、そのタブの間だけ覚えて戻す。
 * `ready` は中身が描けたか（読み込み中は戻さない。高さが足りず先頭に張り付く）。
 * `anchorRef` は一覧の中の要素。そこから実際に動く入れ物を探す。
 */
export function useListScrollMemory(ready: boolean, anchorRef?: RefObject<HTMLElement | null>): void {
  const restoredRef = useRef(false)
  const restoringRef = useRef(false)
  const shouldRestoreRef = useRef<boolean | null>(null)
  /* 覚えていた位置は来た瞬間に読む。読み込み中に途中の位置で上書きされる前に。 */
  const savedRef = useRef(0)
  if (shouldRestoreRef.current === null && typeof window !== 'undefined') {
    shouldRestoreRef.current = cameBackOrReloaded()
    try {
      savedRef.current = Number(window.sessionStorage.getItem(scrollKey(window.location.pathname))) || 0
    } catch {
      savedRef.current = 0
    }
  }

  useEffect(() => {
    if (!ready || restoredRef.current) return
    restoredRef.current = true
    if (!shouldRestoreRef.current) return
    const saved = savedRef.current
    if (saved <= 0) return
    /*
     * 数の帯など後から出る部分で高さが伸びきるまで、届くまで数コマ当て直す
     * （最長 1.5 秒）。利用者が自分で動かしたらやめる。
     */
    restoringRef.current = true
    const started = performance.now()
    let frame = 0
    const stop = () => {
      restoringRef.current = false
      cancelAnimationFrame(frame)
      window.removeEventListener('wheel', byUser)
      window.removeEventListener('touchstart', byUser)
      window.removeEventListener('keydown', byUser)
    }
    const apply = () => {
      const scroller = scrollerOf(anchorRef?.current ?? null)
      scroller.scrollTop = saved
      if (Math.abs(scroller.scrollTop - saved) <= 1 || performance.now() - started > 1500) {
        finished = true
        stop()
        return
      }
      frame = requestAnimationFrame(apply)
    }
    const byUser = () => {
      finished = true
      stop()
    }
    let finished = false
    window.addEventListener('wheel', byUser, { passive: true })
    window.addEventListener('touchstart', byUser, { passive: true })
    window.addEventListener('keydown', byUser)
    frame = requestAnimationFrame(apply)
    return () => {
      stop()
      // 途中で外された（開発時の二重実行など）ときは、次の実行でもう一度戻す。
      if (!finished) restoredRef.current = false
    }
  }, [anchorRef, ready])

  useEffect(() => {
    const path = window.location.pathname
    let frame = 0
    let pendingTop: number | undefined
    const save = () => {
      frame = 0
      // 中身が出て位置を戻し終えるまでは覚えない（伸びきる前の途中の値で上書きしない）。
      if (!restoredRef.current || restoringRef.current) return
      try {
        window.sessionStorage.setItem(scrollKey(path), String(Math.round(pendingTop ?? scrollerOf(anchorRef?.current ?? null).scrollTop)))
      } catch {
        // 覚えられないだけで一覧は動く。
      }
    }
    const onScroll = () => {
      if (restoredRef.current && !restoringRef.current) pendingTop = scrollerOf(anchorRef?.current ?? null).scrollTop
      if (!frame) frame = requestAnimationFrame(save)
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      if (frame) { cancelAnimationFrame(frame); save() }
    }
  }, [anchorRef])
}

/**
 * LINE アカウントを切り替えたときだけ動かす（絞り込みを外す・ページを1へ戻すなど）。
 *
 * `useEffect( => setPage(1), [accountId, …])` のように書くと、来た瞬間（読み込み中の
 * null → いまのアカウント）にも動いて、URL から戻した絞り込み・ページを消してしまう。
 * 前に見ていたアカウントが在って、それと違うアカウントに替わったときだけ呼ぶ。
 */
export function useOnAccountSwitch(accountId: string | null | undefined, onSwitch: () => void): void {
  const previousRef = useRef<string | null | undefined>(undefined)
  const onSwitchRef = useRef(onSwitch)
  onSwitchRef.current = onSwitch
  useEffect(() => {
    const previous = previousRef.current
    if (accountId) previousRef.current = accountId
    if (previous && accountId && previous !== accountId) onSwitchRef.current()
  }, [accountId])
}

/** 一覧の文字・数・入切を URL に保存する。useState と同じ更新関数を受け取る。 */
export function useListUrlValue<T>(key: string, initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
  const [fallback] = useState(initial)
  const zeroBasedPage = key === 'page' && fallback === 0
  const encode = (value: T) => value === null ? '' : String(zeroBasedPage ? Number(value) + 1 : value)
  const decode = (raw: string): T => {
    if (typeof fallback === 'number') return (Number.isFinite(Number(raw)) && raw !== '' ? Math.max(key === 'page' ? (zeroBasedPage ? 0 : 1) : -Infinity, Number(raw) - (zeroBasedPage ? 1 : 0)) : fallback) as T
    if (typeof fallback === 'boolean') return (raw === 'true') as T
    return (raw === '' && fallback === null ? null : raw) as T
  }
  const [raw, setRaw] = useListUrlParam(key, encode(fallback))
  const value = decode(raw)
  const setValue = useCallback((next: T | ((current: T) => T)) => setRaw(encode(typeof next === 'function' ? (next as (current: T) => T)(decode(readListUrlParam(key, encode(fallback)))) : next)), [key, fallback, setRaw])
  return [value, setValue]
}

/** 複数の条件・選択した条件の組をURLへ残す。壊れた値は初期値で開く。 */
export function useListUrlJsonValue<T>(key: string, initial: T, validate?: (value: unknown) => value is T): [T, (next: T | ((current: T) => T)) => void] {
  const [fallback] = useState(initial)
  const decode = useCallback((raw: string): T => {
    try {
      const value: unknown = JSON.parse(raw)
      if (validate) return validate(value) ? value : fallback
      if (Array.isArray(fallback)) return (Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback) as T
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
      const valid = Object.entries(fallback as object).every(([field, expected]) => expected === null || expected === undefined || (Array.isArray(expected) ? Array.isArray((value as Record<string, unknown>)[field]) : typeof (value as Record<string, unknown>)[field] === typeof expected))
      return valid ? value as T : fallback
    } catch { return fallback }
  }, [fallback, validate])
  const initialRaw = JSON.stringify(fallback)
  const [raw, setRaw] = useListUrlParam(key, initialRaw)
  const setValue = useCallback((next: T | ((current: T) => T)) => {
    const previous = decode(readListUrlParam(key, initialRaw))
    setRaw(JSON.stringify(typeof next === 'function' ? (next as (current: T) => T)(previous) : next))
  }, [decode, initialRaw, key, setRaw])
  const value = useMemo(() => decode(raw), [decode, raw])
  return [value, setValue]
}

/** 種類など複数選択の絞り込み。関数による変更もURLの最新の組に重ねる。 */
export function useListUrlSetValue<T extends string>(key: string, initial: T[]): [Set<T>, (next: Set<T> | ((current: Set<T>) => Set<T>)) => void] {
  const [values, setValues] = useListUrlJsonValue<T[]>(key, initial)
  const set = useCallback((next: Set<T> | ((current: Set<T>) => Set<T>)) => {
    setValues(previous => Array.from(typeof next === 'function' ? next(new Set(previous)) : next))
  }, [setValues])
  const value = useMemo(() => new Set(values), [values])
  return [value, set]
}

/** 一覧の書きかけも含めた現在地。戻り先のリンクを描く共通口。 */
const readLocation = () => { if (typeof window === 'undefined' || !window.location) return ''; const loc = currentListLocation(); return `${loc.pathname}${loc.search}${loc.hash}` }
export function useListLocation(): string {
  return useSyncExternalStore(subscribe, readLocation, () => '')
}
/** パネルなど、同じURLを更新する部品も一覧の購読者へ知らせる。 */
export function notifyListLocation(): void {
  window.dispatchEvent(new Event(LOCAL_EVENT))
}
