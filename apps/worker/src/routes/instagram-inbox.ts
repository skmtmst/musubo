import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { instagramIncomingPreviewSql } from '../services/instagram-inbox-list.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { qaOutboundStopped } from '../services/staging-qa-safety.js';
import { decryptInstagramCredential, InstagramError, instagramCanMessage, instagramConfig } from '../services/instagram.js';

// Allow manual reconciliation after the 15-second Meta request has had time to finish.
const staleReservationMs = 2 * 60 * 1000;

type DmConnection = {
  instagram_id: string;
  user_token_encrypted: string;
  expires_at: string;
  data_access_expires_at: string | null;
  scopes: string;
};

function replyState(c: Context<Env>, row: Omit<DmConnection,'user_token_encrypted'> | null) {
  if (!row || !instagramConfig(c.env) || !(Date.parse(row.expires_at) > Date.now()) ||
      (row.data_access_expires_at !== null && !(Date.parse(row.data_access_expires_at) > Date.now()))) return 'disconnected';
  if (!instagramCanMessage(row.scopes)) return 'permission_required';
  return 'ready';
}

async function businessForConversation(c: Context<Env>, lineAccount: string, sender: string) {
  const requested = c.req.query('instagramId');
  if (requested) return requested;
  const rows = await c.env.DB.prepare(
    'SELECT DISTINCT instagram_id FROM instagram_messages WHERE line_account_id=? AND sender_id=? LIMIT 2',
  ).bind(lineAccount, sender).all<{ instagram_id: string }>();
  if (rows.results.length !== 1) throw new InstagramError(rows.results.length ? 'instagram_id_required' : 'not_found', rows.results.length ? 400 : 404);
  return rows.results[0].instagram_id;
}

async function businessConnection(c: Context<Env>, lineAccount: string, business: string) {
  return c.env.DB.prepare('SELECT instagram_id,user_token_encrypted,expires_at,data_access_expires_at,scopes FROM instagram_connections WHERE line_account_id=? AND instagram_id=?')
    .bind(lineAccount, business).first<DmConnection>();
}

export function instagramInboxRoutes(account: (c: Context<Env>) => Promise<string>) {
  const instagram = new Hono<Env>();
  instagram.get('/api/instagram/inbox-status', async c => {
    const id = await account(c);
    const rows = await c.env.DB.prepare('SELECT instagram_id,expires_at,data_access_expires_at,scopes FROM instagram_connections WHERE line_account_id=?')
      .bind(id).all<Omit<DmConnection, 'user_token_encrypted'>>();
    const states = rows.results.map(row => replyState(c, row));
    return c.json({ success: true, data: { state: states.includes('ready') ? 'ready' : states.includes('permission_required') ? 'permission_required' : 'disconnected' } });
  });
  instagram.get('/api/instagram/conversations/:senderId', async (c) => {
    const id = await account(c), sender = c.req.param('senderId');
    const business = await businessForConversation(c, id, sender);
    const state = replyState(c, await businessConnection(c, id, business));
    const rows = await c.env.DB.prepare(`SELECT id,${instagramIncomingPreviewSql} AS content,received_at AS createdAt,'incoming' AS direction FROM instagram_messages
        WHERE line_account_id=? AND sender_id=? AND instagram_id=?
      UNION ALL SELECT COALESCE(meta_message_id,idempotency_key) AS id,content,sent_at AS createdAt,'outgoing' AS direction FROM instagram_outbound_messages
        WHERE line_account_id=? AND sender_id=? AND instagram_id=? AND status='sent'
      ORDER BY createdAt DESC,id DESC LIMIT 200`).bind(id, sender, business, id, sender, business).all();
    if (!rows.results.length) throw new InstagramError('not_found', 404);
    const pending = await c.env.DB.prepare(`SELECT idempotency_key AS key,content,status,created_at
      FROM instagram_outbound_messages WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND status IN ('pending','unknown')`)
      .bind(id, business, sender).first<{ key: string; content: string; status: string; created_at: string }>();
    const pendingReply = pending ? { key: pending.key, content: pending.content,
      canResolve: pending.status === 'unknown' || Date.parse(pending.created_at) <= Date.now() - staleReservationMs } : null;
    return c.json({ success: true, data: { messages: rows.results.reverse(), replyState: state, pendingReply } });
  });
  instagram.post('/api/instagram/conversations/:senderId/resolve', inputJsonBoundary(), async c => {
    const id = await account(c), sender = c.req.param('senderId');
    if (c.get('impersonation')) return c.json({ success: false, error: '代理ログイン中は変更できません' }, 403);
    const business = await businessForConversation(c, id, sender);
    const body = await c.req.json<{ key?: string; outcome?: string } | null>();
    if (!body || typeof body.key !== 'string' || !isValidIdempotencyKey(body.key) || !['sent','not_sent'].includes(body.outcome ?? ''))
      return c.json({ success: false, error: '送信結果を選び直してください。' }, 400);
    const target = `WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND idempotency_key=?
      AND (status='unknown' OR (status='pending' AND created_at<=?))`;
    const sql = body.outcome === 'sent'
      ? "UPDATE instagram_outbound_messages SET status='sent',sent_at=created_at"
      : 'DELETE FROM instagram_outbound_messages';
    const changed = await c.env.DB.prepare(`${sql} ${target}`).bind(id, business, sender, body.key,
      new Date(Date.now() - staleReservationMs).toISOString()).run();
    if (!changed.meta.changes) return c.json({ success: false, error: 'この返信は送信中、または確認済みです。会話を読み直してください。' }, 409);
    return c.json({ success: true });
  });
  instagram.post('/api/instagram/conversations/:senderId/read', async (c) => {
    const id = await account(c), sender = c.req.param('senderId');
    const business = await businessForConversation(c, id, sender);
    const last = await c.env.DB.prepare('SELECT MAX(received_at) AS last FROM instagram_messages WHERE line_account_id=? AND sender_id=? AND instagram_id=?')
      .bind(id, sender, business).first<{ last: string | null }>();
    if (!last?.last) return c.json({ success: false, error: '会話が見つかりません' }, 404);
    await c.env.DB.prepare(`INSERT INTO instagram_inbox_reads(staff_id,line_account_id,sender_id,last_read_at) VALUES(?,?,?,?)
      ON CONFLICT(staff_id,line_account_id,sender_id) DO UPDATE SET last_read_at=MAX(last_read_at,excluded.last_read_at)`)
      .bind(c.get('staff').id, id, JSON.stringify([business, sender]), last.last).run();
    return c.json({ success: true });
  });
  instagram.post('/api/instagram/messages/:id/reply', inputJsonBoundary(), async (c) => {
    if (c.get('impersonation')) return c.json({ success: false, error: '代理ログイン中は送れません' }, 403);
    const id = await account(c);
    const key = c.req.header('Idempotency-Key')?.trim();
    if (!isValidIdempotencyKey(key)) return c.json({ success: false, error: '有効なIdempotency-Keyが必要です' }, 400);
    const body = await c.req.json<{ text?: unknown } | null>();
    if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 1000)
      return c.json({ success: false, error: '返信文を入力してください（1000文字以内）' }, 400);
    const message = await c.env.DB.prepare('SELECT sender_id,instagram_id FROM instagram_messages WHERE line_account_id=? AND id=?')
      .bind(id, c.req.param('id')).first<{ sender_id: string; instagram_id: string }>();
    if (!message) return c.json({ success: false, error: '会話が見つかりません' }, 404);
    const existing = await c.env.DB.prepare('SELECT line_account_id,instagram_id,sender_id,content,status,meta_message_id FROM instagram_outbound_messages WHERE idempotency_key=?')
      .bind(key).first<{ line_account_id: string; instagram_id: string; sender_id: string; content: string; status: string; meta_message_id: string | null }>();
    if (existing) {
      if (existing.line_account_id !== id || existing.instagram_id !== message.instagram_id || existing.sender_id !== message.sender_id || existing.content !== body.text)
        return c.json({ success: false, error: '送信キーが別の返信に使われています' }, 409);
      if (existing.status === 'sent') return c.json({ success: true, data: { messageId: existing.meta_message_id, replayed: true } });
      return c.json({ success: false, error: '送信結果を確認してください。重複防止のため再送できません' }, 409);
    }
    if (c.env.DEPLOY_ENV === 'staging' && (c.env.INSTAGRAM_STAGING_SEND_ENABLED !== 'true' || qaOutboundStopped(c.env)))
      return c.json({ success: false, error: '検証環境ではInstagramへの送信が無効です' }, 403);
    const cfg = instagramConfig(c.env);
    const row = await businessConnection(c, id, message.instagram_id);
    const state = replyState(c, row);
    if (!cfg || !row || state === 'disconnected') return c.json({ success: false, error: '接続が切れているため返信できません。Instagramの接続を確認してください。' }, 409);
    if (state === 'permission_required') return c.json({ success: false, error: 'DMの権限がありません。Metaの審査とInstagramのつなぎ直しを確認してください。' }, 409);
    const latest = await c.env.DB.prepare('SELECT MAX(received_at) AS latest FROM instagram_messages WHERE line_account_id=? AND sender_id=? AND instagram_id=?')
      .bind(id, message.sender_id, message.instagram_id).first<{ latest: string | null }>();
    const lastAt = Date.parse(latest?.latest ?? '');
    if (!Number.isFinite(lastAt) || lastAt > Date.now() || Date.now() - lastAt >= 24 * 60 * 60 * 1000)
      return c.json({ success: false, error: '最後のお客さまのメッセージから24時間を過ぎたため返信できません' }, 409);
    const token = await decryptInstagramCredential(row.user_token_encrypted, cfg.encryptionKey);
    const now = new Date().toISOString();
    const reservation = await c.env.DB.prepare(`INSERT OR IGNORE INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)`)
      .bind(key, id, row.instagram_id, message.sender_id, c.get('staff').id, body.text, now).run();
    if (!reservation.meta.changes) return c.json({ success: false, error: '送信結果の確認待ちです。Instagramを複数店舗で共有している場合は、返信した店舗の受信箱で確認してください。' }, 409);
    try {
      const response = await fetch(`https://graph.instagram.com/${cfg.version}/${row.instagram_id}/messages`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: message.sender_id }, message: { text: body.text } }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const rejection = await response.json() as { error?: { code?: number } };
          const code = rejection.error?.code;
          if (typeof code === 'number' && response.status !== 408) {
            const db = c.env.DB;
            const release = db.prepare("DELETE FROM instagram_outbound_messages WHERE idempotency_key=? AND status='pending'").bind(key);
            if (code === 190) {
              // Discard only the credential Meta rejected, in case the store has already reconnected.
              const expire = db.prepare('UPDATE instagram_connections SET expires_at=?,version=version+1 WHERE line_account_id=? AND instagram_id=? AND user_token_encrypted=?')
                .bind(now, id, row.instagram_id, row.user_token_encrypted);
              await db.batch([expire, release]);
              return c.json({ success: false, error: '接続が切れました。Instagramをつなぎ直してください。' }, 409);
            }
            await release.run();
            const error = code === 10 || code === 200 ? 'Instagramでこの返信が許可されませんでした。DMの権限と返信期限を確認してください。'
              : 'Instagramが送信を受け付けませんでした。内容と利用制限を確認してください。';
            return c.json({ success: false, error }, 422);
          }
        }
        throw new Error('send_failed');
      }
      const sent = await response.json() as { message_id?: unknown };
      if (typeof sent.message_id !== 'string' || !sent.message_id) throw new Error('invalid_response');
      await c.env.DB.prepare("UPDATE instagram_outbound_messages SET status='sent',meta_message_id=?,sent_at=? WHERE idempotency_key=? AND status='pending'")
        .bind(sent.message_id, new Date().toISOString(), key).run();
      return c.json({ success: true, data: { messageId: sent.message_id, replayed: false } });
    } catch {
      await c.env.DB.prepare("UPDATE instagram_outbound_messages SET status='unknown' WHERE idempotency_key=? AND status='pending'").bind(key).run();
      return c.json({ success: false, error: '送信結果を確認できません。Instagramで確認してください' }, 502);
    }
  });
  return instagram;
}
