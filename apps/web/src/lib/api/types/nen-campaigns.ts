export type NenCampaignSetting = {
  campaignKey: string
  label: string
  category: 'transactional' | 'follow_up' | 'column' | 'birthday'
  triggerEvent: string | null
  delayDays: number
  deliveryTime: string
  isEnabled: boolean
  title: string
  bodyText: string
  buttonLabel: string | null
  buttonUrl: string | null
  imageUrl: string | null
  dedupWindowDays: number
  excludeFormRespondents: boolean
  afterActions: NenCampaignAfterAction[]
  /** NEN-07: つなぐ回答フォームが使えない稼働中設定の理由。使えるなら null */
  formIssue: 'form_unselected' | 'form_missing' | 'form_inactive' | 'form_other_account' | null
  updatedAt: string
}

export type NenCampaignAfterAction =
  | {
      kind: 'open_form'
      formId: string
      formName: string
      buttonLabel: string
    }
  | {
      kind: 'award_mileage'
      amount: number
      trigger: 'form_submitted'
    }

export type NenColumn = {
  id: string
  externalId: string | null
  slug: string
  title: string
  category: string | null
  excerpt: string
  introText: string
  articleUrl: string
  imageUrl: string | null
  publishedAt: string | null
  deliveryStatus: 'draft' | 'scheduled' | 'queued' | 'sent'
  deliveryAt: string | null
  lineAccountId: string | null
  updatedAt: string
  targetMode: 'all' | 'tag'
  targetTagId: string | null
  completionEventName: string | null
  completionTagId: string | null
  sourceColumnId: string | null
}

export type NenColumnDeliveryPreview = {
  recipientCount: number
  confirmationToken: string
  column: Pick<NenColumn, 'id' | 'title' | 'excerpt' | 'introText' | 'articleUrl' | 'imageUrl' | 'targetMode' | 'targetTagId' | 'updatedAt'>
  campaign: { updatedAt: string; buttonLabel: string | null }
  messages: Array<{ type: 'text'; text: string } | { type: 'flex'; altText: string; contents: unknown }>
}

export type NenColumnCreateInput = {
  title: string
  category?: string
  excerpt?: string
  articleUrl: string
  imageUrl?: string | null
  /** タイムゾーン付きISO 8601。未公開の下書きはnullまたは省略。 */
  publishedAt?: string | null
  targetMode?: 'all' | 'tag'
  targetTagId?: string | null
  scheduledAt?: string | null
  completionEventName?: string | null
  completionTagId?: string | null
  sourceColumnId?: string | null
}

export type NenPetProfile = {
  id: string
  friendId: string
  customerId: string | null
  name: string
  animalType: 'dog' | 'cat' | 'other'
  gender: 'male' | 'female' | 'unknown'
  birthday: string | null
  ownerName: string | null
  lineUserId: string
  /** M511: 更新の版照合に使う。 */
  updatedAt: string
}

export type NenUnavailableMetric = {
  value: null
  state: 'unavailable'
  reason: string
}

export type NenMetricsRange = { days: number; from: string; to: string }

export type NenMetricsQueryRange = { from: string; to: string }

export type NenFlowMetrics = {
  range: NenMetricsRange
  summary: { active: number; paused: number; planned: number; sent: number; associatedConversions: number; associatedConversionAmount: number }
  flows: Array<{
    campaignKey: string; label: string; category: string; isEnabled: boolean
    planned: number; sent: number; failed: number; skipped: number
    openRate: NenUnavailableMetric; associatedConversions: number; associatedConversionAmount: number; attribution: string
  }>
}

export type NenColumnMetrics = {
  range: NenMetricsRange
  summary: { total: number; sent: number; drafts: number; scheduled: number; unread: number | null; associatedConversions: number; associatedConversionAmount: number }
  columns: Array<{
    id: string; title: string; category: string | null; deliveryStatus: string
    publishedAt: string | null; deliveryAt: string | null
    period: { from: string | null; to: string | null }
    targeted: number; sent: number; pending: number; failed: number
    articleOpened: { value: number | null; rate: number | null; state: 'available' | 'unavailable'; reason: string | null }
    unread: number | null; completionRate: { value: number | null; rate: number | null; state: 'available' | 'unavailable'; reason: string | null }
    associatedConversions: number; associatedConversionAmount: number; attribution: string
  }>
}

export type NenPetMetrics = {
  range: NenMetricsRange
  summary: {
    pets: number; birthdayRegistered: number; birthdayMissing: number; birthdayThisMonth: number
    friends: number; friendsWithoutPet: number; birthdayOpenRate: NenUnavailableMetric
    birthdayReachRate: number; birthdayClickRate: number
    coupons: { issued: number; used: number; usageRate: number }
  }
  breeds: Array<{ name: string; count: number }>
  pets: Array<{
    id: string; name: string; animalType: string; breed: string | null; birthday: string | null
    friendId: string; ownerName: string
    ownerDeliveryHistory: { count: number; lastSentAt: string | null }
    coupons: { issued: number; used: number }
  }>
}

export type NenDelivery = {
  id: string; campaignKey: string; label: string; friendId: string; friendName: string
  lineAccountName: string; scheduledAt: string; sentAt: string | null; status: string
  attempts: number; unmetReason: string | null; unmetReasonCode: string | null; reaction: NenUnavailableMetric
  version: number; updatedAt: string
}

export type NenSkippedReasonCode = 'friend_unavailable' | 'line_account_unavailable' | 'line_account_mismatch' | 'campaign_snapshot_missing' | 'campaign_disabled' | 'campaign_form_already_submitted' | 'frequency_suppressed' | 'order_cancelled' | 'order_refunded' | 'unknown'

export type NenDeliveryList = {
  range: NenMetricsRange
  summary: { pending: number; processing: number; sent: number; skipped: number; failed: number; cancelled: number; retryRequired: number; unmetReasons: Partial<Record<'blocked' | 'unfollowed' | 'other', number>>; skippedReasons?: Partial<Record<NenSkippedReasonCode, number>> }
  deliveries: NenDelivery[]
  pagination: { total: number; limit: number; cursor: string; nextCursor: string | null }
}

export type NenDeliveryDetail = Omit<NenDelivery, 'reaction'> & {
  trigger: string
  content: {
    title: string | null; bodyText: string | null; buttonLabel: string | null
    buttonUrl: string | null; imageUrl: string | null
    state: 'available' | 'unavailable'; reason: string | null
  }
}

export type NenFriendOverview = {
  friend: Record<string, unknown>
  member: Record<string, unknown> | null
  pets: Array<Record<string, unknown>>
  healthLogs: Array<Record<string, unknown>>
  photos: Array<Record<string, unknown>>
  pointLedger: Array<Record<string, unknown>>
  ecEvents: Array<Record<string, unknown>>
}
