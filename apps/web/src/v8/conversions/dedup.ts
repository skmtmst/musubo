import type { ConversionDeduplicationMode } from '@/lib/api'

/**
 * 数え方（重複の数え方）の呼び名（CONVERSION-04）。
 *
 * 作成の選択肢・一覧・詳細・編集・再訪で**同じ呼び名**を使う。
 * 「30日に1回まで」を「1人1回」と出すと、同じ人の2回目が数えられると
 * 読み違える。日数つきのときは実際の日数をそのまま出す。
 */
export function deduplicationLabel(
  mode: ConversionDeduplicationMode | undefined,
  windowDays: number | null | undefined,
): string {
  if (mode === 'once_per_friend') return '1人1回だけ'
  if (mode === 'window') {
    return typeof windowDays === 'number' && Number.isInteger(windowDays) && windowDays > 0
      ? `${windowDays}日に1回まで`
      : '決めた日数に1回まで'
  }
  return '何回でも数える'
}
