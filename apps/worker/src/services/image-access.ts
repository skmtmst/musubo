import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../worker-env.js';
import { getVisibleLineAccountScope } from './account-access.js';
import { verifyCallerLineIdentity } from './liff-auth.js';
import { hasStaffPermission } from '../middleware/role-guard.js';
import { getChatById, getFriendById } from '@line-crm/db';
import { attachmentFromObject, CHAT_ATTACHMENT_ID, CHAT_ATTACHMENT_PREFIX, signedAttachment } from './chat-attachments.js';

export const PRIVATE_IMAGE_TTL_SECONDS = 300;
export function privateImageKey(key: string): boolean {
  return /^(?:nen-pets|nen-pet-profiles|nen-photo-review|form-uploads)\//.test(key);
}

/** 任意のバケットキーや未公開アップロードでなく、明示した公開先だけを使う。 */
export function publicImageKey(key: string): boolean {
  if (!key || /[\\%\x00-\x1f]/.test(key) || key.includes('..')) return false;
  return /^[^/]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(key)
    || /^(?:media|broadcast-media|rich-menus|imagemaps|instagram-jpeg|nen-photo-public)\//.test(key)
    || /^banner\/.+\.(?:png|jpg|jpeg|gif|webp)$/i.test(key)
    || /^hq-templates\/[^/]+\/uploads\//.test(key);
}

/** 公開メディアの名前空間でも、参加者用の再生認証が必要なオブジェクトとして扱う。 */
export async function isWebinarSource(db: D1Database, key: string): Promise<boolean> {
  return !!await db.prepare(`SELECT id FROM webinars WHERE video_prefix IS NOT NULL AND video_prefix <> ''
    AND (video_prefix = ? OR substr(?, 1, length(video_prefix) + 1) = video_prefix || '/') LIMIT 1`)
    .bind(key, key).first();
}

export function publicDeliveryContentType(contentType: string, publishedDocument = false): boolean {
  return /^(?:image\/(?:png|jpeg|gif|webp)|video\/mp4|audio\/(?:mp4|mpeg|x-m4a))$/i.test(contentType)
    || (publishedDocument && contentType.toLowerCase() === 'application/pdf');
}

function staffImageSurface(path: string, key: string): boolean {
  if (key.startsWith('form-uploads/')) return /^\/api\/(?:form-submissions(?:\/|$)|forms\/[^/]+\/(?:submissions|responses)(?:\/|$)|friends\/[^/]+\/(?:forms|form-submissions)(?:\/|$))/.test(path);
  if (key.startsWith('nen-photo-review/')) return /^\/api\/nen-members(?:\/|$)/.test(path);
  return /^\/api\/(?:nen-members|nen-pets)(?:\/|$)/.test(path);
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function signedMessage(key: string, expires: string): Uint8Array {
  return new TextEncoder().encode(`private-image:v1\n${key}\n${expires}`);
}
export async function signPrivateImageUrl(url: URL, secret: string): Promise<string> {
  if (!secret) throw new Error('image_signing_unconfigured');
  const key = url.pathname.slice('/images/'.length);
  if (!privateImageKey(key)) throw new Error('image_not_signable');
  const expires = String(Math.floor(Date.now() / 1000) + PRIVATE_IMAGE_TTL_SECONDS);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), signedMessage(key, expires)));
  url.search = '';
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', Array.from(signature, b => b.toString(16).padStart(2, '0')).join(''));
  return url.toString();
}
export async function privateImageSignatureValid(url: URL, secret: string | undefined): Promise<boolean> {
  const expires = url.searchParams.get('expires') ?? '';
  const signature = url.searchParams.get('signature') ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!secret || !/^\d{10}$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature)
    || Number(expires) <= now || Number(expires) > now + PRIVATE_IMAGE_TTL_SECONDS) return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', await signingKey(secret), bytes, signedMessage(url.pathname.slice('/images/'.length), expires));
}

/** 所有者は要求 URL でなく、バケットと友だち台帳から確定する。 */
export async function canSignPrivateImage(c: Context<Env>, key: string): Promise<boolean> {
  if (!privateImageKey(key) || key.includes('..') || /[\\%\x00-\x1f]/.test(key)) return false;
  const staff = c.get('staff');
  // 無関係なプロフィール・設定の URL だけで権限を発行しない。画像の各入口で機能と対象の権限を検査する。
  if (staff && !staffImageSurface(c.req.path, key)) return false;
  if (staff && key.startsWith('nen-photo-review/') && !hasStaffPermission(c, 'photo.submission.view')) return false;
  const object = await c.env.IMAGES.head(key);
  if (!object) return false;
  const friendId = object.customMetadata?.friendId
    ?? (key.startsWith('form-uploads/') ? key.split('/')[2] : key.split('/')[1]);
  if (!friendId) return false;
  const friend = await c.env.DB.prepare('SELECT line_account_id, line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
    .bind(friendId).first<{ line_account_id: string; line_user_id: string }>();
  if (!friend?.line_account_id) return false;
  if (staff) return (await getVisibleLineAccountScope(c.env.DB, staff)).ids.includes(friend.line_account_id);
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  return !!identity && identity.lineAccountId === friend.line_account_id && identity.lineUserId === friend.line_user_id;
}

/** 応答画像ごとの所有者を検証してから、新しい権限票を発行する。 */
export const privateImageResponseMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  if (c.res.status >= 400 || !c.res.headers.get('Content-Type')?.includes('application/json')) return;
  const body = await c.res.clone().text();
  if (!/\/images\/(?:nen-pets|nen-pet-profiles|nen-photo-review|form-uploads|chat-attachments)\//.test(body)) return;
  const configuredOrigins = [c.env.WORKER_PUBLIC_URL, c.env.WORKER_URL].filter(Boolean) as string[];
  const origins = new Set((configuredOrigins.length ? configuredOrigins : [c.req.url]).map(value => new URL(value).origin));
  const chatOrigins = new Set(origins);
  for (const alias of (c.env.WORKER_ALIAS_URLS ?? '').split(',')) {
    try {
      const url = new URL(alias.trim());
      if (url.protocol === 'https:' && !url.username && !url.password) chatOrigins.add(url.origin);
    } catch { /* Ignore invalid configured aliases; never trust response-provided hosts. */ }
  }
  const cache = new Map<string, Promise<string>>();
  async function walk(value: unknown, field = '', answers = false): Promise<unknown> {
    if (typeof value === 'string') {
      // 保存済みメッセージ JSON は、認可済みの会話応答内でだけリンクを更新し、任意のテキストは書き換えない。
      if (value.includes('/images/chat-attachments/') && /^[\s]*[\[{]/.test(value)) {
        try { return JSON.stringify(await walk(JSON.parse(value), field, answers)); } catch { return value; }
      }
      let url: URL;
      try { url = new URL(value); } catch { return value; }
      if (chatOrigins.has(url.origin) && url.pathname.startsWith('/images/chat-attachments/')) {
        const id = url.pathname.slice('/images/chat-attachments/'.length);
        const conversation = /^\/api\/chats\/([^/]+)(?:\/|$)/.exec(c.req.path)?.[1];
        const staff = c.get('staff');
        if (!CHAT_ATTACHMENT_ID.test(id) || !conversation || !staff || !hasStaffPermission(c, '/chats')) return value;
        let pending = cache.get(url.pathname);
        if (!pending) {
          pending = (async () => {
            const chat = await getChatById(c.env.DB, conversation);
            const friend = await getFriendById(c.env.DB, chat?.friend_id ?? conversation);
            const object = await c.env.IMAGES.head(`${CHAT_ATTACHMENT_PREFIX}${id}`);
            if (!friend || !object || object.customMetadata?.friendId !== friend.id
              || object.customMetadata?.lineAccountId !== (friend.line_account_id ?? '')
              || !(await getVisibleLineAccountScope(c.env.DB, staff)).ids.includes(friend.line_account_id ?? '')
              || !c.env.API_KEY) return value;
            const attachment = attachmentFromObject(id, object, url.origin);
            if (attachment.expiresAt && (!Number.isFinite(Date.parse(attachment.expiresAt)) || Date.parse(attachment.expiresAt) <= Date.now())) return value;
            return (await signedAttachment(attachment, { friendId: friend.id, lineAccountId: friend.line_account_id }, c.env.API_KEY)).url;
          })();
          cache.set(url.pathname, pending);
        }
        return pending;
      }
      const key = url.pathname.slice('/images/'.length);
      const imageField = field === 'url' || /(?:image|photo|review|preview|avatar).*url/i.test(field);
      if ((!imageField && !(answers && key.startsWith('form-uploads/')))
        || !origins.has(url.origin) || !url.pathname.startsWith('/images/') || !privateImageKey(key)) return value;
      let pending = cache.get(key);
      if (!pending) {
        pending = (async () => await canSignPrivateImage(c, key) && c.env.API_KEY
          ? signPrivateImageUrl(url, c.env.API_KEY) : value)();
        cache.set(key, pending);
      }
      return pending;
    }
    if (Array.isArray(value)) return Promise.all(value.map(entry => walk(entry, field, answers)));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, entry]) => [key,
        await walk(entry, key, answers || /^(?:answers|answer|values|responses)$/.test(key)
          || (key === 'data' && typeof record.formId === 'string' && typeof record.friendId === 'string')),
      ])));
    }
    return value;
  }
  const updated = await walk(JSON.parse(body));
  const headers = new Headers(c.res.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  c.res = new Response(JSON.stringify(updated), { status: c.res.status, headers });
};
