'use client'

import { knownValue } from '@/lib/known-value'

/**
 * 写真審査3画面で使う小さな表示補助。`components/shared` ではなく
 * この機能の中だけで共有する（#500 軽: `text` の3ファイル分散の解消）。
 * 見た目の出し方は変えない。未取得は `—` で返さない（呼び側の文言を優先する）。
 */
export const text = (value: unknown): string => String(value ?? '')

/*
 * 呼び方の統一（#500 軽）は列車側で共有の `photoPetDisplayName` へ
 * 一本化されたため、ここには置かない。機能内の表示補助は `text` と
 * `reviewVersionOf` のみ。
 */

/**
 * 楽観ロックの版を整数で取り出す（#500 軽）。
 * 文字や小数など版にならない値が混ざると `Number` は `NaN` になり、
 * JSONでは `null` 化けして400で返ってくる。版が読めないときは初版 `1`
 * として送り、サーバ側の版競合（409）の正規フローに載せる。
 */
export function reviewVersionOf(photo: Record<string, unknown> | null | undefined): number {
  const raw = photo?.review_version
  const version = typeof raw === 'number' ? raw : Number(raw ?? 1)
  return Number.isInteger(version) && version >= 0 ? version : 1
}

/*
 * マイル付与の実状態（アウトボックスの status）を画面の言葉へ。
 * 手続きの行がない採用は EC 未接続（#931 N-307）。
 * 一覧・詳細・掲載管理の3画面で同じ言い方を使う（Issue #1040 IDEA-22）。
 */
export function mileStatusLabel(status: unknown, points = 5) {
  switch (text(status)) {
    case 'synced': return `${points}マイルを付けました`
    case 'pending':
    case 'processing': return `${points}マイルを付ける手続き中`
    // PHOTO-06: 派生状態。長く止まった手続き・失敗の種類を区別して出す。
    case 'stale': return 'マイルの手続きが止まっています'
    case 'failed': return 'マイルの手続きで確認が必要'
    case 'failed_retryable': return 'マイルの手続きに失敗（再試行できます）'
    case 'failed_permanent': return 'マイルの手続きで確認が必要'
    default: return 'EC未接続・マイル対象外'
  }
}

/*
 * 見送り理由の呼び名。一覧の選択肢（page.tsx の REVIEW_REASONS）と
 * 同じ言葉を使う（Issue #1040 IDEA-22: 採用履歴の表示）。
 */
const REVIEW_REASON_TEXT: Record<string, string> = {
  privacy: 'ほかの人の顔が写っています',
  unrelated: 'ほかのお店のロゴや商品名が写っています',
  quality: '暗くて見えにくいです',
  duplicate: '同じ写真をすでにもらっています',
  other: '自分で書く',
}
export function photoReviewReasonLabel(code: unknown) {
  return knownValue(REVIEW_REASON_TEXT, text(code), '理由未記録')
}
