/**
 * 友だち一覧が0件のときの言い方（設計 `bzDn6`）。
 *
 * **絞り込んで0件と、そもそも1人もいないのは別のこと。**
 * 実装はどちらも「条件に合う友だちが見つかりません／検索条件を外すか、
 * 別のキーワードでお試しください。」と出していた。**まだ誰も友だちに
 * なっていないアカウントで、外すべき条件が無いのに「条件を外せ」と言われる。**
 */

export type EmptyFilters = {
  /** 検索欄に入れて実行した言葉。 */
  search: string
  /** 選んでいるタグ。 */
  tagId: string
  /** 詳細条件を使っているか。 */
  advanced: boolean
  /** ほかの絞り込み（担当者・シナリオ・点数・要対応など）を使っているか。 */
  others: boolean
}

export function hasAnyFilter(filters: EmptyFilters): boolean {
  if (!filters || typeof filters !== 'object') return false
  const search = typeof filters.search === 'string' ? filters.search.trim() : ''
  const tagId = typeof filters.tagId === 'string' ? filters.tagId.trim() : ''
  return search !== '' || tagId !== '' || Boolean(filters.advanced) || Boolean(filters.others)
}

export type EmptyMessage = { title: string; description: string }

export function emptyMessageOf(filters: EmptyFilters): EmptyMessage {
  if (hasAnyFilter(filters)) {
    return {
      title: '条件に合う友だちが見つかりません',
      description: '絞り込みを外すか、別の言葉でお試しください。',
    }
  }
  /*
    **外すべき条件が無いときに「条件を外せ」と言わない。**
    ここでは次にやることを書く。友だちは管理画面からは増やせないので、
    増やし方（流入リンク・友だち追加時の配信）を指す。
  */
  return {
    title: 'まだ友だちがいません',
    description: 'LINEで友だちになった人がここに並びます。流入と計測でURLを発行して配ると、どこから来たのかも分かります。',
  }
}
