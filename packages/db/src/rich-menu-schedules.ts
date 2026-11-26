import { boundedListLimit, jstNow } from './utils.js';

// 公開予約の実行状態を DB で持つための最小ヘルパー。
// 342 で足した attempt_count / next_retry_at、344 の journal、355 の lease を使う。
// 上限回数はコード定数で持つ (列は増やさない)。

export const RICH_MENU_SCHEDULE_MAX_ATTEMPTS = 5;

/**
 * claim後にWorkerが止まった場合の回収までの待ち時間。
 * 所有runのlease期限 (lease_expires_at、UTCのISO8601) を過ぎた
 * publishing/restoringだけをstaleとして回収する。
 */
export const RICH_MENU_SCHEDULE_STALE_MS = 10 * 60_000;

/**
 * 予約・再試行の時刻入力をUTCのISO8601('Z')へ正規化する。
 * オフセット付き('+09:00'等)のまま保存すると、due判定の文字列比較で
 * 順序が崩れるため、書き込み境界で必ずここを通す。
 */
export function normalizeScheduleTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('schedule timestamp must be ISO 8601');
  return new Date(time).toISOString();
}

/** claim時刻(UTC ISO)からそのrunのlease期限を作る。 */
export function scheduleLeaseExpiresAt(nowIso: string): string {
  const time = Date.parse(nowIso);
  if (!Number.isFinite(time)) throw new Error('schedule timestamp must be ISO 8601');
  return new Date(time + RICH_MENU_SCHEDULE_STALE_MS).toISOString();
}

export type RichMenuScheduleRow = {
  id: string;
  group_id: string;
  account_id: string;
  mode: 'scheduled' | 'period';
  starts_at: string;
  ends_at: string | null;
  restore_group_id: string | null;
  definition_snapshot: string;
  status: 'scheduled' | 'publishing' | 'published' | 'restoring' | 'completed' | 'cancelled' | 'failed';
  idempotency_key: string;
  requested_by_staff_id: string;
  started_run_id: string | null;
  ended_run_id: string | null;
  last_error_code: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  lease_expires_at: string | null;
  /**
   * 実行開始直前に固定した切替前LINE defaultの状態。365で追加。
   * 'captured'は固定したLINEメニューへ戻す、'no_default'は明示解除する。
   * NULLは未固定(未実行またはscheduled一回きり)。
   */
  restore_default_state: 'captured' | 'no_default' | null;
  /** 固定した切替前LINE defaultのrichMenuId。'captured'のときだけ有効。 */
  restore_default_line_id: string | null;
  created_at: string;
  updated_at: string;
};

const TRANSIENT_PATTERNS = [
  '429', 'rate limit', 'rate_limit', 'ratelimit',
  'timeout', 'timed out', 'etimedout', 'econn', 'eai_again',
  'fetch failed', 'network', 'socket',
  '500', '502', '503', '504', '5xx',
  'temporarily', 'try again', 'busy',
];

const PERMANENT_PATTERNS = [
  'has no image', 'r2 image missing', 'validation',
  'must be', 'invalid', 'not found', 'permission', 'forbidden',
  'unauthorized', 'bad request', '400', '401', '403', '404',
  'snapshot', 'restoregroupid', 'restore_group',
  'account_inactive', 'account_archived', 'account_stopped',
  'staff_inactive', 'staff_forbidden', 'staff_revoked', 'no_restore_target',
  'no_default_pin',
];

/** 失敗を「もう一度試す一時失敗」と「人に対応してほしい恒久失敗」に分ける。 */
export function classifyRichMenuScheduleError(error: unknown): { code: string; retryable: boolean } {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown');
  const lowered = message.toLowerCase().slice(0, 500);
  const code = lowered.slice(0, 120);
  if (PERMANENT_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return { code, retryable: false };
  }
  if (TRANSIENT_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return { code, retryable: true };
  }
  // 正体不明の失敗は一時失敗として上限まで試し、最後は failed に残す。
  return { code, retryable: true };
}

/** 次に試す時刻。1分から倍々に延ばす (1, 2, 4, 8, 16分)。 */
export function nextRichMenuScheduleRetryAt(now: Date, attemptCount: number): string {
  const minutes = Math.pow(2, Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export async function listRichMenuSchedulesByGroup(
  db: D1Database,
  groupId: string,
  limit?: number,
): Promise<RichMenuScheduleRow[]> {
  const bounded = boundedListLimit(limit, 50);
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_schedules WHERE group_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(groupId, bounded)
    .all<RichMenuScheduleRow>();
  return result.results ?? [];
}

/** 開始時刻を過ぎた予約。next_retry_at がある行は再試行時刻も過ぎたものだけ。 */
export async function getDueRichMenuSchedules(
  db: D1Database,
  nowIso: string,
  limit = 20,
): Promise<RichMenuScheduleRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_schedules
        WHERE status = 'scheduled'
          AND starts_at <= ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY starts_at ASC LIMIT ?`,
    )
    .bind(nowIso, nowIso, boundedListLimit(limit, 20))
    .all<RichMenuScheduleRow>();
  return result.results ?? [];
}

/** 期間モードで終了時刻を過ぎた公開中予約。元メニューへ戻す対象。 */
export async function getDueRichMenuScheduleRestores(
  db: D1Database,
  nowIso: string,
  limit = 20,
): Promise<RichMenuScheduleRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_schedules
        WHERE status = 'published'
          AND mode = 'period'
          AND ends_at IS NOT NULL
          AND ends_at <= ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY ends_at ASC LIMIT ?`,
    )
    .bind(nowIso, nowIso, boundedListLimit(limit, 20))
    .all<RichMenuScheduleRow>();
  return result.results ?? [];
}

/**
 * 二重実行を防ぐための排他取得。同じ行を2つのcronが掴んでも、
 * status='scheduled' の1行だけが publishing へ変わる。
 */
/**
 * due の予約を自分の run のものにする。
 *
 * `nowIso` は「いつの予約を拾うか」の時刻 (cron の tick 時刻)。
 * `leaseNowIso` は lease 期限を刻む**実現在時刻**で、既定は `nowIso`。
 * 実行が長引く場合は renewScheduleLease で実時間から延ばす。
 */
export async function claimRichMenuSchedule(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  nowIso: string,
  leaseNowIso: string = nowIso,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'publishing', started_run_id = ?, updated_at = ?,
              attempt_count = attempt_count + 1,
              lease_expires_at = ?
        WHERE id = ? AND account_id = ? AND status = 'scheduled'
          AND starts_at <= ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
    )
    .bind(runId, jstNow(), scheduleLeaseExpiresAt(leaseNowIso), id, accountId, nowIso, nowIso)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 実行中の予約 lease を実現在時刻から延ばす。自分の run でなければ false。
 *
 * claim のときに一度刻んだきりにすると、長い公開の途中で予約行だけ
 * 回収され、group lease を持ったまま予約の所有権を失う。外部工程の
 * 直前に group lease と一緒に延ばす。
 */
export async function renewScheduleLease(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  leaseNowIso: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET lease_expires_at = ?
        WHERE id = ? AND account_id = ?
          AND ((status = 'publishing' AND started_run_id = ?)
            OR (status = 'restoring' AND ended_run_id = ?))`,
    )
    .bind(scheduleLeaseExpiresAt(leaseNowIso), id, accountId, runId, runId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function claimRichMenuScheduleRestore(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  nowIso: string,
  leaseNowIso: string = nowIso,
): Promise<boolean> {
  // started_run_idは開始runのまま残し、復元runはended_run_idへ書く。
  // 開始runと復元runを別々に追跡するため。lease期限もこのrunへ付け替える。
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'restoring', ended_run_id = ?, updated_at = ?,
              attempt_count = attempt_count + 1,
              lease_expires_at = ?
        WHERE id = ? AND account_id = ? AND status = 'published'`,
    )
    .bind(runId, jstNow(), scheduleLeaseExpiresAt(leaseNowIso), id, accountId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getRichMenuScheduleById(
  db: D1Database,
  id: string,
  accountId: string,
): Promise<RichMenuScheduleRow | null> {
  const row = await db
    .prepare(`SELECT * FROM rich_menu_schedules WHERE id = ? AND account_id = ?`)
    .bind(id, accountId)
    .first<RichMenuScheduleRow>();
  return row ?? null;
}

/**
 * 成功記録は lease fencing 付き。claimしたrunだけが書ける。
 * staleなrun Aがrun Bのclaim後に書こうとしても changes=0 で失敗し false を返す。
 */
/**
 * 確定を守る group lease の札。
 *
 * 確定は「まだ自分が lease を持っている」ことを同じ UPDATE の条件に入れる。
 * 公開確定 (markRichMenuGroupPublished) は lease を開けなくなったので、
 * 確定の時点でも owner と世代の両方で見られる。先に確認してから書くと、
 * 確認と書込みの間の回収を取りこぼす。
 */
export type ScheduleGroupFence = { groupId: string; owner: string; generation: number };

function groupFenceClause(fence: ScheduleGroupFence | undefined): string {
  if (!fence) return '';
  return ` AND EXISTS (SELECT 1 FROM rich_menu_groups g
                        WHERE g.id = ? AND g.publishing_owner = ?
                          AND g.publishing_generation = ?)`;
}

function groupFenceBinds(fence: ScheduleGroupFence | undefined): unknown[] {
  return fence ? [fence.groupId, fence.owner, fence.generation] : [];
}

export async function recordRichMenuScheduleSuccess(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  nextStatus: 'completed' | 'published',
  groupFence?: ScheduleGroupFence,
): Promise<boolean> {
  if (nextStatus === 'published') {
    // 期間モードの開始成功。復元の再試行回数を開始と独立させるため
    // attempt_countを0へ戻す。started_run_idは開始runのまま残し、
    // ended_run_idは復元が終わるまで空けておく。確定したのでleaseは空ける。
    const result = await db
      .prepare(
        `UPDATE rich_menu_schedules
            SET status = 'published', ended_run_id = NULL, last_error_code = NULL,
                attempt_count = 0, next_retry_at = NULL, lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND account_id = ? AND status = 'publishing'
            AND started_run_id = ?${groupFenceClause(groupFence)}`,
      )
      .bind(jstNow(), id, accountId, runId, ...groupFenceBinds(groupFence))
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = ?, ended_run_id = ?, last_error_code = NULL,
              next_retry_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'publishing'
          AND started_run_id = ?${groupFenceClause(groupFence)}`,
    )
    .bind(nextStatus, runId, jstNow(), id, accountId, runId, ...groupFenceBinds(groupFence))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordRichMenuScheduleRestoreSuccess(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  groupFence?: ScheduleGroupFence,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'completed', ended_run_id = ?, last_error_code = NULL,
              next_retry_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'restoring'
          AND ended_run_id = ?${groupFenceClause(groupFence)}`,
    )
    .bind(runId, jstNow(), id, accountId, runId, ...groupFenceBinds(groupFence))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordRichMenuScheduleTransientFailure(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  errorCode: string,
  nextRetryAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'scheduled', last_error_code = ?, next_retry_at = ?,
              lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'publishing'
          AND started_run_id = ?`,
    )
    .bind(errorCode.slice(0, 120), nextRetryAt, jstNow(), id, accountId, runId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordRichMenuScheduleRestoreTransientFailure(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  errorCode: string,
  nextRetryAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'published', last_error_code = ?, next_retry_at = ?,
              lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'restoring'
          AND ended_run_id = ?`,
    )
    .bind(errorCode.slice(0, 120), nextRetryAt, jstNow(), id, accountId, runId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordRichMenuSchedulePermanentFailure(
  db: D1Database,
  id: string,
  accountId: string,
  runId: string,
  errorCode: string,
): Promise<boolean> {
  // 恒久失敗もlease付き。stale runが新しいclaimをfailedで潰さない。
  // 開始側(publishing/scheduled)か復元側(restoring/published)のどちらかで
  // 自分のrunが残っている場合だけ書ける。completed/cancelled/failedの
  // 確定済みは反転させない (成功後の通信エラーでfailedに戻さない)。
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'failed', ended_run_id = ?, last_error_code = ?,
              next_retry_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ?
          AND status IN ('scheduled', 'publishing', 'published', 'restoring')
          AND (started_run_id = ? OR ended_run_id = ?)`,
    )
    .bind(runId, errorCode.slice(0, 120), jstNow(), id, accountId, runId, runId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * claim後に止まった行を拾う。所有runのlease期限(UTCのISO8601)を過ぎた行だけ
 * 対象にし、取得と回収は別にする。回収は条件付きUPDATEで二重実行しない。
 * nowIsoはUTCのISO8601で渡す (claimと同じ形式にそろえる)。
 */
export async function getStalePublishingSchedules(
  db: D1Database,
  nowIso: string,
  limit = 20,
): Promise<RichMenuScheduleRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_schedules
        WHERE status = 'publishing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY lease_expires_at ASC LIMIT ?`,
    )
    .bind(nowIso, boundedListLimit(limit, 20))
    .all<RichMenuScheduleRow>();
  return result.results ?? [];
}

export async function getStaleRestoringSchedules(
  db: D1Database,
  nowIso: string,
  limit = 20,
): Promise<RichMenuScheduleRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_schedules
        WHERE status = 'restoring'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY lease_expires_at ASC LIMIT ?`,
    )
    .bind(nowIso, boundedListLimit(limit, 20))
    .all<RichMenuScheduleRow>();
  return result.results ?? [];
}

/** staleなpublishingをscheduledへ戻す。lease期限切れのままなら1行だけ戻る。 */
export async function reclaimStalePublishingSchedule(
  db: D1Database,
  id: string,
  accountId: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'scheduled', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'publishing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?`,
    )
    .bind(jstNow(), id, accountId, nowIso)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** staleなrestoringをpublishedへ戻す。lease期限切れのままなら1行だけ戻る。 */
export async function reclaimStaleRestoringSchedule(
  db: D1Database,
  id: string,
  accountId: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'published', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'restoring'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?`,
    )
    .bind(jstNow(), id, accountId, nowIso)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export type RestoreDefaultPin = {
  state: 'captured' | 'no_default';
  /** 'captured'のときの切替前LINE defaultのrichMenuId。 */
  lineId: string | null;
};

/**
 * 実行開始直前・切替前のLINE実defaultを固定する(365)。
 * 予約時ではなく実行時に読むため、期間中の管理画面外の変更に影響されない。
 * 一度だけ書く pin-once: 既に固定済みなら false を返し、呼び出し側は
 * 保存済み値を読み直して使う(再試行で固定値がずれないようにする)。
 */
export async function pinScheduleRestoreDefault(
  db: D1Database,
  id: string,
  accountId: string,
  pin: RestoreDefaultPin,
): Promise<boolean> {
  if (pin.state !== 'captured' && pin.state !== 'no_default') {
    throw new Error('restore default pin state must be captured or no_default');
  }
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET restore_default_state = ?, restore_default_line_id = ?, updated_at = ?
        WHERE id = ? AND account_id = ?
          AND restore_default_state IS NULL`,
    )
    .bind(pin.state, pin.lineId, jstNow(), id, accountId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 固定済みの戻し先を読む。未固定なら null。 */
export async function getScheduleRestoreDefaultPin(
  db: D1Database,
  id: string,
  accountId: string,
): Promise<RestoreDefaultPin | null> {
  const row = await db
    .prepare(
      `SELECT restore_default_state AS state, restore_default_line_id AS line_id
         FROM rich_menu_schedules WHERE id = ? AND account_id = ?`,
    )
    .bind(id, accountId)
    .first<{ state: string | null; line_id: string | null }>();
  if (!row || (row.state !== 'captured' && row.state !== 'no_default')) return null;
  return { state: row.state, lineId: row.line_id };
}

/**
 * 切替の補償で作りかけを捨てるときにjournalも消す。
 * journalを残したまま新メニューを消すと、再試行が消えたIDへ切替えて壊す。
 * 消せず(D1失敗)に終わったら補償自体をやめ、journalありの再開に任せる。
 */
export async function clearSchedulePublications(
  db: D1Database,
  scheduleId: string,
  kind: SchedulePublicationKind,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM rich_menu_schedule_publications WHERE schedule_id = ? AND kind = ?`,
    )
    .bind(scheduleId, kind)
    .run();
}

export type ScheduleIndividualLink = { friendId: string; lineUserId: string };

/**
 * 期間終了で外す個別割当の対象。期限切れメニューを指す友だちの
 * LINEユーザーIDを返す。LINE側の個別link解除に使う。
 * D1行の削除は解除が終わってから行う (解除にIDが要るため)。
 */
export async function listScheduleGroupIndividualLinks(
  db: D1Database,
  accountId: string,
  groupId: string,
): Promise<ScheduleIndividualLink[]> {
  const result = await db
    .prepare(
      `SELECT a.friend_id AS friend_id, f.line_platform_user_id AS line_user_id
         FROM rich_menu_assignments a
         JOIN friends f ON f.id = a.friend_id AND f.line_account_id = a.line_account_id
        WHERE a.line_account_id = ? AND a.group_id = ?`,
    )
    .bind(accountId, groupId)
    .all<{ friend_id: string; line_user_id: string }>();
  return (result.results ?? [])
    .filter((row) => typeof row.line_user_id === 'string' && row.line_user_id.length > 0)
    .map((row) => ({ friendId: row.friend_id, lineUserId: row.line_user_id }));
}

/** 実行前の取消だけ受け付ける。publishing/restoring の最中は 409 側で止める。 */
export async function cancelRichMenuSchedule(
  db: D1Database,
  id: string,
  groupId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_schedules
          SET status = 'cancelled', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND group_id = ? AND account_id = ? AND status = 'scheduled'`,
    )
    .bind(jstNow(), id, groupId, accountId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export type SchedulePublicationKind = 'publish' | 'restore';

export type SchedulePublicationRow = {
  schedule_id: string;
  kind: SchedulePublicationKind;
  page_id: string;
  line_richmenu_id: string;
  run_id: string;
  created_at: string;
};

/**
 * 外部LINEへの作成結果をdurableに残す。LINE成功後・D1記録前の停止で
 * 再実行しても作り直さないための照合元。INSERT OR IGNOREで二重記録しない。
 */
export async function recordSchedulePublications(
  db: D1Database,
  scheduleId: string,
  kind: SchedulePublicationKind,
  runId: string,
  pages: Array<{ pageId: string; lineRichMenuId: string }>,
  createdAt?: string,
): Promise<void> {
  if (pages.length === 0) return;
  const now = createdAt ?? jstNow();
  const stmts = pages.map((page) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO rich_menu_schedule_publications
           (schedule_id, kind, page_id, line_richmenu_id, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(scheduleId, kind, page.pageId, page.lineRichMenuId, runId, now),
  );
  await db.batch(stmts);
}

export async function getSchedulePublications(
  db: D1Database,
  scheduleId: string,
  kind: SchedulePublicationKind,
): Promise<SchedulePublicationRow[]> {
  const result = await db
    .prepare(
      `SELECT schedule_id, kind, page_id, line_richmenu_id, run_id, created_at
         FROM rich_menu_schedule_publications
        WHERE schedule_id = ? AND kind = ?
        ORDER BY page_id ASC`,
    )
    .bind(scheduleId, kind)
    .all<SchedulePublicationRow>();
  return result.results ?? [];
}

export type CreateScheduleInput = {
  id: string;
  groupId: string;
  accountId: string;
  mode: 'scheduled' | 'period';
  startsAt: string;
  endsAt: string | null;
  restoreGroupId: string | null;
  definitionSnapshot: string;
  idempotencyKey: string;
  requestedByStaffId: string;
  now: string;
};

/**
 * 予約作成を原子的に行う。SELECT→INSERTの2段階にしない。
 * INSERT OR IGNORE相当で競合を吸収し、同keyの既存行と内容を比べる。
 * 同内容なら既存を返し、異内容ならconflictを返す（成功扱いにしない）。
 * 時刻はUTCのISO8601へ正規化して保存する。オフセット付きのままだと
 * due判定の文字列比較で順序が崩れるため、ここでそろえる。
 */
export async function createRichMenuScheduleAtomic(
  db: D1Database,
  input: CreateScheduleInput,
): Promise<
  | { outcome: 'created'; id: string }
  | { outcome: 'existing'; id: string; status: string }
  | { outcome: 'conflict'; id: string; status: string }
> {
  const startsAt = normalizeScheduleTimestamp(input.startsAt);
  const endsAt = input.endsAt === null ? null : normalizeScheduleTimestamp(input.endsAt);
  const insert = await db
    .prepare(
      `INSERT INTO rich_menu_schedules
         (id, group_id, account_id, mode, starts_at, ends_at, restore_group_id,
          definition_snapshot, status, idempotency_key, requested_by_staff_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
       ON CONFLICT(account_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      input.id,
      input.groupId,
      input.accountId,
      input.mode,
      startsAt,
      endsAt,
      input.restoreGroupId,
      input.definitionSnapshot,
      input.idempotencyKey,
      input.requestedByStaffId,
      input.now,
      input.now,
    )
    .run();
  if ((insert.meta?.changes ?? 0) > 0) {
    return { outcome: 'created', id: input.id };
  }
  const existing = await db
    .prepare(
      `SELECT id, status, group_id, mode, starts_at, ends_at, restore_group_id,
              definition_snapshot
         FROM rich_menu_schedules
        WHERE account_id = ? AND idempotency_key = ?`,
    )
    .bind(input.accountId, input.idempotencyKey)
    .first<{
      id: string;
      status: string;
      group_id: string;
      mode: string;
      starts_at: string;
      ends_at: string | null;
      restore_group_id: string | null;
      definition_snapshot: string;
    }>();
  if (!existing) {
    // 同時実行の狭間で消えた等の想定外。再試行させる。
    throw new Error('schedule idempotency race: existing row not found');
  }
  const same =
    existing.group_id === input.groupId &&
    existing.mode === input.mode &&
    existing.starts_at === startsAt &&
    (existing.ends_at ?? null) === (endsAt ?? null) &&
    (existing.restore_group_id ?? null) === (input.restoreGroupId ?? null) &&
    existing.definition_snapshot === input.definitionSnapshot;
  if (same) {
    return { outcome: 'existing', id: existing.id, status: existing.status };
  }
  return { outcome: 'conflict', id: existing.id, status: existing.status };
}

/** snapshot内のpage id一覧を取り出す。壊れたJSONは空配列。 */
export function snapshotPageIds(snapshot: unknown): string[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const pages = (snapshot as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];
  const ids: string[] = [];
  for (const page of pages) {
    if (page && typeof page === 'object' && typeof (page as { id?: unknown }).id === 'string') {
      ids.push((page as { id: string }).id);
    }
  }
  return ids;
}

/**
 * 予約後の下書き編集・ページ削除のずれを検出する。
 * snapshotにあるpageが現在のgroupに無ければdriftとして恒久失敗させる。
 * 内容の編集自体はsnapshotが正本のため許すが、消えたpageへのID記録はしない。
 */
export function detectSnapshotPageDrift(
  snapshot: unknown,
  currentPageIds: string[],
): string | null {
  const wanted = snapshotPageIds(snapshot);
  if (wanted.length === 0) return 'definition_snapshot has no pages';
  const current = new Set(currentPageIds);
  const missing = wanted.filter((id) => !current.has(id));
  if (missing.length > 0) {
    return `snapshot drift: pages deleted after reservation (${missing.slice(0, 3).join(',')})`;
  }
  return null;
}
