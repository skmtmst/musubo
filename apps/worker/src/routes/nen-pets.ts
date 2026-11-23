import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { jstDate as japanDate, jstDateOffset as japanDateOffset, jstMonthStart as japanMonthStart } from '@line-crm/shared';
import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { ACTIVITY_LABELS, DEFAULT_TREAT_LIMIT_PERCENT, getTreatLimitPercent, listFeedingProducts, planForPetRow, pickProduct, stapleProducts, type FeedingProductRow } from '../services/nen-feeding.js';
import { petCallName, petGender } from '../services/nen-pet-name.js';
import { toPetAnimalType } from '../lib/nen-pet-species.js';
import {
  APPETITE_LABELS, STOOL_LABELS, lastLoggedLabel, summarizePetHealth, thirtyDaySummary, type HealthLogRow,
} from '../services/nen-health-admin.js';
import { fail } from '../lib/fail.js';
/**
 * 然-NEN- マイペット（★37-3 `hetvN`）／健康日記（★37-4 `mtoCA`）の管理画面。
 *
 * ペットの正本は LINE 側（nen_pet_profiles）。お客様がマイページで登録・更新し、ここでは一覧と気づきを出す。
 * 「今日の目安」は `services/nen-feeding.ts`（NRC／FEDIAF）で表示のたびに計算する。
 * 主食のカロリー表は `/api/nen/feeding-products`（routes/nen-ranks.ts）。
 */
const nenPets = new Hono<Env>();

const PAGE_SIZE = 20;
const STALE_WEIGHT_DAYS = 90;
const MAX_PETS = 3000;

type PetRow = {
  id: string; friend_id: string; customer_id: string | null; name: string; animal_type: string; gender: string; breed: string | null;
  birthday: string | null; weight_kg: number | null; neutered: number | null; activity_level: string | null; feeding_product_id: string | null;
  image_url: string | null; created_at: string; updated_at: string; weight_updated_at: string | null;
  owner_name: string | null; owner_picture_url: string | null; ec_customer_id: string | null;
};

function accountIdFrom(c: Context<Env>): string {
  return (c.req.query('accountId') ?? '').trim();
}

async function requireAccount(c: Context<Env>, accountId: string): Promise<Response | null> {
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  return null;
}

const PET_SELECT = `SELECT p.id, p.friend_id, p.customer_id, p.name, p.animal_type, p.gender, p.breed, p.birthday, p.weight_kg,
       p.neutered, p.activity_level, p.feeding_product_id, p.image_url, p.created_at, p.updated_at, p.weight_updated_at,
       f.display_name AS owner_name, f.picture_url AS owner_picture_url, s.customer_id AS ec_customer_id
  FROM nen_pet_profiles p
  JOIN friends f ON f.id = p.friend_id
  LEFT JOIN nen_ec_member_snapshots s ON s.friend_id = f.id`;

/**
 * 一覧に出る主食は「ペットが選んだ主食 → アカウントの既定 → 先頭の主食」の順で決まる
 * （`pickProduct` と同じ）。表示と絞り込みを揃えるため、解決後の商品IDをSQLで同じ順に求める。
 * 選んだ値が主食でない（然のおやつ等）ときも既定へ落ちる。
 */
const RESOLVED_STAPLE_SQL = `CASE
    WHEN p.feeding_product_id IN (SELECT fp.id FROM nen_feeding_products fp
        WHERE fp.line_account_id = f.line_account_id AND fp.kind = 'staple')
      THEN p.feeding_product_id
    ELSE COALESCE(?, ?)
  END`;

async function loadPets(db: D1Database, accountId: string): Promise<PetRow[]> {
  const rows = await db.prepare(
    `${PET_SELECT}
      WHERE f.line_account_id = ?
      ORDER BY p.updated_at DESC`,
  ).bind(accountId).all<PetRow>();
  return rows.results ?? [];
}

function ageLabel(birthday: string | null, today: Date): string {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return '—';
  const born = new Date(`${birthday}T00:00:00Z`);
  let months = (today.getUTCFullYear() - born.getUTCFullYear()) * 12 + (today.getUTCMonth() - born.getUTCMonth());
  if (today.getUTCDate() < born.getUTCDate()) months -= 1;
  if (months < 0) return '—';
  if (months < 12) return `${months}か月`;
  return `${Math.floor(months / 12)}歳${months % 12}か月`;
}

function daysBetween(iso: string, today: Date): number | null {
  const t = Date.parse(iso.replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  return Math.floor((today.getTime() - t) / 86_400_000);
}

function petView(row: PetRow, products: FeedingProductRow[], today: Date, treatLimitPercent = DEFAULT_TREAT_LIMIT_PERCENT) {
  const plan = planForPetRow({
    id: row.id, animal_type: row.animal_type, weight_kg: row.weight_kg, birthday: row.birthday,
    neutered: row.neutered, activity_level: row.activity_level, feeding_product_id: row.feeding_product_id,
  }, products, today, treatLimitPercent);
  const product = pickProduct(products, row.feeding_product_id);
  // 「体重の更新」はプロフィール全体の更新日ではなく、体重を測った・
  // 直した日だけを見る。日記や編集で体重が入った瞬間に weight_updated_at が立ち、
  // 名前だけの編集では動かない。未登録（NULL）の行だけ従来どおり updated_at。
  const weightRefreshed = row.weight_updated_at ?? row.updated_at;
  const weightAgeDays = daysBetween(weightRefreshed, today);
  return {
    id: row.id,
    name: row.name,
    callName: petCallName(row.name, row.gender),
    gender: petGender(row.gender),
    animalType: toPetAnimalType(row.animal_type),
    breed: row.breed ?? '',
    birthday: row.birthday,
    ageLabel: ageLabel(row.birthday, today),
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    neutered: row.neutered === 1 ? 'yes' : row.neutered === 0 ? 'no' : 'unknown',
    activityLevel: (row.activity_level === 'low' || row.activity_level === 'high' ? row.activity_level : 'normal') as 'low' | 'normal' | 'high',
    activityLabel: ACTIVITY_LABELS[row.activity_level === 'low' || row.activity_level === 'high' ? row.activity_level : 'normal'],
    productName: product?.name ?? null,
    feeding: plan ? { dailyKcal: plan.dailyKcal, dailyGrams: plan.dailyGrams, factorLabel: plan.factorLabel, stageLabel: plan.stageLabel, venisonGrams: plan.venison.grams, venisonKcal: plan.venison.kcal, treatName: plan.venison.product?.name ?? null } : null,
    imageUrl: row.image_url,
    updatedAt: row.updated_at,
    weightUpdatedAt: weightRefreshed,
    weightStale: weightAgeDays != null && weightAgeDays >= STALE_WEIGHT_DAYS,
    owner: { friendId: row.friend_id, name: row.owner_name ?? '', pictureUrl: row.owner_picture_url, customerId: row.ec_customer_id ?? row.customer_id ?? null },
  };
}

/** LIKE の %・_ が検索語へ混入しても、任意一致として効かないよう逃がす。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 健康日記（37-4）はメモリ上で絞り込んだ結果を分けるために使う。 */
function paginate<T>(items: T[], pageParam: string | undefined, sizeParam?: string) {
  const { page, limit: pageSize } = parseOffsetPaging({ page: pageParam, limit: sizeParam === 'all' ? String(MAX_PETS) : sizeParam }, { defaultLimit: PAGE_SIZE, pagePolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1 }, limitPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1, maximum: MAX_PETS } });
  const start = (page - 1) * pageSize;
  return { page, pageSize, total: items.length, items: items.slice(start, start + pageSize) };
}

// ---------------------------------------------------------------- マイペット（37-3）

nenPets.get('/api/nen/pets', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const today = new Date();
  const [products, treatLimitPercent] = await Promise.all([listFeedingProducts(c.env.DB, accountId), getTreatLimitPercent(c.env.DB, accountId)]);
  const staples = stapleProducts(products);
  const defaultStapleId = staples.find((p) => p.is_default === 1)?.id ?? null;
  const firstStapleId = staples[0]?.id ?? null;

  const q = (c.req.query('q') ?? '').trim();
  const species = c.req.query('species') ?? '';
  const product = c.req.query('product') ?? '';
  const weight = c.req.query('weight') ?? '';
  const sort = c.req.query('sort') ?? 'updated_desc';

  // JSで絞ると読み込み上限より後ろが漏れるため、検索・絞り込み・件数・ページ分割はすべてSQL側で行う。
  const where: string[] = ['f.line_account_id = ?'];
  const binds: Array<string | number | null> = [accountId];
  if (q) {
    const needle = `%${escapeLike(q.toLowerCase())}%`;
    where.push(`(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.breed, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(f.display_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(s.customer_id, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.customer_id, '')) LIKE ? ESCAPE '\\')`);
    binds.push(needle, needle, needle, needle, needle);
  }
  if (species === 'dog' || species === 'cat' || species === 'other') {
    where.push('p.animal_type = ?');
    binds.push(species);
  }
  if (product === 'none') {
    where.push(`${RESOLVED_STAPLE_SQL} IS NULL`);
    binds.push(defaultStapleId, firstStapleId);
  } else if (product) {
    where.push(`${RESOLVED_STAPLE_SQL} = ?`);
    binds.push(defaultStapleId, firstStapleId, product);
  }
  if (weight === 'stale' || weight === 'fresh') {
    const cutoff = new Date(today.getTime() - STALE_WEIGHT_DAYS * 86_400_000).toISOString();
    where.push(`julianday(COALESCE(p.weight_updated_at, p.updated_at)) ${weight === 'stale' ? '<=' : '>'} julianday(?)`);
    binds.push(cutoff);
  }
  const whereSql = where.join(' AND ');

  const orderBy = sort === 'name' ? 'p.name ASC'
    : sort === 'weight_desc' ? 'COALESCE(p.weight_kg, 0) DESC'
    : sort === 'age_desc' ? `COALESCE(p.birthday, '9999') ASC`
    : 'p.updated_at DESC';

  const wantsAll = c.req.query('pageSize') === 'all';
  const { page, limit: pageSize } = parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('pageSize') }, { defaultLimit: PAGE_SIZE, pagePolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1 }, limitPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1, maximum: MAX_PETS } });

  const kpiCutoff = new Date(today.getTime() - STALE_WEIGHT_DAYS * 86_400_000).toISOString();
  const monthStart = japanMonthStart(today);
  const [countRow, kpiRow, planRows, pageRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
        LEFT JOIN nen_ec_member_snapshots s ON s.friend_id = f.id WHERE ${whereSql}`,
    ).bind(...binds).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN p.animal_type = 'dog' THEN 1 ELSE 0 END) AS dogs,
              SUM(CASE WHEN p.animal_type = 'cat' THEN 1 ELSE 0 END) AS cats,
              SUM(CASE WHEN substr(p.created_at, 1, 10) >= ? THEN 1 ELSE 0 END) AS new_this_month,
              SUM(CASE WHEN julianday(COALESCE(p.weight_updated_at, p.updated_at)) <= julianday(?) THEN 1 ELSE 0 END) AS stale_weight
         FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
        WHERE f.line_account_id = ?`,
    ).bind(monthStart, kpiCutoff, accountId).first<Record<string, number | null>>(),
    // 「目安を計算できる頭数」は給餌計算（NRC/FEDIAF）を通した数。計算に必要な列だけを全頭分取る。
    c.env.DB.prepare(
      `SELECT p.id, p.animal_type, p.weight_kg, p.birthday, p.neutered, p.activity_level, p.feeding_product_id
         FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE f.line_account_id = ?`,
    ).bind(accountId).all<Pick<PetRow, 'id' | 'animal_type' | 'weight_kg' | 'birthday' | 'neutered' | 'activity_level' | 'feeding_product_id'>>(),
    c.env.DB.prepare(
      `${PET_SELECT} WHERE ${whereSql} ORDER BY ${orderBy}, p.updated_at DESC, p.id ASC${wantsAll ? '' : ' LIMIT ? OFFSET ?'}`,
    ).bind(...(wantsAll ? binds : [...binds, pageSize, (page - 1) * pageSize])).all<PetRow>(),
  ]);

  const total = Number(countRow?.n ?? 0);
  const views = (pageRows.results ?? []).map((row) => petView(row, products, today, treatLimitPercent));
  const kpis = {
    total: Number(kpiRow?.total ?? 0),
    dogs: Number(kpiRow?.dogs ?? 0),
    cats: Number(kpiRow?.cats ?? 0),
    newThisMonth: Number(kpiRow?.new_this_month ?? 0),
    computable: (planRows.results ?? []).filter((row) => planForPetRow(row, products, today, treatLimitPercent)?.dailyGrams != null).length,
    staleWeight: Number(kpiRow?.stale_weight ?? 0),
  };

  return c.json({ success: true, data: buildOffsetListResponse({ items: views, page, pageSize: wantsAll ? total : pageSize, total, kpis, products: staples.map((p) => ({ id: p.id, name: p.name })), treatLimitPercent, paging: { limit: wantsAll ? total : pageSize, offset: wantsAll ? 0 : (page - 1) * pageSize }, sort: [] }) });
});

// ---------------------------------------------------------------- 健康日記（37-4）

type HealthRow = HealthLogRow & { pet_id: string };

async function loadRecentLogs(db: D1Database, accountId: string, sinceDays: number): Promise<HealthRow[]> {
  const since = japanDateOffset(-sinceDays);
  const rows = await db.prepare(
    `SELECT h.pet_id, h.logged_on, h.weight_kg, h.stool_status, h.appetite, h.skin_status, h.tear_stain_status,
            h.heart_rate_bpm, h.respiratory_rate_bpm, h.note
       FROM nen_health_logs h JOIN friends f ON f.id = h.friend_id
      WHERE f.line_account_id = ? AND h.logged_on >= ?
      ORDER BY h.logged_on ASC`,
  ).bind(accountId, since).all<HealthRow>();
  return rows.results ?? [];
}

nenPets.get('/api/nen/health', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const today = new Date();
  const [pets, logs, lastByPet] = await Promise.all([
    loadPets(c.env.DB, accountId),
    loadRecentLogs(c.env.DB, accountId, 70),
    c.env.DB.prepare(
      `SELECT h.pet_id, MAX(h.logged_on) AS last_logged_on, COUNT(*) AS total
         FROM nen_health_logs h JOIN friends f ON f.id = h.friend_id
        WHERE f.line_account_id = ? GROUP BY h.pet_id`,
    ).bind(accountId).all<{ pet_id: string; last_logged_on: string; total: number }>(),
  ]);
  const totals = new Map((lastByPet.results ?? []).map((row) => [row.pet_id, row]));
  const byPet = new Map<string, HealthRow[]>();
  for (const log of logs) { const list = byPet.get(log.pet_id) ?? []; list.push(log); byPet.set(log.pet_id, list); }

  const weekAgo = japanDateOffset(-7, today);
  const rows = pets.filter((pet) => totals.has(pet.id)).map((pet) => {
    const summary = summarizePetHealth(byPet.get(pet.id) ?? [], today);
    const meta = totals.get(pet.id)!;
    // 直近 70 日に記録が無い場合でも「最終記録」は全期間から出す。
    if (!summary.lastLoggedOn && meta.last_logged_on) {
      summary.lastLoggedOn = meta.last_logged_on;
      summary.daysSinceLast = Math.floor((Date.parse(japanDate(today)) - Date.parse(`${meta.last_logged_on}T00:00:00Z`)) / 86_400_000);
      if (summary.daysSinceLast >= 30 && !summary.changes.some((ch) => ch.key === 'silent')) summary.changes.push({ key: 'silent', label: '30日以上 記録なし', tone: 'faint' });
    }
    return {
      pet: { id: pet.id, name: pet.name, callName: petCallName(pet.name, pet.gender), animalType: toPetAnimalType(pet.animal_type), breed: pet.breed ?? '', ageLabel: ageLabel(pet.birthday, today), imageUrl: pet.image_url },
      owner: { friendId: pet.friend_id, name: pet.owner_name ?? '', customerId: pet.ec_customer_id ?? pet.customer_id ?? null },
      lastLoggedOn: summary.lastLoggedOn,
      lastLoggedLabel: lastLoggedLabel(summary),
      daysSinceLast: summary.daysSinceLast,
      count30d: summary.count30d,
      totalRecords: Number(meta.total),
      weightSeries: summary.weightSeries,
      latestWeightKg: summary.latestWeightKg,
      weightChangePercent: summary.weightChangePercent,
      latestStool: summary.latestStool ? STOOL_LABELS[summary.latestStool] ?? summary.latestStool : null,
      latestAppetite: summary.latestAppetite ? APPETITE_LABELS[summary.latestAppetite] ?? summary.latestAppetite : null,
      changes: summary.changes,
      concerning: summary.changes.some((ch) => ch.tone === 'warn'),
    };
  });

  const kpis = {
    recordsThisWeek: logs.filter((log) => log.logged_on >= weekAgo).length,
    petsWithRecords: rows.length,
    petsTotal: pets.length,
    concerning: rows.filter((row) => row.concerning).length,
    silent30: rows.filter((row) => row.changes.some((ch) => ch.key === 'silent')).length,
  };

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const change = c.req.query('change') ?? '';
  const last = c.req.query('last') ?? '';
  const sort = c.req.query('sort') ?? 'concern';
  let filtered = rows.filter((row) => (!q || row.pet.name.toLowerCase().includes(q) || row.owner.name.toLowerCase().includes(q))
    && (change === 'concern' ? row.concerning : change === 'silent' ? row.changes.some((ch) => ch.key === 'silent') : change === 'none' ? row.changes.length === 0 : true)
    && (last === '7' ? (row.daysSinceLast ?? 999) <= 7 : last === '30' ? (row.daysSinceLast ?? 999) <= 30 : last === 'over30' ? (row.daysSinceLast ?? 999) > 30 : true));
  if (sort === 'concern') filtered = [...filtered].sort((a, b) => Number(b.concerning) - Number(a.concerning) || (a.daysSinceLast ?? 999) - (b.daysSinceLast ?? 999));
  else if (sort === 'recent') filtered = [...filtered].sort((a, b) => (a.daysSinceLast ?? 999) - (b.daysSinceLast ?? 999));
  else if (sort === 'records_desc') filtered = [...filtered].sort((a, b) => b.count30d - a.count30d);

  const pageData = paginate(filtered, c.req.query('page'), c.req.query('pageSize'));
  return c.json({ success: true, data: buildOffsetListResponse({ ...pageData, kpis, paging: { limit: pageData.pageSize, offset: (pageData.page - 1) * pageData.pageSize }, sort: [] }) });
});

nenPets.get('/api/nen/health/:petId/summary', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const petId = c.req.param('petId');
  const pet = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.gender, p.animal_type, p.breed, p.birthday, p.weight_kg, p.friend_id, f.display_name AS owner_name
       FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
      WHERE p.id = ? AND f.line_account_id = ?`,
  ).bind(petId, accountId).first<{ id: string; name: string; gender: string | null; animal_type: string; breed: string | null; birthday: string | null; weight_kg: number | null; friend_id: string; owner_name: string | null }>();
  if (!pet) return fail(c, 404, 'PET_NOT_FOUND');
  const since = japanDateOffset(-30);
  const logs = await c.env.DB.prepare(
    `SELECT pet_id, logged_on, weight_kg, stool_status, appetite, skin_status, tear_stain_status, heart_rate_bpm, respiratory_rate_bpm, note
       FROM nen_health_logs WHERE pet_id = ? AND logged_on >= ? ORDER BY logged_on DESC`,
  ).bind(petId, since).all<HealthRow>();
  const today = new Date();
  return c.json({ success: true, data: {
    pet: { id: pet.id, name: pet.name, callName: petCallName(pet.name, pet.gender), animalType: toPetAnimalType(pet.animal_type), breed: pet.breed ?? '', ageLabel: ageLabel(pet.birthday, today), weightKg: pet.weight_kg },
    owner: { friendId: pet.friend_id, name: pet.owner_name ?? '' },
    generatedAt: today.toISOString(),
    summary: thirtyDaySummary(logs.results ?? [], today),
    labels: { stool: STOOL_LABELS, appetite: APPETITE_LABELS },
  } });
});

export { nenPets };
