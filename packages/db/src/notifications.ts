import { jstNow } from './utils.js';
// 通知機能クエリヘルパー

export interface NotificationRuleRow {
  id: string;
  name: string;
  event_type: string;
  conditions: string;  // JSON
  channels: string;    // JSON配列
  line_account_id: string | null;
  is_active: number;
  version: number; // 内容の版。更新のたびに+1し、発火時に台帳へ写す
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  rule_id: string | null;
  event_type: string;
  title: string;
  body: string;
  channel: string;
  status: string;
  metadata: string | null;
  line_account_id: string | null;
  category: 'error' | 'update' | 'info';
  created_at: string;
}

export interface NotificationCenterRow extends NotificationRow {
  read_at: string | null;
}

export interface NotificationCenterCounts {
  all: number;
  error: number;
  update: number;
  unread: number;
}

// --- 通知ルール ---

export async function getNotificationRules(
  db: D1Database,
  lineAccountId: string,
): Promise<NotificationRuleRow[]> {
  const result = await db.prepare(
    `SELECT * FROM notification_rules WHERE line_account_id = ? ORDER BY created_at DESC`,
  ).bind(lineAccountId).all<NotificationRuleRow>();
  return result.results;
}

export async function getNotificationRuleById(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<NotificationRuleRow | null> {
  return db.prepare(`SELECT * FROM notification_rules WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).first<NotificationRuleRow>();
}

export async function createNotificationRule(
  db: D1Database,
  input: {
    lineAccountId: string;
    name: string;
    eventType: string;
    conditions?: Record<string, unknown>;
    channels?: string[];
  },
): Promise<NotificationRuleRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // A rule is only a draft until the operator delivery executor is connected.
  // The legacy table defaults to active, which made a newly-saved definition
  // look live even though no recipient resolution or delivery was performed.
  await db.prepare(`INSERT INTO notification_rules
    (id, name, event_type, conditions, channels, line_account_id, is_active, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`)
    .bind(
      id,
      input.name,
      input.eventType,
      JSON.stringify(input.conditions ?? {}),
      JSON.stringify(input.channels ?? ['dashboard']),
      input.lineAccountId,
      now,
      now,
    ).run();
  return (await getNotificationRuleById(db, id, input.lineAccountId))!;
}

export async function updateNotificationRule(
  db: D1Database,
  id: string,
  lineAccountId: string,
  updates: Partial<{ name: string; eventType: string; conditions: Record<string, unknown>; channels: string[]; isActive: boolean }>,
  opts?: { expectedVersion?: number },
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  // 内容の版: 名前・きっかけ・条件・通知方法が変わったら+1する。
  // 公開/停止だけの切り替えは版を変えない(発火済みの版表示がぶれないため)。
  const bumpsVersion = updates.name !== undefined || updates.eventType !== undefined
    || updates.conditions !== undefined || updates.channels !== undefined;
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.eventType !== undefined) { sets.push('event_type = ?'); values.push(updates.eventType); }
  if (updates.conditions !== undefined) { sets.push('conditions = ?'); values.push(JSON.stringify(updates.conditions)); }
  if (updates.channels !== undefined) { sets.push('channels = ?'); values.push(JSON.stringify(updates.channels)); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) return true;
  if (bumpsVersion) sets.push('version = version + 1');
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  values.push(lineAccountId);
  // 画面が読んだ版と1文で突き合わせる。違う版からの保存は1行も
  // 触らず false を返し、呼ぶ側が409で止める。
  const conditions = ['id = ?', 'line_account_id = ?'];
  if (opts?.expectedVersion !== undefined) {
    conditions.push('version = ?');
    values.push(opts.expectedVersion);
  }
  const result = await db.prepare(`UPDATE notification_rules SET ${sets.join(', ')} WHERE ${conditions.join(' AND ')}`)
    .bind(...values).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function deleteNotificationRule(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM notification_rules WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).run();
}

// --- 通知 ---

export async function getNotifications(
  db: D1Database,
  opts: { lineAccountId: string; status?: string; limit?: number; staffId: string },
): Promise<NotificationRow[]> {
  const limit = opts.limit ?? 100;
  {
    const result=await db.prepare(`SELECT n.* FROM notifications n WHERE n.line_account_id=? AND (? IS NULL OR n.status=?) AND ${assignmentNoticeVisible('n')} ORDER BY n.created_at DESC LIMIT ?`)
      .bind(opts.lineAccountId,opts.status??null,opts.status??null,opts.staffId,limit).all<NotificationRow>();
    return result.results;
  }
}

export async function createNotification(
  db: D1Database,
  input: {
    ruleId?: string;
    eventType: string;
    title: string;
    body: string;
    channel: string;
    metadata?: string;
    lineAccountId?: string | null;
    category?: 'error' | 'update' | 'info';
  },
): Promise<NotificationRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO notifications (id, rule_id, event_type, title, body, channel, metadata, line_account_id, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      input.ruleId ?? null,
      input.eventType,
      input.title,
      input.body,
      input.channel,
      input.metadata ?? null,
      input.lineAccountId ?? null,
      input.category ?? 'info',
      now,
    ).run();
  return (await db.prepare(`SELECT * FROM notifications WHERE id = ?`).bind(id).first<NotificationRow>())!;
}

export async function updateNotificationStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db.prepare(`UPDATE notifications SET status = ? WHERE id = ?`).bind(status, id).run();
}

// 割当不能の知らせは責任者と指定チームに限定する。ほかの通知には影響しない。
const assignmentNoticeVisible = (alias: string) => `(${alias}.event_type NOT IN ('inbox_assignment_unavailable','inbox_sla') OR EXISTS (
 SELECT 1 FROM (SELECT id,role,is_active,invite_status FROM staff_members UNION ALL SELECT 'env-owner','owner',1,'active') viewer WHERE viewer.id=? AND viewer.is_active=1 AND viewer.invite_status='active' AND (
  (${alias}.event_type='inbox_sla' AND CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata,'$.stage') END IN (1,2)
   AND CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata,'$.staffId') END=viewer.id)
  OR ((${alias}.event_type='inbox_assignment_unavailable' OR (${alias}.event_type='inbox_sla' AND (CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata,'$.stage') END=3 OR CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata,'$.staffId') END IS NULL)))
   AND (viewer.role IN ('owner','admin') OR EXISTS (
    SELECT 1 FROM operator_notification_teams team, json_each(team.staff_ids) member
    WHERE team.line_account_id=${alias}.line_account_id AND team.archived_at IS NULL
    AND team.id=CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata,'$.teamId') END AND member.value=viewer.id
   )))
 )))`;

export async function getNotificationCenter(
  db: D1Database,
  input: {
    lineAccountId: string;
    staffId: string;
    category?: 'error' | 'update';
    /** この担当者の未読だけ。ベルで先頭の数件に切ると、6件目以降の未読が埋もれるため口で絞る。 */
    unreadOnly?: boolean;
    limit?: number;
    /** 通知一覧画面の「さらに読み込む」用。パネルは0のまま。 */
    offset?: number;
  },
): Promise<NotificationCenterRow[]> {
  // 'center' は旧実装が送信枠不足の通知へ付けていた値。画面は 'dashboard'
  // しか読まなかったため書き込み済みの通知が見えなかった。両方を読む。
  const conditions = ['n.line_account_id = ?', "n.channel IN ('dashboard', 'center')", assignmentNoticeVisible('n')];
  const values: unknown[] = [input.staffId, input.lineAccountId, input.staffId];
  if (input.category) {
    conditions.push('n.category = ?');
    values.push(input.category);
  }
  if (input.unreadOnly) conditions.push('r.notification_id IS NULL');
  values.push(input.limit ?? 20, input.offset ?? 0);
  const result = await db.prepare(`
    SELECT n.*, r.read_at
    FROM notifications n
    LEFT JOIN staff_notification_reads r
      ON r.notification_id = n.id AND r.staff_id = ?
    WHERE ${conditions.join(' AND ')}
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ? OFFSET ?
  `).bind(...values).all<NotificationCenterRow>();
  return result.results;
}

export async function getNotificationCenterCounts(
  db: D1Database,
  input: { lineAccountId: string; staffId: string },
): Promise<NotificationCenterCounts> {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS all_count,
      SUM(CASE WHEN n.category = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN n.category = 'update' THEN 1 ELSE 0 END) AS update_count,
      SUM(CASE WHEN r.notification_id IS NULL THEN 1 ELSE 0 END) AS unread_count
    FROM notifications n
    LEFT JOIN staff_notification_reads r
      ON r.notification_id = n.id AND r.staff_id = ?
    WHERE n.line_account_id = ? AND n.channel IN ('dashboard', 'center') AND ${assignmentNoticeVisible('n')}
  `).bind(input.staffId, input.lineAccountId, input.staffId).first<{
    all_count: number;
    error_count: number | null;
    update_count: number | null;
    unread_count: number | null;
  }>();
  return {
    all: Number(row?.all_count ?? 0),
    error: Number(row?.error_count ?? 0),
    update: Number(row?.update_count ?? 0),
    unread: Number(row?.unread_count ?? 0),
  };
}

export async function markNotificationRead(
  db: D1Database,
  input: { notificationId: string; lineAccountId: string; staffId: string },
): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`
    INSERT OR REPLACE INTO staff_notification_reads (notification_id, staff_id, read_at)
    SELECT n.id, ?, ? FROM notifications n
    WHERE n.id = ? AND n.line_account_id = ? AND n.channel IN ('dashboard', 'center') AND ${assignmentNoticeVisible('n')}
  `).bind(input.staffId, now, input.notificationId, input.lineAccountId, input.staffId).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  input: {
    lineAccountId: string;
    staffId: string;
    category?: 'error' | 'update';
  },
): Promise<number> {
  const conditions = ['n.line_account_id = ?', "n.channel IN ('dashboard', 'center')", assignmentNoticeVisible('n')];
  const values: unknown[] = [input.staffId, jstNow(), input.lineAccountId, input.staffId];
  if (input.category) {
    conditions.push('n.category = ?');
    values.push(input.category);
  }
  const result = await db.prepare(`
    INSERT OR REPLACE INTO staff_notification_reads (notification_id, staff_id, read_at)
    SELECT n.id, ?, ? FROM notifications n
    WHERE ${conditions.join(' AND ')}
  `).bind(...values).run();
  return Number(result.meta.changes ?? 0);
}

/** イベントタイプに一致するアクティブな通知ルールを取得 */
export async function getActiveNotificationRulesByEvent(
  db: D1Database,
  eventType: string,
  lineAccountId: string,
): Promise<NotificationRuleRow[]> {
  const result = await db.prepare(
    `SELECT * FROM notification_rules
      WHERE event_type = ? AND line_account_id = ? AND is_active = 1`,
  ).bind(eventType, lineAccountId).all<NotificationRuleRow>();
  return result.results;
}
