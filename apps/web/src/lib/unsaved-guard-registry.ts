/** 履歴の位置。`key` は Navigation API の項目の鍵、`index` は鍵の無いブラウザで履歴の状態に書いた並びの番号。 */
type HistoryPlace = { key: string | null; index: number | null; href: string }
type HistoryGuard = {
  active: () => boolean
  busy: () => boolean
  subject: () => string
  handles: (destination: URL) => boolean
  handlesLink: (destination: URL, current: URL, anchor: HTMLAnchorElement) => boolean
  discard: () => void
  disarm: () => void
  /** 止めた戻る・進むについて、この番兵が確認を出す。`to` は利用者が移ろうとした履歴の位置。 */
  askHistoryLeave: (to: HistoryPlace, cohort: HistoryGuard[], destination: URL) => void
}
export type { HistoryGuard, HistoryPlace }
export const historyGuards = new Set<HistoryGuard>()
let selectedGuard: HistoryGuard | null = null
let selectedCohort: HistoryGuard[] = []
let selectedMatches: (guard: HistoryGuard) => boolean = () => false
export function selectUnsavedCohort(guard: HistoryGuard | null, cohort: HistoryGuard[], matches?: (guard: HistoryGuard) => boolean) {
  selectedGuard = guard
  selectedCohort = cohort
  if (matches) selectedMatches = matches
}
export function selectedUnsavedGuards(): HistoryGuard[] {
  return selectedGuard && selectedCohort.length ? [...historyGuards].filter(entry => entry.active() && selectedMatches(entry)) : []
}
export function clearUnsavedCohort(guard?: HistoryGuard | null) {
  if (guard && selectedGuard !== guard) return
  selectedGuard = null
  selectedCohort = []
  selectedMatches = () => false
}
function otherGuards(): HistoryGuard[] {
  if (!selectedGuard || !selectedCohort.length) return []
  return selectedUnsavedGuards().filter(entry => entry !== selectedGuard)
}
export function otherUnsavedChanges(): string[] { return [...new Set(otherGuards().map(entry => entry.subject()))] }
/** 表示後に入力そのものが増減した場合は、同じ名前でも再確認する。 */
export function otherUnsavedGuardSnapshot(): readonly object[] { return otherGuards() }
export function otherUnsavedGuardBusy(): boolean { return otherGuards().some(entry => entry.busy()) }
