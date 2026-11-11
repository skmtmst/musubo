
// ---------------------------------------------------------------------------
// 運営コンソール（★管理画面 37）
// ---------------------------------------------------------------------------

export type OpsImpersonation = {
  id: string
  tenantId: string
  tenantName?: string | null
  mode: 'read' | 'write'
  piiRevealed: boolean
  startedAt: string
}

export type OpsMe = {
  id: string
  name: string
  email: string | null
  readOnly: boolean
  totpEnabled: boolean
  lineLinked: boolean
  legacy: boolean
  impersonation: OpsImpersonation | null
}

export type OpsTenantRow = {
  id: string
  name: string
  status: 'active' | 'suspended' | 'archived'
  featurePacks: string[]
  plan_key: string | null
  plan_status: 'exempt' | 'trialing' | 'active' | 'past_due' | 'canceled'
  trial_ends_at: string | null
  current_period_ends_at: string | null
  created_at: string
  updated_at: string
  account_count: number
  staff_count: number
  last_login_at: string | null
}

export type OpsTenantSummary = { active: number; trialing: number; suspended: number; pastDue: number }

export type OpsApplication = {
  id: string
  company_name: string
  contact_name: string
  email: string
  phone: string
  referral_source: string
  status: 'pending' | 'contacted' | 'approved' | 'rejected' | 'activated'
  contact_note: string | null
  contacted_at: string | null
  approved_at: string | null
  invite_sent_at: string | null
  tenant_id: string | null
  pricing_snapshot_json?: string | null
  created_at: string
}

export type OpsTenantDetail = {
  tenant: OpsTenantRow
  accounts: Array<{ id: string; name: string; is_active: number; archived_at: string | null; updated_at: string; friend_count: number }>
  members: Array<{ id: string; name: string; email: string | null; role: string; access_level: string; is_active: number; invite_status: string; last_login_at: string | null }>
  audit: OpsAuditRow[]
  metrics: {monthlyListPriceYen:number|null;monthlyListPriceSource:string;thisMonthBilledYen:number|null;invoiceSource:string;accountCount:number;activeAccountCount:number;friendCount:number;friendChangeLastMonth:null;supportCount:number;unresolvedSupportCount:number}
}

export type OpsAuditRow = {
  id: string
  staff_id: string
  staff_name: string
  tenant_id: string | null
  tenant_name: string | null
  action: string
  reason: string | null
  detail: string
  ip: string | null
  visible_to_tenant: number
  created_at: string
}

export type OpsMember = {
  staffId: string
  name: string
  email: string | null
  isActive: boolean
  totpEnabled: boolean
  lineLinked: boolean
  inviteStatus: string
  activationState: OpsMemberActivationState
  invitedAt: string | null
  approvedBy: string | null
  lastLoginAt: string | null
  createdAt: string
}

export type OpsMemberActivationState = 'invited' | 'awaiting_totp' | 'active'

export type OpsMemberSummary = {
  members: number
  invited: number
  awaitingTotp: number
  totpEnabled: number
  impersonationsThisMonth: number
  writeImpersonationsThisMonth: number
  piiRevealsThisMonth: number
}

export type OperatorHistoryRow = { id: string; action: string; operatorName: string; reason: string | null; createdAt: string }

/** 運営コンソールのお問い合わせ（★管理画面 37-6）。形は `apps/worker/src/routes/ops-support.ts`。 */
export type OpsSupportStage = 'new' | 'in_progress' | 'waiting' | 'resolved' | 'closed'

export type OpsSupportPriority = 'low' | 'medium' | 'high'

export type OpsSupportChannel = 'admin' | 'line' | 'ops'

export type OpsSupportAttachment = { key: string; url: string; name: string }

export type OpsSupportTicket = {
  id: string
  ticketNo: number | null
  ticketLabel: string
  tenantId: string
  tenantName: string
  tenantPlanKey: string | null
  tenantPlanStatus: string
  tenantStatus: string
  staffId: string | null
  staffName: string
  staffRole: string | null
  staffEmailRegistered: boolean
  kind: string
  kindLabel: string
  subject: string
  subjectAuto: boolean
  body: string
  attachments: OpsSupportAttachment[]
  stage: OpsSupportStage
  stageLabel: string
  priority: OpsSupportPriority
  priorityLabel: string
  channel: OpsSupportChannel
  channelLabel: string
  assigneeStaffId: string | null
  replyCount: number
  firstRepliedAt: string | null
  lastMessageAt: string
  resolvedAt: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

export type OpsSupportMessage = {
  id: string
  authorKind: 'tenant' | 'ops'
  authorName: string
  body: string
  attachments: OpsSupportAttachment[]
  deliveredVia: string[]
  createdAt: string
}

export type OpsSupportDraft = { body: string; updatedAt: string }
export type OpsSupportTemplateFolder = { id: string; name: string }
export type OpsSupportReplyTemplate = { id: string; folderId: string; title: string; body: string; createdAt: string; updatedAt: string }
export type OpsSupportTemplateCatalog = { folders: OpsSupportTemplateFolder[]; templates: OpsSupportReplyTemplate[] }

export type OpsSupportSummary = {
  byStage: Record<OpsSupportStage | 'all', number>
  kpis: {
    untouched: number
    untouchedFromLine: number
    avgFirstReplyMinutes: number | null
    prevAvgFirstReplyMinutes: number | null
    resolutionRate: number | null
    prevResolutionRate: number | null
    avgResolutionMinutes: number | null
    prevAvgResolutionMinutes: number | null
  }
}

/** 運営ダッシュボード（★管理画面 37-2）。売上はStripe入金実績、未接続時は定価。 */
export type OpsDashboardPeriod = 'month' | 'prev_month' | 'year'

export type OpsDashboard = {
  period: OpsDashboardPeriod
  periodLabel: string
  pricing: 'stripe_actual' | 'list_price'
  lastSyncedAt: string | null
  plans: Array<{ key: string; label: string; monthlyYen: number }>
  kpis: {
    revenueThisMonth: number
    revenueDelta: number
    refundsThisMonth: number
    contractMonthlyTotal: number
    filledByListPriceCount: number
    active: number
    byPlan: Record<'light' | 'standard' | 'pro', number>
    trialing: number
    newInPeriod: number
    newTrialsInPeriod: number
    churnInPeriod: number
    churnRate: number
  }
  revenueByMonth: Array<{ month: string; label: string; yen: number; current: boolean }>
  planShare: { total: number; rows: Array<{ key: string; label: string; count: number; percent: number }> }
  alerts: { pastDue: number; trialEndingSoon: number; lineTokenExpiring: number; unansweredTickets: number }
  tickets: { newCount: number; inProgressCount: number; avgFirstReplyMinutes: number | null; closedInPeriod: number }
  lineRegistration: { registered: number; total: number; unregisteredCount: number }
  usage: Array<{
    tenantId: string
    tenantName: string
    planKey: string | null
    planLabel: string
    messages: number
    bannerUnits: number
    mediaBytes: number
    limits: { messages: number | null; images: number | null; mediaBytes: number | null }
    usageRate: number
  }>
  generatedAt: string
}

export type OpsLineUnregistered = {
  registered: number
  total: number
  people: Array<{ staffId: string; name: string; tenantName: string; hasEmail: boolean }>
}

/** 最初の 10 分の全アカウントのまとめ（運営だけ・数と割合だけ）。形は `apps/worker/src/services/first-run-funnel.ts`。 */
export type OpsFirstRunStage = 'started' | 'style' | 'starter' | 'follow' | 'firstMessage'
export type OpsFirstRunFunnel = {
  period: OpsDashboardPeriod
  periodLabel: string
  accounts: number
  /** その段まで来た数（前の地点が全部そろったお店）・前の段からの割合・前の地点からかかった分の中央値（1 段目は null）。 */
  stages: Array<{ key: OpsFirstRunStage; count: number; percent: number; fromPrevious: number | null; minutesFromPrevious: number | null }>
  /** 前の段からの割合がいちばん低い段。 */
  biggestDrop: { key: OpsFirstRunStage; fromPrevious: number; lost: number } | null
  minutesToFirstMessage: { median: number | null; p75: number | null; reached: number }
  withinTenMinutesPercent: number
  allStepsDone: { count: number; percent: number }
}

/** 運営からのお知らせ配信（★管理画面 37-7）。形は `apps/worker/src/routes/ops-announcements.ts`。 */
export type OpsAnnouncementAudience = 'all' | 'plan' | 'tenants'

export type OpsAnnouncementChannel = 'line' | 'screen' | 'email'

export type OpsAnnouncementStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'

export type OpsAnnouncement = {
  id: string
  subject: string
  body: string
  audienceKind: OpsAnnouncementAudience
  audiencePlans: string[]
  audienceTenantIds: string[]
  audienceLabel: string
  channels: OpsAnnouncementChannel[]
  channelLabels: string[]
  status: OpsAnnouncementStatus
  statusLabel: string
  publishAt: string | null
  sentAt: string | null
  recipientsTotal: number
  lineSent: number
  lineFailed: number
  mailSent: number
  mailFailed: number
  screenRead: number
  screenTotal: number
  lastError: string | null
  createdByName: string
  createdAt: string
  updatedAt: string
}

export type OpsAnnouncementInput = {
  subject: string
  body: string
  audienceKind: OpsAnnouncementAudience
  audiencePlans: string[]
  audienceTenantIds: string[]
  channels: OpsAnnouncementChannel[]
  publishAt: string | null
  mode: 'draft' | 'schedule' | 'send'
}

export type OpsAudiencePreview = { tenants: number; staff: number; lineLinked: number; withEmail: number }

export type OpsNoticeLineAccount = {
  currentId: string | null
  current: { id: string; name: string; basicId: string | null; addFriendUrl: string | null } | null
  candidates: Array<{ id: string; name: string; basicId: string | null }>
  linked: { linked: number; total: number }
}

export type HqNotice = { id: string; subject: string; body: string; sentAt: string | null }

export type HqLineRegistration =
  | { available: false }
  | { available: true; accountName: string; basicId: string | null; addFriendUrl: string | null; linked: boolean; code: string | null; codeExpiresAt: string | null }

export type HqLineRegistrationStatus = { linked: boolean }

export type OpsSupportDetail = {
  ticket: OpsSupportTicket
  tenant: { accountCount: number; staffCount: number; staffWithLine: number; pastTickets: number; pastOpen: number }
  messages: OpsSupportMessage[]
  draft: OpsSupportDraft | null
}
