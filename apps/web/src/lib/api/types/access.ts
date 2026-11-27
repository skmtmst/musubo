export type AccessUserStatus = 'active' | 'invited' | 'expired' | 'suspended'

export type AccessRoleBundle = 'administrator' | 'operations' | 'reception' | 'view_only' | 'custom'

export type AccessUserItem = {
  id: string
  name: string
  email: string | null
  jobTitle: string | null
  roleBundle: AccessRoleBundle
  featureCount: number | null
  hasFieldMasks: boolean | null
  accountScope: {
    type: 'all' | 'accounts'
    assignedLineAccountId: string | null
    lineAccountIds: string[]
    includesDescendants: boolean
  }
  lastLoginAt: string | null
  lastActionAt: string | null
  mfaEnabled: boolean
  status: AccessUserStatus
  policyVersion: number
  createdAt: string
  updatedAt: string
}

export type AccessUserSummary = {
  active: number
  invited: number
  expiredInvitations: number
  unused90Days: number
  mfaEnabled: number
  mfaRate: number | null
  roleCounts: Record<AccessRoleBundle, number>
}

export type AccessRoleItem = {
  id: AccessRoleBundle
  name: string
  description: string
  featureAccess: 'edit' | 'view' | 'custom'
  requiresMfa: boolean
  assignedUserCount: number
  featurePermissions?: Record<string, 'edit' | 'view' | 'none'>
}

export type AuditEventItem = {
  id: string
  category: 'auth' | 'business'
  lineAccountId: string | null
  actor: { id: string | null; name: string | null; role: string | null }
  action: string
  target: { kind: string | null; id: string | null } | null
  result: 'success' | 'denied' | 'failed'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  requestTraceId: string | null
  ipPrefix: string | null
  regionLabel?: string | null
  deviceFamily: string | null
  riskLevel: 'normal' | 'suspicious' | 'high'
  retentionClass: 'general' | 'security' | 'personal_data'
  createdAt: string
}

export type AuditEventSummary = {
  /** 集計した期間の日数。全期間（from 未指定）で取ったときは null。 */
  periodDays: number | null
  total: number
  deleted: number
  sent: number
  changed: number
  logins: number
  suspiciousLogins: number
  /** 「気になるもの」タブと同じ条件（失敗・要確認）の件数。タブの件数は一覧と同じ分類で数える（監査 R69）。 */
  attention: number
}

/** 大事な操作の直前再確認（V）が対象にする操作の名前。Workerの STEP_UP_PURPOSES と一致させる。 */
export type StepUpPurpose =
  | 'auth.login.trust'
  | 'auth.api_key'
  | 'privacy.retention'
  | 'data.export'
  | 'broadcast.send'
  | 'ops.impersonation'
  | 'secrets.reveal'
  | 'auth.mfa.policy'
  | 'auth.mfa.reenroll'
  | 'auth.passkey.register'
  | 'auth.passkey.remove'
  | 'operations.control'
  | 'affiliate.payout.export'
  | 'photo.original.download'
  | 'staff.permissions.change'
  | 'staff.two_factor.remove'
  | 'line_account.connect'
  | 'line_account.credentials'
  | 'line_account.archive'
  | 'account_handover.execute'
  | 'broadcast.approval'
  | 'webhook.api_token'
  | 'webhook.secret'
  | 'ai.settings'
  | 'mcp.connection'
