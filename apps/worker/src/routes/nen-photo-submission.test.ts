/*
 *  投稿経路のメタデータ除去と寸法検査をルートで直接固定する。
 * EXIF 等は審査用派生（nen-photo-review/*）から外れ、原本はそのまま残る
 * 寸法が読めない・20,000px 超の画像は 400 で止まり、R2 へも DB へも残らない
 * 申告 MIME と実体が違うものは弾く
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verifyIdentity: vi.fn(),
  getFriend: vi.fn(),
  jstNow: vi.fn(() => '2026-08-28 02:00:00'),
}));
vi.mock('../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verifyIdentity }));
vi.mock('@line-crm/db', async original => ({
  ...await original<typeof import('@line-crm/db')>(),
  getFriendByLineUserIdForAccount: mocks.getFriend,
  jstNow: mocks.jstNow,
  resolveLineCredential: vi.fn(),
}));
vi.mock('../services/nen-tag-sync.js', () => ({
  refreshAllNenTags: vi.fn(), syncNenHealthTags: vi.fn(),
  syncNenPetTags: vi.fn(), syncNenPhotoTags: vi.fn(),
}));

const { nenMembers } = await import('./nen-members.js');

type Put = { key: string; body: Uint8Array; options: Record<string, unknown> };

function harness() {
  const statements: Array<{ query: string; bindings: unknown[] }> = [];
  const puts: Put[] = [];
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.env = {
      WORKER_PUBLIC_URL: 'https://worker.example.test',
      DB: {
        prepare(query: string) {
          const entry = { query, bindings: [] as unknown[] };
          statements.push(entry);
          const statement = {
            bind(...bindings: unknown[]) { entry.bindings = bindings; return statement; },
            async first() {
              if (query.includes('FROM friends f') && query.includes('channel_access_token')) {
                return {
                  id: 'friend-1', line_user_id: 'U1', display_name: '利用者', user_id: null,
                  line_account_id: 'account-a', channel_access_token: null,
                  channel_access_token_encrypted: null,
                };
              }
              if (query.includes('FROM nen_pet_profiles')) {
                return entry.bindings[0] === 'pet-1' && entry.bindings[1] === 'friend-1'
                  ? { id: 'pet-1' } : null;
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
      },
      IMAGES: {
        async put(key: string, body: Uint8Array, options: Record<string, unknown>) {
          puts.push({ key, body: new Uint8Array(body), options });
        },
      },
    };
    await next();
  });
  app.route('/', nenMembers);
  return { app, statements, puts };
}

// --- 最小限の画像バイト列 -------------------------------------------------
// JPEG: SOI → APP1(EXIF) → SOF0(寸法) → SOS → EOI
function jpeg(width: number, height: number, withExif = true): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (withExif) {
    const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]; // 'Exif\0\0' + payload
    parts.push(0xff, 0xe1, 0x00, exif.length + 2, ...exif);
  }
  // SOF0: len=17, precision=8, height, width, 3 components
  parts.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );
  // SOS + scan data + EOI
  parts.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0xaa, 0xbb, 0xcc, 0xff, 0xd9);
  return new Uint8Array(parts);
}

// PNG: signature → IHDR(寸法) → tEXt → eXIf → IEND（CRCは実在性に関係しないので固定値）
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((ch) => ch.charCodeAt(0));
    return [
      (data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff,
      ...t, ...data, 0x00, 0x00, 0x00, 0x00,
    ];
  };
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [
      (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
      (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]),
    ...chunk('tEXt', [...'GPS=secret'].map((ch) => ch.charCodeAt(0))),
    ...chunk('eXIf', [0x49, 0x49, 0x2a, 0x00]),
    ...chunk('IEND', []),
  ]);
}

function post(app: Hono<any>, body: Record<string, unknown>) {
  return app.request('/api/liff/nen/photos', {
    method: 'POST',
    headers: { Authorization: 'Bearer liff-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hasMarker = (bytes: Uint8Array, marker: number) => {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === marker) return true;
  }
  return false;
};
const hasChunk = (bytes: Uint8Array, type: string) => {
  const needle = [...type].map((ch) => ch.charCodeAt(0));
  for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    if (needle.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdentity.mockResolvedValue({ lineUserId: 'U1', lineAccountId: 'account-a' });
  mocks.getFriend.mockResolvedValue({ id: 'friend-1', is_following: 1 });
});

describe('POST /api/liff/nen/photos のメタデータ除去と寸法検査(#931 N-310)', () => {
  it('EXIF付きJPEGは原本をそのまま、審査用はEXIFを外して保存し、寸法をDBへ残す', async () => {
    const { app, statements, puts } = harness();
    const original = jpeg(640, 480, true);
    const res = await post(app, { petId: 'pet-1', data: b64(original), mimeType: 'image/jpeg', caption: 'テスト' });
    expect(res.status).toBe(201);

    // 原本と審査用の2件が入る。原本は入力と同一、審査用は APP1(EXIF) が無い。
    const originalPut = puts.find((put) => put.key.startsWith('nen-photo-originals/friend-1/'));
    const reviewPut = puts.find((put) => put.key.startsWith('nen-photo-review/friend-1/'));
    expect(originalPut).toBeTruthy();
    expect(reviewPut).toBeTruthy();
    expect([...originalPut!.body]).toEqual([...original]);
    expect(hasMarker(reviewPut!.body, 0xe1)).toBe(false);
    // 画像本体（SOF0・SOS・EOI）は残るので壊れない。
    expect(hasMarker(reviewPut!.body, 0xc0)).toBe(true);
    expect(hasMarker(reviewPut!.body, 0xda)).toBe(true);

    // 寸法・バイト数・審査用URLが INSERT へ渡る。
    const insert = statements.find((entry) => entry.query.includes('INSERT INTO nen_photo_submissions'));
    expect(insert).toBeTruthy();
    const bindings = insert!.bindings;
    expect(bindings[9]).toBe('account-a'); // line_account_id
    expect(bindings[10]).toMatch(/^https:\/\/worker\.example\.test\/images\/nen-photo-review\//); // review_image_url
    expect(bindings[11]).toBe(bindings[10]); // public_image_url（メタデータ除去済み派生を再利用）
    expect(bindings[12]).toBe(640); // image_width
    expect(bindings[13]).toBe(480); // image_height
    expect(bindings[14]).toBe(original.byteLength); // image_byte_size

    // 公開されるURLは審査用派生を指す。原本キーは返さない。
    const body = await res.json() as { data: { imageUrl: string } };
    expect(body.data.imageUrl).toBeNull(); // 検査記録を確定できない段ではURLを出さない
  });

  it('テキスト・EXIF付きPNGは審査用から付帯チャンクが外れ、IHDRは残る', async () => {
    const { app, puts } = harness();
    const res = await post(app, { petId: 'pet-1', data: b64(png(300, 200)), mimeType: 'image/png' });
    expect(res.status).toBe(201);
    const reviewPut = puts.find((put) => put.key.startsWith('nen-photo-review/'));
    expect(reviewPut).toBeTruthy();
    expect(hasChunk(reviewPut!.body, 'tEXt')).toBe(false);
    expect(hasChunk(reviewPut!.body, 'eXIf')).toBe(false);
    expect(hasChunk(reviewPut!.body, 'IHDR')).toBe(true);
    expect(hasChunk(reviewPut!.body, 'IEND')).toBe(true);
  });

  it('申告MIMEと実体が違う投稿は400で止まり、何も保存しない', async () => {
    const { app, statements, puts } = harness();
    const res = await post(app, { petId: 'pet-1', data: b64(jpeg(640, 480)), mimeType: 'image/png' });
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
    expect(statements.some((entry) => entry.query.includes('INSERT INTO nen_photo_submissions'))).toBe(false);
  });

  it('寸法を読めない壊れた画像は400で止まり、何も保存しない', async () => {
    const { app, statements, puts } = harness();
    // JPEG の先頭らしさはあるが SOF が無く寸法を読めない。
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const res = await post(app, { petId: 'pet-1', data: b64(broken), mimeType: 'image/jpeg' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('寸法');
    expect(puts).toHaveLength(0);
    expect(statements.some((entry) => entry.query.includes('INSERT INTO nen_photo_submissions'))).toBe(false);
  });

  it('片辺20,000pxを超える画像は400で止まり、何も保存しない', async () => {
    const { app, statements, puts } = harness();
    const res = await post(app, { petId: 'pet-1', data: b64(jpeg(21000, 100)), mimeType: 'image/jpeg' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('20000');
    expect(puts).toHaveLength(0);
    expect(statements.some((entry) => entry.query.includes('INSERT INTO nen_photo_submissions'))).toBe(false);
  });

  it('他人のペットへの投稿は400で止まる', async () => {
    const { app, puts } = harness();
    const res = await post(app, { petId: 'pet-other', data: b64(jpeg(640, 480)), mimeType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});
