import type { RichMenuPublishRun } from './rich-menu-publish-types'

export type FormDeleteImpact = {
  form: {
    id: string
    name: string
    isActive: boolean
    status: 'active' | 'archived'
  }
  submissionCount: number
  openCount: number
  references: Array<{
    kind: 'webinar' | 'rich_menu'
    name: string | null
    href: string | null
    state: 'available' | 'unavailable'
  }>
  referenceCount: number
  answerUrl: string | null
  revision: number
  /** 編集の版(#723)。受付停止が updateForm を通るので、ここから渡す。 */
  contentRevision: number
  checkedAt: string
  canDelete: boolean
  canArchive: boolean
  recommendedAction: 'delete' | 'archive' | 'none'
  blockers: Array<'published' | 'has_submissions' | 'has_opens' | 'in_use' | 'already_archived'>
}

/**
 * リッチメニューを消したときの影響（`GET /api/rich-menu-groups/:id/delete-impact`）。
 *
 * LINEは友だちごとの現在表示を返さないため、割当台帳に記録された人数を返す。
 * 台帳の記録開始前は含まれないので、state が partial の値を確定値として扱わない。
 */
export type RichMenuDeleteImpact = {
  group: {
    id: string
    accountId: string
    name: string
    status: 'draft' | 'published'
    version?: number
    publishingGeneration?: number
  }
  currentAudience: {
    value: number | null
    state?: 'available' | 'partial' | 'unavailable'
    reason: 'preexisting_assignments_not_backfilled' | 'assignment_ledger_unavailable' | null
  }
  nextDisplay: {
    guaranteedGroupId: null
    reason: 'friend_specific_rules'
    candidates: Array<{
      groupId: string
      name: string
      targetingPriority: number
      isTargetingEnabled: boolean
      isDefaultForAll: boolean
    }>
  }
  incomingSwitches: Array<{
    sourceGroupId: string
    sourceGroupName: string
    sourcePageId: string
    sourcePageName: string
    areaId: string
    areaLabel: string | null
    targetPageId: string
    targetPageName: string
  }>
  operationalReferences: Array<{
    kind: 'automation' | 'common_action'
    ownerId: string
    ownerName: string
  }>
  lineResources: {
    pageCount: number
    pagesWithLineRichMenuId: number
    isDefaultForAll: boolean
    publishing: boolean
    pages?: Array<{id:string;orderIndex:number;lineRichMenuId:string|null}>
  }
  blockers: Array<
    | 'published'
    | 'publishing'
    | 'default_for_all'
    | 'line_resources'
    | 'incoming_switches'
    | 'operational_references'
  >
  canDelete: boolean
  recommendedAction: 'delete' | 'unpublish' | 'review_references'
}

export type RichMenuTargetPreview = {
  matched: { value: number | null; state: 'available' | 'unavailable'; reason: string | null }
  overlap: { value: number | null; state: 'available' | 'unavailable'; reason: string | null }
  effective: { value: number | null; state: 'available' | 'unavailable'; reason: string | null }
  higherMenus: string[]
  priority: number
}

export type RichMenuScheduleInput = {
  mode: 'scheduled' | 'period'
  startsAt: string
  endsAt?: string | null
  restoreGroupId?: string | null
}

/**
 * 公開履歴の応答。`published` はいま対象へ出ている版（最後に成功したrun）、
 * `draftDiffersFromPublished` は編集中の下書きが公開版と違うか。
 */
export type RichMenuPublishRunsResponse = {
  runs: RichMenuPublishRun[]
  published: RichMenuPublishRun | null
  draftDiffersFromPublished: boolean | null
}

/** 本人LINEへのテスト適用1件。 */
export type RichMenuTestApplyItem = {
  id: string
  status: string
  previousRichMenuId: string | null
  /** 適用前の表示を記録できたか。false の失敗は本人の表示を変えていない。 */
  previousCaptured: boolean
  appliedRichMenuId: string | null
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
}

/** revert が本人の表示に何をしたか。 */
export type RichMenuTestApplyUserMenuAction =
  | 'restored'
  | 'already_restored'
  | 'left_as_is'
  | 'untouched'
