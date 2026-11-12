import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import {
  NenRankValidationError,
  countNenMilestoneReached,
  ensureNenRankDefaults,
  findOrCreateGlobalTag,
  getNenLifetimeMilestones,
  getNenMemberKpis,
  getNenRankRules,
  getNenRankSettings,
  jstNow,
  listNenMembers,
  saveNenLifetimeMilestones,
  saveNenRankSettings,
  setNenRankSyncStatus,
  setNenRankTagId,
  validateNenRankInputs,
  type NenMemberListOptions,
  type NenRankSetting,
} from '@line-crm/db';
import { fail } from '../lib/fail.js';
import type { Env } from '../worker-env.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { NenRankSyncError, buildNenRankSyncPayload, pushNenRankSettingsToEc } from '../services/nen-rank-sync.js';
import { refreshAllNenTags } from '../services/nen-tag-sync.js';
import { deleteNenRank, NenRankDeleteError, countRankMembers, rankDeleteMembers, type ConfirmedRankMember } from '../services/nen-rank-delete.js';
import { getMemberRankSync, syncMemberRanks } from '../services/nen-member-rank-sync.js';
import {
  ENERGY_FACTORS,
  NenFeedingValidationError,
  getTreatLimitPercent,
  listFeedingProducts,
  productKind,
  refreshAccountFeeding,
  saveFeedingProducts,
  saveTreatLimitPercent,
  validateTreatLimitPercent,
} from '../services/nen-feeding.js';

/**
 * 然-NEN- 会員（ランク・ライフタイム・マイル）。★37-1（`IqL2Z`）／37-1-A（`p7xHl`）／37-1-B（`Vt65m`）。
 *
 * - 設定の正本はここ（LINE管理画面）。保存すると版が上がり、ECへ署名付きで送る。
 * - 計算はEC側。結果は `POST /api/integrations/eccube/events` の `membership` で届く。
 * - 保存のたびに友だち属性タグ「[会員] ランク：◯◯」を用意し、見える範囲の友だちを付け替える。
 */
const nenRanks = new Hono<Env>();

function accountIdFrom(c: Context<Env>, body?: Record<string, unknown> | null): string {
  const fromBody = body && typeof body.accountId === 'string' ? body.accountId : '';
  const fromQuery = c.req.query('accountId') ?? '';
  return (fromBody || fromQuery).trim();
}

async function requireAccount(c: Context<Env>, accountId: string): Promise<Response | null> {
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  return null;
}

function serializeRank(rank: NenRankSetting, tagName: string | null, count: number) {
  return {
    id: rank.id,
    key: rank.rank_key,
    name: rank.name,
    annualThresholdYen: rank.annual_threshold_yen,
    mileRatePercent: rank.mile_rate_percent,
    tagId: rank.tag_id,
    tagName,
    memberCount: count,
  };
}

async function tagNames(db: D1Database, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db.prepare(
    `SELECT id, name FROM tags WHERE id IN (${sqlIdSet(unique).sql})`,
  ).bind(...(unique.length ? sqlIdSet(unique).binds : [])).all<{ id: string; name: string }>();
  return new Map(rows.results.map((row) => [row.id, row.name]));
}

/**
 * ランクに友だち属性タグを用意する。無ければ「[会員] ランク：◯◯」を作る。
 * 初期の4ランクは migration 080 のタグ ID を指しているが、そのタグが無い環境（新しい統括）では作り直す。
 */
async function ensureRankTags(db: D1Database, ranks: NenRankSetting[], now: string): Promise<NenRankSetting[]> {
  const existing = await tagNames(db, ranks.map((rank) => rank.tag_id));
  const result: NenRankSetting[] = [];
  for (const rank of ranks) {
    if (rank.tag_id && existing.has(rank.tag_id)) {
      result.push(rank);
      continue;
    }
    const tag = await findOrCreateGlobalTag(db, { name: `[会員] ランク：${rank.name}`, color: '#10B981' });
    await setNenRankTagId(db, rank.id, tag.id, now);
    result.push({ ...rank, tag_id: tag.id });
  }
  return result;
}

async function syncToEc(c: Context<Env>, accountId: string): Promise<{ status: 'synced' | 'failed' | 'skipped'; error: string | null }> {
  const db = c.env.DB;
  const [ranks, rules, milestones] = await Promise.all([
    getNenRankSettings(db, accountId),
    getNenRankRules(db, accountId),
    getNenLifetimeMilestones(db, accountId),
  ]);
  if (!ranks.length) return { status: 'failed', error: 'ランクが未設定です。初期ランクを作成してください' };
  if (!rules) return { status: 'failed', error: 'ランクの設定を保存してから再同期してください' };
  const baseUrl = c.env.NEN_EC_BASE_URL;
  const secret = c.env.ECCUBE_WEBHOOK_SECRET;
  if (!baseUrl || !secret) {
    const error = 'ECのつなぎ先（NEN_EC_BASE_URL / ECCUBE_WEBHOOK_SECRET）が未設定です';
    await setNenRankSyncStatus(db, accountId, 'failed', error);
    return { status: 'failed', error };
  }
  try {
    await pushNenRankSettingsToEc(baseUrl, secret, buildNenRankSyncPayload(ranks, rules, milestones));
    await setNenRankSyncStatus(db, accountId, 'synced', null);
    return { status: 'synced', error: null };
  } catch (error) {
    const message = error instanceof NenRankSyncError ? error.message : 'ECへの同期に失敗しました';
    await setNenRankSyncStatus(db, accountId, 'failed', message);
    return { status: 'failed', error: message };
  }
}

async function settingsResponse(c: Context<Env>, accountId: string) {
  const db = c.env.DB;
  const [ranks, rules, milestones, kpis] = await Promise.all([
    getNenRankSettings(db, accountId),
    getNenRankRules(db, accountId),
    getNenLifetimeMilestones(db, accountId),
    getNenMemberKpis(db, [accountId]),
  ]);
  const names = await tagNames(db, ranks.map((rank) => rank.tag_id));
  const reached = await countNenMilestoneReached(db, [accountId], milestones.map((m) => m.threshold_yen));
  return {
    ranks: ranks.map((rank) => serializeRank(rank, rank.tag_id ? names.get(rank.tag_id) ?? null : null, kpis.byRank[rank.rank_key] ?? 0)),
    rules: rules ? {
      yearStartMonth: rules.year_start_month,
      applyOnReach: rules.apply_on_reach,
      keepUntil: rules.keep_until,
      countOrders: rules.count_orders,
      version: rules.version,
      syncStatus: rules.sync_status,
      syncError: rules.sync_error,
      syncedAt: rules.synced_at,
      updatedAt: rules.updated_at,
    } : null,
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      thresholdYen: milestone.threshold_yen,
      title: milestone.title,
      benefitKind: milestone.benefit_kind,
      benefitNote: milestone.benefit_note,
      notifyOnReach: milestone.notify_on_reach === 1,
      reachedCount: reached[milestone.threshold_yen] ?? 0,
    })),
    kpis,
  };
}

nenRanks.get('/api/nen/rank-settings', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  return c.json({ success: true, data: await settingsResponse(c, accountId) });
});

nenRanks.post('/api/nen/rank-settings/initialize', requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  await ensureNenRankDefaults(c.env.DB, accountId);
  await ensureRankTags(c.env.DB, await getNenRankSettings(c.env.DB, accountId), jstNow());
  return c.json({ success: true, data: await settingsResponse(c, accountId) });
});

nenRanks.get('/api/nen/rank-settings/:id/delete-preview', requireRole('owner','admin'), async c=>{
  const accountId=accountIdFrom(c),denied=await requireAccount(c,accountId);
  if(denied)return denied;
  const [ranks,rules]=await Promise.all([getNenRankSettings(c.env.DB,accountId),getNenRankRules(c.env.DB,accountId)]);
  const rank=ranks.find(item=>item.id===c.req.param('id'));
  if(!rank||!rules)return c.json({success:false,error:'ランクが見つかりません'},404);
  const members=await rankDeleteMembers(c.env.DB,accountId,rank.rank_key);
  return c.json({success:true,data:{count:members.length,members,version:rules.version}});
});

nenRanks.delete('/api/nen/rank-settings/:id', requireRole('owner', 'admin'), async (c) => {
  const body = await c.req.json<{ accountId?: string; replacementRankId?: unknown; expectedVersion?: unknown; confirmedMembers?:unknown }>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  if (!body || typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ success: false, error: 'expectedVersionには読み込んだ版を指定してください' }, 400);
  }
  if (body.replacementRankId != null && (typeof body.replacementRankId !== 'string' || !body.replacementRankId.trim())) {
    return c.json({ success: false, error: '移す先のランクを選んでください' }, 400);
  }
  if(body.confirmedMembers!==undefined&&(!Array.isArray(body.confirmedMembers)||body.confirmedMembers.some((item:unknown)=>!item||typeof item!=='object'||typeof (item as ConfirmedRankMember).friendId!=='string'||!((item as ConfirmedRankMember).customerId===null||typeof (item as ConfirmedRankMember).customerId==='string'))||new Set(body.confirmedMembers.map((item:ConfirmedRankMember)=>item.friendId)).size!==body.confirmedMembers.length))return c.json({success:false,error:'確認した会員を指定してください'},400);
  const actor = `musubo:${c.get('staff').id}`;
  if (actor.length > 128) return c.json({ success: false, error: '担当者IDが長すぎます' }, 400);
  try {
    const data = await deleteNenRank(c.env.DB, accountId, c.req.param('id'),
      typeof body.replacementRankId === 'string' ? body.replacementRankId : null, body.expectedVersion,
      async (ranks, now) => {
        if(body.confirmedMembers===undefined)return ensureRankTags(c.env.DB,ranks,now);
        const names=await tagNames(c.env.DB,ranks.map(rank=>rank.tag_id));
        if(ranks.some(rank=>!rank.tag_id||!names.has(rank.tag_id)))throw new NenRankDeleteError('ランクのタグを保存してから再確認してください',409,await countRankMembers(c.env.DB,accountId,ranks[0].rank_key));
        return ranks;
      }, actor,body.confirmedMembers as ConfirmedRankMember[]|undefined);
    let ecSyncResult;
    try {
      ecSyncResult = await syncMemberRanks(c.env.DB, accountId, data.operationId, memberSyncConfig(c));
    } catch {
      // 削除は既に保存済み。結果の保存障害を削除失敗として返さない。
      return c.json({ success: true, data: { ...data, ecSyncResult: null,
        message: '移し替えは保存しました。ECの送信結果を確認できませんでした。操作IDで確認してやり直してください' } });
    }
    return c.json({ success: true, data: { ...data, ecSync: ecSyncResult.status, ecSyncResult,
      message: ecSyncResult.status === 'synced' ? '会員のランクをECへ反映しました'
        : ecSyncResult.status === 'failed' ? 'ECへの反映に失敗した会員がいます。結果を確認してやり直してください' : data.message } });
  } catch (error) {
    if (error instanceof NenRankDeleteError) return inputError(c, { success: false, error: error.message,...(error.currentCount===undefined?{}:{data:{count:error.currentCount}}) }, error.status, []);
    throw error;
  }
});

function memberSyncConfig(c: Context<Env>) {
  return { enabled: c.env.NEN_EC_MEMBER_RANK_SYNC_ENABLED, baseUrl: c.env.NEN_EC_BASE_URL,
    secret: c.env.ECCUBE_WEBHOOK_SECRET };
}

nenRanks.get('/api/nen/rank-settings/member-sync/:operationId', requireRole('owner', 'admin'), async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const data = await getMemberRankSync(c.env.DB, accountId, c.req.param('operationId'), c.req.query('afterId'));
  if (!data.total) return c.json({ success: false, error: '会員の送信記録が見つかりません' }, 404);
  return c.json({ success: true, data });
});

nenRanks.post('/api/nen/rank-settings/member-sync/:operationId/retry', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const operationId = c.req.param('operationId');
  if (!(await getMemberRankSync(c.env.DB, accountId, operationId)).total) {
    return c.json({ success: false, error: '会員の送信記録が見つかりません' }, 404);
  }
  return c.json({ success: true, data: await syncMemberRanks(c.env.DB, accountId, operationId, memberSyncConfig(c)) });
});

type RankBody = { accountId?: string; ranks?: Array<{ id?: string | null; name?: unknown; annualThresholdYen?: unknown; mileRatePercent?: unknown }> };

nenRanks.put('/api/nen/rank-settings', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"ranks":["array"]}), async (c) => {
  const body = await c.req.json<RankBody>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  if (!body || !Array.isArray(body.ranks)) return inputError(c, { success: false, error: 'ranks is required' }, 400, ["ranks"]);
  const now = jstNow();
  try {
    validateNenRankInputs(body.ranks.map((rank) => ({ id: typeof rank.id === 'string' ? rank.id : null,
      name: String(rank.name ?? ''), annualThresholdYen: Number(rank.annualThresholdYen), mileRatePercent: Number(rank.mileRatePercent) })));
    const existing = await getNenRankSettings(c.env.DB, accountId);
    if (existing.some((rank) => !body.ranks!.some((input) => input.id === rank.id))) {
      return inputError(c, { success: false, error: 'ランクの削除は、版と移す先を指定して削除操作から行ってください' }, 400, ["ranks","accountId","ranks"]);
    }
    const saved = await saveNenRankSettings(c.env.DB, accountId, body.ranks.map((rank) => ({
      id: typeof rank.id === 'string' ? rank.id : null,
      name: String(rank.name ?? ''),
      annualThresholdYen: Number(rank.annualThresholdYen),
      mileRatePercent: Number(rank.mileRatePercent),
    })), now);
    await ensureRankTags(c.env.DB, saved, now);
  } catch (error) {
    if (error instanceof NenRankValidationError) return inputError(c, { success: false, error: error.message }, 400, ['ranks']);
    throw error;
  }
  const sync = await syncToEc(c, accountId);
  // 付け替えは見える範囲の友だちだけ。ここで待つと保存が遅くなるので、上限を切って先頭だけ回し、残りは定期処理に任せる。
  const refreshed = await refreshAllNenTags(c.env.DB, [accountId], 200).catch(() => ({ friends: 0, added: 0, removed: 0 }));
  return c.json({ success: true, data: { ...(await settingsResponse(c, accountId)), sync, refreshed } });
});

type MilestoneBody = { accountId?: string; milestones?: Array<{ id?: string | null; thresholdYen?: unknown; title?: unknown; notifyOnReach?: unknown }> };

nenRanks.put('/api/nen/lifetime-milestones', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"milestones":["array"]}), async (c) => {
  const body = await c.req.json<MilestoneBody>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  if (!body || !Array.isArray(body.milestones)) return inputError(c, { success: false, error: 'milestones is required' }, 400, ["milestones"]);
  const now = jstNow();
  try {
    await saveNenLifetimeMilestones(c.env.DB, accountId, body.milestones.map((milestone) => ({
      id: typeof milestone.id === 'string' ? milestone.id : null,
      thresholdYen: Number(milestone.thresholdYen),
      title: String(milestone.title ?? ''),
      notifyOnReach: milestone.notifyOnReach === undefined ? undefined : milestone.notifyOnReach !== false,
    })), now);
  } catch (error) {
    if (error instanceof NenRankValidationError) return inputError(c, { success: false, error: error.message }, 400, ['milestones']);
    throw error;
  }
  const sync = await syncToEc(c, accountId);
  return c.json({ success: true, data: { ...(await settingsResponse(c, accountId)), sync } });
});

nenRanks.post('/api/nen/rank-settings/resync', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  if (!(await getNenRankSettings(c.env.DB, accountId)).length) {
    return c.json({ success: false, error: 'ランクが未設定です。初期ランクを作成してください' }, 409);
  }
  if (!(await getNenRankRules(c.env.DB, accountId))) {
    return c.json({ success: false, error: 'ランクの設定を保存してから再同期してください' }, 409);
  }
  const sync = await syncToEc(c, accountId);
  return c.json({ success: true, data: { ...(await settingsResponse(c, accountId)), sync } });
});

/**
 * 主食のカロリー表（★37-1 会員 › 給与量）。マイページ「今日の目安」のグラム数はここから決まる。
 * ペットの正本は LINE 側。EC には送らない。
 */
function feedingProductsResponse(products: Awaited<ReturnType<typeof listFeedingProducts>>, petCount: number, treatLimitPercent: number) {
  return {
    products: products.map((p) => ({ id: p.id, name: p.name, kcalPer100g: Number(p.kcal_per_100g), isDefault: p.is_default === 1, kind: productKind(p.kind) })),
    treatLimitPercent,
    petCount,
    factors: ENERGY_FACTORS,
  };
}

async function accountPetCount(db: D1Database, accountId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE f.line_account_id = ?`,
  ).bind(accountId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

nenRanks.get('/api/nen/feeding-products', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const [products, petCount, treatLimitPercent] = await Promise.all([listFeedingProducts(c.env.DB, accountId), accountPetCount(c.env.DB, accountId), getTreatLimitPercent(c.env.DB, accountId)]);
  return c.json({ success: true, data: feedingProductsResponse(products, petCount, treatLimitPercent) });
});

nenRanks.put('/api/nen/feeding-products', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string; products?: unknown; treatLimitPercent?: unknown }>().catch(() => null);
  const accountId = accountIdFrom(c, body);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  if (!body || !Array.isArray(body.products)) return inputError(c, { success: false, error: 'products is required' }, 400, ["products"]);
  const now = jstNow();
  let products;
  let treatLimitPercent: number;
  try {
    treatLimitPercent = body.treatLimitPercent === undefined ? await getTreatLimitPercent(c.env.DB, accountId) : validateTreatLimitPercent(body.treatLimitPercent);
    products = await saveFeedingProducts(c.env.DB, accountId, body.products, now);
    await saveTreatLimitPercent(c.env.DB, accountId, treatLimitPercent, now);
  } catch (error) {
    if (error instanceof NenFeedingValidationError) return inputError(c, { success: false, error: error.message }, 400, ['products']);
    throw error;
  }
  // 表や上限を変えたら、登録済みのペットの目安も直す（表示は毎回計算するが、保存値も揃えておく）。
  const refreshed = await refreshAccountFeeding(c.env.DB, accountId, now);
  const petCount = await accountPetCount(c.env.DB, accountId);
  return c.json({ success: true, data: { ...feedingProductsResponse(products, petCount, treatLimitPercent), refreshedPets: refreshed } });
});

nenRanks.get('/api/nen/members', async (c) => {
  const accountId = accountIdFrom(c);
  const denied = await requireAccount(c, accountId);
  if (denied) return denied;
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const accountIds: Array<string | null> = scope.allowedAccountIds.includes(accountId) ? [accountId] : [];
  const ranks = await getNenRankSettings(c.env.DB, accountId);
  const sortParam = c.req.query('sort');
  const petParam = c.req.query('pet');
  const linkParam = c.req.query('link');
  // ★V8「○○以上」の札：区切りに合うランクキーをカンマ区切りで受ける。
  const rankKeys = (c.req.query('ranks') ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key && ranks.some((rank) => rank.rank_key === key))
    .slice(0, 8);
  const { page, limit: pageSize } = parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('pageSize') }, { defaultLimit: 20, pagePolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1 }, limitPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1, maximum: 100 } });
  const options: NenMemberListOptions = {
    accountIds,
    rankKey: c.req.query('rank') || null,
    rankKeys,
    linkedOnly: linkParam === 'linked' || linkParam === 'unlinked' ? linkParam : undefined,
    petFilter: petParam === 'with' || petParam === 'without' ? petParam : 'any',
    query: c.req.query('q') ?? '',
    sort: sortParam === 'lifetime_desc' || sortParam === 'balance_desc' || sortParam === 'recent' ? sortParam : 'annual_desc',
    page,
    pageSize,
  };
  const [{ items, total }, kpis] = await Promise.all([
    listNenMembers(c.env.DB, options),
    getNenMemberKpis(c.env.DB, accountIds),
  ]);
  const data = items.map((row) => {
    const ecRankKey = row.member_rank_key?.trim() ? row.member_rank_key : null;
    const ecRankName = row.ec_member_rank_name?.trim() ? row.ec_member_rank_name : null;
    const matchingRank = ecRankKey ? ranks.find((item) => item.rank_key === ecRankKey) : null;
    return {
      friendId: row.friend_id,
      name: row.display_name ?? '',
      pictureUrl: row.picture_url,
      customerId: row.customer_id,
      rankKey: ecRankKey ?? matchingRank?.rank_key ?? null,
      rankName: matchingRank?.name ?? (ecRankKey ? ecRankName : null) ?? '未設定',
      mileRatePercent: row.mile_rate_percent ?? matchingRank?.mile_rate_percent ?? null,
      annualMilesYen: row.annual_miles_yen,
      lifetimeMilesYen: row.lifetime_miles_yen,
      mileBalance: row.mile_balance,
      rankValidUntil: row.rank_valid_until,
      lastPurchasedAt: row.last_purchased_at,
      purchaseCount: row.purchase_count,
      petCount: row.pet_count,
      petNames: row.pet_names,
      syncedAt: row.synced_at,
    };
  });
  return c.json({
    success: true,
    data: buildOffsetListResponse({ items: data,
      total,
      page: options.page,
      pageSize: options.pageSize,
      kpis,
      ranks: ranks.map((rank) => ({ key: rank.rank_key, name: rank.name, annualThresholdYen: rank.annual_threshold_yen, mileRatePercent: rank.mile_rate_percent })), paging: { limit: pageSize, offset: (page - 1) * pageSize }, sort: [] }),
  });
});

export { nenRanks };
