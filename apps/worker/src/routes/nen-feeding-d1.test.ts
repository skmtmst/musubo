/*
 * マイペットの給与量（★37-2「今日の目安」／★37-1 会員 › 給与量）を実D1で固定する。
 *  1. 管理画面：主食のカロリー表を保存すると、登録済みペットの目安が計算し直される
 *  2. LIFF：ペット登録で避妊去勢・活動量・主食を受け取り、feeding（kcal・g）を返す
 *  3. LIFF：ペットの変更（体重など）で目安が変わる。他人のペットは変えられない
 *  4. 主食が無いアカウントでは kcal だけ返し、グラムは null
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const liffAuth = vi.hoisted(() => ({
  verifyCallerLineIdentity: vi.fn(),
  verifyCallerLineUserId: vi.fn(),
}));
vi.mock('../services/liff-auth.js', () => liffAuth);
vi.mock('../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: vi.fn() }));
vi.mock('../services/local-line-proxy.js', () => ({ dispatchLineProxyLocally: vi.fn() }));

const { nenMembers } = await import('./nen-members.js');
const { nenRanks } = await import('./nen-ranks.js');

let sql: Database.Database;
let db: D1Database;

beforeEach(() => {
  const created = createTestD1();
  sql = created.raw;
  db = created.db;
  sql.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-nen', 'channel-nen', '然', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', 'account-nen', 1, '2026-09-01', '2026-09-01'),
      ('friend-b', 'U-b', '見本 176', 'account-nen', 1, '2026-09-01', '2026-09-01');
    INSERT INTO nen_pet_profiles (id, friend_id, name, animal_type, gender, birthday, breed, weight_kg, concerns,
      recommended_daily_grams, recommended_daily_min_grams, recommended_daily_max_grams, venison_daily_grams, food_cycle_days, created_at, updated_at)
    VALUES ('pet-old', 'friend-a', 'モモ', 'dog', 'female', '2022-04-01', '柴犬', 10, '[]', 250, 200, 300, 25, 4, '2026-09-01', '2026-09-01');
  `);
});

function liff(lineUserId: string) {
  liffAuth.verifyCallerLineIdentity.mockResolvedValue({ lineUserId, lineAccountId: 'account-nen' });
  const harness = new Hono<any>();
  harness.use('*', async (c, next) => {
    c.env = { DB: db, IMAGES: { put: vi.fn(), delete: vi.fn() } };
    await next();
  });
  harness.route('/', nenMembers);
  return {
    request: (path: string, init?: RequestInit) => harness.request(path, init, undefined, executionCtx),
  };
}

const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

function admin(role = 'owner') {
  const harness = new Hono<any>();
  harness.use('*', async (c, next) => {
    c.env = { DB: db };
    c.set('staff', { id: 'staff-1', role, line_account_id: null, tenant_id: null });
    await next();
  });
  harness.route('/', nenRanks);
  return harness;
}

const auth = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

async function saveProducts(products: unknown, treatLimitPercent?: unknown) {
  const res = await admin().request('/api/nen/feeding-products', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'account-nen', products, ...(treatLimitPercent === undefined ? {} : { treatLimitPercent }) }),
  });
  return { status: res.status, body: await res.json() as any };
}

describe('管理画面：主食のカロリー表', () => {
  it('保存すると一覧が返り、登録済みペットの目安が NRC／FEDIAF の式で計算し直される', async () => {
    const before = sql.prepare(`SELECT recommended_daily_grams, daily_kcal FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any;
    expect(before.daily_kcal).toBeNull();

    const saved = await saveProducts([
      { name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true },
      { name: '鹿肉ジャーキー', kcalPer100g: 300 },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.body.data.products).toHaveLength(2);
    expect(saved.body.data.products[0]).toMatchObject({ name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true });
    expect(saved.body.data.refreshedPets).toBe(1);
    expect(saved.body.data.petCount).toBe(1);
    expect(saved.body.data.factors.dog.adult.neutered.factor).toBe(1.6);

    // 10kg・2022年生まれ・避妊去勢は未回答（→済み扱い 1.6）・ふつう → 630kcal → 525g（120kcal/100g）
    const after = sql.prepare(`SELECT recommended_daily_grams, recommended_daily_min_grams, recommended_daily_max_grams, daily_kcal FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any;
    expect(after).toEqual({ recommended_daily_grams: 525, recommended_daily_min_grams: 473, recommended_daily_max_grams: 578, daily_kcal: 630 });

    const list = await admin('staff').request('/api/nen/feeding-products?accountId=account-nen');
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).data.products.map((p: any) => p.name)).toEqual(['鹿肉ミンチ', '鹿肉ジャーキー']);
  });

  it('入力の誤りは 400 で理由を返し、staff は保存できない', async () => {
    const bad = await saveProducts([{ name: '鹿肉ミンチ', kcalPer100g: 0 }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('カロリー');

    const res = await admin('staff').request('/api/nen/feeding-products', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-nen', products: [{ name: 'A', kcalPer100g: 100 }] }),
    });
    expect(res.status).toBe(403);
  });

  it('消した主食を選んでいたペットは既定の主食に戻る', async () => {
    const first = await saveProducts([{ name: 'A', kcalPer100g: 100, isDefault: true }, { name: 'B', kcalPer100g: 200 }]);
    const bId = first.body.data.products[1].id;
    sql.prepare(`UPDATE nen_pet_profiles SET feeding_product_id = ? WHERE id = 'pet-old'`).run(bId);
    await saveProducts([{ id: first.body.data.products[0].id, name: 'A', kcalPer100g: 100, isDefault: true }]);
    const row = sql.prepare(`SELECT feeding_product_id, recommended_daily_grams FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any;
    expect(row.feeding_product_id).toBeNull();
    expect(row.recommended_daily_grams).toBe(630); // 630kcal ÷ 100kcal/100g
  });
});

describe('管理画面：然の商品（おやつ）と上限（★37-3-A 更新）', () => {
  it('主食と然の商品を分けて保存し、然の鹿肉の目安（必要カロリー × 上限% ÷ 然商品の kcal）を保存する', async () => {
    const saved = await saveProducts([
      { name: 'ドライフード', kcalPer100g: 360, isDefault: true },
      { name: '然 鹿肉ジャーキー', kcalPer100g: 300, isDefault: true, kind: 'nen' },
      { name: '然 鹿肉ミンチ', kcalPer100g: 135, kind: 'nen' },
    ], 10);
    expect(saved.status).toBe(200);
    expect(saved.body.data.treatLimitPercent).toBe(10);
    expect(saved.body.data.products.map((p: any) => [p.name, p.kind, p.isDefault])).toEqual([
      ['ドライフード', 'staple', true], ['然 鹿肉ジャーキー', 'nen', true], ['然 鹿肉ミンチ', 'nen', false],
    ]);
    // 10kg → 630kcal → 主食 175g。おやつ 63kcal ÷ 300kcal/100g → 21g
    const row = sql.prepare(`SELECT recommended_daily_grams, venison_daily_grams, daily_kcal FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any;
    expect(row).toEqual({ recommended_daily_grams: 175, venison_daily_grams: 21, daily_kcal: 630 });

    // 上限を 15% にすると 95kcal → 32g
    const raised = await saveProducts(saved.body.data.products, 15);
    expect(raised.body.data.treatLimitPercent).toBe(15);
    expect((sql.prepare(`SELECT venison_daily_grams FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any).venison_daily_grams).toBe(32);
    expect((await saveProducts([], 40)).status).toBe(400);

    // LIFF：主食の選択肢には然の商品が出ず、feeding.venison が返る
    const member = await liff('U-a').request('/api/liff/nen/member', { headers: auth });
    const data = ((await member.json()) as any).data;
    expect(data.feedingProducts.map((p: any) => p.name)).toEqual(['ドライフード']);
    expect(data.nenProducts.map((p: any) => p.name)).toEqual(['然 鹿肉ジャーキー', '然 鹿肉ミンチ']);
    expect(data.treatLimitPercent).toBe(15);
    expect(data.pets[0].feeding.venison).toMatchObject({ limitPercent: 15, kcal: 95, grams: 32, product: { name: '然 鹿肉ジャーキー' } });
    expect(data.pets[0].callName).toBe('モモちゃん');
    expect(JSON.stringify(data)).not.toContain('ポイント');
  });
});

describe('LIFF：マイペットの登録・変更', () => {
  it('性別は必須。男の子は「くん」、女の子は「ちゃん」の呼び名になる', async () => {
    const noGender = await liff('U-b').request('/api/liff/nen/pets', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: '豆太郎', animalType: 'dog', breed: '柴犬', birthday: '2022-04-01', weightKg: 10 }),
    });
    expect(noGender.status).toBe(400);
    const boy = await liff('U-b').request('/api/liff/nen/pets', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: '豆太郎', animalType: 'dog', breed: '柴犬', birthday: '2022-04-01', weightKg: 10, gender: 'male' }),
    });
    expect(boy.status).toBe(201);
    expect(((await boy.json()) as any).data).toMatchObject({ gender: 'male', callName: '豆太郎くん' });
  });


  it('避妊去勢・活動量・主食を受け取り、feeding（kcal・g・係数）を返す', async () => {
    await saveProducts([{ name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true }]);
    const res = await liff('U-b').request('/api/liff/nen/pets', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'ハナ', animalType: 'dog', breed: 'トイプードル', birthday: '2020-05-10', weightKg: 4, gender: 'female', neutered: 'no', activityLevel: 'high', concerns: ['weight'] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // 4kg・成犬・未去勢 1.8 + 運動多め 0.2 = 2.0。RER 70×4^0.75 = 198 → 396kcal → 330g
    expect(body.data).toMatchObject({ neutered: 'no', activityLevel: 'high', feedingProductId: null });
    expect(body.data.feeding).toMatchObject({ factor: 2.0, factorLabel: '成犬・運動多め', rerKcal: 198, dailyKcal: 396, dailyGrams: 330, stage: 'adult' });
    expect(body.data.feeding.product).toMatchObject({ name: '鹿肉ミンチ', kcalPer100g: 120 });
    expect(body.data.recommendedDailyGrams).toBe(330);

    const member = await liff('U-b').request('/api/liff/nen/member', { headers: auth });
    const data = ((await member.json()) as any).data;
    expect(data.feedingProducts).toEqual([expect.objectContaining({ name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true })]);
    expect(data.activityLabels).toEqual({ low: '少なめ', normal: 'ふつう', high: '多め' });
    expect(data.pets[0].feeding.dailyGrams).toBe(330);
    expect(JSON.stringify(data)).not.toContain('ポイント');
  });

  it('体重・避妊去勢・活動量・主食を変えると目安が変わる。他人のペットは 404', async () => {
    const saved = await saveProducts([{ name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true }, { name: '鹿肉ジャーキー', kcalPer100g: 300 }]);
    const jerkyId = saved.body.data.products[1].id;

    const res = await liff('U-a').request('/api/liff/nen/pets/pet-old', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ weightKg: 12.04, neutered: 'yes', activityLevel: 'low', feedingProductId: jerkyId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // 12kg・避妊去勢済み 1.6 − 運動少なめ 0.2 = 1.4。RER 70×12^0.75 = 451 → 631kcal → 210g（300kcal/100g）
    expect(body.data).toMatchObject({ weightKg: 12, neutered: 'yes', activityLevel: 'low', feedingProductId: jerkyId });
    expect(body.data.feeding).toMatchObject({ factor: 1.4, dailyKcal: 631, dailyGrams: 210 });
    expect(body.data.feeding.product.name).toBe('鹿肉ジャーキー');

    const stored = sql.prepare(`SELECT weight_kg, neutered, activity_level, feeding_product_id, daily_kcal, recommended_daily_grams FROM nen_pet_profiles WHERE id = 'pet-old'`).get() as any;
    expect(stored).toEqual({ weight_kg: 12, neutered: 1, activity_level: 'low', feeding_product_id: jerkyId, daily_kcal: 631, recommended_daily_grams: 210 });

    const other = await liff('U-b').request('/api/liff/nen/pets/pet-old', { method: 'PUT', headers: auth, body: JSON.stringify({ weightKg: 3 }) });
    expect(other.status).toBe(404);

    const badWeight = await liff('U-a').request('/api/liff/nen/pets/pet-old', { method: 'PUT', headers: auth, body: JSON.stringify({ weightKg: 999 }) });
    expect(badWeight.status).toBe(400);
    const badProduct = await liff('U-a').request('/api/liff/nen/pets/pet-old', { method: 'PUT', headers: auth, body: JSON.stringify({ feedingProductId: 'nope' }) });
    expect(badProduct.status).toBe(400);
    const nothing = await liff('U-a').request('/api/liff/nen/pets/pet-old', { method: 'PUT', headers: auth, body: JSON.stringify({}) });
    expect(nothing.status).toBe(400);
  });

  it('「その他」の動物も登録できる。犬・猫専用の目安は計算しない（DEEP-24）', async () => {
    await saveProducts([{ name: '鹿肉ミンチ', kcalPer100g: 120, isDefault: true }]);
    const res = await liff('U-b').request('/api/liff/nen/pets', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'ピノ', animalType: 'other', breed: 'うさぎ', birthday: '2023-01-10', weightKg: 2, gender: 'female' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // 種別は「その他」のまま。犬の係数で出した目安は返さない・保存しない。
    expect(body.data.animalType).toBe('other');
    expect(body.data.callName).toBe('ピノちゃん');
    expect(body.data.feeding).toBeNull();
    expect(body.data.recommendedDailyGrams).toBeNull();
    expect(body.data.venisonDailyGrams).toBeNull();
    const stored = sql.prepare(
      `SELECT animal_type, recommended_daily_grams, daily_kcal FROM nen_pet_profiles WHERE name = 'ピノ'`,
    ).get() as any;
    expect(stored).toEqual({ animal_type: 'other', recommended_daily_grams: null, daily_kcal: null });

    const member = await liff('U-b').request('/api/liff/nen/member', { headers: auth });
    const pet = ((await member.json()) as any).data.pets[0];
    expect(pet.animalType).toBe('other');
    expect(pet.feeding).toBeNull();
    expect(pet.recommendedDailyGrams).toBeNull();
  });

  it('主食が無いアカウントでは kcal だけ返し、グラムは null。従来の目安は残す', async () => {
    const member = await liff('U-a').request('/api/liff/nen/member', { headers: auth });
    const pet = ((await member.json()) as any).data.pets[0];
    expect(pet.feeding).toMatchObject({ dailyKcal: 630, dailyGrams: null, minGrams: null, product: null });
    expect(pet.recommendedDailyMinGrams).toBe(200);
    expect(pet.recommendedDailyMaxGrams).toBe(300);
  });
});
