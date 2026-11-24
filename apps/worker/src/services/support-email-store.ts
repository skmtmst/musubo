import { logger } from '@line-crm/shared/server';
import { createBroadcastRetryKey } from '../features/broadcasts/broadcast-retry-key/index.js';
import { hashOutboundPayload } from './outbound-idempotency.js';
import { inboxEventStatement } from './inbox-events.js';
const MAX_BODY_CHARS = 200_000;


export type SupportEmailEnv = {
  DB: D1Database;
  EMAIL?: SendEmail;
  CONTACT_EMAIL?: string;
  SUPPORT_INBOUND_EMAIL?: string;
  XSERVER_MAIL_HOST?: string;
  XSERVER_MAIL_USER?: string;
  XSERVER_MAIL_PASSWORD?: string;
  XSERVER_RELAY_URL?: string;
  XSERVER_RELAY_SECRET?: string;
};


export type SupportInboundEmail = {
  customerEmail: string;
  customerName?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  messageId?: string | null;
  sentAt?:string|null;
  inReplyTo?: string | null;
  references?: string | null;
};


export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


export function normalizeEmailSubject(subject: string): string {
  let normalized = subject.trim();
  for (let i = 0; i < 8; i++) {
    const next = normalized.replace(/^\s*(?:re|fw|fwd|sv|返信|転送)\s*[:：]\s*/i, '').trim();
    if (next === normalized) break;
    normalized = next;
  }
  return normalized.toLocaleLowerCase('ja-JP') || '(件名なし)';
}


function lastReference(references: string | undefined): string | null {
  if (!references) return null;
  const ids = references.match(/<[^>]+>/g);
  return ids?.at(-1) ?? null;
}


async function findThreadId(
  db: D1Database,
  customerEmail: string,
  inReplyTo: string | undefined,
  references: string | undefined,
): Promise<string | null> {
  const replyId = inReplyTo || lastReference(references);
  if (replyId) {
    const byReply = await db.prepare(
      `SELECT m.thread_id, m.sender_email, m.direction, t.customer_email FROM support_email_messages m JOIN support_email_threads t ON t.id=m.thread_id WHERE m.message_id = ? AND lower(t.customer_email) = ? LIMIT 1`,
    ).bind(replyId, customerEmail).first<{ thread_id: string }>();
    if (byReply?.thread_id) return byReply.thread_id;
  }

  // 件名や解決状態が変わっても、同じ顧客メールの問い合わせと返信を同じ時系列へまとめる。
  const byCustomer = await db.prepare(
    `SELECT id FROM support_email_threads
     WHERE customer_email = ?
     ORDER BY last_message_at DESC LIMIT 1`,
  ).bind(customerEmail).first<{ id: string }>();
  return byCustomer?.id ?? null;
}


export async function storeSupportEmail(
  env: SupportEmailEnv,
  input: SupportInboundEmail,
): Promise<{ threadId: string; duplicate: boolean }> {
  const contactEmail = (env.CONTACT_EMAIL || 'contact-shed@nen-petfood.com').toLowerCase();
  const customerEmail = input.customerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new Error('INVALID_CUSTOMER_EMAIL');
  }
  const customerName = input.customerName?.trim() || null;
  const subject = (input.subject || '(件名なし)').trim();
  const normalizedSubject = normalizeEmailSubject(subject);
  let messageId = input.messageId?.trim() || null;
  const inReplyTo = input.inReplyTo?.trim() || undefined;
  const references = input.references?.trim() || undefined;
  const body = (input.bodyText?.trim()
    || (input.bodyHtml ? stripHtml(input.bodyHtml) : '')
    || '(本文なし)').slice(0, MAX_BODY_CHARS);

  // 再配信でも同じ指紋になるよう、再試行時刻でなく元の発生時刻を使う。
  if(!messageId)messageId=`fallback:${await hashOutboundPayload(JSON.stringify([
    customerEmail,subject,input.sentAt?.trim()||'',input.bodyText??'',input.bodyHtml??'',
  ]))}`;

  if (messageId) {
    const duplicate = await env.DB.prepare(
      `SELECT m.thread_id, m.sender_email, m.direction, t.customer_email FROM support_email_messages m JOIN support_email_threads t ON t.id=m.thread_id WHERE m.message_id = ? LIMIT 1`,
    ).bind(messageId).first<{ thread_id: string; sender_email: string; direction: string; customer_email: string }>();
    if (duplicate?.thread_id) {
      if (duplicate.direction !== 'incoming' || duplicate.sender_email.trim().toLowerCase() !== customerEmail || duplicate.customer_email.trim().toLowerCase() !== customerEmail) throw new Error('SUPPORT_MESSAGE_ID_COLLISION');
      const correctedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE support_email_messages
           SET sender_email = ?, sender_name = ?, subject = ?, body_text = ?
           WHERE message_id = ?`,
        ).bind(customerEmail, customerName, subject, body, messageId),
        env.DB.prepare(
          `UPDATE support_email_threads
           SET customer_name = COALESCE(?, customer_name),
               subject = ?, normalized_subject = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(
          customerName,
          subject,
          normalizedSubject,
          correctedAt,
          duplicate.thread_id,
        ),
      ]);
      return { threadId: duplicate.thread_id, duplicate: true };
    }
  }

  const now = new Date().toISOString();
  const existingThreadId = await findThreadId(
    env.DB,
    customerEmail,
    inReplyTo,
    references,
  );
  const threadId = existingThreadId ?? await createBroadcastRetryKey('support-initial-thread',customerEmail);
  const messageRowId = crypto.randomUUID();
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO support_email_threads
      (id,customer_email,customer_name,subject,normalized_subject,status,last_message_at,last_incoming_at,last_customer_message_at,created_at,updated_at,revision)
      VALUES(?,?,?,?,?,'unread',?,?,?,?,?,0)`).bind(threadId,customerEmail,customerName,subject,normalizedSubject,now,now,now,now,now),
    env.DB.prepare(`INSERT OR IGNORE INTO support_email_messages
      (id,thread_id,direction,sender_email,sender_name,recipient_email,subject,body_text,message_id,in_reply_to,references_header,created_at)
      VALUES(?,?,'incoming',?,?,?,?,?,?,?,?,?)`).bind(messageRowId,threadId,customerEmail,customerName,contactEmail,subject,body,messageId,inReplyTo??null,references??null,now),
    env.DB.prepare(`UPDATE support_email_threads SET customer_name=COALESCE(?,customer_name),subject=?,normalized_subject=?,status='unread',
      last_message_at=?,last_incoming_at=?,last_customer_message_at=?,resolved_at=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM support_email_messages WHERE id=?)`).bind(customerName,subject,normalizedSubject,now,now,now,now,threadId,messageRowId),
    inboxEventStatement(env.DB, {channel:'email',conversationId:threadId,eventType:'status',
      before:existingThreadId?{status:'previous'}:null,after:{status:'unread',source:'customer_message'},
      actorStaffId:null,correlationId:messageRowId,createdAt:now,messageGuardId:messageRowId}),
  ]);
  if(results[1].meta.changes!==1){
    const saved=await env.DB.prepare('SELECT thread_id FROM support_email_messages WHERE message_id=?').bind(messageId).first<{thread_id:string}>();
    if(!saved)throw new Error('SUPPORT_MESSAGE_NOT_SAVED');
    return {threadId:saved.thread_id,duplicate:true};
  }

  logger.log("support_email_received");
  return { threadId, duplicate: false };
}
