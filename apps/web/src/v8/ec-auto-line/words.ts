import type { AutoLineKind } from '@line-crm/shared'
import { ApiError } from '@/lib/api'

/*
 * EC連携「自動の LINE」（G6）の言葉と選べる値。docs/v8-requirements/gap-features/G6-ec-auto-line.md。
 * 今は試験運転だけ（LINE へは送らず、送る予定を記録する）。実際の配信は後の段。
 */
export const KIND_LABEL: Record<AutoLineKind, string> = { cart: 'カゴ落ち', browse: '閲覧落ち', restock: '再入荷' }
export const KIND_WHO: Record<AutoLineKind, string> = {
  cart: 'カートに入れたまま買わなかった人へ',
  browse: '商品を見たまま買わなかった人へ',
  restock: '入荷待ちにした商品が戻ったとき',
}
/** 確かめの窓の「これから 〇〇 自動で送ります」。 */
export const KIND_WHEN: Record<AutoLineKind, string> = {
  cart: 'カートに入れて待つ時間だけ買わなかった人',
  browse: '商品を見て待つ時間だけ買わなかった人',
  restock: '入荷待ちにした商品が戻ったとき、待っていた人',
}
export const KIND_ORDER: AutoLineKind[] = ['cart', 'browse', 'restock']

/** 待つ時間の選び肢（分）。API は 0〜10080 分。 */
export const WAIT_CHOICES: Record<AutoLineKind, number[]> = {
  cart: [30, 60, 180, 360, 1440],
  browse: [180, 1440, 2880],
  restock: [0],
}

export function waitLabel(minutes: number): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—'
  if (minutes <= 0) return 'すぐ'
  if (minutes % 1440 === 0) return `${minutes / 1440} 日`
  if (minutes % 60 === 0) return `${minutes / 60} 時間`
  return `${minutes} 分`
}

/** 送る予定の本文（1つ目の文章）。 */
export function ruleText(messages: unknown[]): string {
  if (!Array.isArray(messages)) return ''
  const first = messages.find((m): m is { type?: string; text?: string } => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'text')
  return typeof first?.text === 'string' ? first.text : ''
}

export function failureText(reason: unknown, doing: string): string {
  const code = reason instanceof ApiError ? reason.code : undefined
  if (code === 'connector_unavailable') return 'EC のつなぎ先がまだつながっていないため、オンにできません。「つなぎ先」を設定してください。'
  if (code === 'version_conflict') return '別の人が先に変えていました。読み直したので、もう一度お試しください。'
  if (code === 'forbidden' || (reason instanceof ApiError && reason.status === 403)) return `${doing}する権限がありません。オーナーか管理者に頼んでください。`
  if (code === 'invalid_rule') return '入力を直してください。待つ時間か本文が受け付けられませんでした。'
  return `${doing}ことができませんでした。時間をおいてもう一度お試しください。`
}
