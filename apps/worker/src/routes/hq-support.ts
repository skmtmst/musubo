import { logger } from '@line-crm/shared/server';
import { HQ_SUPPORT_KIND_LABELS, serialize } from './hq-support-display.js';
export { HQ_SUPPORT_KIND_LABELS } from './hq-support-display.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  HQ_SUPPORT_KINDS,
  createHqSupportRequest,
  findRecentDuplicateHqSupportRequest,
  getTenantBilling,
  getStaffById,
  listHqSupportRequests,
  markHqSupportRequestNotified,
  type HqSupportKind,
  type HqSupportRequest,
  addSupportTenantMessage,
  formatTicketNo,
  getHqSupportRequest,
  getSupportTicket,
  listSupportMessages,
  SUPPORT_STAGE_LABELS,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { requireRole } from '../middleware/role-guard.js';
import { sendPlainMail } from '../services/plain-mail.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { findPlan, formatJstMonthDay } from '../services/billing-plans.js';
import { musuboQuoteInquiryReceiptMail } from '../services/quote-mail-design.js';

/**
 * 統括から運営へのお問い合わせ（★36-3）。
 *
 * - 送るとこの統括の記録に残り、運営の連絡先へメールで知らせ、送信者に控えを送る
 * - メールが送れなくても記録は残す（`notified` が false で返る）
 * - 役割は問わない（統括・管理者・担当者が送れる。閲覧のみは更新ができない決まりなので送れない）。
 *   見えるのは自分の統括の分だけ
 */
export const hqSupport = new Hono<Env>();

const SUBJECT_MAX = 100;
const BODY_MAX = 4000;
const ATTACHMENT_MAX = 3;
const ATTACHMENT_BYTES_MAX = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg']);

function tenantOf(c: Context<Env>): string {
  return c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
}

function workerUrl(c: Context<Env>): string {
  return c.env.WORKER_URL || new URL(c.req.url).origin;
}

function supportPlanLabel(billing: Awaited<ReturnType<typeof getTenantBilling>>): string {
  if (!billing) return '—';
  if (billing.plan_status === 'trialing') {
    const end = formatJstMonthDay(billing.trial_ends_at);
    return end ? `無料トライアル（${end}まで）` : '無料トライアル';
  }
  if (billing.plan_status === 'exempt') return '課金対象外';
  if (billing.plan_status === 'canceled') return '契約終了';
  return findPlan(billing.plan_key)?.name ?? '—';
}

function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const raw = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

type Upload = { key: string; bytes: Uint8Array; mimeType: string };

/** 添付（base64 の画像）を検査して R2 のキーを決める。36-3 の送信と 36-3-A の続きで共通。 */
function parseAttachments(raw: unknown): { uploads: Upload[] } | { error: string; status: 400 | 413 } {
  const attachmentsRaw = Array.isArray(raw) ? raw : [];
  if (attachmentsRaw.length > ATTACHMENT_MAX) return { error: `画像は${ATTACHMENT_MAX}枚までです`, status: 400 };
  const uploads: Upload[] = [];
  for (const item of attachmentsRaw) {
    const record = item as Record<string, unknown>;
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
    const data = typeof record.data === 'string' ? record.data : '';
    if (!ATTACHMENT_TYPES.has(mimeType)) return { error: '画像は PNG・JPEG のみ添付できます', status: 400 };
    const bytes = decodeBase64(data);
    if (!bytes) return { error: '画像の中身を読み取れませんでした', status: 400 };
    if (bytes.byteLength > ATTACHMENT_BYTES_MAX) return { error: '画像が大きすぎます（1枚 5MB まで）', status: 413 };
    if (!hasImageSignature(bytes, mimeType)) return { error: '画像の実際の形式が、選択された形式と一致しません', status: 400 };
    uploads.push({ key: `support/${crypto.randomUUID()}.${mimeType === 'image/png' ? 'png' : 'jpg'}`, bytes, mimeType });
  }
  return { uploads };
}

/** 一覧のページ数に左右されない、所属する統括のお問い合わせ集計。 */
hqSupport.get('/api/hq/support/summary', async (c) => {
  const data = await c.env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(stage='new'),0) AS newCount,
    COALESCE(SUM(stage='in_progress'),0) AS inProgressCount,
    COALESCE(SUM(stage='in_progress' AND assignee_staff_id IS NOT NULL),0) AS assignedInProgressCount,
    COALESCE(SUM(strftime('%Y-%m',resolved_at)=strftime('%Y-%m','now','+9 hours')),0) AS resolvedThisMonth,
    COALESCE(SUM(strftime('%Y-%m',resolved_at)=strftime('%Y-%m','now','+9 hours','start of month','-1 month')),0) AS resolvedPreviousMonth,
    AVG(CASE WHEN julianday(first_replied_at)>=julianday(created_at)
      THEN (julianday(first_replied_at)-julianday(created_at))*24 END) AS averageFirstReplyHours,
    COUNT(CASE WHEN julianday(first_replied_at)>=julianday(created_at) THEN 1 END) AS firstReplySampleCount
    FROM hq_support_requests WHERE tenant_id=?`).bind(tenantOf(c)).first();
  return c.json({ success: true, data });
});

hqSupport.get('/api/hq/support/requests', async (c) => {
  try {
    const rows = await listHqSupportRequests(c.env.DB, tenantOf(c));
    const base = workerUrl(c);
    const data = await Promise.all(rows.map(async (row) => {
      const messages = await listSupportMessages(c.env.DB, row.id);
      const replies = messages
        .filter((m) => m.author_kind === 'ops')
        .map((m) => ({ id: m.id, authorName: m.author_name, body: m.body, createdAt: m.created_at }));
      return serialize(row, base, replies);
    }));
    return c.json({ success: true, data });
  } catch (err) {
    throw err;
  }
});

/**
 * 停止中でもお問い合わせ画面を組み立てられる、問い合わせ専用の read-model。
 * staff/me・tenants/me・line-accounts を個別に許可せず、必要最小限をこの経路へ集約する。
 */
hqSupport.get('/api/hq/support/context', async (c) => {
  try {
    const tenantId = tenantOf(c);
    const staff = c.get('staff');
    const [{ accounts }, member, billing] = await Promise.all([
      getVisibleLineAccountScope(c.env.DB, staff),
      staff?.id ? getStaffById(c.env.DB, staff.id) : Promise.resolve(null),
      getTenantBilling(c.env.DB, tenantId),
    ]);
    let accountRows: Array<{ id: string; name: string }> = [];
    if (accounts.length > 0) {
      const rows = await c.env.DB
        .prepare(`SELECT id, name FROM line_accounts WHERE id IN (${sqlIdSet(accounts.map(account => account.id)).sql}) AND COALESCE(tenant_id, ?) = ? ORDER BY name, id`)
        .bind(...sqlIdSet(accounts.map(account => account.id)).binds, DEFAULT_TENANT_ID, tenantId)
        .all<{ id: string; name: string }>();
      accountRows = rows.results ?? [];
    }
    return c.json({
      success: true,
      data: {
        kinds: HQ_SUPPORT_KINDS.map((key) => ({ key, label: HQ_SUPPORT_KIND_LABELS[key] })),
        accounts: accountRows,
        sender: {
          tenantName: billing?.name ?? '',
          name: member?.name ?? staff?.name ?? '',
          email: member?.email ?? null,
          planLabel: supportPlanLabel(billing),
        },
      },
    });
  } catch (err) {
    throw err;
  }
});

hqSupport.get('/api/hq/support/kinds', (c) => {
  return c.json({
    success: true,
    data: HQ_SUPPORT_KINDS.map((key) => ({ key, label: HQ_SUPPORT_KIND_LABELS[key] })),
  });
});

hqSupport.post('/api/hq/support/requests', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const staff = c.get('staff');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: '送信内容を読み取れませんでした' }, 400, []);

    const kind = typeof body.kind === 'string' ? body.kind : '';
    if (!(HQ_SUPPORT_KINDS as readonly string[]).includes(kind)) {
      return inputError(c, { success: false, error: '種類を選んでください' }, 400, ["kind"]);
    }
    const quoteInquiry = body.purpose === 'individual_quote';
    if (body.purpose !== undefined && !quoteInquiry) {
      return inputError(c, { success: false, error: 'お問い合わせの種類を確認してください' }, 400, ['purpose']);
    }
    if (quoteInquiry && kind !== 'billing') {
      return inputError(c, { success: false, error: 'お見積もりは料金についてのお問い合わせを選んでください' }, 400, ['kind']);
    }
    if (quoteInquiry && staff?.role !== 'owner' && staff?.role !== 'admin') {
      return c.json({ success: false, error: 'お見積もりのお問い合わせは管理者に依頼してください' }, 403);
    }
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    if (!subject) return inputError(c, { success: false, error: '件名を入力してください' }, 400, ["subject"]);
    if (subject.length > SUBJECT_MAX) return inputError(c, { success: false, error: `件名は${SUBJECT_MAX}文字以内で入力してください` }, 400, ["subject"]);
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return inputError(c, { success: false, error: '本文を入力してください' }, 400, ["body"]);
    if (text.length > BODY_MAX) return inputError(c, { success: false, error: `本文は${BODY_MAX}文字以内で入力してください` }, 400, ["body"]);

    let lineAccountId: string | null = null;
    let lineAccountName: string | null = null;
    if (typeof body.lineAccountId === 'string' && body.lineAccountId) {
      const { accounts } = await getVisibleLineAccountScope(c.env.DB, staff);
      const account = accounts.find((a) => a.id === body.lineAccountId);
      if (!account) return c.json({ success: false, error: '関係する店舗が見つかりません' }, 404);
      lineAccountId = account.id;
      const accountLabel = await c.env.DB
        .prepare('SELECT name FROM line_accounts WHERE id = ? AND COALESCE(tenant_id, ?) = ?')
        .bind(account.id, DEFAULT_TENANT_ID, tenantId)
        .first<{ name: string }>();
      lineAccountName = accountLabel?.name ?? null;
    }

    const member = staff?.id ? await getStaffById(c.env.DB, staff.id).catch(() => null) : null;
    const staffName = member?.name ?? staff?.name ?? '';

    /*
     * 確定応答を失った再送で重複チケットを作らない。
     * 同じ人・同じ内容の直近の送信があれば、新しく作らず既存のものを返す。
     * 作り直さないので、運営への知らせも送り直さない。R2 への置き場確保より前で見る。
     */
    const duplicate = await findRecentDuplicateHqSupportRequest(c.env.DB, {
      tenantId,
      staffId: staff?.id ?? null,
      staffName,
      kind: kind as HqSupportKind,
      subject,
      body: text,
      lineAccountId,
    });
    if (duplicate) {
      const base = workerUrl(c);
      const messages = await listSupportMessages(c.env.DB, duplicate.id);
      const replies = messages
        .filter((m) => m.author_kind === 'ops')
        .map((m) => ({ id: m.id, authorName: m.author_name, body: m.body, createdAt: m.created_at }));
      return c.json({
        success: true,
        data: { ...serialize(duplicate, base, replies), notified: duplicate.notified_at !== null },
      }, 200);
    }

    const parsed = parseAttachments(body.attachments);
    if ('error' in parsed) return inputError(c, { success: false, error: parsed.error }, parsed.status, []);
    const uploads = parsed.uploads;
    for (const upload of uploads) {
      await c.env.IMAGES.put(upload.key, upload.bytes, { httpMetadata: { contentType: upload.mimeType } });
    }

    const tenant = await c.env.DB.prepare('SELECT name FROM tenants WHERE id = ?').bind(tenantId).first<{ name: string }>().catch(() => null);
    const staffEmail = member?.email ?? null;
    const applicant = quoteInquiry ? await c.env.DB.prepare(`SELECT email FROM registration_applications
      WHERE tenant_id=? AND status='activated' ORDER BY created_at DESC LIMIT 1`)
      .bind(tenantId).first<{ email: string }>().catch(() => null) : null;
    const receiptEmail = applicant?.email ?? staffEmail;

    const request = await createHqSupportRequest(c.env.DB, {
      tenantId,
      staffId: staff?.id ?? null,
      staffName,
      staffEmail,
      kind: kind as HqSupportKind,
      subject,
      body: text,
      lineAccountId,
      attachmentKeys: uploads.map((u) => u.key),
    });

    // 運営への通知と、送信者への控え。送れなくても記録は残す。
    const base = workerUrl(c);
    const kindLabel = HQ_SUPPORT_KIND_LABELS[kind as HqSupportKind];
    const lines = [
      `種類: ${kindLabel}`,
      `件名: ${subject}`,
      `統括: ${tenant?.name ?? tenantId}`,
      `送信者: ${staffName}${staffEmail ? ` <${staffEmail}>` : ''}`,
      lineAccountName ? `関係する店舗: ${lineAccountName}` : null,
      '',
      text,
      uploads.length > 0 ? '' : null,
      uploads.length > 0 ? `添付: ${uploads.map((u) => `${base}/images/${u.key}`).join('\n')}` : null,
    ].filter((line): line is string => line !== null);
    let notified = false;
    const operatorTo = c.env.SUPPORT_NOTIFY_EMAIL || c.env.CONTACT_EMAIL;
    if (operatorTo) {
      try {
        await sendPlainMail(c.env, {
          to: operatorTo,
          subject: `【musubo お問い合わせ】${kindLabel}: ${subject}`,
          body: lines.join('\n'),
        });
        notified = true;
      } catch { logger.warn('hq_support.send_request_notification_failed'); }
    }
    if (receiptEmail) {
      try {
        if (quoteInquiry) {
          const mail = musuboQuoteInquiryReceiptMail();
          await sendPlainMail(c.env, { to: receiptEmail, subject: mail.subject, body: mail.text, html: mail.html });
        } else {
          await sendPlainMail(c.env, {
            to: receiptEmail,
            subject: `【musubo】お問い合わせを受け付けました: ${subject}`,
            body: `${staffName} 様\n\nお問い合わせを受け付けました。返信は登録メールアドレスに届きます（平日 2営業日以内）。\n\n${lines.join('\n')}`,
          });
        }
      } catch { logger.warn('hq_support.send_request_receipt_failed'); }
    }
    if (notified) await markHqSupportRequestNotified(c.env.DB, request.id);

    return c.json({
      success: true,
      data: { ...serialize({ ...request, notified_at: notified ? request.created_at : null }, base), notified },
    }, 201);
  } catch (err) {
    throw err;
  }
});

/** 36-3-A：1 件のやり取り。統括の境界（tenant_id）で必ず絞る。 */
hqSupport.get('/api/hq/support/requests/:id', async (c) => {
  try {
    const tenantId = tenantOf(c);
    const row = await getHqSupportRequest(c.env.DB, c.req.param('id'), tenantId);
    if (!row) return c.json({ success: false, error: 'お問い合わせが見つかりません' }, 404);
    const base = workerUrl(c);
    const messages = await listSupportMessages(c.env.DB, row.id);
    return c.json({
      success: true,
      data: {
        ...serialize(row, base, messages.filter((m) => m.author_kind === 'ops').map((m) => ({ id: m.id, authorName: m.author_name, body: m.body, createdAt: m.created_at }))),
        stageLabel: SUPPORT_STAGE_LABELS[row.stage],
        messages: messages.map((m) => ({
          id: m.id,
          authorKind: m.author_kind,
          authorName: m.author_kind === 'ops' ? `musubo 運営 ／ ${m.author_name}` : m.author_name,
          body: m.body,
          attachments: safeKeysOf(m.attachment_keys).map((key) => ({ key, url: `${base}/images/${key}` })),
          createdAt: m.created_at,
        })),
        canFollowUp: true,
      },
    });
  } catch (err) {
    throw err;
  }
});

function safeKeysOf(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** 36-3-A：続きを送る。運営のチケットは対応中へ戻り、運営へ通知メール、送信者に控えを送る。 */
hqSupport.post('/api/hq/support/requests/:id/messages', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const staff = c.get('staff');
    const row = await getHqSupportRequest(c.env.DB, c.req.param('id'), tenantId);
    if (!row) return c.json({ success: false, error: 'お問い合わせが見つかりません' }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: '送信内容を読み取れませんでした' }, 400, []);
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return inputError(c, { success: false, error: '本文を入力してください' }, 400, ["body"]);
    if (text.length > BODY_MAX) return inputError(c, { success: false, error: `本文は${BODY_MAX}文字以内で入力してください` }, 400, ["body"]);
    const parsed = parseAttachments(body.attachments);
    if ('error' in parsed) return inputError(c, { success: false, error: parsed.error }, parsed.status, []);
    for (const upload of parsed.uploads) {
      await c.env.IMAGES.put(upload.key, upload.bytes, { httpMetadata: { contentType: upload.mimeType } });
    }
    const member = staff?.id ? await getStaffById(c.env.DB, staff.id).catch(() => null) : null;
    const staffName = member?.name ?? staff?.name ?? '';
    const staffEmail = member?.email ?? row.staff_email ?? null;
    const message = await addSupportTenantMessage(c.env.DB, {
      requestId: row.id,
      staffId: staff?.id ?? null,
      staffName,
      body: text,
      attachmentKeys: parsed.uploads.map((u) => u.key),
    });

    const base = workerUrl(c);
    const ticket = await getSupportTicket(c.env.DB, row.id);
    const ticketLabel = formatTicketNo(row.ticket_no ?? null);
    const lines = [
      `チケット: ${ticketLabel}`,
      `件名: ${row.subject}`,
      `統括: ${ticket?.tenant_name ?? tenantId}`,
      `送信者: ${staffName}${staffEmail ? ` <${staffEmail}>` : ''}`,
      '',
      text,
      parsed.uploads.length > 0 ? '' : null,
      parsed.uploads.length > 0 ? `添付: ${parsed.uploads.map((u) => `${base}/images/${u.key}`).join('\n')}` : null,
    ].filter((line): line is string => line !== null);
    const operatorTo = c.env.SUPPORT_NOTIFY_EMAIL || c.env.CONTACT_EMAIL;
    try {
      if (operatorTo) {
        await sendPlainMail(c.env, {
          to: operatorTo,
          subject: `【musubo お問い合わせ】続き ${ticketLabel}: ${row.subject}`,
          body: lines.join('\n'),
        });
      }
      if (staffEmail) {
        await sendPlainMail(c.env, {
          to: staffEmail,
          subject: `【musubo】お問い合わせの続きを受け付けました ${ticketLabel}: ${row.subject}`,
          body: `${staffName} 様\n\nお問い合わせの続きを受け付けました。返信は登録メールアドレスと管理画面のお問い合わせに届きます。\n\n${lines.join('\n')}`,
        });
      }
    } catch (error) {
      logger.warn("hq_support.send_reply_notification_failed");
    }
    return c.json({
      success: true,
      data: {
        id: message.id,
        authorKind: 'tenant',
        authorName: message.author_name,
        body: message.body,
        attachments: parsed.uploads.map((u) => ({ key: u.key, url: `${base}/images/${u.key}` })),
        createdAt: message.created_at,
        stage: ticket?.stage ?? 'in_progress',
        status: ticket?.status ?? 'open',
      },
    }, 201);
  } catch (err) {
    throw err;
  }
});
