export type FollowerImportState = {
  version: 1
  capability: 'unknown' | 'available' | 'unavailable'
  phase: 'not_started' | 'importing_ids' | 'hydrating_profiles' | 'completed'
  eligibilityCheckedAt: string | null
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
  received: number
  imported: number
  reactivated: number
  claimedUnassigned: number
  alreadyPresent: number
  conflicts: number
  invalid: number
  profilesProcessed: number
  profilesUpdated: number
  profileErrors: number
  lastError: string | null
}

export type LineAccountConnectStep = {
  order: 1 | 2 | 3 | 4 | 5
  state: 'passed' | 'failed' | 'skipped'
  message: string
}

export type LineAccountConnectVerification = {
  tokenOk: boolean
  loginOk: boolean
  /** 同じプロバイダー（両チャネル認証の通過を代理条件にする）。 */
  sameProvider: boolean
  webhook: {
    expectedUrl: string
    registeredUrl: string | null
    active: boolean | null
    testPassed: boolean | null
  }
  /** 登録前の友だち総数。取れなければ null。 */
  followerTotal: number | null
}

export type LineAccountConnectData = {
  additionState?: 'active' | 'pending_payment' | 'pending_reconciliation' | null
  steps: LineAccountConnectStep[]
  /** V8 登録④の5行に載る内訳。古い応答には無いことがある。 */
  verification?: LineAccountConnectVerification
  id?: string
  displayName?: string
  pictureUrl: string | null
  basicId: string | null
  liffId?: string
  followerImport: Pick<FollowerImportState, 'capability' | 'phase'>
  remainingActions: string[]
}

/** 事前確認の4区分。設計 ★管理画面 33-4 の言葉と1対1。 */
export type HandoverMatchBucket = 'auto' | 'review' | 'unmatched' | 'lookalike'

export type HandoverMatchCounts = Record<HandoverMatchBucket, number>

export interface AccountHandover {
  id: string
  fromAccountId: string
  /** 受け取り先。コードが読まれるまでは null。 */
  toAccountId: string | null
  code: string
  codeExpiresAt: string
  status:
    | 'code_issued'
    | 'linked'
    | 'previewed'
    | 'resolved'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'cancelled'
  /**
   * プロバイダーが同じか。**`unknown` を「同じ」と読まない。**
   * LINE は返さないので、こちらに入っていなければ分からない。
   */
  providerMatch: 'same' | 'different' | 'unknown'
  /**
   * 事前確認の結果。**まとめて出るか、まとめて出ないか。**
   * 片方だけ出ることはない（合計が合わない表示を作らないため）。
   */
  counts: (HandoverMatchCounts & { sourceTotal: number }) | null
  movedCount: number
  failedCount: number
  failureReason: string | null
  /** 移し元システム側の申告件数。事前確認の合計と違うままでは本実行できない。 */
  declaredFriendTotal?: number | null
  /** 切り戻せる期限（本実行から7日間）。本実行前は null。 */
  rollbackDeadline?: string | null
  rolledBackAt?: string | null
  rolledBackBy?: string | null
  rollbackNote?: string | null
  createdAt: string
  linkedAt: string | null
  previewedAt: string | null
  resolvedAt: string | null
  executedAt: string | null
  completedAt: string | null
}

export interface AccountHandoverDecision {
  id: string
  handover_id: string
  from_friend_id: string
  to_friend_id: string | null
  decision: 'link' | 'new' | 'skip'
  bucket: HandoverMatchBucket
  note: string | null
  decided_by: string | null
  decided_at: string
}

export type UidMigrationStatus = 'dry_run' | 'review' | 'ready' | 'executing' | 'completed' | 'failed' | 'rolled_back'

export interface UidMigrationItem {
  id: string
  oldUid: string
  newUid: string | null
  candidateName: string | null
  evidenceType: 'same_provider' | 'line_login' | 'signed_customer_id' | 'verified_contact' | 'operator_csv' | 'manual'
  classification: 'auto' | 'review' | 'unmatched' | 'conflict'
  conflictReason: string | null
  decision: 'pending' | 'link' | 'create' | 'exclude'
  result: 'pending' | 'applied' | 'skipped' | 'failed' | 'rolled_back'
  errorMessage: string | null
}

export interface UidMigrationRun {
  suppressionReconciliation?: { status: 'unavailable'; transferredCount: null; mismatchCount: null; reason: 'delivery_consent_snapshot_missing' } | { status: 'matched' | 'mismatch' | 'rolled_back'; transferredCount: number; mismatchCount: number; reason: null }
  id: string
  fromAccountId: string
  toAccountId: string
  purpose: string
  sourceKind: 'csv' | 'verified_api' | 'manual'
  sourceFilename: string | null
  status: UidMigrationStatus
  dryRunRevision: number
  counts: { total: number; auto: number; review: number; unmatched: number; conflict: number; applied: number; failed: number }
  createdBy: string
  approvedBy: string | null
  createdAt: string
  reviewedAt: string | null
  executedAt: string | null
  completedAt: string | null
  rolledBackAt: string | null
  failureReason: string | null
  /**
   * 完了、または一部失敗で反映済みの行がある = 切り戻せる。
   * 口が返さない古い応答では undefined になるため `=== true` で扱う。
   */
  rollbackable?: boolean
  items?: UidMigrationItem[]
}

export interface FriendMigrationJob {
  id: string
  kind: 'export' | 'import'
  line_account_id: string
  row_count?: number | null
  total_count?: number | null
  update_count?: number | null
  conflict_count?: number | null
  status: string
  created_by_name: string
  created_at: string
  expires_at?: string | null
}

/** LINEアカウントのタグ（板 ・）。 */
export type LineAccountTag = { id: string; name: string; color: string | null; displayOrder: number }

export type LineRegistrationReceipt = {
  status: 'waiting' | 'confirmed' | 'error'
  receivedAt: string | null
}
