import type { Hono, Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { requirePermission } from '../middleware/role-guard.js';
import { instagramIncomingPreviewSql } from '../services/instagram-inbox-list.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { qaOutboundStopped } from '../services/staging-qa-safety.js';
import { decryptInstagramCredential, InstagramError, instagramCanMessage, instagramConfig } from '../services/instagram.js';

const staleReservationMs = 2 * 60 * 1000;
const unknownNotSentWaitMs = 5 * 60 * 1000;

export function normalizeInstagramText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

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

const metaClockSkewMs = 5 * 1000;
const maxMetaConversationPages = 5;
const maxMetaMessagePagesPerThread = 5;

type TargetOutboundRow = {
  idempotency_key: string;
  content: string;
  status: string;
  meta_message_id: string | null;
  created_at: string;
};

type MetaAbsenceCheck =
  | { ok: true; kind: 'meta_conversation_absent'; evidence: string }
  | { ok: false; status: 409 | 502; error: string; matchedId?: string; reasonCode?: 'sender_id_mismatch' };

function safeGraphNextUrl(next: unknown, version: string): URL | null {
  if (typeof next !== 'string' || !next) return null;
  try {
    const parsed = new URL(next);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'graph.instagram.com' ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !parsed.pathname.startsWith(`/${version}/`)
    ) {
      return null;
    }
    parsed.searchParams.delete('access_token');
    return parsed;
  } catch {
    return null;
  }
}

function parseMetaPagingNext(paging: unknown, version: string): { ok: true; nextUrl: URL | null } | { ok: false } {
  if (paging === undefined || paging === null) return { ok: true, nextUrl: null };
  if (typeof paging !== 'object' || Array.isArray(paging)) return { ok: false };
  const next = (paging as { next?: unknown }).next;
  if (next === undefined || next === null || next === '') return { ok: true, nextUrl: null };
  const nextUrl = safeGraphNextUrl(next, version);
  return nextUrl ? { ok: true, nextUrl } : { ok: false };
}

async function fetchMetaGraphJson(url: URL, token: string): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if ((response.type as string) === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || !response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

async function verifyAbsentInMetaConversation(
  c: Context<Env>,
  lineAccount: string,
  business: string,
  sender: string,
  targetRow: TargetOutboundRow,
  resolvedAt: string,
): Promise<MetaAbsenceCheck> {
  const cfg = instagramConfig(c.env);
  const conn = await businessConnection(c, lineAccount, business);
  if (!cfg || !conn || replyState(c, conn) !== 'ready') {
    return {
      ok: false,
      status: 409,
      error: 'Instagram をつなぎ直すと照合できます。',
    };
  }
  const targetCreatedMs = Date.parse(targetRow.created_at);
  if (!Number.isFinite(targetCreatedMs)) {
    return { ok: false, status: 502, error: '送信記録の時刻を確認できないため未送信と確定できません。' };
  }
  const windowStartMs = targetCreatedMs - metaClockSkewMs;
  let token: string;
  try {
    token = await decryptInstagramCredential(conn.user_token_encrypted, cfg.encryptionKey);
  } catch {
    return { ok: false, status: 502, error: 'Instagramの認証情報を確認できないため未送信と確定できません。' };
  }
  const knownRows = await c.env.DB.prepare(
    'SELECT idempotency_key,meta_message_id FROM instagram_outbound_messages WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND meta_message_id IS NOT NULL',
  ).bind(lineAccount, business, sender).all<{ idempotency_key: string; meta_message_id: string }>();
  const otherKnownMetaIds = new Set(
    knownRows.results
      .filter(row => row.idempotency_key !== targetRow.idempotency_key && row.meta_message_id)
      .map(row => row.meta_message_id),
  );

  let convUrl: URL | null = new URL(`https://graph.instagram.com/${cfg.version}/${encodeURIComponent(business)}/conversations`);
  convUrl.searchParams.set('platform', 'instagram');
  convUrl.searchParams.set('user_id', sender);
  convUrl.searchParams.set('fields', 'messages.limit(25){id,message,created_time,from}');

  let convPages = 0;
  let checkedThreads = 0;
  let checkedMessages = 0;
  const seenMessageIds = new Set<string>();

  while (convUrl) {
    convPages += 1;
    const payload = await fetchMetaGraphJson(convUrl, token);
    if (!payload || !Array.isArray(payload.data)) {
      return { ok: false, status: 502, error: 'Meta側の会話を取得できないため未送信と確定できません。' };
    }
    for (const rawThread of payload.data) {
      if (!rawThread || typeof rawThread !== 'object' || Array.isArray(rawThread)) {
        return { ok: false, status: 502, error: 'Meta側の会話応答を確認できないため未送信と確定できません。' };
      }
      checkedThreads += 1;
      let currentBox = (rawThread as { messages?: unknown }).messages as { data?: unknown; paging?: unknown } | undefined;
      if (!currentBox || typeof currentBox !== 'object' || !Array.isArray(currentBox.data)) {
        return { ok: false, status: 502, error: 'Meta側の会話本文を取得できないため未送信と確定できません。' };
      }
      let msgPages = 0;
      let oldestTime = Infinity;
      let prevTime = Infinity;
      let monotonicDesc = true;

      while (true) {
        msgPages += 1;
        const batch = currentBox.data as unknown[];
        for (const rawMsg of batch) {
          if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
            return { ok: false, status: 502, error: 'Meta側の会話本文を確認できないため未送信と確定できません。' };
          }
          const msg = rawMsg as { id?: unknown; message?: unknown; created_time?: unknown; from?: unknown };
          if (typeof msg.id !== 'string' || !msg.id.trim()) {
            return { ok: false, status: 502, error: 'Meta側のメッセージ識別子を確認できないため未送信と確定できません。' };
          }
          const msgTime = typeof msg.created_time === 'string' ? Date.parse(msg.created_time) : NaN;
          if (!Number.isFinite(msgTime)) {
            return { ok: false, status: 502, error: 'Meta側の送信時刻を確認できないため未送信と確定できません。' };
          }
          if (msgTime > prevTime) monotonicDesc = false;
          prevTime = msgTime;
          if (msgTime < oldestTime) oldestTime = msgTime;

          if (seenMessageIds.has(msg.id)) continue;
          seenMessageIds.add(msg.id);
          checkedMessages += 1;

          if (targetRow.meta_message_id !== null) {
            if (msg.id === targetRow.meta_message_id) {
              return { ok: false, status: 409, matchedId: msg.id, error: 'Meta側の会話でこの返信の送信を確認しました。送信済みとして記録しました。' };
            }
          }
          if (otherKnownMetaIds.has(msg.id)) continue;
          if (msg.from !== undefined && (!msg.from || typeof msg.from !== 'object' || typeof (msg.from as { id?: unknown }).id !== 'string' || !(msg.from as { id: string }).id)) {
            return { ok: false, status: 502, error: 'Meta側の送信者情報を確認できないため未送信と確定できません。' };
          }
          const fromId = msg.from ? (msg.from as { id: string }).id : undefined;
          if (fromId !== undefined && fromId !== business && fromId !== sender) {
            return { ok: false, status: 502, reasonCode: 'sender_id_mismatch', error: 'Meta側の送り主の番号の形が違うため照合できません。' };
          }
          if ((fromId === undefined || fromId === business) && msgTime >= windowStartMs) {
            if (typeof msg.message !== 'string') {
              return { ok: false, status: 502, error: 'Meta側の送信内容を確認できないため未送信と確定できません。' };
            }
            if (normalizeInstagramText(msg.message) === normalizeInstagramText(targetRow.content)) {
              return {
                ok: false,
                status: 409,
                matchedId: msg.id,
                error: 'Meta側に同じ文面の返信があるため送信済みとして記録しました。',
              };
            }
          }
        }

        const innerPaging = parseMetaPagingNext(currentBox.paging, cfg.version);
        if (!innerPaging.ok) {
          return { ok: false, status: 502, error: 'Meta側の会話履歴の続きを確認できないため未送信と確定できません。' };
        }
        if (!innerPaging.nextUrl) break;
        // 降順が確認でき、かつ照合下限より厳密に古い時刻まで到達した場合のみ後続ページを省略できる。
        if (monotonicDesc && batch.length > 0 && oldestTime < windowStartMs) break;
        if (msgPages >= maxMetaMessagePagesPerThread) {
          return { ok: false, status: 502, error: 'Meta側の会話履歴を送信時刻まで最後まで確認できないため未送信と確定できません。' };
        }
        const nextMessages = await fetchMetaGraphJson(innerPaging.nextUrl, token);
        if (!nextMessages || !Array.isArray(nextMessages.data)) {
          return { ok: false, status: 502, error: 'Meta側の会話履歴の続きを取得できないため未送信と確定できません。' };
        }
        currentBox = nextMessages as { data: unknown[]; paging?: unknown };
      }
    }

    const outerPaging = parseMetaPagingNext(payload.paging, cfg.version);
    if (!outerPaging.ok) {
      return { ok: false, status: 502, error: 'Meta側の会話一覧の続きを確認できないため未送信と確定できません。' };
    }
    if (!outerPaging.nextUrl) {
      convUrl = null;
      break;
    }
    if (convPages >= maxMetaConversationPages) {
      return { ok: false, status: 502, error: 'Meta側の会話一覧を最後まで確認できないため未送信と確定できません。' };
    }
    convUrl = outerPaging.nextUrl;
  }

  return {
    ok: true,
    kind: 'meta_conversation_absent',
    evidence: `meta_conversation_absent:threads=${checkedThreads}:messages=${checkedMessages}:checked_at=${resolvedAt}`,
  };
}

export function registerInstagramInboxRoutes(instagram: Hono<Env>, account: (c: Context<Env>) => Promise<string>): void {
  instagram.get('/api/instagram/inbox-status', requirePermission('/chats'), async c => {
    const id = await account(c);
    const rows = await c.env.DB.prepare('SELECT instagram_id,expires_at,data_access_expires_at,scopes FROM instagram_connections WHERE line_account_id=?')
      .bind(id).all<Omit<DmConnection, 'user_token_encrypted'>>();
    const states = rows.results.map(row => replyState(c, row));
    return c.json({ success: true, data: { state: states.includes('ready') ? 'ready' : states.includes('permission_required') ? 'permission_required' : 'disconnected' } });
  });
  instagram.get('/api/instagram/conversations/:senderId', requirePermission('/chats'), async (c) => {
    const id = await account(c), sender = c.req.param('senderId');
    const business = await businessForConversation(c, id, sender);
    const state = replyState(c, await businessConnection(c, id, business));
    const rows = await c.env.DB.prepare(`SELECT id,${instagramIncomingPreviewSql} AS content,received_at AS createdAt,'incoming' AS direction FROM instagram_messages
        WHERE line_account_id=? AND sender_id=? AND instagram_id=?
      UNION ALL SELECT COALESCE(meta_message_id,idempotency_key) AS id,content,sent_at AS createdAt,'outgoing' AS direction FROM instagram_outbound_messages
        WHERE line_account_id=? AND sender_id=? AND instagram_id=? AND status='sent'
      ORDER BY createdAt DESC,id DESC LIMIT 200`).bind(id, sender, business, id, sender, business).all();
    if (!rows.results.length) throw new InstagramError('not_found', 404);
    const pending = await c.env.DB.prepare(`SELECT idempotency_key AS key,content,status,created_at,resolution_evidence
      FROM instagram_outbound_messages WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND status IN ('pending','unknown')`)
      .bind(id, business, sender).first<{ key: string; content: string; status: string; created_at: string; resolution_evidence: string | null }>();
    const serverNow = new Date().toISOString();
    const pendingReply = pending ? { serverNow, warning: pending.resolution_evidence?.includes('[echo_ambiguous]') ? '送信通知の候補が複数あるため、Instagramで確かめてください。' : pending.resolution_evidence?.includes('[sender_id_mismatch]') ? '送り主の番号の形が違うため、Instagramで確かめてください。' : null, key: pending.key, content: pending.content,
      canResolve: pending.status === 'unknown' || Date.parse(pending.created_at) <= Date.now() - staleReservationMs,
      canResolveNotSent: Date.parse(pending.created_at) <= Date.now() - unknownNotSentWaitMs,
      resolveAt: new Date(Date.parse(pending.created_at) + unknownNotSentWaitMs).toISOString() } : null;
    const lateEcho = await c.env.DB.prepare(`SELECT created_at,resolved_at,content FROM instagram_outbound_messages
      WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND resolution_evidence LIKE '%[echo_after_not_sent]%'
      ORDER BY resolved_at DESC LIMIT 1`).bind(id, business, sender).first<{created_at: string; resolved_at: string; content: string}>();
    const resent = lateEcho ? await c.env.DB.prepare(`SELECT 1 FROM instagram_outbound_messages
      WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND created_at>=? AND created_at>? AND status IN ('pending','unknown','sent') LIMIT 1`)
      .bind(id, business, sender, lateEcho.resolved_at, lateEcho.created_at).first() : null;
    const ambiguous = await c.env.DB.prepare("SELECT 1 FROM instagram_outbound_messages WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND status IN ('pending','unknown','not_sent_confirmed') AND resolution_evidence LIKE '%[echo_ambiguous]%' LIMIT 1").bind(id, business, sender).first();
    return c.json({ success: true, data: { messages: rows.results.reverse(), replyState: state, pendingReply, reconciliationWarning: ambiguous ? '送信通知の候補が複数あるため、Instagramで確かめてください。' : null,
      lateEchoNotice: lateEcho ? (resent ? '未送信とした返信が実際には届いていました。再送済みのため二重送信の可能性があります。' : '未送信とした返信が実際には届いていました。') : null } });
  });
  instagram.post('/api/instagram/conversations/:senderId/resolve', requirePermission('/chats'), inputJsonBoundary(), async c => {
    const id = await account(c), sender = c.req.param('senderId');
    if (c.get('impersonation')) return c.json({ success: false, error: '代理ログイン中は変更できません' }, 403);
    const body = await c.req.json<{ key?: unknown; outcome?: unknown; reason?: unknown } | null>();
    if (!body || typeof body.key !== 'string' || !isValidIdempotencyKey(body.key)
      || (body.outcome !== 'sent' && body.outcome !== 'not_sent')
      || (body.reason !== undefined && typeof body.reason !== 'string'))
      return c.json({ success: false, error: '送信結果を選び直してください。' }, 400);
    const staff = c.get('staff');
    if (!staff || staff.readOnly || (staff.role !== 'owner' && staff.role !== 'admin')) {
      return c.json({ success: false, error: '送信結果を確定できるのはオーナーまたは管理者のみです。' }, 403);
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length > 500) {
      return c.json({ success: false, error: '確認理由は500文字以内で入力してください。' }, 400);
    }
    const business = await businessForConversation(c, id, sender);
    const staleCutoff = new Date(Date.now() - (body.outcome === 'not_sent' ? unknownNotSentWaitMs : staleReservationMs)).toISOString();
    const target = `WHERE line_account_id=? AND instagram_id=? AND sender_id=? AND idempotency_key=?
      AND ${body.outcome === 'sent' ? "(status='unknown' OR (status='pending' AND created_at<=?))" : "status IN ('unknown','pending') AND created_at<=?"}`;
    const targetRow = await c.env.DB.prepare(`SELECT idempotency_key,content,status,meta_message_id,created_at
      FROM instagram_outbound_messages ${target}`).bind(id, business, sender, body.key, staleCutoff).first<TargetOutboundRow>();
    if (!targetRow) {
      return c.json({ success: false, error: 'この返信は送信中、または確認済みです。会話を読み直してください。' }, 409);
    }
    const resolvedAt = new Date().toISOString();
    if (body.outcome === 'sent') {
      const changed = await c.env.DB.prepare(
        `UPDATE instagram_outbound_messages SET status='sent',sent_at=COALESCE(sent_at,created_at),resolved_by_staff_id=?,resolved_at=? ${target}`,
      ).bind(staff.id, resolvedAt, id, business, sender, body.key, staleCutoff).run();
      if (!changed.meta.changes) return c.json({ success: false, error: 'この返信は送信中、または確認済みです。会話を読み直してください。' }, 409);
      return c.json({ success: true });
    }
    const verified = await verifyAbsentInMetaConversation(c, id, business, sender, targetRow, resolvedAt);
    let resolutionKind: 'reason' | 'meta_conversation_absent';
    let resolutionEvidence: string;
    if (!verified.ok) {
      if (verified.matchedId) {
        const updated = await c.env.DB.prepare(
          `UPDATE instagram_outbound_messages SET status='sent',meta_message_id=?,sent_at=COALESCE(sent_at,created_at),resolved_by_staff_id=?,resolved_at=?,resolution_kind=NULL,resolution_evidence=? ${target}`,
        ).bind(verified.matchedId, staff.id, resolvedAt, JSON.stringify({ type: 'meta_message_found', messageId: verified.matchedId, reason }), id, business, sender, body.key, staleCutoff).run();
        if (!updated.meta.changes) return c.json({ success: false, error: '会話を読み直してください。' }, 409);
        return c.json({ success: true, data: { outcome: 'sent', message: 'Instagram で届いていたので送信済みにしました。' } });
      }
      if (verified.reasonCode === 'sender_id_mismatch') {
        await c.env.DB.prepare(`UPDATE instagram_outbound_messages SET resolution_evidence=COALESCE(resolution_evidence,'') || '[sender_id_mismatch]' ${target} AND COALESCE(resolution_evidence,'') NOT LIKE '%[sender_id_mismatch]%'`)
          .bind(id, business, sender, body.key, staleCutoff).run();
      }
      if (!reason) return c.json({ success: false, error: `${verified.error} Instagram で届いていないことを確かめてから、理由を入力してください。` }, verified.status);
      resolutionKind = 'reason';
      resolutionEvidence = JSON.stringify({ reason, failure: verified.error });
    } else {
      resolutionKind = verified.kind;
      resolutionEvidence = reason ? `${verified.evidence}:reason=${JSON.stringify(reason)}` : verified.evidence;
    }
    const changed = await c.env.DB.prepare(
      `UPDATE instagram_outbound_messages
          SET status='not_sent_confirmed',resolved_by_staff_id=?,resolved_at=?,resolution_kind=?,resolution_evidence=?
        ${target}`,
    ).bind(staff.id, resolvedAt, resolutionKind, resolutionEvidence, id, business, sender, body.key, staleCutoff).run();
    if (!changed.meta.changes) return c.json({ success: false, error: 'この返信は送信中、または確認済みです。会話を読み直してください。' }, 409);
    return c.json({ success: true, data: { outcome: 'not_sent' } });
  });
  instagram.post('/api/instagram/conversations/:senderId/read', requirePermission('/chats'), async (c) => {
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
  instagram.post('/api/instagram/messages/:id/reply', requirePermission('/chats'), inputJsonBoundary(), async (c) => {
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
      if (existing.status === 'not_sent_confirmed')
        return c.json({ success: false, error: '未送信として確定済みの送信キーは再利用できません。新しい送信として送り直してください' }, 409);
      return c.json({ success: false, error: '送信結果を確認してください。重複防止のため再送できません' }, 409);
    }
    const unresolved = await c.env.DB.prepare(
      "SELECT 1 FROM instagram_outbound_messages WHERE instagram_id=? AND sender_id=? AND status IN ('pending','unknown') LIMIT 1",
    ).bind(message.instagram_id, message.sender_id).first();
    if (unresolved) {
      return c.json({ success: false, error: '送信結果の確認待ちです。未送信または送信済みと確定するまで再送できません。' }, 409);
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
    let receivedMessageId: string | null = null;
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
      receivedMessageId = sent.message_id;
      await c.env.DB.prepare("UPDATE instagram_outbound_messages SET status='sent',meta_message_id=?,sent_at=? WHERE idempotency_key=? AND status='pending'")
        .bind(sent.message_id, new Date().toISOString(), key).run();
      return c.json({ success: true, data: { messageId: sent.message_id, replayed: false } });
    } catch {
      await c.env.DB.prepare("UPDATE instagram_outbound_messages SET status='unknown',meta_message_id=COALESCE(meta_message_id,?) WHERE idempotency_key=? AND status='pending'")
        .bind(receivedMessageId, key).run();
      return c.json({ success: false, error: '送信結果を確認できません。Instagramで確認してください' }, 502);
    }
  });
}
