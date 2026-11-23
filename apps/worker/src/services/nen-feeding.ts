/**
 * 然-NEN- マイペットの給与量（★37-2「今日の目安」）。
 *
 * 公的な指針（NRC 2006 / FEDIAF 栄養ガイドライン）の式をそのまま使う：
 *   安静時エネルギー   RER = 70 × 体重(kg)^0.75
 *   1日の必要カロリー MER = RER × 係数
 *   目安のグラム数     = MER ÷ 主食の 100g あたり kcal × 100
 *
 * 係数は年齢区分・避妊去勢・活動量で決まる（下の ENERGY_FACTORS）。
 * 数字は「参考値」であり、体型や体調で前後する。画面には必ずその旨を出す。
 *
 * ペットの正本は LINE 側（nen_pet_profiles）。主食のカロリーは nen_feeding_products。
 */

import { isFeedingSupportedAnimal, toPetAnimalType } from '../lib/nen-pet-species.js';

export type AnimalType = 'dog' | 'cat';
export type ActivityLevel = 'low' | 'normal' | 'high';
export type LifeStage = 'young' | 'adult' | 'senior';

export const ACTIVITY_LEVELS: ReadonlyArray<ActivityLevel> = ['low', 'normal', 'high'];
export const ACTIVITY_LABELS: Record<ActivityLevel, string> = { low: '少なめ', normal: 'ふつう', high: '多め' };

/** 子犬・子猫は 12 か月未満。シニアは犬 7 歳〜、猫 11 歳〜（FEDIAF の区分）。 */
export const SENIOR_MONTHS: Record<AnimalType, number> = { dog: 84, cat: 132 };
export const YOUNG_MONTHS = 12;

export type FeedingProduct = { id: string; name: string; kcalPer100g: number };
/** staple＝主食（お客様が選ぶ一般的なフード）、nen＝然の商品（おやつ・トッピング）。 */
export type FeedingProductKind = 'staple' | 'nen';
export const DEFAULT_TREAT_LIMIT_PERCENT = 10;
export const TREAT_LIMIT_RANGE = { min: 1, max: 30 } as const;

/** 然の鹿肉（おやつ）の目安。1日の必要カロリー × 上限% を、目安に使う然商品の kcal で割る。 */
export type VenisonPlan = {
  limitPercent: number;
  kcal: number;
  /** 然の商品が登録されていなければ null（kcal だけ出す）。 */
  grams: number | null;
  product: FeedingProduct | null;
};

export type FeedingInput = {
  animalType: AnimalType;
  weightKg: number;
  birthday: string | null;
  neutered: boolean | null;
  activityLevel: ActivityLevel;
};

export type FeedingPlan = {
  weightKg: number;
  ageMonths: number | null;
  stage: LifeStage;
  stageLabel: string;
  factor: number;
  factorLabel: string;
  rerKcal: number;
  dailyKcal: number;
  /** 主食が決まっていれば 1 日のグラム数。主食が無ければ null（kcal だけ出す）。 */
  dailyGrams: number | null;
  product: FeedingProduct | null;
  /** 参考の幅（±10%）。 */
  minGrams: number | null;
  maxGrams: number | null;
  venison: VenisonPlan;
};

/**
 * 係数表。犬・猫 × 年齢区分 × 避妊去勢。活動量で ±（犬 0.2／猫 0.1）。
 * 避妊去勢が未回答のときは「済み」の係数（少なめ）を使い、与えすぎにならないようにする。
 */
export const ENERGY_FACTORS = {
  dog: {
    youngUnder4Months: { factor: 3.0, label: '子犬（4か月未満）' },
    young: { factor: 2.0, label: '子犬' },
    adult: { neutered: { factor: 1.6, label: '成犬・避妊去勢済み' }, intact: { factor: 1.8, label: '成犬' } },
    senior: { neutered: { factor: 1.4, label: 'シニア・避妊去勢済み' }, intact: { factor: 1.6, label: 'シニア' } },
    activityStep: 0.2,
  },
  cat: {
    youngUnder4Months: { factor: 2.5, label: '子猫（4か月未満）' },
    young: { factor: 2.5, label: '子猫' },
    adult: { neutered: { factor: 1.2, label: '成猫・避妊去勢済み' }, intact: { factor: 1.4, label: '成猫' } },
    senior: { neutered: { factor: 1.1, label: 'シニア・避妊去勢済み' }, intact: { factor: 1.3, label: 'シニア' } },
    activityStep: 0.1,
  },
} as const;

export function ageInMonths(birthday: string | null, today: Date): number | null {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const born = new Date(`${birthday}T00:00:00Z`);
  if (!Number.isFinite(born.getTime())) return null;
  const months = (today.getUTCFullYear() - born.getUTCFullYear()) * 12 + (today.getUTCMonth() - born.getUTCMonth())
    - (today.getUTCDate() < born.getUTCDate() ? 1 : 0);
  return Math.max(0, months);
}

export function lifeStageFor(animalType: AnimalType, ageMonths: number | null): LifeStage {
  if (ageMonths == null) return 'adult';
  if (ageMonths < YOUNG_MONTHS) return 'young';
  if (ageMonths >= SENIOR_MONTHS[animalType]) return 'senior';
  return 'adult';
}

export function energyFactor(input: {
  animalType: AnimalType; stage: LifeStage; ageMonths: number | null; neutered: boolean | null; activityLevel: ActivityLevel;
}): { factor: number; label: string } {
  const table = ENERGY_FACTORS[input.animalType];
  if (input.stage === 'young') {
    // 成長期は活動量で変えない（成長に必要な分が大きいため）。
    return input.ageMonths != null && input.ageMonths < 4 ? table.youngUnder4Months : table.young;
  }
  const base = input.stage === 'senior'
    ? (input.neutered === false ? table.senior.intact : table.senior.neutered)
    : (input.neutered === false ? table.adult.intact : table.adult.neutered);
  const step = input.activityLevel === 'high' ? table.activityStep : input.activityLevel === 'low' ? -table.activityStep : 0;
  const factor = Math.round((base.factor + step) * 100) / 100;
  const suffix = input.activityLevel === 'high' ? '・運動多め' : input.activityLevel === 'low' ? '・運動少なめ' : '';
  return { factor, label: `${base.label}${suffix}` };
}

export function restingEnergyKcal(weightKg: number): number {
  return Math.round(70 * Math.pow(weightKg, 0.75));
}

export function gramsFor(dailyKcal: number, kcalPer100g: number): number {
  return Math.max(1, Math.round((dailyKcal / kcalPer100g) * 100));
}

export function venisonPlan(dailyKcal: number, treat: FeedingProduct | null, limitPercent = DEFAULT_TREAT_LIMIT_PERCENT): VenisonPlan {
  const kcal = Math.round(dailyKcal * limitPercent / 100);
  return { limitPercent, kcal, grams: treat ? gramsFor(kcal, treat.kcalPer100g) : null, product: treat };
}

export function feedingPlan(input: FeedingInput, product: FeedingProduct | null, today: Date = new Date(), treat: FeedingProduct | null = null, treatLimitPercent = DEFAULT_TREAT_LIMIT_PERCENT): FeedingPlan {
  const weightKg = Math.round(input.weightKg * 10) / 10;
  const ageMonths = ageInMonths(input.birthday, today);
  const stage = lifeStageFor(input.animalType, ageMonths);
  const { factor, label } = energyFactor({ animalType: input.animalType, stage, ageMonths, neutered: input.neutered, activityLevel: input.activityLevel });
  const rerKcal = restingEnergyKcal(weightKg);
  const dailyKcal = Math.round(rerKcal * factor);
  const dailyGrams = product ? gramsFor(dailyKcal, product.kcalPer100g) : null;
  const stageLabel = stage === 'young' ? (input.animalType === 'cat' ? '子猫' : '子犬') : stage === 'senior' ? 'シニア' : (input.animalType === 'cat' ? '成猫' : '成犬');
  return {
    weightKg, ageMonths, stage, stageLabel, factor, factorLabel: label, rerKcal, dailyKcal, dailyGrams, product,
    minGrams: dailyGrams == null ? null : Math.max(1, Math.round(dailyGrams * 0.9)),
    maxGrams: dailyGrams == null ? null : Math.max(1, Math.round(dailyGrams * 1.1)),
    venison: venisonPlan(dailyKcal, treat, treatLimitPercent),
  };
}

export function normalizeActivity(value: unknown): ActivityLevel | null {
  return value === 'low' || value === 'normal' || value === 'high' ? value : null;
}

/** 1 / 0 / null（未回答）→ boolean | null。 */
export function neuteredFromRow(value: unknown): boolean | null {
  if (value === 1 || value === true || value === '1') return true;
  if (value === 0 || value === false || value === '0') return false;
  return null;
}

/** 画面からの入力 'yes' | 'no' | 'unknown' → boolean | null。想定外は undefined（変更しない）。 */
export function neuteredFromInput(value: unknown): boolean | null | undefined {
  if (value === 'yes' || value === true) return true;
  if (value === 'no' || value === false) return false;
  if (value === 'unknown' || value === null) return null;
  return undefined;
}

// ---------------------------------------------------------------- 主食（D1）

export type FeedingProductRow = {
  id: string; line_account_id: string; name: string; kcal_per_100g: number; is_default: number; sort_order: number;
  kind: FeedingProductKind; created_at: string; updated_at: string;
};

export function productKind(value: unknown): FeedingProductKind {
  return value === 'nen' ? 'nen' : 'staple';
}

/** おやつの上限（%）。未設定なら 10。 */
export async function getTreatLimitPercent(db: D1Database, lineAccountId: string): Promise<number> {
  const row = await db.prepare(`SELECT treat_limit_percent FROM nen_feeding_settings WHERE line_account_id = ?`).bind(lineAccountId).first<{ treat_limit_percent: number }>();
  const value = Number(row?.treat_limit_percent);
  return Number.isFinite(value) && value >= TREAT_LIMIT_RANGE.min && value <= TREAT_LIMIT_RANGE.max ? value : DEFAULT_TREAT_LIMIT_PERCENT;
}

export function validateTreatLimitPercent(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TREAT_LIMIT_PERCENT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < TREAT_LIMIT_RANGE.min || n > TREAT_LIMIT_RANGE.max) {
    throw new NenFeedingValidationError(`おやつの上限は ${TREAT_LIMIT_RANGE.min}〜${TREAT_LIMIT_RANGE.max}% の整数で入力してください`);
  }
  return n;
}

export async function saveTreatLimitPercent(db: D1Database, lineAccountId: string, percent: number, now: string): Promise<void> {
  await db.prepare(
    `INSERT INTO nen_feeding_settings (line_account_id, treat_limit_percent, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(line_account_id) DO UPDATE SET treat_limit_percent = excluded.treat_limit_percent, updated_at = excluded.updated_at`,
  ).bind(lineAccountId, percent, now).run();
}

export async function listFeedingProducts(db: D1Database, lineAccountId: string): Promise<FeedingProductRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM nen_feeding_products WHERE line_account_id = ? ORDER BY sort_order ASC, created_at ASC`,
  ).bind(lineAccountId).all<FeedingProductRow>();
  return rows.results ?? [];
}

export function toFeedingProduct(row: FeedingProductRow | null | undefined): FeedingProduct | null {
  return row ? { id: row.id, name: row.name, kcalPer100g: Number(row.kcal_per_100g) } : null;
}

export function stapleProducts(products: FeedingProductRow[]): FeedingProductRow[] {
  return products.filter((p) => productKind(p.kind) === 'staple');
}
export function nenProducts(products: FeedingProductRow[]): FeedingProductRow[] {
  return products.filter((p) => productKind(p.kind) === 'nen');
}

/** ペットが選んだ主食 → 無ければ既定 → それも無ければ先頭（主食だけ。然の商品は選ばない）。 */
export function pickProduct(products: FeedingProductRow[], petProductId: string | null | undefined): FeedingProduct | null {
  const staples = stapleProducts(products);
  const chosen = petProductId ? staples.find((p) => p.id === petProductId) : undefined;
  return toFeedingProduct(chosen ?? staples.find((p) => p.is_default === 1) ?? staples[0] ?? null);
}

/** 「目安に使う」然の商品（おやつ）。無ければ先頭、それも無ければ null。 */
export function pickTreat(products: FeedingProductRow[]): FeedingProduct | null {
  const nen = nenProducts(products);
  return toFeedingProduct(nen.find((p) => p.is_default === 1) ?? nen[0] ?? null);
}

export class NenFeedingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NenFeedingValidationError';
  }
}

export type FeedingProductInput = { id?: string | null; name: string; kcalPer100g: number; isDefault?: boolean; kind: FeedingProductKind };

export const MAX_FEEDING_PRODUCTS = 20;

export function validateFeedingProducts(input: unknown): FeedingProductInput[] {
  if (!Array.isArray(input)) throw new NenFeedingValidationError('主食の一覧の形が正しくありません');
  if (input.length > MAX_FEEDING_PRODUCTS) throw new NenFeedingValidationError(`主食は${MAX_FEEDING_PRODUCTS}件までです`);
  const seen = new Set<string>();
  const products = input.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const kcal = Number(item.kcalPer100g);
    if (!name || name.length > 40) throw new NenFeedingValidationError(`${index + 1}行目：商品名は1〜40文字で入力してください`);
    if (!Number.isFinite(kcal) || kcal <= 0 || kcal > 1000) throw new NenFeedingValidationError(`${name}：100gあたりのカロリーは 1〜1000 kcal で入力してください`);
    if (seen.has(name)) throw new NenFeedingValidationError(`${name}：同じ商品名が2回あります`);
    seen.add(name);
    return {
      id: typeof item.id === 'string' && item.id ? item.id : null,
      name,
      kcalPer100g: Math.round(kcal * 10) / 10,
      isDefault: item.isDefault === true,
      kind: productKind(item.kind),
    };
  });
  // 既定（主食）・目安に使う（然の商品）は、それぞれの種類で1つだけ。無ければ先頭を既定にする。
  for (const kind of ['staple', 'nen'] as const) {
    const ofKind = products.filter((p) => p.kind === kind);
    if (ofKind.filter((p) => p.isDefault).length > 1) {
      throw new NenFeedingValidationError(kind === 'staple' ? '既定の主食は1つだけ選べます' : '目安に使う然の商品は1つだけ選べます');
    }
    if (ofKind.length > 0 && !ofKind.some((p) => p.isDefault)) ofKind[0].isDefault = true;
  }
  return products;
}

/**
 * 主食の一覧を保存する（無くなった行は削除、既定は1つ）。
 * 削除した主食を選んでいたペットは既定に戻す（feeding_product_id を NULL）。
 */
export async function saveFeedingProducts(db: D1Database, lineAccountId: string, input: unknown, now: string): Promise<FeedingProductRow[]> {
  const products = validateFeedingProducts(input);
  const existing = await listFeedingProducts(db, lineAccountId);
  /*
   * 画面が編集した対象と保存先が一致しているかの最終確認。
   * このアカウントに存在しないidは新規へ黙って変換せず、1件も書き込む前に拒否する。
   * 別アカウントの商品idが混ざった一覧をそのまま置き換えると、
   * いまある商品とペットとの関連が消えるため。
   */
  const existingIds = new Set(existing.map((row) => row.id));
  for (const product of products) {
    if (product.id && !existingIds.has(product.id)) {
      throw new NenFeedingValidationError('保存する対象が見つかりません。画面を読み直してから保存してください');
    }
  }
  const keep = new Set<string>();
  for (const [index, product] of products.entries()) {
    const current = product.id ? existing.find((row) => row.id === product.id) : undefined;
    const id = current?.id ?? crypto.randomUUID();
    keep.add(id);
    if (current) {
      await db.prepare(
        `UPDATE nen_feeding_products SET name = ?, kcal_per_100g = ?, is_default = ?, sort_order = ?, kind = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`,
      ).bind(product.name, product.kcalPer100g, product.isDefault ? 1 : 0, index, product.kind, now, id, lineAccountId).run();
    } else {
      await db.prepare(
        `INSERT INTO nen_feeding_products (id, line_account_id, name, kcal_per_100g, is_default, sort_order, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, lineAccountId, product.name, product.kcalPer100g, product.isDefault ? 1 : 0, index, product.kind, now, now).run();
    }
  }
  for (const row of existing) {
    if (keep.has(row.id)) continue;
    await db.prepare(`UPDATE nen_pet_profiles SET feeding_product_id = NULL, updated_at = ? WHERE feeding_product_id = ?`).bind(now, row.id).run();
    await db.prepare(`DELETE FROM nen_feeding_products WHERE id = ? AND line_account_id = ?`).bind(row.id, lineAccountId).run();
  }
  return listFeedingProducts(db, lineAccountId);
}

// ---------------------------------------------------------------- ペット行の再計算

export type PetFeedingRow = {
  id: string; animal_type: string; weight_kg: number | null; birthday: string | null; neutered: number | null;
  activity_level: string | null; feeding_product_id: string | null;
};

export function planForPetRow(row: PetFeedingRow, products: FeedingProductRow[], today: Date = new Date(), treatLimitPercent = DEFAULT_TREAT_LIMIT_PERCENT): FeedingPlan | null {
  const weightKg = Number(row.weight_kg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  /*
   * NRC／FEDIAF の係数は犬・猫専用。「その他」の動物へ犬の式を
   * 暗黙に当てない（計算対象外として null を返し、画面側で理由を出す）。
   */
  const species = toPetAnimalType(row.animal_type);
  if (!isFeedingSupportedAnimal(species)) return null;
  const animalType: AnimalType = species;
  return feedingPlan({
    animalType, weightKg, birthday: row.birthday ?? null,
    neutered: neuteredFromRow(row.neutered),
    activityLevel: normalizeActivity(row.activity_level) ?? 'normal',
  }, pickProduct(products, row.feeding_product_id), today, pickTreat(products), treatLimitPercent);
}

/**
 * 保存済みの目安（daily_kcal と recommended_daily_*）を計算し直す。
 * 主食が無いときは、これまでの目安（体重×g/kg）を残す。
 */
export async function refreshStoredFeeding(db: D1Database, petId: string, plan: FeedingPlan | null, now: string): Promise<void> {
  if (!plan) return;
  if (plan.dailyGrams == null) {
    if (plan.venison.grams != null) {
      await db.prepare(`UPDATE nen_pet_profiles SET daily_kcal = ?, venison_daily_grams = ?, updated_at = ? WHERE id = ?`).bind(plan.dailyKcal, plan.venison.grams, now, petId).run();
    } else {
      await db.prepare(`UPDATE nen_pet_profiles SET daily_kcal = ?, updated_at = ? WHERE id = ?`).bind(plan.dailyKcal, now, petId).run();
    }
    return;
  }
  await db.prepare(
    `UPDATE nen_pet_profiles
        SET daily_kcal = ?, recommended_daily_grams = ?, recommended_daily_min_grams = ?, recommended_daily_max_grams = ?,
            venison_daily_grams = ?, food_cycle_days = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    plan.dailyKcal, plan.dailyGrams, plan.minGrams, plan.maxGrams,
    // 然の商品が登録されていれば「必要カロリー × 上限% ÷ 然商品の kcal」。無ければ従来どおり主食の 10%。
    plan.venison.grams ?? Math.max(1, Math.round(plan.dailyGrams * 0.1)), Math.max(1, Math.round(1000 / plan.dailyGrams)), now, petId,
  ).run();
}

/** 主食の表を変えたあと、そのアカウントのペット全員の保存値を直す（上限つき）。 */
export async function refreshAccountFeeding(db: D1Database, lineAccountId: string, now: string, limit = 500): Promise<number> {
  const products = await listFeedingProducts(db, lineAccountId);
  const treatLimitPercent = await getTreatLimitPercent(db, lineAccountId);
  const pets = await db.prepare(
    `SELECT p.id, p.animal_type, p.weight_kg, p.birthday, p.neutered, p.activity_level, p.feeding_product_id
       FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
      WHERE p.archived_at IS NULL AND f.line_account_id = ? ORDER BY p.updated_at DESC LIMIT ?`,
  ).bind(lineAccountId, limit).all<PetFeedingRow>();
  let refreshed = 0;
  const today = new Date();
  for (const pet of pets.results ?? []) {
    const plan = planForPetRow(pet, products, today, treatLimitPercent);
    if (!plan) continue;
    await refreshStoredFeeding(db, pet.id, plan, now);
    refreshed++;
  }
  return refreshed;
}
