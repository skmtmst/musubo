import { logger } from '@line-crm/shared/server';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import {
  getCalendarConnections,
  getCalendarConnectionById,
  createCalendarConnection,
  deleteCalendarConnection,
  getCalendarBookings,
  getCalendarBookingById,
  createCalendarBooking,
  updateCalendarBookingStatus,
  updateCalendarBookingEventId,
  getBookingsInRange,
  getFriendById,
  type CalendarAccountScope,
  toJstString,
  decryptCredential,
} from '@line-crm/db';
import { fail } from '../lib/fail.js';
import { GoogleCalendarClient } from '../services/google-calendar.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import type { Env } from '../worker-env.js';

const calendar = new Hono<Env>();

async function resolveCalendarScope(c: Context<Env>): Promise<CalendarAccountScope> {
  const visible = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  return {
    allowedAccountIds: visible.allowedAccountIds,
    includeUnassigned: visible.canSeeUnassigned,
  };
}

function canUseConnectionForFriend(
  connectionAccountId: string | null,
  friendAccountId: string | null,
): boolean {
  return connectionAccountId === friendAccountId;
}

// ========== 接続管理 ==========

calendar.get('/api/integrations/google-calendar', requireRole('owner', 'admin'), async (c) => {
  try {
    const scope = await resolveCalendarScope(c);
    const items = await getCalendarConnections(c.env.DB, scope);
    return c.json({
      success: true,
      data: items.map((conn) => ({
        id: conn.id,
        calendarId: conn.calendar_id,
        authType: conn.auth_type,
        isActive: Boolean(conn.is_active),
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
      })),
    });
  } catch (err) {
    throw err;
  }
});

calendar.post('/api/integrations/google-calendar/connect', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"calendarId":["string"],"authType":["string"],"accessToken":["string"],"refreshToken":["string"],"apiKey":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ accountId: string; calendarId: string; authType: string; accessToken?: string; refreshToken?: string; apiKey?: string }>();
    if (!body.accountId || !body.calendarId) {
      return fail(c, 400, 'ACCOUNT_ID_AND_CALENDAR_ID_ARE_REQUIRED', {}, ["accountId","calendarId"]);
    }
    const scope = await resolveCalendarScope(c);
    if (!scope.allowedAccountIds.includes(body.accountId)) {
      return c.json({ success: false, error: 'Forbidden account' }, 403);
    }
    const conn = await createCalendarConnection(c.env.DB, {
      calendarId: body.calendarId,
      authType: body.authType,
      lineAccountId: body.accountId,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      apiKey: body.apiKey,
    }, scope, c.env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY);
    if (!conn) return c.json({ success: false, error: 'meeting_disconnect_in_progress', message: '解除の処理中です。少し待ってからつなぎ直してください。' }, 409);
    return c.json({
      success: true,
      data: { id: conn.id, calendarId: conn.calendar_id, authType: conn.auth_type, isActive: Boolean(conn.is_active), createdAt: conn.created_at },
    }, 201);
  } catch (err) {
    throw err;
  }
});

calendar.delete('/api/integrations/google-calendar/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const scope = await resolveCalendarScope(c);
    const deleted = await deleteCalendarConnection(c.env.DB, c.req.param('id'), scope);
    if (!deleted) return fail(c, 404, 'CALENDAR_CONNECTION_NOT_FOUND');
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

// ========== 空きスロット取得 ==========

calendar.get('/api/integrations/google-calendar/slots', requireRole('owner', 'admin'), async (c) => {
  try {
    const connectionId = c.req.query('connectionId');
    const date = c.req.query('date'); // YYYY-MM-DD
    const slotMinutes = Number(c.req.query('slotMinutes') ?? '60');
    const startHour = Number(c.req.query('startHour') ?? '9');
    const endHour = Number(c.req.query('endHour') ?? '18');

    if (!connectionId || !date) {
      return c.json({ success: false, error: 'connectionId and date are required' }, 400);
    }

    const scope = await resolveCalendarScope(c);
    const conn = await getCalendarConnectionById(c.env.DB, connectionId, scope);
    if (!conn) {
      return fail(c, 404, 'CALENDAR_CONNECTION_NOT_FOUND');
    }

    const dayStart = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
    const dayEnd = `${date}T${String(endHour).padStart(2, '0')}:00:00`;

    // 既存D1予約を取得
    const bookings = await getBookingsInRange(c.env.DB, connectionId, dayStart, dayEnd, scope);

    // Google FreeBusy API から busy 区間を取得（access_token がある場合のみ）
    let googleBusyIntervals: { start: string; end: string }[] = [];
    if (conn.access_token) {
      const accessToken = await decryptCredential(conn.access_token, c.env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY);
      try {
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken,
        });
        // タイムゾーンオフセットを付けて ISO 形式で渡す（Asia/Tokyo = +09:00）
        const timeMin = `${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`;
        const timeMax = `${date}T${String(endHour).padStart(2, '0')}:00:00+09:00`;
        googleBusyIntervals = await gcal.getFreeBusy(timeMin, timeMax);
      } catch (err) {
        // Google API 失敗はベストエフォート — D1 のみでフォールバック
        logger.warn("calendar.read_free_busy_failed");
      }
    }

    // スロットを生成して空きを計算
    const slots: { startAt: string; endAt: string; available: boolean }[] = [];
    const baseDate = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`);

    for (let h = startHour; h < endHour; h += slotMinutes / 60) {
      const slotStart = new Date(baseDate);
      slotStart.setMinutes(slotStart.getMinutes() + (h - startHour) * 60);
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);

      const startStr = toJstString(slotStart);
      const endStr = toJstString(slotEnd);

      // D1 予約との重複チェック
      const isBookedInD1 = bookings.some((b) => {
        const bStart = new Date(b.start_at).getTime();
        const bEnd = new Date(b.end_at).getTime();
        return slotStart.getTime() < bEnd && slotEnd.getTime() > bStart;
      });

      // Google busy 区間との重複チェック
      const isBookedInGoogle = googleBusyIntervals.some((interval) => {
        const gStart = new Date(interval.start).getTime();
        const gEnd = new Date(interval.end).getTime();
        return slotStart.getTime() < gEnd && slotEnd.getTime() > gStart;
      });

      slots.push({ startAt: startStr, endAt: endStr, available: !isBookedInD1 && !isBookedInGoogle });
    }

    return c.json({ success: true, data: slots });
  } catch (err) {
    throw err;
  }
});

// ========== 予約管理 ==========

calendar.get('/api/integrations/google-calendar/bookings', requireRole('owner', 'admin'), async (c) => {
  try {
    const connectionId = c.req.query('connectionId');
    const friendId = c.req.query('friendId');
    const scope = await resolveCalendarScope(c);
    if (connectionId && !await getCalendarConnectionById(c.env.DB, connectionId, scope)) {
      return fail(c, 404, 'CALENDAR_CONNECTION_NOT_FOUND');
    }
    if (friendId) {
      const friend = await getFriendById(c.env.DB, friendId);
      const friendVisible = friend && (friend.line_account_id === null
        ? scope.includeUnassigned
        : scope.allowedAccountIds.includes(friend.line_account_id));
      if (!friendVisible) return fail(c, 404, 'FRIEND_NOT_FOUND');
    }
    const items = await getCalendarBookings(c.env.DB, scope, {
      connectionId: connectionId ?? undefined,
      friendId: friendId ?? undefined,
    });
    return c.json({
      success: true,
      data: items.map((b) => ({
        id: b.id,
        connectionId: b.connection_id,
        friendId: b.friend_id,
        eventId: b.event_id,
        title: b.title,
        startAt: b.start_at,
        endAt: b.end_at,
        status: b.status,
        metadata: b.metadata ? JSON.parse(b.metadata) : null,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    throw err;
  }
});

calendar.post('/api/integrations/google-calendar/book', requireRole('owner', 'admin'), inputJsonBoundary({"connectionId":["string"],"friendId":["string"],"title":["string"],"startAt":["string"],"endAt":["string"],"description":["string"],"metadata":["object"]}), async (c) => {
  try {
    const body = await c.req.json<{ connectionId: string; friendId?: string; title: string; startAt: string; endAt: string; description?: string; metadata?: Record<string, unknown> }>();
    if (!body.connectionId || !body.title || !body.startAt || !body.endAt) {
      return inputError(c, { success: false, error: 'connectionId, title, startAt, endAt are required' }, 400, ["connectionId","title","startAt","endAt"]);
    }

    const scope = await resolveCalendarScope(c);
    const conn = await getCalendarConnectionById(c.env.DB, body.connectionId, scope);
    if (!conn) return fail(c, 404, 'CALENDAR_CONNECTION_NOT_FOUND');
    // 不正な鍵や平文で予約だけが保存されないよう、書込前に資格情報を解決する。
    const accessToken = conn.access_token
      ? await decryptCredential(conn.access_token, c.env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY) : null;

    if (body.friendId) {
      const friend = await getFriendById(c.env.DB, body.friendId);
      if (!friend || !canUseConnectionForFriend(conn.line_account_id, friend.line_account_id)) {
        return fail(c, 404, 'FRIEND_NOT_FOUND');
      }
    }

    // D1 に予約レコードを作成
    const booking = await createCalendarBooking(c.env.DB, {
      ...body,
      metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
    }, scope);
    if (!booking) return fail(c, 404, 'CALENDAR_CONNECTION_NOT_FOUND');

    // Google Calendar にイベントを作成（access_token がある場合のみ、ベストエフォート）
    if (accessToken) {
      try {
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken,
        });
        const { eventId } = await gcal.createEvent({
          summary: body.title,
          start: body.startAt,
          end: body.endAt,
          description: body.description,
        });
        // event_id を D1 予約レコードに保存
        const linked = await updateCalendarBookingEventId(c.env.DB, booking.id, eventId, scope);
        if (!linked) {
          try {
            await gcal.deleteEvent(eventId);
          } catch (cleanupError) {
            logger.warn("calendar.delete_unsaved_event_failed");
          }
          return c.json({ success: false, error: 'Calendar booking changed during sync' }, 409);
        }
        booking.event_id = eventId;
      } catch (err) {
        // Google API 失敗はベストエフォート — D1 予約は維持する
        logger.warn("calendar.create_event_failed");
      }
    }

    return c.json({
      success: true,
      data: {
        id: booking.id,
        connectionId: booking.connection_id,
        friendId: booking.friend_id,
        eventId: booking.event_id,
        title: booking.title,
        startAt: booking.start_at,
        endAt: booking.end_at,
        status: booking.status,
        createdAt: booking.created_at,
      },
    }, 201);
  } catch (err) {
    throw err;
  }
});

calendar.put('/api/integrations/google-calendar/bookings/:id/status', requireRole('owner', 'admin'), inputJsonBoundary({"status":["string"]}), async (c) => {
  try {
    const id = c.req.param('id');
    const { status } = await c.req.json<{ status: string }>();
    const scope = await resolveCalendarScope(c);
    const booking = await getCalendarBookingById(c.env.DB, id, scope);
    if (!booking) return fail(c, 404, 'CALENDAR_BOOKING_NOT_FOUND');

    const conn = status === 'cancelled' && booking.event_id && booking.connection_id
      ? await getCalendarConnectionById(c.env.DB, booking.connection_id, scope) : null;
    const accessToken = conn?.access_token
      ? await decryptCredential(conn.access_token, c.env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY) : null;

    const updated = await updateCalendarBookingStatus(c.env.DB, id, status, scope);
    if (!updated) return fail(c, 404, 'CALENDAR_BOOKING_NOT_FOUND');

    // DB更新後に、Google Calendar のイベントも削除する（ベストエフォート）
    if (status === 'cancelled') {
      if (booking.event_id && booking.connection_id) {
        if (conn && accessToken) {
          try {
            const gcal = new GoogleCalendarClient({
              calendarId: conn.calendar_id,
              accessToken,
            });
            await gcal.deleteEvent(booking.event_id);
          } catch (err) {
            logger.warn("calendar.delete_cancelled_event_failed");
          }
        }
      }
    }

    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

export { calendar };
