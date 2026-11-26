import type { Context } from 'hono';
import {
  markMileageAdjustmentNotification,
  reserveMileageAdjustmentNotification,
  resolveLineCredential,
} from '@line-crm/db';
import type { Env } from '../../worker-env.js';
import { dispatchLineProxyLocally } from '../../services/local-line-proxy.js';
import { pushViaHarnessProxy, type HarnessProxyDispatch } from '../../services/line-proxy-send.js';

/**
 * m22o: cron からも送れるよう、Hono の Context ではなく
 * 差し替えられる3点だけを受け取る。既存の調整の口の振る舞いは変えない。
 */
export interface MileageNotificationPorts {
  db: D1Database;
  workerPublicUrl: string;
  dispatch: HarnessProxyDispatch;
}

type NotificationFriend = {
  id: string;
  line_user_id: string;
  is_following: number;
  channel_access_token: string | null;
  channel_access_token_encrypted: string | null;
};

export function mileageAdjustmentMessage(input: {
  direction: 'increase' | 'decrease';
  amount: number;
  balanceAfter: number;
  expiresAt?: string | null;
}): string {
  const change = input.direction === 'increase' ? '増えました' : '減りました';
  const expiration = input.expiresAt
    ? `\nこのマイルの有効期限: ${new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(input.expiresAt))}`
    : '';
  return [
    `マイルが${input.amount.toLocaleString('ja-JP')} mile ${change}。`,
    `現在の利用可能残高は ${input.balanceAfter.toLocaleString('ja-JP')} mile です。${expiration}`,
  ].join('\n');
}

/**
 * 手動調整後の自動通知。調整自体は既に確定しているため、送信失敗で台帳を
 * 巻き戻さず failed を監査へ残す。同じ台帳行を再送しても二重送信しない。
 * m22o: 中身は Context を受けない sendMileageNotification へ寄せた。
 */
export async function sendMileageAdjustmentNotification(
  c: Context<Env>,
  input: {
    lineAccountId: string;
    friendId: string;
    ledgerEntryId: string;
    idempotencyKey: string;
    message: string;
  },
) {
  return sendMileageNotification(
    {
      db: c.env.DB,
      workerPublicUrl: c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin,
      dispatch: (request) => dispatchLineProxyLocally(request, c.env, c.executionCtx),
    },
    input,
  );
}

/**
 * m22o: 予約ずみのマイル通知を1件送る。調整と付与の両方で使う。
 * 送り済みなら送り直さない。失敗は台帳を巻き戻さず failed に残す。
 */
export async function sendMileageNotification(
  ports: MileageNotificationPorts,
  input: {
    lineAccountId: string;
    friendId: string;
    ledgerEntryId: string;
    idempotencyKey: string;
    message: string;
  },
) {
  const reserved = await reserveMileageAdjustmentNotification(ports.db, input);
  if (reserved.status === 'sent') return reserved;
  try {
    const friend = await ports.db.prepare(
      `SELECT f.id, f.line_platform_user_id AS line_user_id, f.is_following,
              a.channel_access_token, a.channel_access_token_encrypted
         FROM friends f JOIN line_accounts a ON a.id = f.line_account_id
        WHERE f.id = ? AND f.line_account_id = ?`,
    ).bind(input.friendId, input.lineAccountId).first<NotificationFriend>();
    if (!friend || !friend.is_following || !friend.line_user_id) {
      return markMileageAdjustmentNotification(ports.db, {
        id: reserved.id, status: 'failed', errorCode: 'friend_unavailable',
      });
    }
    const accessToken = await resolveLineCredential(
      friend.channel_access_token_encrypted,
      friend.channel_access_token,
      { lineAccountId: input.lineAccountId, field: 'channel_access_token' },
    );
    const sent = await pushViaHarnessProxy(
      ports.workerPublicUrl,
      accessToken,
      friend.line_user_id,
      [{ type: 'text', text: input.message }],
      input.idempotencyKey,
      ports.dispatch,
    );
    return markMileageAdjustmentNotification(ports.db, {
      id: reserved.id, status: 'sent', lineRequestId: sent.requestId,
    });
  } catch (error) {
    /*
     * 相手が明示的に拒否した失敗（HTTP応答あり）と、応答が届かず
     * 送れたか分からない失敗（タイムアウト・接続断）は区別する。
     * 後者は同じキーで再送しても LINE 側が一度だけ受理にまとめる。
     */
    const explicit = typeof (error as { status?: unknown } | null)?.status === 'number';
    return markMileageAdjustmentNotification(ports.db, {
      id: reserved.id,
      status: 'failed',
      errorCode: explicit ? 'delivery_failed' : 'delivery_unknown',
    });
  }
}
