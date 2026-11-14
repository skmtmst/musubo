/* ★V8 写し：src/app/contents/media-usage-display.ts から写した（src/v8 は src/app を import しない決まり）。中身は同じ。直すときは両方を直す。 */
/**
 * 登録メディアの「使用箇所」の言葉づかい（設計 `voJtX` 15-1）。
 *
 * **表に無い種別を、内部の記号のまま出さない。**
 *
 * 画面は `REF_KIND_LABELS[u.refKind] ?? u.refKind` と書いていた。表に載って
 * いる種類は日本語になるが、載っていない種別は `card_message` のまま並ぶ。
 * 一斉配信から引用する素材（リッチメッセージ・カードタイプ・クーポン・
 * リサーチ）がまさにそれで、運用者の画面にDBの語が出ていた。
 *
 * `?? u.refKind` のような「取れなければ生の値」は、**表を足し忘れた瞬間に
 * 静かに内部名を漏らす。** 既定を言葉のほうに寄せる。
 */

const USAGE_KIND_LABELS: Record<string, string> = {
  // メディア走査が記録する種類（`packages/db` の `MEDIA_REF_KINDS`）。
  template: 'テンプレート',
  broadcast: '一斉配信',
  rich_menu: 'リッチメニュー',
  scenario_step: 'シナリオのステップ',
  nen_column: 'NENコラム',
  event: 'イベント',
  webinar: 'ウェビナー',
  auto_reply: '自動応答',
  visit_stamp_card: '来店スタンプ',
  booking_menu: '予約メニューの写真',
  restaurant_menu: '飲食メニューの画像',
  booking_staff: '予約スタッフの写真',
  booking_settings: 'お店の写真',
  form: '回答フォーム',
  // 一斉配信から引用する素材。言い方は作る画面（一斉配信）に合わせる。
  rich_message: 'リッチメッセージ',
  card_message: 'カードタイプ',
  coupon: 'クーポン',
  research: 'リサーチ',
}

/**
 * 表に無い種別の言い方。
 *
 * 「その他」だと、そういう分類が有るように読める。分からないと書く。
 */
export const UNKNOWN_USAGE_KIND = '種類を判別できない使用先'

/** 使用箇所の種別を運用者の言葉にする。 */
export function mediaUsageKindText(refKind: string): string {
  return USAGE_KIND_LABELS[refKind] ?? UNKNOWN_USAGE_KIND
}

/**
 * 容量の短い表示。一覧と詳細で同じ書き方にする（2か所のコピペをここへ寄せた）。
 */
export function formatMediaSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
