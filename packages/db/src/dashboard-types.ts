import type { FriendActiveMonthComparison as importFriendActiveMonthComparison } from '@line-crm/shared';


/** 今日・過去7日・過去30日。旧last28は既存のAPI利用先向けに保持。 */
export type DashboardPeriod = 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom';

export type DashboardSectionState = 'ok' | 'empty' | 'unavailable' | 'stale' | 'estimated' | 'partial';

export type DashboardFreshness = 'fresh' | 'delayed' | 'stale' | 'unavailable' | 'partial';

export interface DashboardSectionStatus {
  status: DashboardSectionState;
  /** The latest time represented by this section. */
  asOf: string | null;
  /** The age/availability of the source represented by asOf. */
  freshness: DashboardFreshness;
  /** Why a source is unavailable or partial. */
  reason: DashboardMetricReason;
  /** Human-readable fixed period key; the UI maps it to Japanese labels. */
  period: DashboardPeriod | 'latest' | 'last7-fixed' | 'this-month';
}

export type DashboardMetricState =
  | 'available'
  | 'empty'
  | 'unavailable'
  | 'estimated'
  | 'partial'
  | 'stale';

export type DashboardMetricReason =
  | 'source_failed'
  | 'fetch_failed'
  | 'not_connected'
  | 'not_loaded'
  | 'not_applicable'
  | null;

export interface DashboardMetric<T> {
  /** 未取得・取得失敗時は0や空配列にせずnull。 */
  value: T | null;
  state: DashboardMetricState;
  reason: DashboardMetricReason;
  asOf: string | null;
  period: DashboardSectionStatus['period'];
}

export interface DashboardFriendTrendPoint {
  date: string;
  added: number;
  blocked: number;
  /** その日の終わりの有効友だち数。 */
  active: number;
  /**
   * 日次記録が無く、いまの友だちから逆算した日。
   *
   * 退会して行ごと消えた友だちは数に出ないので、実態より少なく見える。
   * 画面はこの日を実線で結ばない。正しい記録と同じ見た目にすると、
   * 見た人が違いに気づけない。
   */
  estimated: boolean;
  /**
   * その日に増えた友だちの経路内訳。多い順。
   *
   * `name` が null の行は「経路不明」（中継リンクを踏まずに増えた分）。
   * 画面は null を経路名ではなく `—`（内訳なしと同じ置き方）で出す。
   */
  sources: Array<{ name: string | null; count: number }>;
}

export interface DashboardOverview {
  period: DashboardPeriod;
  /** 集計した時刻（JST）。カードごとの基準日がずれていないことの証拠になる。 */
  generatedAt: string;
  /** 取得に成功した元データのうち、最も古い基準時刻。 */
  asOf: string | null;
  /** セクション全体のうち最も注意が必要な鮮度。 */
  freshness: DashboardFreshness;
  friends: {
    /** 有効＝ブロックされておらず、非表示にもしていない。 */
    active: number;
    total: number;
    /** 相手からブロック／自分で非表示／その両方。 */
    blockedByThem: number;
    hiddenByUs: number;
    blockedBoth: number;
  };
  inbox: {
    unanswered: number;
    inProgress: number;
    /** 保留。受信箱の対応状況と同じ4状態で数える。 */
    onHold: number;
    resolved: number;
    /**
     * チャネル別の内訳。LINE は友だち単位、MAIL はスレッド単位で数える。
     * 受信箱の一覧（`/api/chats`・`/api/support/inbox`）と同じ定義・同じ範囲。
     */
    line: InboxStatusBreakdown;
    email: InboxStatusBreakdown;
    /** 未対応のうち、最も古いものからの経過時間（分）。無ければ null。 */
    oldestUnansweredMinutes: number | null;
    /**
     * 受信してから最初に返すまでの平均（分）。過去7日ぶん。
     *
     * 107 を当てた日より前の往復は記録が無いので入らない。
     * 記録が1件も無ければ null。0 を出すと「即答している」と読めてしまう。
     */
    averageFirstReplyMinutes: number | null;
  };
  delivery: {
    /**
     * 今月に送った通数。見出し「今月の配信」どおり、選んだ期間に関わらず
     * 今月1日から数える。messages_log は送信時に1行足すので created_at が
     * 送信日時にあたる（予約分を先に書く口はない）。
     */
    sent: number;
    /**
     * こちらから送った数（プッシュ）と、受信への応答（リプライ）。
     *
     * LINEは課金の数え方が違うので、まとめると枠の減りを読み違える。
     * source（028）で分かれる。auto_reply と manual が応答。
     */
    push: number;
    reply: number;
    /**
     * 今月の一斉配信の件数。sent と同じく今月1日から数える。
     * 数えるのは送った日（sent_at）。作った日ではない。
     */
    broadcasts: number;
    /** 今月の送信上限。LINE から取れないときは null。 */
    quotaLimit: number | null;
    /** 今月すでに使った数。取れないときは null。 */
    quotaUsed: number | null;
  };
  /** 友だち数の推移。古い順。 */
  trend: DashboardFriendTrendPoint[];
  conversions: {
    /** 期間内の成果の件数。 */
    total: number;
    /** 成果地点ごとの内訳。多い順に5件まで。 */
    byPoint: Array<{ name: string; count: number }>;
  };
  /** Individual sections that failed; callers must not present these as real zeroes. */
  partialFailures: string[];
  operations: {
    scenarios: { active: number; paused: number };
    migrations: { active: number; completed: number };
    bookings: { pending: number; upcoming: number };
    /** 経路不明の塊は name=null で返す。経路名「経路不明」として出さない。 */
    inflowTop: Array<{ name: string | null; count: number }>;
    funnelAlerts: number;
    automationFailures: number;
  };
  /**
   * Availability metadata kept alongside the legacy numeric shape.
   * Consumers must check this before rendering a numeric zero.
   */
  sections: {
    friends: DashboardSectionStatus;
    inbox: DashboardSectionStatus;
    delivery: DashboardSectionStatus;
    quota: DashboardSectionStatus;
    trend: DashboardSectionStatus;
    conversions: DashboardSectionStatus;
    operations: DashboardSectionStatus;
  };
  /**
   * 画面が使う、未取得をnullで区別できる指標契約。
   * 上の既存フィールドは段階配備中の互換用に残す。
   */
  metrics: {
    activeFriends: DashboardMetric<number>;
    monthlyQuota: DashboardMetric<{
      used: number | null;
      limit: number | null;
      remaining: number | null;
      /** LINE が「上限なし」の契約を返したとき true。limit=null と区別する。 */
      unlimited: boolean;
    }>;
    friendTrend: DashboardMetric<DashboardFriendTrendPoint[]>;
    officialProfileUrl: DashboardMetric<string>;
  };
}

export interface CountRow {
  n: number;
}

export type AccountStatsScope =
  | { allowedAccountIds: readonly string[]; includeUnassigned: boolean }
  | { allTenants: true };

/** 受信箱の対応状況4状態の件数。受信箱の一覧と同じ定義で数えたもの。 */
export interface InboxStatusBreakdown {
  unanswered: number;
  inProgress: number;
  onHold: number;
  resolved: number;
}

/**
 * 受信箱の対応状況の正本（LINE＋MAILの4状態）。
 *
 * ダッシュボードの「現在の対応状況」と受信箱の絞り込みが同じ数を出すための、
 * 唯一の数え方。二重に持たない。
 *
 * - LINE は `/api/chats` の一覧と同じく友だち単位。messages_log か chats の
 *   どちらかに履歴がある友だちを母集団にし、最新の chats 行の status を使う
 *   （行が無い友だちは対応済み。一覧の `COALESCE(c.status, 'resolved')` と同じ）。
 * - MAIL は `/api/support/inbox` と同じく `support_email_threads` の status 単位。
 * - MAIL はアカウントを持たないため、未割り当てが見える範囲のときだけ数える
 *   （受信箱の一覧と同じ条件）。アカウント選択中も、見える人には数える。
 */
export interface InboxStatusCounts extends InboxStatusBreakdown {
  line: InboxStatusBreakdown;
  email: InboxStatusBreakdown;
}

/** 日次記録の1行。 */
export interface FriendDailySnapshot {
  date: string;
  line_account_id: string;
  active: number;
  total: number;
  blocked_by_them: number;
  hidden_by_us: number;
  added: number;
  blocked: number;
}

/** 受信箱の上部に出す数（設計 `V2 2-1 受信箱` の KPIs）。 */
export interface InboxStats {
  /** 返信を待っている人。 */
  waiting: number;
  /** 返信を待っている会話のうち、最も長い待ち時間（分）。 */
  oldestWaitingMinutes: number | null;
  /** 受信から初回返信までの平均（分）。記録が無ければ null。 */
  averageFirstReplyMinutes: number | null;
  /** そのうち1時間以上待たせているもの。 */
  waitingOverAnHour: number;
  /** 自分が担当しているもの（対応中）。 */
  mine: number;
  /** 今日の受信。 */
  todayInbound: number;
  todayByChannel: { line: number; email: number };
  /**
   * 担当者ごとの未読数。担当がまだ決まっていない会話は operatorId/name が null。
   *
   * 一覧はページ送りされるため、画面側で見えている行を数えてはいけない。
   * 0件の担当者はこの配列に現れず、担当者一覧と結合する画面側が実値0として描く。
   */
  assigneeUnread: Array<{
    operatorId: string | null;
    operatorName: string | null;
    unread: number;
  }>;
}

/** 友だち画面の上部に出す数（設計 `V2 2-2 友だち` の KPIs）。 */
export interface FriendStats extends importFriendActiveMonthComparison {
  active: number;
  total: number;
  blockedByThem: number;
  hiddenByUs: number;
  unanswered: number;
  resolved: number;
  /** 今月に追加された人数と、前月同期比。 */
  addedThisMonth: number;
  addedLastMonth: number;
}

/** 一斉配信の一覧に出す数（設計 `V2 4-2 一斉配信` の KPIs）。 */
export interface BroadcastStats {
  /**
   * 今月送り終わった配信の件数と、そのうち予約中。
   * 数えるのは送った日（sent_at）。作った日ではない（BROADCAST-14）。
   */
  thisMonth: number;
  scheduled: number;
  /** 過去28日の到達と失敗。 */
  delivered: number;
  failed: number;
  /** 過去28日の平均開封率（%）。取れないときは null。 */
  openRate: number | null;
}

/**
 * 一斉配信の集計。
 *
 * 開封率は broadcast_insights から。LINEは20人未満の配信だと開封数を返さない
 * ので、その配信は平均から外す。0として混ぜると平均が不当に下がる。
 */
export type BroadcastStatsScope = {
  allowedAccountIds: readonly string[];
  canSeeUnassigned: boolean;
};

/**
 * 一覧画面の上部に出す数。
 *
 * タグ・テンプレート・シナリオ・リマインダは、設計上どれも
 * 「Head ＋ KPI4枚 ＋ 本体」という同じ形をしている。画面ごとに
 * 別の関数にすると、同じ数え方（今月・稼働中・未使用）が散らばって、
 * あとで定義がずれる。1本にまとめる。
 */
export interface ListStats {
  tags: { total: number; unused: number; taggedFriends: number; assignedThisMonth: number };
  marks: {
    total: number;
    inUse: number;
    unanswered: number;
    inProgress: number;
    /** 受信箱の「保留」トーク数。未対応割合の母数を全状態にするため。 */
    onHold: number;
    resolved: number;
    /** 過去7日でマークを変えた回数（110）。 */
    changedLast7: number;
  };
  searches: { total: number; limit: number };
  templates: {
    total: number;
    inUse: number;
    sentThisMonth: number;
    unused90d: number;
    /** テンプレート由来の短縮URLの平均クリック率（%）。取れなければ null。 */
    clickRate: number | null;
  };
  scenarios: {
    total: number;
    active: number;
    subscribers: number;
    completed: number;
    /** 今週（過去7日）のシナリオ由来の送信。 */
    sentThisWeek: number;
  };
  reminders: { total: number; active: number; waiting: number; sentThisMonth: number; failed: number };
  /**
   * ★V8 回答フォーム一覧の数の帯。
   * 「公開中」は受付中（is_active）の数、下書きは受付中でない数。
   * 今月・先月は日本時間の暦月。答え終えた割合は「今月開いた人のうち
   * 今月答え終えた人」の割合で、開いた人が 0 のとき null（「—」と出す）。
   * 後処理の未完は、失敗したか途中で止まった予約を持つ回答の数
   * （一覧の「後処理の未完」の札と同じ近似）。
   */
  forms: {
    total: number;
    published: number;
    draft: number;
    monthlySubmits: number;
    prevMonthSubmits: number;
    monthlyCompletionRate: number | null;
    pendingPostActions: number;
  };
}
