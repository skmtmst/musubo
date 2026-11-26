import { knownValue } from '@/lib/known-value'
/**
 * ダッシュボードの「読み込めなかった部品」の名前（API の partialFailures のキー → 日本語）。
 * 画面に英語の内部の名前（quota など）を出さないため、対応はここ1か所に置く。
 * 知らないキーは「その他」。
 */
export const PARTIAL_FAILURE_LABEL: Record<string, string> = {
  quota: '送信枠',
  friends: '友だちの状態',
  inbox: '受信',
  trend: '友だち数の推移',
  conversions: '成果',
  delivery: '配信',
  broadcasts: '一斉配信',
  operations: '運用の数',
}

export function partialFailureLabel(name: string): string {
  return knownValue(PARTIAL_FAILURE_LABEL, name, 'その他')
}

/** 「送信枠、友だちの状態」のように重ねずに並べる。 */
export function partialFailureLabels(names: readonly string[]): string {
  return [...new Set(names.map(partialFailureLabel))].join('、')
}

/**
 * 部品の中で自分のエラーと「もう一度読み込む」を出すカード（V8 ダッシュボード）。
 * そのカードが出ている間は、頭の下の帯に同じ失敗を重ねて出さない。
 */
export const PARTIAL_FAILURE_OWN_CARD: Record<string, readonly string[]> = {
  quota: ['send-quota'],
  friends: ['friend-status'],
  trend: ['friend-trend'],
  conversions: ['recent-results'],
  delivery: ['monthly-delivery'],
}

/** 出し先のカードが見えていない失敗だけを残す（頭の下の帯に出す分）。 */
export function partialFailuresWithoutCard(names: readonly string[], visibleCardIds: ReadonlySet<string>): string[] {
  return names.filter((name) => !(PARTIAL_FAILURE_OWN_CARD[name] ?? []).some((id) => visibleCardIds.has(id)))
}
