import type { RichMenuAreaIntent } from '@line-crm/shared'

/* ---- リッチメニューのボタン（147） ---- */

/**
 * ボタンが「何をするか」。
 *
 * LINE が持てる動きは uri / message / postback / richmenuswitch の4つだけ。
 * 「電話をかける」「テンプレートを送る」「回答フォームを開く」はその上に乗せた
 * 言い換えで、LINE に登録するときに4つのどれかへ変換される。
 */
/** 押された回数（148）。 */
export type RichMenuAreaTapCount = {
  areaId: string
  groupId: string
  pageId: string
  /** ボタン名。消されたボタンは、押された時点の名前が出る。 */
  label: string | null
  taps: number
  /** そのうち、計測リンク経由で数えた分。 */
  viaTrackedLink: number
}

export type RichMenuTapStats = {
  from: string
  to: string
  byArea: RichMenuAreaTapCount[]
  byGroup: { groupId: string; taps: number }[]
  total: number
}

export type RichMenuGroupListItem = Partial<import('@line-crm/shared').StyleSampleMetadata> & {
  id: string
  accountId: string
  name: string
  chatBarText: string
  size: 'large' | 'compact'
  defaultPageId: string | null
  isDefaultForAll: boolean
  status: 'draft' | 'published'
  version?: number
  publishingAt: string | null
  targetingCondition: string | null
  targetingPriority: number
  targetingEnabled: boolean
  folderId: string | null
  displayOrder: number
  /** トークを開いたときメニューを出した状態にするか（公開する形に含まれる）。 */
  defaultOpen: boolean
  thumbnailR2Key: string | null
  /** ★V8 一覧の「大・6面・切替タブ N」。ページの束の数。 */
  pageCount?: number
  /** 代表ページ（既定、なければ先頭）の面の数。 */
  defaultPageAreaCount?: number
  /** ★V8 一覧の「対象 N人」。条件で出し分ける行だけ、当てはまる友だちの数。 */
  audienceCount?: number | null
  monthlyStats?: {
    from: string
    to: string
    taps: number
    uniqueAudience: {
      value: number | null
      state: 'available' | 'partial' | 'unavailable'
      reason: 'preexisting_assignments_not_backfilled' | null
    }
  }
  createdAt: string
  updatedAt: string
}

export type RichMenuGroupListPage = {
  items: RichMenuGroupListItem[]
  total: number
  limit: number
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>
  facets?: {
    total: number
    published: number
    targeting: number
    folderCounts: Record<string, number>
  }
}

/** 保存するときに送るボタン1つぶん。 */
export type RichMenuAreaPayload = {
  /** 既存ボタンの id。渡すと引き継がれる（押された回数の集計が途切れない）。 */
  id?: string
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
  /**
   * O: datetimepicker・clipboard も送れる（受け口が intent から DB へ落とす）。
   * intent が真実で、actionType は容れ物。
   */
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch' | 'datetimepicker' | 'clipboard'
  actionData: Record<string, unknown>
  intent?: RichMenuAreaIntent | null
  /** 管理用のボタン名。 */
  label?: string | null
  /** 押されたときに付けるタグ。 */
  tagIds?: string[] | null
  /** 押されたときに足すスコア。 */
  scoreChange?: number | null
  templateId?: string | null
  formId?: string | null
  trackedLinkId?: string | null
}

/** 読み出したときのボタン1つぶん。 */
export type RichMenuAreaResponse = {
  id: string
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch'
  actionData: Record<string, unknown>
  intent: RichMenuAreaIntent | null
  label: string | null
  tagIds: string[]
  scoreChange: number | null
  templateId: string | null
  formId: string | null
  trackedLinkId: string | null
}
