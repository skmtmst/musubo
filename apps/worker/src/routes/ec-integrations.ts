import { formatYen as yen } from '@line-crm/shared';
import type { EcItem } from '../features/ec-commerce/member-snapshot/index.js';
export { syncMemberSnapshot } from '../features/ec-commerce/member-snapshot/index.js';
import { syncMemberSnapshot } from '../features/ec-commerce/member-snapshot/index.js';
export type { EcEvent } from '../features/ec-commerce/member-snapshot/index.js';
import type { EcEvent } from '../features/ec-commerce/member-snapshot/index.js';
import { logger } from '@line-crm/shared/server';
import { validateNenWebhookHeaders, verifyNenWebhook } from '../lib/hmac.js';
import { WEBHOOK_BODY_BYTES, isDeclaredWebhookBodyTooLarge, isWebhookBodyTooLarge } from '../lib/webhook-body.js';
import { getConnectorSecret } from './ec-connector-secret.js';
import { isCalendarDate as isExistingCalendarDate } from '@line-crm/shared';
import { savePublicationDailyViews } from '@line-crm/db';
import type { PublicationViewSample } from '@line-crm/shared';
import { Hono } from 'hono';
import {
  decryptCredential,
  getLineAccountById,
  jstNow,
  setEcActionExecutionStatus,
  upsertEcEventReadModels,
} from '@line-crm/db';
import type { Message } from '@line-crm/line-sdk';
import { EC_EVENT_TYPES } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { dispatchOperatorEvent } from '../services/operator-notification-dispatch.js';

import { cancelPendingOrderFollowUps } from '../services/nen-engagement.js';
import { markEcEventFailed, processEcEvent } from '../features/ec-commerce/ec-event-processing/index.js';

const ecIntegrations = new Hono<Env>();
const MAX_BODY_BYTES = WEBHOOK_BODY_BYTES.ec;
export { EC_EVENT_TYPES } from '@line-crm/shared';
const EVENT_TYPES = new Set<string>(EC_EVENT_TYPES);

/**
 * 公式サイトの掲載閲覧数。種類は共通名簿（@line-crm/shared の
 * EC_EVENT_TYPES）が正本。ここでは分岐用の名前だけ残す。
 */
export const PUBLICATION_VIEW_EVENT_TYPE = 'ec.site.publication_viewed';

function isValidPublicationViews(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  for (const item of value) {
    if (!item || typeof item !== 'object') return false;
    const view = item as { photo_id?: unknown; view_count?: unknown; placement_label?: unknown; view_date?: unknown };
    const photoId = String(view.photo_id ?? '').trim();
    if (!photoId || photoId.length > 128) return false;
    if (!Number.isSafeInteger(view.view_count) || Number(view.view_count) < 0) return false;
    if (view.view_date !== undefined) {
      if (typeof view.view_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(view.view_date)) return false;
      const date = new Date(`${view.view_date}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== view.view_date
        || view.view_date > new Date().toISOString().slice(0,10)) return false;
    }
    if (view.placement_label != null
      && (typeof view.placement_label !== 'string' || view.placement_label.trim().length > 512)) return false;
  }
  return true;
}

export function validateEvent(value: unknown): value is EcEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<EcEvent>;
  if (typeof event.event_id !== 'string' || event.event_id.length < 8 || event.event_id.length > 255) return false;
  if (typeof event.event_type !== 'string' || !EVENT_TYPES.has(event.event_type)) return false;
  if (event.event_type === PUBLICATION_VIEW_EVENT_TYPE
    && !isValidPublicationViews(event.publication_views)) return false;
  if (event.line_user_id != null
      && (typeof event.line_user_id !== 'string' || !/^U[0-9a-f]{32}$/i.test(event.line_user_id))) return false;
  if (typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at))) return false;
  if (event.order?.items && (!Array.isArray(event.order.items) || event.order.items.length > 50)) return false;
  if (event.order_history && (!Array.isArray(event.order_history) || event.order_history.length > 50)) return false;
  if (event.subscriptions && (!Array.isArray(event.subscriptions) || event.subscriptions.length > 20)) return false;
  if (event.profile?.pets) {
    if (!Array.isArray(event.profile.pets) || event.profile.pets.length > 20) return false;
    for (const pet of event.profile.pets) {
      if (!pet || typeof pet !== 'object' || typeof pet.name !== 'string' || !pet.name.trim() || pet.name.length > 80) return false;
      if (pet.animal_type && !['dog', 'cat', 'other'].includes(pet.animal_type)) return false;
      if (pet.gender && !['male', 'female', 'unknown'].includes(pet.gender)) return false;
      if (pet.birthday != null && !isExistingCalendarDate(pet.birthday)) return false;
    }
  }
  return true;
}



function itemSummary(items: EcItem[] | undefined): string {
  if (!items?.length) return '商品情報なし';
  const visible = items.slice(0, 4).map((item) => `${item.name.slice(0, 80)} × ${item.quantity}`);
  if (items.length > visible.length) visible.push(`ほか${items.length - visible.length}点`);
  return visible.join('\n');
}

export type EcMessageOptions = {
  title?: string | null;
  introText?: string | null;
  outroText?: string | null;
  test?: boolean;
};

function messageText(title: string, fixedLines: string[], options?: EcMessageOptions): Message {
  const sections = [
    `${options?.test ? '【テスト送信】\n' : ''}${options?.title || title}`,
    options?.introText?.trim() || '',
    fixedLines.filter(Boolean).join('\n'),
    options?.outroText?.trim() || '',
  ].filter(Boolean);
  return { type: 'text', text: sections.join('\n\n').trim() };
}

export function ecTextMessage(event: EcEvent, options?: EcMessageOptions): Message {
  const orderNumber = event.order?.number || '—';
  if (event.event_type === 'ec.order.confirmed') {
    return messageText('ご注文ありがとうございます', [
        `注文番号：${orderNumber}`,
        itemSummary(event.order?.items),
        `合計：${yen(event.order?.total)}`,
        event.order?.delivery_date ? `お届け予定：${event.order.delivery_date}${event.order.delivery_time ? ` ${event.order.delivery_time}` : ''}` : '',
        event.order?.detail_url || '',
    ], options);
  }
  if (event.event_type === 'ec.order.shipped') {
    return messageText('商品を発送しました', [
        `注文番号：${orderNumber}`,
        itemSummary(event.order?.items),
        event.shipping?.carrier ? `配送会社：${event.shipping.carrier}` : '',
        event.shipping?.tracking_number ? `送り状番号：${event.shipping.tracking_number}` : '',
        event.shipping?.tracking_url || event.order?.detail_url || '',
    ], options);
  }
  if (event.event_type === 'ec.subscription.upcoming') {
    return messageText('次回の定期便をお知らせします', [
        event.subscription?.next_order_date ? `次回確定日：${event.subscription.next_order_date}` : '',
        event.subscription?.change_deadline ? `変更期限：${event.subscription.change_deadline}` : '',
        itemSummary(event.order?.items),
        `予定金額：${yen(event.order?.total)}`,
        event.subscription?.manage_url || '',
    ], options);
  }
  if (event.event_type === 'ec.subscription.payment_failed') {
    const subscriptionUrl = event.subscription?.mypage_subscription_url || event.subscription?.manage_url || '';
    const paymentMethodUrl = event.subscription?.payment_method_update_url || event.subscription?.manage_url || '';
    return messageText('定期便のお支払いをご確認ください', [
      '定期便のお支払いを確認できませんでした。',
      'お支払い方法をご確認ください。',
      event.subscription?.contract_number ? `契約番号：${event.subscription.contract_number}` : '',
      typeof event.subscription?.amount === 'number' ? `お支払い金額：${yen(event.subscription.amount)}` : '',
      event.subscription?.scheduled_shipping_date ? `発送予定日：${event.subscription.scheduled_shipping_date}` : '',
      subscriptionUrl ? `定期便の確認：\n${subscriptionUrl}` : '',
      paymentMethodUrl ? `クレジットカードの変更：\n${paymentMethodUrl}` : '',
    ], options);
  }
  return messageText('定期便の解約を受け付けました', [
    '定期便の解約を受け付けました。',
    event.subscription?.id ? `定期便番号：${event.subscription.id}` : '',
  ], options);
}

/**
 * `X-Line-Account-Id` が無いときの宛先の決め方（EC-CUBE 側はこのヘッダーを送らず、
 * 署名も `timestamp.body`（アカウントIDなし）で作る。/columns と同じ決まり）。
 *
 * 1. 出来事の `line_user_id` が、動いている LINE アカウントの友だちとして 1 件だけ見つかれば、そのアカウント
 * 2. 見つからなければ、動いているアカウントが 1 つだけならそのアカウント
 * 3. どちらでも決まらなければ null（→ 400）
 */
async function resolveAccountIdWithoutHeader(db: D1Database, lineUserId: string | null): Promise<string | null> {
  if (lineUserId) {
    const friends = await db.prepare(
      `SELECT f.line_account_id AS id FROM friends f JOIN line_accounts a ON a.id = f.line_account_id
        WHERE f.line_platform_user_id = ? AND a.is_active = 1 AND a.archived_at IS NULL LIMIT 2`,
    ).bind(lineUserId).all<{ id: string }>();
    const ids = [...new Set((friends.results ?? []).map((row) => String(row.id)))];
    if (ids.length === 1) return ids[0];
  }
  const activeAccounts = await db.prepare(
    `SELECT id
       FROM line_accounts
      WHERE is_active = 1 AND archived_at IS NULL
      ORDER BY id
      LIMIT 2`,
  ).all<{ id: string }>();
  const ids = (activeAccounts.results ?? []).map((row) => String(row.id));
  return ids.length === 1 ? ids[0] : null;
}

function lineUserIdFromRawBody(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { line_user_id?: unknown };
    return typeof parsed?.line_user_id === 'string' && /^U[0-9a-f]{32}$/i.test(parsed.line_user_id) ? parsed.line_user_id : null;
  } catch {
    return null;
  }
}

/** 全体の鍵。未設定・短いときは使えない（移行が済むまでのつなぎ）。 */
function usableGlobalSecret(value: string | undefined): string | null {
  return value && value.length >= 32 ? value : null;
}

/**
 * 公式サイトの掲載閲覧数を保存する。
 *
 * ECが数えた累計を、今ある数と比べて大きい方だけ残す。足し算しないので、
 * 再送や順番の入れ替わりで数が減ったり二重に増えたりしない。
 * 掲載先の表示名が付いていて、同じ site の掲載先が既にあれば、そちらも同じ扱いで直す。
 * musuboに無い写真IDは無視して、呼び出し元へ知らせる（ typo の発見用）。
 */
export async function applyPublicationViewCounts(
  db: D1Database,
  lineAccountId: string,
  views: NonNullable<EcEvent['publication_views']>,
  now: string,
): Promise<{ saved: Array<{ photo_id: string; view_count: number; placement_label: string | null }>; unknownPhotos: string[] }> {
  const saved: Array<{ photo_id: string; view_count: number; placement_label: string | null }> = [];
  const unknownPhotos: string[] = [];
  for (const view of views) {
    const photoId = String(view.photo_id ?? '').trim();
    const reported = Math.max(0, Math.trunc(Number(view.view_count)));
    const publication = await db.prepare(
      `SELECT id, view_count FROM nen_photo_publications WHERE photo_id = ? AND line_account_id = ?`,
    ).bind(photoId, lineAccountId).first<{ id: string; view_count: number | null }>();
    if (!publication) {
      unknownPhotos.push(photoId);
      continue;
    }
    if (view.view_date) {
      await savePublicationDailyViews(db, {
        publicationId: publication.id, lineAccountId, viewDate: view.view_date,
        placementLabel: view.placement_label?.trim() ?? '', viewCount: reported, now,
      });
      saved.push({ photo_id: photoId, view_count: reported, placement_label: view.placement_label?.trim() || null });
      continue;
    }
    const next = Math.max(Number(publication.view_count ?? 0), reported);
    await db.prepare(
      `UPDATE nen_photo_publications SET view_count = MAX(COALESCE(view_count,0),?), updated_at = ? WHERE id = ?`,
    ).bind(next, now, publication.id).run();
    const label = typeof view.placement_label === 'string' ? view.placement_label.trim().slice(0, 512) : '';
    if (label) {
      const placement = await db.prepare(
        `SELECT id, view_count FROM nen_photo_publication_placements
          WHERE publication_id = ? AND placement_type = 'site' AND placement_label = ?`,
      ).bind(publication.id, label).first<{ id: string; view_count: number | null }>();
      if (placement) {
        await db.prepare(
          `UPDATE nen_photo_publication_placements SET view_count = ? WHERE id = ?`,
        ).bind(Math.max(Number(placement.view_count ?? 0), reported), placement.id).run();
      }
    }
    saved.push({ photo_id: photoId, view_count: next, placement_label: label || null });
  }
  return { saved, unknownPhotos };
}

/** 候補の鍵を順に試し、1つでも合えば通す。移行期間の両受けが本体。 */
async function verifyWithAnySecret(
  secrets: Array<string | null>,
  input: { timestamp: string; signature: string; rawBody: string; accountId?: string; nowSeconds: number },
): Promise<boolean> {
  for (const secret of secrets) {
    if (!secret) continue;
    if ((await verifyNenWebhook({ ...input, profile: 'ec', secret })).ok) return true;
  }
  return false;
}

ecIntegrations.post('/api/integrations/eccube/events', async (c) => {
  const requestedLineAccountId = c.req.header('x-line-account-id')?.trim();
  // ヘッダー無し（EC-CUBE 標準）で署名の時刻も無い呼び出しは、宛先を探す前に断る。
  if (!requestedLineAccountId && !c.req.header('x-nen-timestamp')) {
    return c.json({ success: false, error: 'LINE account is required' }, 400);
  }
  // つなぎ先ごとの鍵へ移行中。使える鍵が1つもないときだけ 503 にする。
  const globalSecret = usableGlobalSecret(c.env.ECCUBE_WEBHOOK_SECRET);
  const headerConnectorSecret = requestedLineAccountId
    ? await getConnectorSecret(c.env.DB, requestedLineAccountId, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY)
    : null;
  if (!globalSecret && !headerConnectorSecret) {
    logger.error("ec_integrations.resolve_webhook_secret_failed");
    return c.json({ success: false, error: 'Integration is not configured' }, 503);
  }

  if (isDeclaredWebhookBodyTooLarge(c.req.header('content-length'), MAX_BODY_BYTES)) {
    return c.json({ success: false, error: 'Payload too large' }, 413);
  }

  const rawBody = await c.req.text();
  if (isWebhookBodyTooLarge(rawBody, MAX_BODY_BYTES)) return c.json({ success: false, error: 'Payload too large' }, 413);

  const timestamp = c.req.header('x-nen-timestamp') || '';
  const signature = c.req.header('x-nen-signature') || '';
  const nowSeconds = Date.now() / 1000;
  const input = { timestamp, signature, rawBody, accountId: requestedLineAccountId || undefined, nowSeconds };
  const headerCheck = validateNenWebhookHeaders({ ...input, profile: 'ec' });
  if (!headerCheck.ok && headerCheck.error === 'Expired request') {
    return c.json({ success: false, error: 'Expired request' }, 401);
  }
  // 鍵候補と宛先の探索順は維持する。他アカウントの鍵へ探索を広げない。
  let verified = requestedLineAccountId
    ? await verifyWithAnySecret([headerConnectorSecret, globalSecret], input)
    : await verifyWithAnySecret([globalSecret], input);
  if (!verified && !requestedLineAccountId) {
    const fallbackAccountId = await resolveAccountIdWithoutHeader(c.env.DB, lineUserIdFromRawBody(rawBody));
    if (fallbackAccountId) {
      const fallbackSecret = await getConnectorSecret(
        c.env.DB, fallbackAccountId, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
      );
      verified = await verifyWithAnySecret([fallbackSecret], input);
    }
  }
  if (!verified) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }
  const lineAccountId = requestedLineAccountId || await resolveAccountIdWithoutHeader(c.env.DB, lineUserIdFromRawBody(rawBody));
  if (!lineAccountId) return c.json({ success: false, error: 'LINE account is required' }, 400);

  const account = await getLineAccountById(c.env.DB, lineAccountId);
  if (!account || account.is_active !== 1) {
    return c.json({ success: false, error: 'Integration account is not configured' }, 404);
  }

  let event: unknown;
  try { event = JSON.parse(rawBody); } catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }
  if (!validateEvent(event)) return c.json({ success: false, error: 'Invalid event' }, 400);

  const now = jstNow();
  const id = crypto.randomUUID();
  const source = `eccube:${lineAccountId}`;
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO ec_events
      (id, source, external_event_id, event_type, line_account_id, customer_id,
       line_user_id, payload, status, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
  ).bind(
    id,
    source,
    event.event_id,
    event.event_type,
    lineAccountId,
    event.customer_id == null ? null : String(event.customer_id),
    event.line_user_id ?? null,
    rawBody,
    now,
    now,
  ).run();

  const row = inserted.meta.changes
    ? { id, status: 'received' }
    : await c.env.DB.prepare(
        `SELECT id, status FROM ec_events WHERE source = ? AND external_event_id = ?`,
      ).bind(source, event.event_id).first<{ id: string; status: string }>();
  if (!row) return c.json({ success: false, error: 'Event ledger failure' }, 500);
  if (row.status === 'processed' || row.status === 'skipped') {
    return c.json({ success: true, duplicate: true, status: row.status });
  }

  const subscription = await c.env.DB.prepare('SELECT status,event_types_json FROM ec_connectors WHERE line_account_id=?').bind(lineAccountId).first<{status:string;event_types_json:string}>();
  if(subscription && subscription.status !== 'paused' && !(JSON.parse(subscription.event_types_json) as string[]).includes(event.event_type)) {
    await c.env.DB.prepare("UPDATE ec_events SET status='skipped',error_message='event_not_subscribed',updated_at=? WHERE id=?").bind(now,row.id).run();
    return c.json({success:true,status:'not_subscribed'},202);
  }
  try {
    await upsertEcEventReadModels(c.env.DB, {
      eventId: row.id,
      sourceKey: source,
      externalEventId: event.event_id,
      eventType: event.event_type,
      lineAccountId,
      customerId: event.customer_id == null ? null : String(event.customer_id),
      occurredAt: event.occurred_at,
      order: event.order,
      refund: event.refund,
    }, now);
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE ec_events SET status = 'failed', error_message = 'read_model_failed', updated_at = ? WHERE id = ?`,
    ).bind(now, row.id).run();
    await setEcActionExecutionStatus(c.env.DB, {
      eventId: row.id, lineAccountId, status: 'retryable_failed',
      errorCode: 'read_model_failed', errorMessageSafe: '注文情報を取り込めませんでした', now,
    }).catch(() => undefined);
    logger.error("ec_integrations.integrations_eccube_events_create_failed");
    return c.json({ success: false, error: 'Event processing failed' }, 503);
  }

  // 取り込み停止中は、受信の保存までは済ませたうえで動作を止める。
  // 通知・タグ・シナリオ開始などの副作用は一切起こさない。再開時は
  // 止めていた分を待ち行列へ戻す（コネクタ更新口が担う）。
  const connector = await c.env.DB.prepare(
    `SELECT status FROM ec_connectors WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{ status: string }>();
  if (connector?.status === 'paused') {
    await c.env.DB.prepare(
      `UPDATE ec_events SET status = 'skipped', error_message = 'connector_paused', updated_at = ? WHERE id = ?`,
    ).bind(now, row.id).run();
    await setEcActionExecutionStatus(c.env.DB, {
      eventId: row.id, lineAccountId, status: 'skipped',
      errorCode: 'connector_paused', errorMessageSafe: '取り込みは停止中のため処理しませんでした', now,
    });
    return c.json({ success: true, status: 'paused' }, 202);
  }


  /*
   * 注文の取り消し・返金が届いたら、その注文を起点に待っている
   * 発送後の案内（到着確認・口コミ・次の商品）を「送らない」へ倒す。
   * ここで倒さないと、配信履歴に「これから送ります」と出たままになる。
   * 止め損ねても送信時の再検証（processNenDeliveries）が最後に弾くので、
   * この処理の失敗でイベント受付そのものは止めない。
   */
  if (event.event_type === 'ec.order.cancelled' || event.event_type === 'ec.order.refunded') {
    try {
      const cancelled = await cancelPendingOrderFollowUps(c.env.DB, {
        lineAccountId,
        orderNumber: event.order?.number ?? '',
        reason: event.event_type === 'ec.order.cancelled' ? 'order_cancelled' : 'order_refunded',
      });
      if (cancelled > 0) {
        logger.log("nen_order_followups_stopped");
      }
    } catch (followUpError) {
      logger.error("ec_integrations.integrations_eccube_events_create_failed");
    }
  }

  // 受注は運用者へ知らせる。LINEの友だちが見つからなくても受注自体は起きて
  // いるので、この先の照合結果を待たずにここで出す。台帳の行IDを発生元に
  // 使うため、EC側の再送でも通知は1件しか作られない。
  if (event.event_type === 'ec.order.confirmed') {
    try {
      const orderNumber = event.order?.number?.trim();
      await dispatchOperatorEvent(c.env.DB, c.env, {
        lineAccountId,
        eventType: 'ec_order_received',
        sourceEventId: row.id,
        message: orderNumber ? `ECで注文${orderNumber}を受け付けました` : 'ECで新しい注文を受け付けました',
        executionMode: 'automatic',
      });
    } catch (notificationError) {
      // 受注の取り込みは通知の失敗で止めない。送り残しは回収口から拾う。
      logger.error("ec_integrations.integrations_eccube_events_create_failed");
    }
  }

  // の閲覧数は友だちに結びつけない（回数だけ数える）ので、本人探しを飛ばす。
  if (!event.line_user_id && event.event_type !== PUBLICATION_VIEW_EVENT_TYPE) {
    await c.env.DB.prepare(
      `UPDATE ec_events
          SET status = 'identity_pending', error_message = 'line_identity_unmatched', updated_at = ?
        WHERE id = ? AND status IN ('received', 'failed', 'identity_pending')`,
    ).bind(now, row.id).run();
    await setEcActionExecutionStatus(c.env.DB, {
      eventId: row.id, lineAccountId, status: 'skipped',
      errorCode: 'line_identity_unmatched', errorMessageSafe: 'LINEの友だちが見つかりません', now,
    });
    return c.json({ success: true, status: 'identity_pending' }, 202);
  }


  /*
   * 公式サイトの掲載閲覧数。友だちの突き合わせは要らない（回数だけ数える）
   * ので、ここで受けて返す。停止中（paused）の取り込みは、他の種類と同じく
   * 受付の保存だけ残して書き込まない。
   */
  if (event.event_type === PUBLICATION_VIEW_EVENT_TYPE) {
    // 台帳に既にある event_id（EC側の再送）は触らず、受け付け済みとして返す。
    if (!inserted.meta.changes && (row.status === 'processed' || row.status === 'skipped')) {
      return c.json({ success: true, duplicate: true, status: row.status });
    }
    try {
      const result = await applyPublicationViewCounts(
        c.env.DB, lineAccountId, event.publication_views ?? [], now,
      );
      await c.env.DB.prepare(`UPDATE ec_events SET status = 'processed', processed_at = ?, updated_at = ?, error_message = NULL WHERE id = ?`).bind(now,now,row.id).run();
      return c.json({ success: true, status: 'view_counts_saved', ...result });
    } catch (viewError) {
      await c.env.DB.prepare(`UPDATE ec_events SET status = 'failed', error_message = 'publication_views_failed', updated_at = ? WHERE id = ?`).bind(now,row.id).run().catch(() => undefined);
      logger.error("ec_integrations.publish_event_views_failed");
      return c.json({ success: false, error: 'Event processing failed' }, 503);
    }
  }

  try {
    const outcome = await processEcEvent(c.env.DB, {
      account,
      lineAccountId,
      event,
      eventRowId: row.id,
      now,
      credentialKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    });
    if (outcome === 'duplicate') return c.json({ success: true, duplicate: true, status: 'processing' }, 202);
    if (outcome === 'processed') return c.json({ success: true, status: 'processed' });
    return c.json({ success: true, status: outcome }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
    await markEcEventFailed(c.env.DB, {
      eventRowId: row.id,
      externalEventId: event.event_id,
      lineAccountId,
      message,
      now: jstNow(),
    });
    return c.json({ success: false, error: 'Event processing failed' }, 503);
  }
});

export { ecIntegrations };
