/*
 * 統括のアカウント画面の「返信の期限を過ぎた会話」。
 * 店ごとの期限超過（統括の対応が要るものの口）を、数の帯の1枚にまとめる。
 * 足りない値・読めない値を 0 にしない。期限が未設定の会話が1店でも混じれば合計は出さない。
 */

/** 1店の期限超過の状態。口の形が合わないときは unknown にして、0 と区別する。 */
export type AccountOverdueState =
  | { kind: 'off' }
  | { kind: 'count'; count: number }
  | { kind: 'uncertain'; missing: number }
  | { kind: 'unknown' }

/** 数の帯の1枚の中身。hidden は帯に出さない（期限を使う店が無い）。 */
export type OverdueSummary =
  | { kind: 'hidden' }
  | { kind: 'unknown' }
  | { kind: 'uncertain'; missing: number }
  | { kind: 'count'; total: number; accounts: Array<{ accountId: string; count: number }> }

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** 口の `overdue` を読む。古い口で項目が無い・形が違うときは unknown。 */
export function readAccountOverdue(value: unknown): AccountOverdueState {
  if (typeof value !== 'object' || value === null) return { kind: 'unknown' }
  const { status, overdueCount, uncertainCount } = value as Record<string, unknown>
  if (status === 'disabled') return { kind: 'off' }
  if (status !== 'enabled') return { kind: 'unknown' }
  if (isCount(overdueCount)) return { kind: 'count', count: overdueCount }
  if (overdueCount === null && isCount(uncertainCount) && uncertainCount > 0) return { kind: 'uncertain', missing: uncertainCount }
  return { kind: 'unknown' }
}

/**
 * 店ごとの状態を1枚にまとめる。
 * - 全店が期限を使っていない（店が無いときも）→ 出さない。
 * - 1店でも読めない → 合計を出さない（unknown）。
 * - 期限が未設定の会話がある店が混じる → 合計を出さず、未設定の件数を全店で足す。
 * - それ以外 → 合計と、期限超過がある店（多い順・同じ数は元の並び）。
 */
export function summarizeOverdue(entries: ReadonlyArray<{ accountId: string; overdue: unknown }>): OverdueSummary {
  const states = entries.map((entry) => ({ accountId: entry.accountId, state: readAccountOverdue(entry.overdue) }))
  if (states.every(({ state }) => state.kind === 'off')) return { kind: 'hidden' }
  if (states.some(({ state }) => state.kind === 'unknown')) return { kind: 'unknown' }
  const missing = states.reduce((sum, { state }) => sum + (state.kind === 'uncertain' ? state.missing : 0), 0)
  if (missing > 0) return { kind: 'uncertain', missing }
  const accounts = states.flatMap(({ accountId, state }) => (state.kind === 'count' && state.count > 0 ? [{ accountId, count: state.count }] : []))
    .sort((a, b) => b.count - a.count)
  return { kind: 'count', total: accounts.reduce((sum, account) => sum + account.count, 0), accounts }
}
