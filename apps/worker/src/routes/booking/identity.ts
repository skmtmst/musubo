import { tracedFetch as fetch } from '@line-crm/shared/server';
import type { SelfBookingChange } from '../booking-self-meet-sync.js';
import { inputError } from '../../lib/input-errors.js';
import { type Context, type MiddlewareHandler } from 'hono';
import { getLineAccounts } from '@line-crm/db';
import { BOOKING_STAFF_OWN_KEY } from '@line-crm/shared';
import type { Env } from '../../worker-env.js';
import { hasStaffPermission } from '../../middleware/role-guard.js';
import { staffAuditActor } from './notification-input.js';

export async function resolveAccountIdFromLiff(c: Context<Env>): Promise<string | null> {
  const liffId = c.req.query('liffId');
  if (!liffId) return null;
  const acc = await c.env.DB
    .prepare(`SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1`)
    .bind(liffId)
    .first<{ id: string }>();
  return acc?.id ?? null;
}

// 未検証 JWT の aud を信用せず、保存済み LIFF ID が指すアカウントのログインチャネルでトークンを検証する。
export async function verifyCallerLineUserId(c: Context<Env>, expectedAccountId?: string): Promise<string | null> {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const idToken = auth.slice('Bearer '.length).trim();
  if (!idToken) return null;
  const accountId = expectedAccountId ?? await resolveAccountIdFromLiff(c);
  if (!accountId) return null;
  const accounts = await getLineAccounts(c.env.DB);
  const account = accounts.find(row => row.id === accountId);
  if (!account) return null;
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  if (account.login_channel_id) {
    push(account.login_channel_id);
  } else {
    // 保存済みのチャネルも対象アカウントへ限定し、環境の代替値はアカウントが1つの場合だけに使う。
    if (accounts.length === 1) push(c.env.LINE_LOGIN_CHANNEL_ID);
    push(account.liff_id?.split('-')[0]);
    push(account.channel_id);
  }

  for (const channelId of candidates) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (res.ok) {
      const verified = await res.json<{ sub?: string }>();
      if (verified.sub) return verified.sub;
    } else {
      // Provider failure is an authentication failure; do not read/log its body.
    }
  }
  return null;
}

export async function resolveAccountIdAdmin(c: Context<Env>): Promise<string | null> {
  return c.req.query('account_id') ?? null;
}

// F6 本人操作の監査 actor。管理者 staff と区別し 'customer' で残す。
export function selfAuditActor(self: SelfBookingChange | undefined, c: Context<Env>) {
  if (self) return { actorType: 'customer' as const, actorId: self.friendId, actorName: null };
  return staffAuditActor(c);
}

// F6 本人操作の期限・締切 (menu→store)。defaults は一覧と同じ 1440 分。
export async function readSelfBookingRules(
  db: D1Database,
  accountId: string,
  menuId: string,
): Promise<{ cancelDeadlineMinutesBefore: number; cutoffMinutesBefore: number }> {
  const row = await db
    .prepare(
      `SELECT m.cancel_deadline_hours_before AS menu_deadline_hours,
              m.cutoff_hours_before AS menu_cutoff_hours,
              COALESCE(bs.cancel_deadline_minutes_before, 1440) AS store_deadline_minutes,
              COALESCE(bs.cutoff_minutes_before, 1440) AS store_cutoff_minutes
         FROM menus m
         LEFT JOIN booking_settings bs ON bs.line_account_id = m.line_account_id
        WHERE m.id = ? AND m.line_account_id = ?`,
    )
    .bind(menuId, accountId)
    .first<{
      menu_deadline_hours: number | null;
      menu_cutoff_hours: number | null;
      store_deadline_minutes: number;
      store_cutoff_minutes: number;
    }>();
  if (!row) return { cancelDeadlineMinutesBefore: 1440, cutoffMinutesBefore: 1440 };
  return {
    cancelDeadlineMinutesBefore: row.menu_deadline_hours == null
      ? Number(row.store_deadline_minutes)
      : Number(row.menu_deadline_hours) * 60,
    cutoffMinutesBefore: row.menu_cutoff_hours == null
      ? Number(row.store_cutoff_minutes)
      : Number(row.menu_cutoff_hours) * 60,
  };
}

// F6 本人認証: liffId→account、idToken→LINE userId→friend 所有。
// 失敗時は { error, status } を返す。
export async function resolveSelfBookingCaller(
  c: Context<Env>,
): Promise<
  | { ok: true; accountId: string; friendId: string; lineUserId: string }
  | { ok: false; error: string; status: 401 | 403 | 404 }
> {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return { ok: false, error: 'unknown_liff', status: 404 };
  const lineUserId = await verifyCallerLineUserId(c, accountId);
  if (!lineUserId) return { ok: false, error: 'unauthorized', status: 401 };
  const friendId = await resolveFriendId(c, lineUserId, accountId);
  if (!friendId) return { ok: false, error: 'friend_not_found', status: 404 };
  const friend = await c.env.DB
    .prepare(`SELECT is_following FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ is_following: number }>();
  if (!friend || friend.is_following === 0) return { ok: false, error: 'cannot_book', status: 403 };
  return { ok: true, accountId, friendId, lineUserId };
}

/**
 *  本人勤務: staff ロールは「自分に紐づく予約スタッフ」だけを対象にする。
 * owner/admin は全員分を通す。staff は対象行の staff_member_id が自分と
 * 一致し、かつ `booking.staff.own` キーを持つときだけ通す
 * （キー判定は middleware の permissionForApiPath が済ませている）。
 */
export function requireOwnBookingStaffOrAdmin(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const me = c.get('staff');
    if (!me) return c.json({ error: 'Unauthorized' }, 401);
    if (me.role === 'owner' || me.role === 'admin') return next();
    const accountId = await resolveAccountIdAdmin(c);
    if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
    const row = await c.env.DB
      .prepare(
        `SELECT staff_member_id FROM staff
          WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`,
      )
      .bind(c.req.param('id'), accountId)
      .first<{ staff_member_id: string | null }>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.staff_member_id !== me.id || !hasStaffPermission(c, BOOKING_STAFF_OWN_KEY)) {
      return c.json({ success: false, error: 'この勤務情報を操作する権限がありません' }, 403);
    }
    return next();
  };
}

// staff が指定 account に属することを保証する。属していなければ null を返す。
export async function assertStaffInAccount(
  db: D1Database,
  staffId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM staff WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(staffId, accountId)
    .first<{ ok: number }>();
  return Boolean(row?.ok);
}

// account-scope な friend 解決。friends.line_account_id が webhook で書き換わる
// マルチアカウント環境で、別 tenant の friend 行を再利用しないようにする。
// line_account_id が NULL の旧データ（multi-account 化前）は account 一致が判定できないので
// 安全側として除外（必要なら個別にバックフィルする）。
export async function resolveFriendId(
  c: Context<Env>,
  lineUserId: string,
  accountId: string,
): Promise<string | null> {
  const f = await c.env.DB
    .prepare(
      `SELECT id FROM friends
        WHERE line_platform_user_id = ? AND line_account_id = ?`,
    )
    .bind(lineUserId, accountId)
    .first<{ id: string }>();
  return f?.id ?? null;
}
