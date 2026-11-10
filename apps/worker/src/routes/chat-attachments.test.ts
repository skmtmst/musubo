import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { CHAT_FILE_MAX_BYTES, CHAT_FILE_TYPES, CHAT_VIDEO_MAX_BYTES, type ChatAttachment } from '@line-crm/shared';

import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { attachmentBucket, MP4_BYTES, PDF_BYTES, PNG_BYTES, zipBytes } from '../test-utils/chat-attachment-bucket.js';
import { chatAttachments } from './chat-attachments.js';
import { chats } from './chats.js';
import { images } from './images.js';
import { processDueScheduledChatSends } from '../services/scheduled-chat-sends.js';
import { uploadKind, validateChatUpload, CHAT_UPLOAD_PREFIX } from '../services/chat-attachments.js';
import { privateImageResponseMiddleware } from '../services/image-access.js';

const signed = vi.hoisted(() => vi.fn());
vi.mock('../services/r2-presigned-upload.js', () => ({ createR2PresignedPutUrl: signed }));
let db: SqliteD1;
let storage: ReturnType<typeof attachmentBucket>;
let bindings: Env['Bindings'];
const owner: AuthenticatedStaff = { id: 'owner', name: '担当者', role: 'owner', readOnly: false, tenantId: 'tenant' };
type TestReply = { data: ChatAttachment & { messageType: string } };
const key = () => crypto.randomUUID();
const future = (days = 1) => new Date(Date.now() + days * 86400000).toISOString();
const lineFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
const app = (actor = owner) => {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => { c.set('staff', actor); await next(); });
  instance.use('*', privateImageResponseMiddleware);
  instance.route('/', chatAttachments); instance.route('/', chats); instance.route('/', images);
  return instance;
};
function json(path: string, body: unknown, method = 'POST', actor = owner, sendKey = key()) {
  return app(actor).request(path, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sendKey }, body: JSON.stringify(body) }, bindings);
}
function upload(bytes = PDF_BYTES, filename = '案内.pdf', mime = 'application/pdf', friend = 'f1', actor = owner, size?: number) {
  return app(actor).request(`/api/chats/${friend}/attachments/upload`, {
    method: 'POST', headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(filename), ...(size === undefined ? {} : { 'Content-Length': String(size) }) }, body: bytes,
  }, bindings);
}
async function uploadedFile() { return (await (await upload()).json<TestReply>()).data; }
function send(type: string, content: unknown, sendKey = key()) {
  return json('/api/chats/f1/send', { messageType: type, content: typeof content === 'string' ? content : JSON.stringify(content) }, 'POST', owner, sendKey);
}
function schedule(type: string, content: unknown, days = 1) {
  return json('/api/chats/f1/schedule', { messageType: type, content: JSON.stringify(content), scheduledAt: future(days) });
}
function pushes() { return lineFetch.mock.calls.filter(call => String(call[0]).endsWith('/v2/bot/message/push')); }
function payload() { return JSON.parse(pushes().at(-1)![1]!.body as string); }
async function video(actor = owner) {
  const created = await json('/api/chats/f1/attachments/upload-sessions', { filename: '動画.mp4', mimeType: 'video/mp4', sizeBytes: MP4_BYTES.length }, 'POST', actor);
  expect(created.status).toBe(201);
  const { data } = await created.json<TestReply>();
  await storage.bucket.put(`${CHAT_UPLOAD_PREFIX}${data.id}.mp4`, MP4_BYTES, {
    httpMetadata: { contentType: 'video/mp4' }, customMetadata: { 'upload-session-id': data.id, 'line-account-id': 'a1' },
  });
  const head = await storage.bucket.head(`${CHAT_UPLOAD_PREFIX}${data.id}.mp4`);
  const complete = await json(`/api/chats/f1/attachments/upload-sessions/${data.id}/complete`, { etag: `"${head!.etag}"` }, 'POST', actor);
  expect(complete.status).toBe(201);
  return { attachment: (await complete.json<TestReply>()).data, sessionId: data.id, etag: head!.etag };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', lineFetch);
  // NodeにはWorkerのFixedLengthStreamがない。実際に長さの不一致も拒否する。
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expected: number) {
      let count = 0;
      super({ transform(chunk, controller) { count += chunk.length; controller.enqueue(chunk); },
        flush() { if (count !== expected) throw new Error('length mismatch'); } });
    }
  });
  db = createTestD1();
  db.raw.exec(`INSERT INTO tenants(id,name) VALUES('tenant','統括'),('other','別の統括');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,is_active,tenant_id)
    VALUES('a1','c1','LINE1','token','secret',1,'tenant'),('a2','c2','LINE2','token2','secret',1,'other');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope,permission_keys)
    VALUES('owner','担当者','owner','key','tenant','all','[]');
    INSERT INTO friends(id,line_user_id,display_name,line_account_id)
    VALUES('f1','U1','利用者1','a1'),('f2','U2','利用者2','a1'),('f3','U3','別の利用者','a2');`);
  storage = attachmentBucket();
  bindings = { DB: db.db, IMAGES: storage.bucket, WORKER_URL: 'https://worker.example', API_KEY: 'fixture-download-signing-key', LINE_CHANNEL_ACCESS_TOKEN: 'token',
    CF_ACCOUNT_ID: 'cf', MEDIA_R2_ACCESS_KEY_ID: 'id', MEDIA_R2_SECRET_ACCESS_KEY: 'secret', MEDIA_R2_BUCKET_NAME: 'images' } as Env['Bindings'];
  signed.mockResolvedValue({ url: 'https://r2.example/signed', headers: { 'Content-Type': 'video/mp4' }, expiresAt: future() });
});
afterEach(() => { db.raw.close(); vi.unstubAllGlobals(); });

describe('受信箱の添付アップロード', () => {
  it.each(Object.entries(CHAT_FILE_TYPES))('%sを内容・拡張子が合うときだけ受け付ける', async (mime, extension) => {
    const office = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' } as Record<string, string>;
    const bytes = extension === 'pdf' ? PDF_BYTES : zipBytes(extension === 'zip' ? ['案内.txt'] : ['[Content_Types].xml', office[extension]]);
    const res = await upload(bytes, `案内.${extension}`, mime);
    expect(res.status).toBe(201);
    const { data } = await res.json<TestReply>();
    expect(data.url).not.toContain('案内'); expect(new URL(data.url).searchParams.get('signature')).toMatch(/^[a-f0-9]{64}$/); expect(new URL(data.url).pathname.split('/')).not.toContain('f1');
    expect(Date.parse(data.expiresAt!) - Date.now()).toBeCloseTo(30 * 86400000, -3);
    expect(storage.objects.get(data.key)?.meta.customMetadata?.friendId).toBe('f1');
  });
  it('10MBと200MBの境界を守る', () => {
    expect(uploadKind('application/pdf', 'a.pdf', 10 * 1024 * 1024)).toBe('file');
    expect(() => uploadKind('application/pdf', 'a.pdf', 10 * 1024 * 1024 + 1)).toThrow();
    expect(uploadKind('video/mp4', 'a.mp4', 200 * 1024 * 1024)).toBe('video');
    expect(() => uploadKind('video/mp4', 'a.mp4', 200 * 1024 * 1024 + 1)).toThrow();
  });
  it('申告を小さく偽っても、実際に10MBを超えたファイルは保存しない', async () => {
    const res = await upload(new Uint8Array(CHAT_FILE_MAX_BYTES + 1), 'a.pdf', 'application/pdf', 'f1', owner, 1);
    expect(res.status).toBe(400); expect(storage.mock.put).not.toHaveBeenCalled();
  });
  it.each([
    ['案内.pdf', 'application/pdf', MP4_BYTES], ['案内.exe', 'application/pdf', PDF_BYTES],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipBytes(['xl/workbook.xml'])],
    ['a.zip', 'application/zip', zipBytes(['macro/vbaProject.bin'])],
    ['a.zip', 'application/zip', zipBytes(['../秘密.txt'])],
    ['a.zip', 'application/zip', Uint8Array.from([80, 75, 3, 4])],
  ])('形式が偽られた%sを保存しない', async (filename, mime, bytes) => {
    expect((await upload(bytes, filename, mime)).status).toBe(400);
    expect(storage.mock.put).not.toHaveBeenCalled();
  });
  it('PDFの自動実行指定を保存しない', () => {
    expect(() => validateChatUpload(new TextEncoder().encode('%PDF-1.7 /JavaScript (alert) %%EOF'), 'application/pdf', 'a.pdf')).toThrow();
  });
  it('別統括・権限なし・閲覧のみの人はアップロードできない', async () => {
    expect((await upload(PDF_BYTES, 'a.pdf', 'application/pdf', 'f3')).status).toBe(404);
    expect((await upload(PDF_BYTES, 'a.pdf', 'application/pdf', 'f1', { ...owner, role: 'staff', permissionKeys: [] })).status).toBe(403);
    expect((await upload(PDF_BYTES, 'a.pdf', 'application/pdf', 'f1', { ...owner, readOnly: true })).status).toBe(403);
    expect(storage.mock.put).not.toHaveBeenCalled();
  });
  it('受信箱だけの権限で動画を入れられ、完了の再送でコピーは増えない', async () => {
    const { attachment, sessionId, etag } = await video({ ...owner, role: 'staff', permissionKeys: ['/chats'], assignedLineAccountId: 'a1' });
    expect(attachment.kind).toBe('video');
    expect((await json(`/api/chats/f1/attachments/upload-sessions/${sessionId}/complete`, { etag })).status).toBe(200);
    expect(storage.mock.put).toHaveBeenCalledTimes(3); // context・一時物・確定物
    expect((await json(`/api/chats/f2/attachments/upload-sessions/${sessionId}/complete`, { etag })).status).toBe(404);
  });
  it('動画上限超過・設定なしはアップロード予約を作らない', async () => {
    expect((await json('/api/chats/f1/attachments/upload-sessions', { filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: CHAT_VIDEO_MAX_BYTES + 1 })).status).toBe(400);
    bindings.MEDIA_R2_SECRET_ACCESS_KEY = '';
    expect((await json('/api/chats/f1/attachments/upload-sessions', { filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 100 })).status).toBe(503);
    expect(db.raw.prepare('SELECT * FROM broadcast_media_upload_sessions').all()).toHaveLength(0);
  });
  it('ETag・サイズ・所属が違う動画と、期限切れのアップロードを確定しない', async () => {
    const { data } = await (await json('/api/chats/f1/attachments/upload-sessions', { filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 16 })).json<TestReply>();
    const path = `/api/chats/f1/attachments/upload-sessions/${data.id}/complete`;
    await storage.bucket.put(`${CHAT_UPLOAD_PREFIX}${data.id}.mp4`, MP4_BYTES, { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { 'upload-session-id': data.id, 'line-account-id': 'wrong' } });
    expect((await json(path, { etag: (await storage.bucket.head(`${CHAT_UPLOAD_PREFIX}${data.id}.mp4`))!.etag })).status).toBe(409);
    const stored = storage.objects.get(`${CHAT_UPLOAD_PREFIX}${data.id}.mp4`)!;
    stored.meta.customMetadata!['line-account-id'] = 'a1';
    expect((await json(path, { etag: 'wrong' })).status).toBe(409);
    stored.bytes = new Uint8Array(15);
    expect((await json(path, { etag: stored.etag })).status).toBe(409);
    db.raw.prepare('UPDATE broadcast_media_upload_sessions SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    expect((await json(path, { etag: 'wrong' })).status).toBe(409);
    expect(db.raw.prepare('SELECT public_key FROM broadcast_media_upload_sessions').get()).toEqual({ public_key: null });
  });
});

describe('受信箱の送信・期限付きリンク', () => {
  beforeEach(() => {
    // 同じ時刻のURLを比較する。署名の秒境界で再生成URLが変わる揺れを防ぐ。
    const issuedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(issuedAt);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('動画をvideoで送り、決まったPNGのプレビューを使う', async () => {
    const { attachment } = await video();
    expect((await send('video', { originalContentUrl: attachment.url })).status).toBe(200);
    expect(payload().messages[1]).toEqual({ type: 'text', text: `後から開く場合はこちら（LINEで本人確認）\nhttps://worker.example/liff/files/${attachment.id}` });
    expect(payload().messages[0]).toEqual({ type: 'video', originalContentUrl: attachment.url, previewImageUrl: 'https://worker.example/images/chat-attachments/video-preview.png' });
    const preview = await app().request('/images/chat-attachments/video-preview.png', {}, bindings);
    expect(preview.headers.get('Content-Type')).toBe('image/png');
    expect((await preview.arrayBuffer()).byteLength).toBeLessThan(1024 * 1024);
    expect(new Headers(pushes()[0][1]?.headers).has('X-Line-Harness-Source')).toBe(false); // 既存と同じ、Proxyを経由しない直接送信
  });
  it('アップロードした1MB以下の画像を動画プレビューに使える', async () => {
    const { attachment } = await video();
    const image = (await (await upload(PNG_BYTES, 'p.png', 'image/png')).json<TestReply>()).data;
    expect((await send('video', { originalContentUrl: attachment.url, previewImageUrl: image.url })).status).toBe(200);
    expect(payload().messages[0].previewImageUrl).toBe(image.url);
    storage.objects.get(image.key)!.bytes = new Uint8Array(1024 * 1024 + 1);
    lineFetch.mockClear();
    expect((await send('video', { originalContentUrl: attachment.url, previewImageUrl: image.url })).status).toBe(400);
    expect(pushes()).toHaveLength(0);
  });
  it('ファイルは名前・大きさ・期限付きURLをテキストで送り、再送は1通のまま', async () => {
    const file = await uploadedFile(); const k = key();
    expect((await send('file', { attachmentId: file.id, url: 'https://evil.example' }, k)).status).toBe(200);
    expect(payload().messages[0].type).toBe('text');
    expect(payload().messages[0].text).toContain('案内.pdf'); expect(payload().messages[0].text).toContain(`https://worker.example/liff/files/${file.id}`); expect(payload().messages[0].text).not.toContain('signature=');
    expect(payload().messages[0].text).not.toContain('evil.example');
    expect((await send('file', { attachmentId: file.id, url: 'https://evil.example' }, k)).status).toBe(200);
    expect(pushes()).toHaveLength(1);
    expect(db.raw.prepare("SELECT source,message_type FROM messages_log WHERE direction='outgoing'").get()).toEqual({ source: 'manual', message_type: 'file' });
    expect((await send('file', { attachmentId: file.id }, k)).status).toBe(409);
  });
  it('画像を表示するURLはLINE用のまま、本文の再取得先は署名なしのLIFF入口にする', async () => {
    const image = (await (await upload(PNG_BYTES, 'p.png', 'image/png')).json<TestReply>()).data;
    expect((await send('image', { originalContentUrl: image.url, previewImageUrl: image.url })).status).toBe(200);
    expect(payload().messages).toHaveLength(2);
    expect(payload().messages[0].originalContentUrl).toBe(image.url);
    expect(payload().messages[1].text).toContain(`/liff/files/${image.id}`);
    expect(payload().messages[1].text).not.toContain('signature=');
  });
  it('別の会話のファイル・外部動画・壊れたJSONはLINEを呼ばず履歴も作らない', async () => {
    const file = (await (await upload(PDF_BYTES, 'a.pdf', 'application/pdf', 'f2')).json<TestReply>()).data;
    expect((await send('file', { attachmentId: file.id })).status).toBe(400);
    expect((await send('video', { originalContentUrl: 'https://evil.example/a.mp4' })).status).toBe(400);
    expect((await send('video', 'null')).status).toBe(400);
    expect((await send('file', '{broken')).status).toBe(400);
    expect(pushes()).toHaveLength(0);
    expect(db.raw.prepare('SELECT * FROM messages_log').all()).toHaveLength(0);
  });
  it('署名リンクは認証なしで開け、原本キーでは取れず、保存期限後は410になる', async () => {
    const file = await uploadedFile();
    const download = await app().request(file.url, {}, bindings);
    expect(download.status).toBe(200); expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await download.text()).toBe(new TextDecoder().decode(PDF_BYTES));
    expect((await app().request(`/images/${file.key}`, {}, bindings)).status).toBe(404);
    storage.objects.get(file.key)!.meta.customMetadata!.expiresAt = '2000-01-01T00:00:00Z';
    const expired = await app().request(file.url, {}, bindings);
    expect(expired.status).toBe(410); expect(expired.headers.get('Cache-Control')).toContain('no-store');
    lineFetch.mockClear(); expect((await send('file', { attachmentId: file.id })).status).toBe(400);
    expect(pushes()).toHaveLength(0);
  });
  it('動画は部分取得で再生でき、範囲が不正なら416', async () => {
    const { attachment } = await video();
    const res = await app().request(attachment.url, { headers: { Range: 'bytes=0-3' } }, bindings);
    expect(res.status).toBe(206); expect(res.headers.get('Content-Range')).toBe('bytes 0-3/16');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES.slice(0, 4));
    expect((await app().request(attachment.url, { headers: { Range: 'bytes=99-100' } }, bindings)).status).toBe(416);
  });
});

describe('短命の添付URL', () => {
  it.each(['image', 'video', 'file'])('%sは署名なし・改ざん・期限切れで本文を渡さない', async kind => {
    const file = kind === 'video' ? (await video()).attachment
      : kind === 'image' ? (await (await upload(PNG_BYTES, 'a.png', 'image/png')).json<TestReply>()).data : await uploadedFile();
    const unsigned = new URL(file.url); unsigned.search = '';
    const forged = new URL(file.url); forged.searchParams.set('signature', '0'.repeat(64));
    expect((await app().request(unsigned.toString(), {}, bindings)).status).toBe(303);
    expect((await app().request(forged.toString(), {}, bindings)).status).toBe(403);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Number(new URL(file.url).searchParams.get('expires')) * 1000);
    try { expect((await app().request(file.url, {}, bindings)).status).toBe(403); }
    finally { now.mockRestore(); }
  });
  it('署名を別の添付・別の持ち主へ移しても、鍵を変えても開けない', async () => {
    const a = await uploadedFile(), b = await uploadedFile();
    const swapped = new URL(a.url); swapped.pathname = new URL(b.url).pathname;
    expect((await app().request(swapped.toString(), {}, bindings)).status).toBe(403);
    storage.objects.get(a.key)!.meta.customMetadata!.friendId = 'f2';
    expect((await app().request(a.url, {}, bindings)).status).toBe(403);
    bindings.API_KEY = 'rotated-fixture-key';
    expect((await app().request(b.url, {}, bindings)).status).toBe(403);
  });
  it('鍵なしでは保存せず、他の会話の添付の署名を作らない', async () => {
    bindings.API_KEY = '';
    expect((await upload()).status).toBe(503); expect(storage.mock.put).not.toHaveBeenCalled();
    bindings.API_KEY = 'fixture-download-signing-key';
    const file = (await (await upload(PNG_BYTES, 'a.png', 'image/png', 'f2')).json<TestReply>()).data;
    expect((await send('image', { originalContentUrl: file.url, previewImageUrl: file.url })).status).toBe(400);
    expect(pushes()).toHaveLength(0);
  });
  it('本人の会話を読み直すと古いURLを更新し、別の会話に埋めたURLは更新しない', async () => {
    const file = await uploadedFile();
    const raw = new URL(file.url); raw.search = '';
    const scoped = new Hono<Env>();
    scoped.use('*', async (c, next) => { c.set('staff', owner); await next(); });
    scoped.use('*', privateImageResponseMiddleware);
    scoped.get('/api/chats/:id/history', c => c.json({ data: { content: JSON.stringify({ url: raw.toString() }) } }));
    const own = await scoped.request('/api/chats/f1/history', {}, bindings);
    const foreign = await scoped.request('/api/chats/f2/history', {}, bindings);
    const parsed = await own.json<{ data: { content: string } }>();
    const fresh = JSON.parse(parsed.data.content).url;
    expect(new URL(fresh).searchParams.has('signature')).toBe(true);
    expect((await app().request(fresh, {}, bindings)).status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('private, no-store');
    const other = await foreign.json<{ data: { content: string } }>();
    expect(JSON.parse(other.data.content).url).toBe(raw.toString());
    raw.hostname = 'old-worker.example';
    const untrusted = await scoped.request('/api/chats/f1/history', {}, bindings);
    expect(JSON.parse((await untrusted.json<{ data: { content: string } }>()).data.content).url).toBe(raw.toString());
    bindings.WORKER_ALIAS_URLS = 'https://old-worker.example,invalid';
    const aliased = await scoped.request('/api/chats/f1/history', {}, bindings);
    const updatedAlias = JSON.parse((await aliased.json<{ data: { content: string } }>()).data.content).url;
    expect(new URL(updatedAlias).searchParams.has('signature')).toBe(true);
    expect((await app().request(updatedAlias, {}, bindings)).status).toBe(200);
  });
});

describe('画像・動画・ファイルの送信予約', () => {
  it('一時的な送信失敗の後、LIFF入口が変わらず同じ予約を再試行できる', async () => {
    const file = await uploadedFile();
    const { data } = await (await schedule('file', { attachmentId: file.id })).json<TestReply>();
    db.raw.prepare('UPDATE scheduled_chat_sends SET scheduled_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    lineFetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await processDueScheduledChatSends(bindings)).sent).toBe(0);
    const first = payload().messages[0].text;
    db.raw.prepare('UPDATE scheduled_chat_sends SET scheduled_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000);
    try {
      expect((await processDueScheduledChatSends(bindings)).sent).toBe(1);
      expect(payload().messages[0].text).toBe(first);
      expect(first).toContain(`/liff/files/${file.id}`); expect(first).not.toContain('signature=');
    } finally { now.mockRestore(); }
    expect(new Headers(pushes().at(-1)![1]?.headers).has('X-Line-Harness-Source')).toBe(false);
  });
  it.each(['image', 'video', 'file'])('%sを予約してcronから送り、種別と履歴を残す', async type => {
    let content: unknown;
    if (type === 'file') content = { attachmentId: (await uploadedFile()).id };
    else if (type === 'video') content = { originalContentUrl: (await video()).attachment.url };
    else content = { originalContentUrl: 'https://example.com/a.png', previewImageUrl: 'https://example.com/p.png' };
    const res = await schedule(type, content); expect(res.status).toBe(200);
    const { data } = await res.json<TestReply>(); expect(data.messageType).toBe(type);
    expect((await json(`/api/chats/f1/scheduled/${data.id}`, { scheduledAt: future(2) }, 'PATCH')).status).toBe(200);
    db.raw.prepare('UPDATE scheduled_chat_sends SET scheduled_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    const result = await processDueScheduledChatSends(bindings);
    expect(result.sent).toBe(1);
    expect(payload().messages[0].type).toBe(type === 'file' ? 'text' : type);
    if (type === 'video') expect(payload().messages[1].text).toContain('/liff/files/');
    expect(new Headers(pushes()[0][1]?.headers).has('X-Line-Harness-Source')).toBe(false);
    expect(db.raw.prepare("SELECT source,message_type FROM messages_log WHERE direction='outgoing'").get()).toEqual({ source: 'scheduled', message_type: type });
  });
  it('ファイル期限より後の予約・日時変更は作らない', async () => {
    const file = await uploadedFile();
    expect((await schedule('file', { attachmentId: file.id }, 31)).status).toBe(400);
    expect(db.raw.prepare('SELECT * FROM scheduled_chat_sends').all()).toHaveLength(0);
    const { data } = await (await schedule('file', { attachmentId: file.id })).json<TestReply>();
    expect((await json(`/api/chats/f1/scheduled/${data.id}`, { scheduledAt: future(31) }, 'PATCH')).status).toBe(400);
    expect((await json(`/api/chats/f1/scheduled/${data.id}`, { content: '普通の文には変えない' }, 'PATCH')).status).toBe(400);
  });
  it('予約後に期限切れになったファイルは送信せず、failedで残す', async () => {
    const file = await uploadedFile();
    const { data } = await (await schedule('file', { attachmentId: file.id })).json<TestReply>();
    storage.objects.get(file.key)!.meta.customMetadata!.expiresAt = '2000-01-01T00:00:00Z';
    db.raw.prepare('UPDATE scheduled_chat_sends SET scheduled_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    const result = await processDueScheduledChatSends(bindings);
    expect(result.failed).toBe(1); expect(pushes()).toHaveLength(0);
    expect(db.raw.prepare('SELECT status,last_error_code FROM scheduled_chat_sends').get()).toEqual({ status: 'failed', last_error_code: 'CHAT_ATTACHMENT_EXPIRED' });
  });
  it('同じ予約キーを別の会話や別の内容へ使うと409で、予約は1件のまま', async () => {
    const file = await uploadedFile();
    const k = key(); const body = { content: JSON.stringify({ attachmentId: file.id }), messageType: 'file', scheduledAt: future() };
    expect((await json('/api/chats/f1/schedule', body, 'POST', owner, k)).status).toBe(200);
    expect((await json('/api/chats/f1/schedule', body, 'POST', owner, k)).status).toBe(200);
    expect((await json('/api/chats/f2/schedule', { content: '別の文面', scheduledAt: body.scheduledAt }, 'POST', owner, k)).status).toBe(409);
    expect(db.raw.prepare('SELECT * FROM scheduled_chat_sends').all()).toHaveLength(1);
  });
  it('cronにWORKER_URLがなくても、アップロードしたURLを使って動画を送る', async () => {
    const { attachment } = await video();
    const { data } = await (await schedule('video', { originalContentUrl: attachment.url })).json<TestReply>();
    db.raw.prepare('UPDATE scheduled_chat_sends SET scheduled_at=? WHERE id=?').run('2000-01-01T00:00:00Z', data.id);
    bindings.WORKER_URL = '';
    expect((await processDueScheduledChatSends(bindings)).sent).toBe(1);
    const uploadedUrl = new URL(attachment.url);
    const sentUrl = new URL(payload().messages[0].originalContentUrl);
    expect(`${sentUrl.origin}${sentUrl.pathname}`).toBe(`${uploadedUrl.origin}${uploadedUrl.pathname}`);
    expect(sentUrl.searchParams.get('signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(sentUrl.searchParams.get('expires'))).toBeGreaterThanOrEqual(Number(uploadedUrl.searchParams.get('expires')));
  });
});
