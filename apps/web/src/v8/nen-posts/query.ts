/*
 * ダッシュボードの「写真審査」から来たときに、どの札を開くかを決める。
 *
 * ダッシュボードは `/nen-members?tab=photos&status=pending_review` へ送る。
 * ここで読まないと、押しても全部の写真が出るだけで「審査待ちだけ見たい」
 * という押した理由が消える（#666 N-004）。
 *
 * 画面の中の呼び名（pending/adopted/rejected）と、URLに書く呼び名は別。
 * URL側は API と同じ `pending_review` などの言い方も受ける。
 *
 * #931 N-314: 開いている札・詳細の写真・検索語もURLへ写す。
 * ブラウザの戻る・再読込で「どこを見ていたか」が残るようにする。
 */

export type PhotoReviewStatus = 'pending' | 'adopted' | 'rejected'

export interface PhotoReviewEntry {
  view: 'list' | 'detail' | 'publications'
  status: PhotoReviewStatus
  /** view が detail のときだけ。開く写真のID。 */
  photoId?: string
  /** 一覧の絞り込み語。未指定は undefined（#931 N-308）。 */
  q?: string
}

const STATUS_ALIASES: Record<string, PhotoReviewStatus> = Object.assign(Object.create(null), {
  pending: 'pending',
  pending_review: 'pending',
  'pending-review': 'pending',
  review: 'pending',
  adopted: 'adopted',
  approved: 'adopted',
  rejected: 'rejected',
  returned: 'rejected',
})

const DEFAULT_ENTRY: PhotoReviewEntry = { view: 'list', status: 'pending' }

/** URL に書いてある状態の呼び名を、画面の札の名前へ直す。知らない値は null。 */
export function photoReviewStatusFrom(raw: string | null | undefined): PhotoReviewStatus | null {
  if (!raw) return null
  return STATUS_ALIASES[raw.trim().toLowerCase()] ?? null
}

/**
 * `?tab=...&status=...` を読んで、開く画面と札を決める。
 * 知らない値・空のときは、一覧の「審査待ち」。
 * `view=detail&photo=<id>` は詳細を開く。`q=` は一覧の絞り込み語。
 */
export function photoReviewEntryFrom(search: string | null | undefined): PhotoReviewEntry {
  if (!search) return DEFAULT_ENTRY
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const tab = params.get('tab')?.trim().toLowerCase() ?? ''
  const status = photoReviewStatusFrom(params.get('status'))
  const q = params.get('q')?.trim().slice(0, 100) || undefined
  if (tab === 'publications' || tab === 'published') {
    return { view: 'publications', status: status ?? DEFAULT_ENTRY.status, q }
  }
  const view = params.get('view')?.trim().toLowerCase() ?? ''
  const photoId = params.get('photo')?.trim() || undefined
  if (view === 'detail' && photoId) {
    return { view: 'detail', status: status ?? DEFAULT_ENTRY.status, photoId, q }
  }
  return { view: 'list', status: status ?? DEFAULT_ENTRY.status, q }
}

/**
 * 画面の状態からURLの検索部分を作る。`tab` は既存の深掘りと揃えて
 * `photos` / `publications` を使う。詳細は `view=detail&photo=` を足す。
 */
export function photoReviewSearch(entry: PhotoReviewEntry): string {
  const params = new URLSearchParams()
  if (entry.view === 'publications') {
    params.set('tab', 'publications')
  } else {
    params.set('tab', 'photos')
    params.set('status', entry.status)
    if (entry.view === 'detail' && entry.photoId) {
      params.set('view', 'detail')
      params.set('photo', entry.photoId)
    }
    if (entry.q) params.set('q', entry.q)
  }
  return params.toString()
}
