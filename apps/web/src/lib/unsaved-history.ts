import { useEffect } from 'react'
import { canonicalNavigationHref } from './canonical-route'
import { historyGuards, type HistoryGuard, type HistoryPlace } from './unsaved-guard-registry'

/*
 * 戻る・進むの受け止め（全部の番兵で1つ）。
 *
 * Next のルーターは window の popstate を受けると、その場で前の画面を描き切る。後から止めても、確認を出す前に
 * 入力ごと画面が消える。そこで受け口を管理画面のいちばん外側（UnsavedHistoryRoot）から Next より先に付け、
 * 止めるときは Next や画面の popstate へ届けずに元の位置へ戻してから確認を出す。Chromium は window 宛ての
 * 受け口を付けた順に呼ぶので、先に付けることが要る。捕捉段（capture）でも付け、捕捉段を先に呼ぶブラウザでも先に受ける。
 *
 * 位置は、Navigation API があれば履歴の項目の鍵で、無いブラウザでは Next の履歴の状態に書いた並びの番号で指す
 * （戻る・進む・飛び越し・連打でも行き過ぎない）。どちらも分からない位置は、戻るとみなして1つ進めて戻す。
 * 別の文書（別のオリジンを含む）への戻る・進むは popstate にならず、beforeunload のブラウザの確認が守る。
 */

export type { HistoryPlace }

type NavigationLike = EventTarget & {
  currentEntry: { key: string } | null
  traverseTo: (key: string) => { committed?: Promise<unknown>; finished?: Promise<unknown> }
}

/** 番兵が居る間の「居てよい」位置。止めたらここへ戻す。 */
let settledPlace: HistoryPlace | null = null
/** 止めた戻る・進むを元の位置へ戻している途中か。 */
let restoringPlace = false
/** 確認で移ると決めた移動。行き先に着くまで、途中に着いた位置は画面へ届けずに行き先へ向け直す。 */
let leavingRequest: { owner: HistoryGuard; to: HistoryPlace | null } | null = null
let restoreTimer: ReturnType<typeof setTimeout> | null = null
let leaveTimer: ReturnType<typeof setTimeout> | null = null
/** 戻せない・行き先に着けない場合も、次の戻る・進むを止め続けない。 */
const SETTLE_TIMEOUT_MS = 3000

export function canonicalLocalUrl(url: URL): URL {
  return new URL(canonicalNavigationHref(`${url.pathname}${url.search}${url.hash}`), url.origin)
}

function navigationApi(): NavigationLike | null {
  const navigation = (window as Window & { navigation?: Partial<NavigationLike> }).navigation
  return navigation && typeof navigation.traverseTo === 'function' && typeof navigation.addEventListener === 'function'
    ? navigation as NavigationLike : null
}

/*
 * Navigation API の無いブラウザでは、Next が持つ履歴の項目（状態に `__NA` がある）にだけ並びの番号を書く。
 * pushState で1つ増やし、replaceState で今の番号を保つ。Next は起動時にこの書き込みの外側から包むので、
 * 一度付けたら付けたままにする。Next の外の試験や部品だけの画面では番号を使わない。
 */
const INDEX_FIELD = '__lhGuardIndex'
let indexedHistory = false
let lastIndex = 0

function isRouterState(state: unknown): state is Record<string, unknown> {
  return Boolean(state) && typeof state === 'object' && (state as Record<string, unknown>).__NA === true
}

function stateIndex(state: unknown): number | null {
  const value = isRouterState(state) ? state[INDEX_FIELD] : undefined
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function withIndex(state: unknown, index: number): unknown {
  return isRouterState(state) ? { ...state, [INDEX_FIELD]: index } : state
}

function indexHistoryEntries() {
  const history = window.history
  if (indexedHistory || navigationApi() || !isRouterState(history.state)) return
  indexedHistory = true
  const push = history.pushState
  const replace = history.replaceState
  lastIndex = stateIndex(history.state) ?? 0
  if (stateIndex(history.state) === null) replace.call(history, withIndex(history.state, lastIndex), '')
  history.pushState = function pushState(state: unknown, unused: string, url?: string | URL | null) {
    lastIndex = (stateIndex(history.state) ?? lastIndex) + 1
    push.call(history, withIndex(state, lastIndex), unused, url)
    noteEntryChange()
  }
  history.replaceState = function replaceState(state: unknown, unused: string, url?: string | URL | null) {
    lastIndex = stateIndex(history.state) ?? lastIndex
    replace.call(history, withIndex(state, lastIndex), unused, url)
    noteEntryChange()
  }
}

function currentPlace(state: unknown = window.history.state): HistoryPlace {
  return { key: navigationApi()?.currentEntry?.key ?? null, index: indexedHistory ? stateIndex(state) : null, href: window.location.href }
}

/** 同じ履歴の項目か。鍵も番号も使えなければ分からない（null）。 */
function samePlace(a: HistoryPlace, b: HistoryPlace): boolean | null {
  if (a.key && b.key) return a.key === b.key
  if (a.index === null || b.index === null) return null
  if (a.index !== b.index) return false
  return a.href === b.href ? true : null
}

/** 指した位置へ動かす。鍵があれば鍵で、番号があれば差の分だけ、どちらも無ければ fallbackDelta だけ動かす。 */
function travelTo(place: HistoryPlace | null, from: HistoryPlace, fallbackDelta: number, onFail: () => void) {
  const navigation = navigationApi()
  if (navigation && place?.key) {
    const result = navigation.traverseTo(place.key)
    void result.committed?.catch(onFail)
    void result.finished?.catch(() => {})
    return
  }
  const delta = place && place.index !== null && from.index !== null && place.index !== from.index ? place.index - from.index : fallbackDelta
  if (delta === -1) window.history.back()
  else window.history.go(delta)
}

function finishRestore() {
  restoringPlace = false
  if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null }
}

function finishLeave() {
  leavingRequest = null
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null }
}

function onHistoryTraverse(event: Event) {
  const here = currentPlace((event as PopStateEvent).state)
  if (leavingRequest) {
    // 元へ戻している途中に移ると決めた場合、先に着くのは元の位置。画面へ届けずに、決めた移動を待つ。
    if (restoringPlace) { event.stopImmediatePropagation(); finishRestore(); return }
    const to = leavingRequest.to
    if (!to || samePlace(here, to) !== false) { finishLeave(); settledPlace = here; return }
    // 移る途中に届いた別の位置。画面へは届けずに行き先へ向かう。
    event.stopImmediatePropagation()
    travelTo(to, here, -1, finishLeave)
    return
  }
  if (restoringPlace) {
    // 元へ戻した着地。続けて押された戻る・進むで別の位置に居れば、もう一度元へ戻す。
    event.stopImmediatePropagation()
    if (settledPlace && samePlace(here, settledPlace) === false) { travelTo(settledPlace, here, 1, finishRestore); return }
    finishRestore()
    return
  }
  const from = settledPlace
  // 同じ項目のまま（移動ではない）なら止めない。
  if (!from || samePlace(here, from) === true) { settledPlace = here; return }
  const destination = canonicalLocalUrl(new URL(here.href))
  if (navigationApi() || indexedHistory) {
    // 位置を追えている間は、同じ URL の履歴どうし・hash だけ変わる移動を同じ画面の中の移動として止めない。
    const origin = canonicalLocalUrl(new URL(from.href))
    if (origin.pathname === destination.pathname && origin.search === destination.search) { settledPlace = here; return }
  }
  const cohort = [...historyGuards].filter(entry => entry.active() && entry.handles(destination))
  if (!cohort.length) { settledPlace = here; return }
  event.stopImmediatePropagation()
  restoringPlace = true
  if (restoreTimer) clearTimeout(restoreTimer)
  restoreTimer = setTimeout(finishRestore, SETTLE_TIMEOUT_MS)
  travelTo(from, here, 1, () => { if (from === settledPlace) finishRestore() })
  cohort[0].askHistoryLeave(here, cohort, destination)
}

/** 画面の中の push・replace では「居てよい」位置を今の位置へ動かす。戻る・進むは popstate で決める。 */
function noteEntryChange() {
  if (interceptionUsers > 0 && !restoringPlace && !leavingRequest) settledPlace = currentPlace()
}

function onHistoryEntryChange(event: Event) {
  if ((event as Event & { navigationType?: string }).navigationType !== 'traverse') noteEntryChange()
}

/*
 * 受け口は、管理画面のいちばん外側（UnsavedHistoryRoot）と番兵の両方から借りる。外側で先に付けると、Next の
 * ルーターより前に受け口が並ぶ（Next は起動時に付ける）。外側が無い試験や部品だけの画面では番兵が付ける。
 */
let interceptionUsers = 0

export function retainHistoryInterception() {
  interceptionUsers += 1
  if (interceptionUsers !== 1) return
  indexHistoryEntries()
  settledPlace = currentPlace()
  window.addEventListener('popstate', onHistoryTraverse, { capture: true })
  navigationApi()?.addEventListener('currententrychange', onHistoryEntryChange)
}

export function releaseHistoryInterception() {
  interceptionUsers = Math.max(0, interceptionUsers - 1)
  if (interceptionUsers !== 0) return
  window.removeEventListener('popstate', onHistoryTraverse, { capture: true })
  navigationApi()?.removeEventListener('currententrychange', onHistoryEntryChange)
  settledPlace = null
  finishRestore()
  finishLeave()
}

/** 管理画面のいちばん外側で1回だけ使う。戻る・進むの受け口を Next のルーターより先に付ける。 */
export function useUnsavedHistoryInterception() {
  useEffect(() => {
    retainHistoryInterception()
    return releaseHistoryInterception
  }, [])
}

/** 確認で移ると決めた戻る・進み。元へ戻している途中なら、戻った位置から数えて向かう。 */
export function leaveThroughHistory(owner: HistoryGuard, to: HistoryPlace | null) {
  const from = restoringPlace && settledPlace ? settledPlace : currentPlace()
  finishLeave()
  leavingRequest = { owner, to }
  leaveTimer = setTimeout(finishLeave, SETTLE_TIMEOUT_MS)
  travelTo(to, from, -1, finishLeave)
}

/** 番兵の入力がきれいになったら、その番兵が決めた移動の予約を外す（次の戻るはまた確かめる）。 */
export function forgetLeave(owner: HistoryGuard) {
  if (leavingRequest?.owner === owner) finishLeave()
}
