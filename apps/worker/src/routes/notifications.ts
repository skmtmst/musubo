import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { jstDate as japanDate } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import {
  getNotificationRules,
  getOperatorNotificationTeam,
  operatorRuleRecipientIds,
  getNotificationRuleById,
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  getNotifications,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import { lineTokenNoticeDisplay } from '../services/line-token-notices.js';
import {
  OperatorEventError,
  dispatchOperatorEvent,
  dispatchOperatorRule,
  operatorRecipients,
  recipientPreview,
  ruleChannels,
  ruleConditions,
  sweepOperatorNotifications,
} from '../services/operator-notification-dispatch.js';
import {
  isKnownOperatorEventType,
  listOperatorEventTypes,
} from '../services/operator-notification-registry.js';

import { notificationTeams } from './notification-teams.js';
const notifications = new Hono<Env>();
notifications.route('/', notificationTeams);

const OPERATOR_NOTIFICATION_CHANNELS = new Set(['dashboard', 'email', 'line','push']);

function serializeRule(item: Awaited<ReturnType<typeof getNotificationRuleById>> extends infer T
  ? Exclude<T, null>
  : never) {
  return {
    id: item.id,
    name: item.name,
    eventType: item.event_type,
    conditions: JSON.parse(item.conditions),
    channels: JSON.parse(item.channels),
    isActive: Boolean(item.is_active),
    version: Number((item as { version?: unknown }).version ?? 1),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function normalizeChannels(channels: unknown): string[] | null {
  if (!Array.isArray(channels) || channels.length === 0) return ['dashboard'];
  if (!channels.every((channel) => typeof channel === 'string' && OPERATOR_NOTIFICATION_CHANNELS.has(channel))) {
    return null;
  }
  return [...new Set(channels)];
}

// ========== 通知ルールCRUD ==========

notifications.get('/api/notifications/rules', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const items = await getNotificationRules(c.env.DB, lineAccountId);
    return c.json({
      success: true,
      data: items.map((item) => serializeRule(item)),
    });
  } catch (err) {
    throw err;
  }
});

const listOperatorRules = async (c: Context<Env>) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const rules = await getNotificationRules(c.env.DB, lineAccountId);
    const today = japanDate();
    const activity = await c.env.DB.prepare(`
      SELECT i.definition_id AS rule_id,
             COUNT(DISTINCT i.id) AS occurred_today,
             SUM(CASE WHEN d.status = 'provider_accepted' THEN 1 ELSE 0 END) AS accepted_today,
             SUM(CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END) AS excluded_today,
             MAX(i.created_at) AS last_occurred_at
        FROM notification_instances i
        LEFT JOIN notification_deliveries d
          ON d.instance_id = i.id AND d.line_account_id = i.line_account_id
       WHERE i.line_account_id = ? AND i.audience_type = 'operator'
         AND date(i.created_at, '+9 hours') = ?
       GROUP BY i.definition_id
    `).bind(lineAccountId, today).all<{
      rule_id: string; occurred_today: number; accepted_today: number;
      excluded_today: number; last_occurred_at: string | null;
    }>();
    const byRule = new Map((activity.results ?? []).map((row) => [row.rule_id, row]));
    const resolvedRecipientIds = new Set<string>();
    const items = await Promise.all(rules.map(async (rule) => {
      const conditions = ruleConditions(rule);
      const recipients = await operatorRecipients(c.env.DB, lineAccountId, await operatorRuleRecipientIds(c.env.DB, lineAccountId, conditions));
      const preview = recipients.map((recipient) => recipientPreview(recipient, ruleChannels(rule)));
      for (const recipient of preview) {
        if (recipient.canReceive) resolvedRecipientIds.add(recipient.id);
      }
      const stats = byRule.get(rule.id);
      return {
        ...serializeRule(rule),
        status: rule.is_active ? 'published' : 'draft',
        recipientCount: preview.filter((item) => item.canReceive).length,
        lineRecipientCount: preview.filter((item) => item.channels.line).length,
        occurredToday: Number(stats?.occurred_today ?? 0),
        acceptedToday: Number(stats?.accepted_today ?? 0),
        excludedToday: Number(stats?.excluded_today ?? 0),
        lastOccurredAt: stats?.last_occurred_at ?? null,
      };
    }));
    return c.json({
      success: true,
      data: {
        items,
        summary: {
          total: items.length,
          published: items.filter((item) => item.status === 'published').length,
          stopped: items.filter((item) => item.status !== 'published').length,
          missingRecipients: items.filter((item) => item.recipientCount === 0).length,
          recipients: resolvedRecipientIds.size,
          acceptedToday: items.reduce((sum, item) => sum + item.acceptedToday, 0),
          excludedToday: items.reduce((sum, item) => sum + item.excludedToday, 0),
        },
      },
    });
  } catch (err) {
    throw err;
  }
};

notifications.get('/api/notifications/operator-rules', requireRole('owner', 'admin'), listOperatorRules);
//  要件の正本名は /api/line-notifications。旧パスも残す。
notifications.get('/api/line-notifications/operator-rules', requireRole('owner', 'admin'), listOperatorRules);

const previewOperatorRecipients = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: string; recipientIds?: string[]; channels?: string[];
    }>();
    const lineAccountId = body.lineAccountId?.trim();
    const channels = normalizeChannels(body.channels);
    if (!lineAccountId || !channels) {
      return inputError(c, { success: false, error: 'LINEアカウントと通知方法を確認してください' }, 400, ["lineAccountId","channels"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const recipients = await operatorRecipients(c.env.DB, lineAccountId, body.recipientIds);
    const items = recipients.map((recipient) => recipientPreview(recipient, channels));
    return c.json({
      success: true,
      data: {
        items,
        summary: {
          staff: items.length,
          canReceive: items.filter((item) => item.canReceive).length,
          line: items.filter((item) => item.channels.line).length,
          email: items.filter((item) => item.channels.email).length,
          dashboard: items.filter((item) => item.channels.dashboard).length,
          unavailable: items.filter((item) => !item.canReceive).length,
        },
      },
    });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/operator-rules/recipients-preview', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"recipientIds":["array"],"channels":["array"]}), previewOperatorRecipients);
notifications.post('/api/line-notifications/operator-rules/recipients-preview', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"recipientIds":["array"],"channels":["array"]}), previewOperatorRecipients);

/**
 * ルール1件を指定するプレビュー。保存済みルールの受け取る人・
 * 通知方法を既定にし、本文で上書きもできる。作る前のプレビューは
 * 上の集合口(recipients-preview)を使う。
 */
const previewOperatorRuleRecipients = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: string; recipientIds?: string[]; channels?: string[];
    }>().catch((): { lineAccountId?: string; recipientIds?: string[]; channels?: string[] } => ({}));
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) {
      return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const rule = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!rule) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    const channels = body.channels === undefined ? ruleChannels(rule) : normalizeChannels(body.channels);
    if (!channels) {
      return inputError(c, { success: false, error: '利用できない通知方法が含まれています' }, 400, ["channels","lineAccountId"]);
    }
    const recipientIds = body.recipientIds ?? await operatorRuleRecipientIds(c.env.DB, lineAccountId, ruleConditions(rule));
    const recipients = await operatorRecipients(c.env.DB, lineAccountId, recipientIds);
    const items = recipients.map((recipient) => recipientPreview(recipient, channels));
    return c.json({
      success: true,
      data: {
        items,
        summary: {
          staff: items.length,
          canReceive: items.filter((item) => item.canReceive).length,
          line: items.filter((item) => item.channels.line).length,
          email: items.filter((item) => item.channels.email).length,
          dashboard: items.filter((item) => item.channels.dashboard).length,
          unavailable: items.filter((item) => !item.canReceive).length,
        },
      },
    });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/line-notifications/operator-rules/:id/recipients-preview', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"recipientIds":["array"],"channels":["array"]}), previewOperatorRuleRecipients);

const publishOperatorRule = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string }>();
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const rule = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!rule) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    /*
     * 登録簿に無いきっかけは、公開できても自動発火しない(dispatch が
     * unknown_event_type で断る)。公開の時点で断らないと「公開したのに
     * 届かない」を静かに作る。 の芯はそこなので、ここで閉じる。
     *
     * 画面の選択肢も登録簿に合わせてあるが、この口は API を直接叩いても
     * 通るので、入口の数だけ塞いでおく。
     */
    if (!isKnownOperatorEventType(rule.event_type)) {
      return c.json({
        success: false,
        code: 'event_type_not_connected',
        error: 'このきっかけでは自動でお知らせできません。きっかけを選び直してください。',
      }, 409);
    }
    const conditions = ruleConditions(rule);
    const recipientIds = await operatorRuleRecipientIds(c.env.DB, lineAccountId, conditions);
    if (!recipientIds?.length) {
      return c.json({ success: false, code: 'recipient_required', error: '受け取るスタッフを1人以上選んでください' }, 409);
    }
    const recipients = await operatorRecipients(c.env.DB, lineAccountId, await operatorRuleRecipientIds(c.env.DB, lineAccountId, conditions));
    const deliverable = recipients.map((recipient) => recipientPreview(recipient, ruleChannels(rule)))
      .filter((recipient) => recipient.canReceive);
    if (deliverable.length === 0) {
      return c.json({ success: false, code: 'recipient_unavailable', error: '現在受け取れるスタッフがいません' }, 409);
    }
    await updateNotificationRule(c.env.DB, rule.id, lineAccountId, { isActive: true });
    const updated = await getNotificationRuleById(c.env.DB, rule.id, lineAccountId);
    auditLog(c, 'operator_notification.rule.publish', { kind: 'notification_rule', id: rule.id });
    return c.json({ success: true, data: updated ? serializeRule(updated) : null });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/operator-rules/:id/publish', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"]}), publishOperatorRule);
notifications.post('/api/line-notifications/operator-rules/:id/publish', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"]}), publishOperatorRule);

/**
 * 公開の反対。停止は新規受付を止めるだけで、送信中のものは
 * 無断で取り消さない(要件 §5-1)。
 */
const stopOperatorRule = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string }>();
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const rule = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!rule) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    await updateNotificationRule(c.env.DB, rule.id, lineAccountId, { isActive: false });
    const updated = await getNotificationRuleById(c.env.DB, rule.id, lineAccountId);
    auditLog(c, 'operator_notification.rule.stop', { kind: 'notification_rule', id: rule.id });
    return c.json({ success: true, data: updated ? serializeRule(updated) : null });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/line-notifications/operator-rules/:id/stop', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"]}), stopOperatorRule);

const testOperatorRule = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string; message?: string }>();
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const rule = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!rule) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    const recipients = await operatorRecipients(c.env.DB, lineAccountId, [c.get('staff').id]);
    if (recipients.length === 0) {
      return c.json({ success: false, code: 'recipient_unavailable', error: '自分の受信設定を確認してください' }, 409);
    }
    const sourceEventId = `test:${c.get('staff').id}:${crypto.randomUUID()}`;
    const result = await dispatchOperatorRule(c.env.DB, c.env, rule, {
      lineAccountId, sourceEventId, message: body.message, executionMode: 'test',
      recipientIds: [c.get('staff').id],
    });
    auditLog(c, 'operator_notification.rule.test', { kind: 'notification_rule', id: rule.id });
    return c.json({ success: true, data: result });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/operator-rules/:id/test', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"message":["string"]}), testOperatorRule);
notifications.post('/api/line-notifications/operator-rules/:id/test', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"message":["string"]}), testOperatorRule);

const dispatchOperatorEventRoute = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: string; eventType?: string; sourceEventId?: string; message?: string;
    }>();
    const lineAccountId = body.lineAccountId?.trim();
    const eventType = body.eventType?.trim();
    const sourceEventId = body.sourceEventId?.trim();
    if (!lineAccountId || !eventType || !sourceEventId) {
      return inputError(c, { success: false, error: 'LINEアカウント、きっかけ、発生元IDは必須です' }, 400, ["lineAccountId","eventType","sourceEventId"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    try {
      const dispatched = await dispatchOperatorEvent(c.env.DB, c.env, {
        lineAccountId, eventType, sourceEventId, message: body.message, executionMode: 'automatic',
      });
      return c.json({ success: true, data: { rules: dispatched } });
    } catch (err) {
      if (err instanceof OperatorEventError && err.code === 'unknown_event_type') {
        return inputError(c, { success: false, code: err.code, error: err.message }, 400, ["eventType"]);
      }
      throw err;
    }
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/operator-events', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"eventType":["string"],"sourceEventId":["string"],"message":["string"]}), dispatchOperatorEventRoute);
notifications.post('/api/line-notifications/operator-events', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"eventType":["string"],"sourceEventId":["string"],"message":["string"]}), dispatchOperatorEventRoute);

const listOperatorEventTypesRoute = async (c: Context<Env>) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const items = listOperatorEventTypes();
    const published = await c.env.DB.prepare(`
      SELECT event_type, COUNT(*) AS count FROM notification_rules
       WHERE line_account_id = ? AND is_active = 1 GROUP BY event_type
    `).bind(lineAccountId).all<{ event_type: string; count: number }>();
    const publishedByType = new Map((published.results ?? []).map((row) => [row.event_type, Number(row.count)]));
    return c.json({
      success: true,
      data: {
        items: items.map((item) => ({
          ...item,
          publishedRules: publishedByType.get(item.eventType) ?? 0,
        })),
        summary: {
          total: items.length,
          connected: items.filter((item) => item.connected).length,
          unconnected: items.filter((item) => !item.connected).length,
        },
      },
    });
  } catch (err) {
    throw err;
  }
};

notifications.get('/api/notifications/operator-event-types', requireRole('owner', 'admin'), listOperatorEventTypesRoute);
notifications.get('/api/line-notifications/operator-event-types', requireRole('owner', 'admin'), listOperatorEventTypesRoute);

const sweepOperatorOutbox = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string; limit?: number }>()
      .catch((): { lineAccountId?: string; limit?: number } => ({}));
    const lineAccountId = body.lineAccountId?.trim() || undefined;
    if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const result = await sweepOperatorNotifications(c.env.DB, c.env, {
      lineAccountId,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/operator-outbox/sweep', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"limit":["number"]}), sweepOperatorOutbox);
notifications.post('/api/line-notifications/operator-outbox/sweep', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"limit":["number"]}), sweepOperatorOutbox);

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const exportOperatorDeliveriesCsv = async (c: Context<Env>) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    const reason = c.req.query('reason')?.trim();
    if (!lineAccountId || !reason) {
      return inputError(c, { success: false, error: 'LINEアカウントと出力理由は必須です' }, 400, ["lineAccountId","reason"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを出力する権限がありません' }, 403);
    }
    const rows = await c.env.DB.prepare(`
      SELECT r.name AS rule_name, i.source_event_type, d.recipient_id, sm.name AS recipient_name,
             d.channel, d.status, d.attempts, d.execution_mode, d.queued_at, d.accepted_at,
             d.error_message_safe
        FROM notification_deliveries d
        JOIN notification_instances i ON i.id = d.instance_id AND i.line_account_id = d.line_account_id
        LEFT JOIN notification_rules r ON r.id = i.definition_id AND r.line_account_id = d.line_account_id
        LEFT JOIN staff_members sm ON sm.id = d.recipient_id
       WHERE d.line_account_id = ? AND d.audience_type = 'operator'
       ORDER BY d.queued_at DESC, d.id DESC LIMIT 5000
    `).bind(lineAccountId).all<Record<string, unknown>>();
    const modeLabel = (mode: unknown): string => {
      if (mode === 'test') return 'テスト';
      if (mode === 'retry' || mode === 'resend') return '再送';
      return '自動';
    };
    const headings = ['お知らせ', 'きっかけ', '受け取る人', '通知方法', '状態', '試行回数', '実行区分', '受付日時', 'LINE API受付日時', '理由'];
    c.set('outputAudit', { count: rows.results?.length ?? 0, accountId: lineAccountId });
    const lines = [headings, ...(rows.results ?? []).map((row) => [
      row.rule_name, row.source_event_type, row.recipient_name, row.channel,
      row.status, row.attempts, modeLabel(row.execution_mode),
      row.queued_at, row.accepted_at, row.error_message_safe,
    ])].map((row) => row.map(csvCell).join(','));
    await c.env.DB.prepare(`
      INSERT INTO operation_audit
        (id, target_kind, target_id, action, actor_id, detail_json, created_at)
      VALUES (?, 'notification_delivery', ?, 'exported', ?, ?, ?)
    `).bind(
      crypto.randomUUID(), lineAccountId, c.get('staff').id,
      JSON.stringify({ reason: reason.slice(0, 200), count: rows.results?.length ?? 0 }),
      new Date().toISOString(),
    ).run();
    auditLog(c, 'operator_notification.delivery.export', {
      kind: 'notification_delivery', id: lineAccountId,
    });
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="operator-notifications-${japanDate()}.csv"`,
      },
    });
  } catch (err) {
    throw err;
  }
};

notifications.get('/api/notifications/operator-deliveries.csv', requireRole('owner'), exportOperatorDeliveriesCsv);
notifications.get('/api/line-notifications/operator-deliveries.csv', requireRole('owner'), exportOperatorDeliveriesCsv);

const getOperatorRule = async (c: Context<Env>) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const item = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: serializeRule(item),
    });
  } catch (err) {
    throw err;
  }
};

notifications.get('/api/notifications/rules/:id', requireRole('owner', 'admin'), getOperatorRule);
notifications.get('/api/line-notifications/operator-rules/:id', requireRole('owner', 'admin'), getOperatorRule);

const createOperatorRule = async (c: Context<Env>) => {
  try {
    const body = await c.req.json<{ lineAccountId: string; name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }>();
    const lineAccountId = body.lineAccountId?.trim();
    const name = body.name?.trim();
    const eventType = body.eventType?.trim();
    const channels = normalizeChannels(body.channels);
    if (!lineAccountId || !name || !eventType) {
      return inputError(c, { success: false, error: 'LINEアカウント、名前、きっかけは必須です' }, 400, ["lineAccountId","name","eventType"]);
    }
    if (!channels) return inputError(c, { success: false, error: '利用できない通知方法が含まれています' }, 400, ["channels"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    if (body.conditions?.teamId !== undefined && (typeof body.conditions.teamId !== 'string' || !body.conditions.teamId || !await getOperatorNotificationTeam(c.env.DB, body.conditions.teamId, lineAccountId))) {
      return inputError(c, { success: false, error: '選んだチームが見つかりません。読み直してください' }, 422, ["conditions","lineAccountId"]);
    }
    const item = await createNotificationRule(c.env.DB, {
      lineAccountId,
      name,
      eventType,
      conditions: body.conditions,
      channels,
    });
    return c.json({
      success: true,
      data: serializeRule(item),
    }, 201);
  } catch (err) {
    throw err;
  }
};

notifications.post('/api/notifications/rules', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"name":["string"],"eventType":["string"],"conditions":["object"],"channels":["array"]}), createOperatorRule);
notifications.post('/api/line-notifications/operator-rules', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"name":["string"],"eventType":["string"],"conditions":["object"],"channels":["array"]}), createOperatorRule);

const updateOperatorRule = async (c: Context<Env>) => {
  try {
    const id = c.req.param('id') ?? '';
    const body = await c.req.json<{
      lineAccountId: string;
      name?: string;
      eventType?: string;
      conditions?: Record<string, unknown>;
      channels?: string[];
      isActive?: boolean;
    }>();
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (body.isActive === true) {
      return c.json({
        success: false,
        error: '受け取る人と送信処理を接続するまで、運用者へのお知らせは公開できません',
      }, 409);
    }
    const channels = body.channels === undefined ? undefined : normalizeChannels(body.channels);
    if (channels === null) return inputError(c, { success: false, error: '利用できない通知方法が含まれています' }, 400, ["channels"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const current = await getNotificationRuleById(c.env.DB, id, lineAccountId);
    if (!current) return c.json({ success: false, error: 'Not found' }, 404);
    if (body.conditions?.teamId !== undefined && (typeof body.conditions.teamId !== 'string' || !body.conditions.teamId || !await getOperatorNotificationTeam(c.env.DB, body.conditions.teamId, lineAccountId))) {
      return inputError(c, { success: false, error: '選んだチームが見つかりません。読み直してください' }, 422, ["conditions","lineAccountId"]);
    }
    await updateNotificationRule(c.env.DB, id, lineAccountId, {
      name: body.name,
      eventType: body.eventType,
      conditions: body.conditions,
      channels,
      isActive: body.isActive,
    });
    const updated = await getNotificationRuleById(c.env.DB, id, lineAccountId);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: serializeRule(updated),
    });
  } catch (err) {
    throw err;
  }
};

notifications.put('/api/notifications/rules/:id', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"name":["string"],"eventType":["string"],"conditions":["object"],"channels":["array"],"isActive":["boolean"]}), updateOperatorRule);

/*
 * 要件の正本名は PATCH .../operator-rules/:id/draft。下書きの
 * 編集だけを受け、公開・停止はそれぞれの口へ分ける(ここで isActive を
 * 触らせない)。内容は PUT /api/notifications/rules/:id と同じ検証。
 */
const updateOperatorRuleDraft = async (c: Context<Env>) => {
  try {
    const id = c.req.param('id') ?? '';
    const body = await c.req.json<{
      lineAccountId: string;
      expectedVersion?: unknown;
      name?: string;
      eventType?: string;
      conditions?: Record<string, unknown>;
      channels?: string[];
      isActive?: boolean;
    }>();
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    // 顧客通知の下書きとそろえ、読んだ版を必須にする。版なしの保存は
    // 古い画面からの上書きを許すので受け付けない。
    const expectedVersion = typeof body.expectedVersion === 'number'
      && Number.isInteger(body.expectedVersion) && body.expectedVersion > 0
      ? body.expectedVersion
      : null;
    if (!expectedVersion) {
      return inputError(c, { success: false, error: 'LINEアカウントと現在の版は必須です' }, 400, ["expectedVersion"]);
    }
    if (body.isActive !== undefined) {
      return c.json({
        success: false,
        code: 'use_publish_or_stop',
        error: '公開・停止は、それぞれの操作で行ってください',
      }, 409);
    }
    const channels = body.channels === undefined ? undefined : normalizeChannels(body.channels);
    if (channels === null) return inputError(c, { success: false, error: '利用できない通知方法が含まれています' }, 400, ["channels"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const current = await getNotificationRuleById(c.env.DB, id, lineAccountId);
    if (!current) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    if (body.conditions?.teamId !== undefined && (typeof body.conditions.teamId !== 'string' || !body.conditions.teamId || !await getOperatorNotificationTeam(c.env.DB, body.conditions.teamId, lineAccountId))) {
      return inputError(c, { success: false, error: '選んだチームが見つかりません。読み直してください' }, 422, ["conditions","lineAccountId"]);
    }
    const saved = await updateNotificationRule(c.env.DB, id, lineAccountId, {
      name: body.name,
      eventType: body.eventType,
      conditions: body.conditions,
      channels,
    }, { expectedVersion });
    if (!saved) {
      // 読んだ後にほかの担当者が保存した。先行内容は保たれたまま、
      // 比較と開き直しのために現在値を返す。
      const latest = await getNotificationRuleById(c.env.DB, id, lineAccountId);
      if (!latest) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
      return c.json({
        success: false,
        code: 'version_conflict',
        error: 'ほかの担当者が先に保存しました。開き直して内容を確認してください',
        data: { current: serializeRule(latest) },
      }, 409);
    }
    const updated = await getNotificationRuleById(c.env.DB, id, lineAccountId);
    if (!updated) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    return c.json({ success: true, data: serializeRule(updated) });
  } catch (err) {
    throw err;
  }
};

notifications.patch('/api/line-notifications/operator-rules/:id/draft', requireRole('owner', 'admin'), inputJsonBoundary({"lineAccountId":["string"],"name":["string"],"eventType":["string"],"conditions":["object"],"channels":["array"],"isActive":["boolean"]}), updateOperatorRuleDraft);

notifications.delete('/api/notifications/rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const current = await getNotificationRuleById(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    if (!current) return c.json({ success: false, error: 'Not found' }, 404);
    await deleteNotificationRule(c.env.DB, c.req.param('id') ?? '', lineAccountId);
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

// ========== 通知一覧 ==========

notifications.get('/api/notifications', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const limit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 100, limitPolicy: { fallback: 'integer', minimum: 1, maximum: 100 } }).limit;
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const items = await getNotifications(c.env.DB, { lineAccountId, status, limit, staffId:c.get('staff').id });
    const responseItems = items.map((n) => {
      const metadata = n.metadata ? JSON.parse(n.metadata) : null;
      return {
        id: n.id,
        ruleId: n.rule_id,
        eventType: n.event_type,
        ...lineTokenNoticeDisplay(n, metadata),
        channel: n.channel,
        status: n.status,
        metadata,
        createdAt: n.created_at,
      };
    });
    return c.json(buildOffsetListResponse({ success: true, data: responseItems, items: responseItems, total: null, paging: { limit, offset: 0 }, sort: [] }));
  } catch (err) {
    throw err;
  }
});

export { notifications };
