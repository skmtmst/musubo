import PostalMime from 'postal-mime';
import type { Env } from '../worker-env.js';
import { stripHtml } from './support-email-store.js';

export const accountEmailPrefix = 'inbox-';
const maxRawBytes = 10 * 1024 * 1024;
const chunkBytes = 256 * 1024;
export const verificationSubject = '【musubo】メール転送の受信確認';

export async function hashMail(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function receiveAccountEmail(message: ForwardableEmailMessage, env: Env['Bindings']) {
  const db = env.DB;
  const address = message.to.toLowerCase();
  if (address.split('@')[1] !== env.ACCOUNT_EMAIL_DOMAIN?.trim().toLowerCase() || !env.ACCOUNT_EMAIL_DOMAIN) {
    return message.setReject('受信用アドレスが無効です');
  }
  const connection = await db
    .prepare("SELECT id,status FROM account_email_connections WHERE address=? AND status <> 'revoked'")
    .bind(address)
    .first<{ id: string; status: string }>();
  if (!connection) return message.setReject('受信用アドレスが無効です');
  if (message.rawSize > maxRawBytes) return message.setReject('メールは10 MiBまで受信できます');
  const raw = await new Response(message.raw).arrayBuffer();
  const mail = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer',
    maxNestingDepth: 20,
    maxHeadersSize: 256 * 1024,
  });
  const subject = (mail.subject || '(件名なし)').slice(0, 1000);
  const sender = mail.from?.address?.trim().toLowerCase();
  const body = (mail.text || stripHtml(mail.html || '')).slice(0, 200_000);
  if (subject.includes(verificationSubject)) {
    const proof = body.match(/musubo-verify=([0-9a-f-]{36})\b/);
    if (proof)
      await db
        .prepare(
          `UPDATE account_email_connections SET status='connected',challenge_hash=NULL,forwarding_confirmation=NULL,checked_at=?,automated_at=NULL
       WHERE id=? AND status IN ('pending','connected') AND challenge_hash=? AND challenge_sent>=?`,
        )
        .bind(new Date().toISOString(), connection.id, await hashMail(proof[1]), Date.now() - 3600_000)
        .run();
    return;
  }
  const envelopeSender = message.from.trim().toLowerCase();
  const yahooIdentity = !!sender && /^(?:login|reg)-master@mail\.yahoo\.co\.jp$/i.test(sender);
  if (connection.status !== 'connected') {
    // Gmail sends its own setup code before forwarding is active. Never render email HTML or links.
    if (
      sender === envelopeSender &&
      (sender === 'forwarding-noreply@google.com' ||
        (yahooIdentity && subject.includes('連絡用メールアドレス') && subject.includes('確認コード')))
    ) {
      const code = body.match(/(?:confirmation code|確認コード)\s*[:：]?\s*(\d{5,12})/i)?.[1];
      const confirmation =
        code ?? (body+' '+(mail.html ?? '')).match(/https:\/\/mail-settings\.google\.com\/mail\/vf-[A-Za-z0-9_-]+/)?.[0];
      if (confirmation)
        await db
          .prepare(
            "UPDATE account_email_connections SET forwarding_confirmation=? WHERE id=? AND status IN ('setup','pending')",
          )
          .bind(confirmation, connection.id)
          .run();
      return;
    }
    return message.setReject('転送の受信確認が完了していません');
  }
  const auto = message.headers.get('auto-submitted')?.toLowerCase();
  if (yahooIdentity || sender === 'forwarding-noreply@google.com') return;
  if (auto && auto !== 'no' && auto !== 'auto-forwarded') {
    await db
      .prepare("UPDATE account_email_connections SET automated_at=? WHERE id=? AND status='connected'")
      .bind(Date.now(), connection.id)
      .run();
    return;
  }
  if (
    !sender ||
    !message.from ||
    message.from === '<>' ||
    sender.endsWith('@' + env.ACCOUNT_EMAIL_DOMAIN.trim().toLowerCase()) ||
    /^(mailer-daemon|postmaster)@/i.test(sender)
  )
    return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) return message.setReject('送信元を確認できません');
  if (
    mail.attachments.length > 16 ||
    mail.attachments.some(
      (file) => !(file.content instanceof ArrayBuffer) || file.content.byteLength > maxRawBytes,
    )
  ) {
    return message.setReject('メール全体は10 MiBまで、添付は16件までです');
  }
  const key = await hashMail(mail.messageId?.trim() || raw);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const thread = `SELECT t.id FROM account_email_threads t JOIN account_email_connections c ON c.id=t.connection_id
    WHERE c.id=? AND c.status='connected' AND t.customer_email=?`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO account_email_threads(id,connection_id,customer_email,customer_name,subject,last_message_at)
      SELECT ?,id,?,?,?,? FROM account_email_connections WHERE id=? AND status='connected'
      ON CONFLICT(connection_id,customer_email) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), sender, mail.from?.name || null, subject, now, connection.id),
    db
      .prepare(
        `INSERT INTO account_email_messages(id,thread_id,dedup_key,subject,body_text,created_at)
      SELECT ?,t.id,?,?,?,max(?,coalesce((SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(created_at),'+0.001 seconds') FROM account_email_messages WHERE thread_id=t.id),'')) FROM (${thread}) t WHERE true ON CONFLICT(thread_id,dedup_key) DO NOTHING`,
      )
      .bind(id, key, subject, body, now, connection.id, sender),
    db
      .prepare(
        `INSERT INTO notifications(id,event_type,title,body,channel,status,line_account_id,category,created_at)
      SELECT m.id,'account_email_received','店舗メールを受信しました','受信箱のメールで確認できます。','dashboard','sent',c.account_id,'info',m.created_at
      FROM account_email_messages m JOIN account_email_threads t ON t.id=m.thread_id JOIN account_email_connections c ON c.id=t.connection_id
      WHERE m.id=? AND c.id=? AND c.status='connected'`,
      )
      .bind(id, connection.id),
    ...mail.attachments.flatMap((file) => {
      const content = file.content as ArrayBuffer;
      const fileId = crypto.randomUUID();
      const statements = [
        db
          .prepare(
            `INSERT INTO account_email_attachments(id,message_id,filename,content_type,size)
        SELECT ?,id,?,?,? FROM account_email_messages WHERE id=?`,
          )
          .bind(fileId, (file.filename || 'attachment').slice(0, 240), file.mimeType, content.byteLength, id),
      ];
      for (let offset = 0; offset < content.byteLength; offset += chunkBytes) {
        statements.push(
          db
            .prepare(
              `INSERT INTO account_email_attachment_parts(attachment_id,part,content)
          SELECT id,?,? FROM account_email_attachments WHERE id=?`,
            )
            .bind(offset / chunkBytes, new Uint8Array(content.slice(offset, offset + chunkBytes)), fileId),
        );
      }
      return statements;
    }),
  ]);
}
