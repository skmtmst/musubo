/**
 * 店舗のメール受信箱（転送用アドレス方式）の口の形。
 * 口は `/api/account-email/:accountId/*`。どの口も LINE アカウントを URL に必ず含め、
 * 既存の共通メール（`/api/support/*`）には戻らない。
 */

/** 接続の状態。未接続・設定中・受信確認待ち・接続済み・接続切れの5つ。 */
export type AccountEmailStatus = 'disconnected' | 'setup' | 'pending' | 'connected' | 'revoked'

/**
 * 接続の情報。転送用アドレス・お店のメールアドレス・転送の確認文は、
 * オーナーと管理者にだけ値が入る。ほかの人には null で届く（無いのではなく見せない）。
 */
export type AccountEmailConnection = {
  status: AccountEmailStatus
  /** 接続そのものの id（管理者だけに入る）。解除のときに If-Match で送り、別の接続を消さない。 */
  connectionId?: string | null
  address: string | null
  mailbox: string | null
  /** 受信箱からの返信はまだできない。 */
  canReply: false
  /** Gmail・Yahoo!メールなどが転送先へ送る確認コード、または確認用 URL の文字列。文字としてだけ出す。 */
  forwardingConfirmation: string | null
  /**
   * 詰まりの判定。確認メールを送って5分たっても届かない・確認の期限が切れた（転送が止まった疑い）・
   * 自動のメール（自動返信など）を受け取った。古い口は返さないので省略を null と同じに扱う。
   */
  issue?: AccountEmailIssue | null
  /** 最後に受信を確かめた日時。まだ無いときは null。 */
  checkedAt?: string | null
}

export type AccountEmailIssue = 'confirmation_delayed' | 'verification_expired' | 'automated_mail'

/** 会話の対応状況。既存のメール・LINE と同じ4つ。 */
export type AccountEmailThreadStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

/** 一覧の1件。既存のメール一覧と同じ形。 */
export type AccountEmailInboxItem = {
  id: string
  threadId: string
  customerName: string
  customerIdentifier?: string
  subject: string
  preview: string
  status: AccountEmailThreadStatus
  revision: number
  assignedStaffId?: string | null
  assignedStaffName?: string | null
  lastMessageAt?: string | null
  lastIncomingAt: string
  isUnread: boolean
}

export type AccountEmailInboxList = {
  items: AccountEmailInboxItem[]
  summary?: { total?: number; email?: number; emailUnread?: number }
}

/** 受け取ったメールの添付。中身は認証付きの口から取る。 */
export type AccountEmailAttachment = {
  id: string
  filename: string
  contentType: string
  size: number
}

export type AccountEmailMessage = {
  id: string
  direction: 'incoming' | 'outgoing'
  sender_email?: string | null
  sender_name?: string | null
  subject?: string | null
  body_text: string
  created_at: string
  sent_by_staff_name: string | null
  attachments?: AccountEmailAttachment[]
}

/** 会話の詳細。既存のメールの会話と同じ形で、続きの位置も同じ。 */
export type AccountEmailThreadDetail = {
  thread: {
    id: string
    subject: string
    customer_name: string | null
    customer_email: string
    /** 対応状況。店舗の会話でも既存の4つ（未対応・対応中・保留・対応済み）を使う。 */
    status: AccountEmailThreadStatus
    assigned_staff_id: string | null
    notes: string | null
    /** 版。1から始まり、状態の変更と新着で増える。状態を変えるときに送り返す。 */
    revision: number
  }
  messages: AccountEmailMessage[]
  hasMoreOlder?: boolean
  oldestCursor?: string | null
  newestCursor?: string | null
}
