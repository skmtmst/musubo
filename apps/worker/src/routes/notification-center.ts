import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  getNotificationCenter,
  getNotificationCenterCounts,
  markAllNotificationsRead,
  markNotificationRead,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { lineTokenNoticeDisplay } from '../services/line-token-notices.js';

const notificationCenter = new Hono<Env>();

type NotificationCategory = 'error' | 'update';

function categoryFrom(value: string | undefined): NotificationCategory | undefined | null {
  if (!value || value === 'all') return undefined;
  if (value === 'error' || value === 'update') return value;
  return null;
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  try {
    return value ? JSON.parse(value) as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function canReadAccount(
  db: D1Database,
  staff: Parameters<typeof getVisibleLineAccountScope>[1],
  lineAccountId: string,
): Promise<boolean> {
  const scope = await getVisibleLineAccountScope(db, staff);
  return scope.allowedAccountIds.includes(lineAccountId);
}

/** ダッシュボードの通知パネル。配信状態と既読状態を混ぜない。 */
notificationCenter.get('/api/notifications/center', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canReadAccount(c.env.DB, c.get('staff'), lineAccountId)) {
      return c.json({ success: false, error: 'このLINEアカウントの通知は確認できません' }, 403);
    }
    const category = categoryFrom(c.req.query('category'));
    if (category === null) return c.json({ success: false, error: '通知の種類が正しくありません' }, 400);
    // 未読だけ（ベル・通知の一覧の「未読」）。この担当者の既読で決める。
    const unreadParam = c.req.query('unread');
    if (unreadParam !== undefined && unreadParam !== '' && unreadParam !== '0' && unreadParam !== '1') {
      return c.json({ success: false, error: '未読の指定が正しくありません' }, 400);
    }
    const unreadOnly = unreadParam === '1';
    // 件数（total）は種類ごとの未読を数えていないので、組み合わせは受けない（残りの件数がずれる）。
    if (unreadOnly && category) return c.json({ success: false, error: '未読と種類は一緒に指定できません' }, 400);
    const rawLimit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 20, limitPolicy: {} }).limit;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return c.json({ success: false, error: '表示件数は1〜100で指定してください' }, 400);
    }
    // 通知一覧画面の「さらに読み込む」が使う。パネルは省略して先頭から読む。
    const rawOffset = parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset;
    if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 100000) {
      return c.json({ success: false, error: '開始位置が正しくありません' }, 400);
    }
    const staffId = c.get('staff').id;
    const [items, counts] = await Promise.all([
      getNotificationCenter(c.env.DB, { lineAccountId, staffId, category, ...(unreadOnly ? { unreadOnly } : {}), limit: rawLimit, offset: rawOffset }),
      getNotificationCenterCounts(c.env.DB, { lineAccountId, staffId }),
    ]);
    return c.json({
      success: true,
      data: buildOffsetListResponse({
        items: items.map((item) => {
          const metadata = parseMetadata(item.metadata);
          return {
            id: item.id,
            eventType: item.event_type,
            category: item.category,
            ...lineTokenNoticeDisplay(item, metadata),
            metadata,
            isRead: Boolean(item.read_at),
            createdAt: item.created_at,
          };
        }),
        counts,
        unreadCount: counts.unread,
        total: unreadOnly ? counts.unread : category ? counts[category] : counts.all,
        paging: { limit: rawLimit, offset: rawOffset },
        sort: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }],
      }),
    });
  } catch (err) {
    throw err;
  }
});

notificationCenter.post(
  '/api/notifications/center/read-all',
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary({"lineAccountId":["string"],"category":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string; category?: string }>();
    if (!body.lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canReadAccount(c.env.DB, c.get('staff'), body.lineAccountId)) {
      return c.json({ success: false, error: 'このLINEアカウントの通知は変更できません' }, 403);
    }
    const category = categoryFrom(body.category);
    if (category === null) return inputError(c, { success: false, error: '通知の種類が正しくありません' }, 400, ["category"]);
    const updated = await markAllNotificationsRead(c.env.DB, {
      lineAccountId: body.lineAccountId,
      staffId: c.get('staff').id,
      category,
    });
    return c.json({ success: true, data: { updated } });
  } catch (err) {
    throw err;
  }
  },
);

notificationCenter.post(
  '/api/notifications/center/:id/read',
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary({"lineAccountId":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string }>();
    if (!body.lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canReadAccount(c.env.DB, c.get('staff'), body.lineAccountId)) {
      return c.json({ success: false, error: 'このLINEアカウントの通知は変更できません' }, 403);
    }
    const updated = await markNotificationRead(c.env.DB, {
      notificationId: c.req.param('id'),
      lineAccountId: body.lineAccountId,
      staffId: c.get('staff').id,
    });
    if (!updated) return c.json({ success: false, error: '通知が見つかりません' }, 404);
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
  },
);

export { notificationCenter };
