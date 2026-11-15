export type DashboardMetric<T> = {
  /** 未取得・取得失敗時は0や空配列にせずnull。 */
  value: T | null
  state: 'available' | 'empty' | 'unavailable' | 'estimated' | 'partial' | 'stale'
  reason: 'source_failed' | 'fetch_failed' | 'not_connected' | 'not_loaded' | 'not_applicable' | null
  asOf: string | null
  period: 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom' | 'latest' | 'last7-fixed' | 'this-month'
}

export type DashboardFriendTrendPoint = {
  date: string
  added: number
  blocked: number
  active: number
  /** 日次記録が無く、いまの友だちから逆算した日。 */
  estimated: boolean
  /** 段階配備中の旧Workerでは未返却。経路不明は name=null。 */
  sources?: Array<{ name: string | null; count: number }>
}

/** ダッシュボードが1回で読む数（設計 `管理画面 1-1 ダッシュボード`）。 */
export type DashboardOverview = {
  period: 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom'
  /** 集計した時刻。カードごとの基準がずれていないことの手がかり。 */
  generatedAt: string
  /** 取得に成功した元データのうち最も古い時刻。 */
  asOf?: string | null
  /** 元データの鮮度。段階配備中の旧Workerでは未返却。 */
  freshness?: 'fresh' | 'delayed' | 'stale' | 'unavailable' | 'partial'
  friends: {
    active: number
    total: number
    blockedByThem: number
    hiddenByUs: number
    blockedBoth: number
  }
  inbox: {
    unanswered: number
    inProgress: number
    /** 保留。段階配備中の旧Workerでは未返却。 */
    onHold?: number
    resolved: number
    /**
     * チャネル別の内訳。LINE は友だち単位、MAIL はスレッド単位。
     * 段階配備中の旧Workerでは未返却。
     */
    line?: { unanswered: number; inProgress: number; onHold: number; resolved: number }
    email?: { unanswered: number; inProgress: number; onHold: number; resolved: number }
    oldestUnansweredMinutes: number | null
    /** 受信から初回返信までの平均（分）。記録が無ければ null。 */
    averageFirstReplyMinutes: number | null
  }
  delivery: {
    sent: number
    /** こちらから送った数と、受信への応答。LINEは課金の数え方が違う。 */
    push: number
    reply: number
    broadcasts: number
    quotaLimit: number | null
    quotaUsed: number | null
  }
  trend: DashboardFriendTrendPoint[]
  conversions: {
    total: number
    byPoint: Array<{ name: string; count: number }>
  }
  /** 取得に失敗して0へ見せていない項目。段階配備中の旧Workerでは未返却。 */
  partialFailures?: string[]
  /** 段階配備中の旧Workerでは未返却。 */
  operations?: {
    scenarios: { active: number; paused: number }
    migrations: { active: number; completed: number }
    bookings: { pending: number; upcoming: number }
    /** 経路不明の塊は name=null。経路名としては出さず `—` で出す。 */
    inflowTop: Array<{ name: string | null; count: number }>
    funnelAlerts: number
    automationFailures: number
  }
  sections?: Record<
    'friends' | 'inbox' | 'delivery' | 'quota' | 'trend' | 'conversions' | 'operations',
    {
      status: 'ok' | 'empty' | 'unavailable' | 'stale' | 'estimated' | 'partial'
      asOf: string | null
      freshness?: 'fresh' | 'delayed' | 'stale' | 'unavailable' | 'partial'
      reason?: 'source_failed' | 'fetch_failed' | 'not_connected' | 'not_loaded' | 'not_applicable' | null
      period: 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom' | 'latest' | 'last7-fixed' | 'this-month'
    }
  >
  /** 管理画面指標。段階配備中の旧Workerでは未返却。 */
  metrics?: {
    activeFriends: DashboardMetric<number>
    monthlyQuota: DashboardMetric<{
      used: number | null
      limit: number | null
      remaining: number | null
      /**
       * LINE が「上限なし」（type=none）を返した契約。limit=null の
       * 取得失敗・未接続と区別する（DASH-08）。段階配備中の旧Workerでは未返却。
       */
      unlimited?: boolean
    }>
    friendTrend: DashboardMetric<DashboardFriendTrendPoint[]>
    officialProfileUrl: DashboardMetric<string>
  }
  /** 撮影モックだけが返す設計照合用の値。本番APIでは未返却。 */
  visualQa?: {
    referenceQr: boolean
    friendAddUrl: string
    officialProfileUrl: string
    pendingPhotos: number
    hideBookings: boolean
    healthRisk: 'normal' | 'warning' | 'danger'
    operationalAlerts: number
    twoFactor: { enabled: number; total: number }
    notificationUnreadCount: number
    shipmentStatus: string
    supportInbox: { unanswered: number; resolved: number }
  }
}

export type DashboardPreferenceResponse = {
  source: 'personal' | 'account-default' | 'builtin'
  version: number
  cards: unknown
  updatedAt: string | null
}

/** M (今後の予定): 7日分の束ね。種類ごとの一覧への行き先を持つ。 */
export type DashboardUpcomingItem = {
  kind: 'broadcast' | 'reminder' | 'booking'
  id: string
  title: string
  startsAt: string
  href: string
}

export type DashboardUpcoming = {
  items: DashboardUpcomingItem[]
  asOf: string
  rangeDays: number
}
