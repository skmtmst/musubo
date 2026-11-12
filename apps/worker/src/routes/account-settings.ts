import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { personalDataRetention } from './personal-data-retention.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  getLinkBaseUrl,
  setLinkBaseUrl,
  getTrackedLinkBaseUrl,
  setTrackedLinkBaseUrl,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { saveVersionedAccountSetting } from '@line-crm/db';
import {accountCustomerLook, CUSTOMER_LOOK_KEY} from '../services/customer-look.js';
import {customerLookError, resolveCustomerLook} from '@line-crm/shared';
import { validateAllergyValues } from '@line-crm/shared';
import { ALLERGY_OPTIONS_KEY, accountAllergyOptions } from '../services/allergy-options.js';
import { fail } from '../lib/fail.js';
const accountSettings = new Hono<Env>();
accountSettings.route('/', personalDataRetention);
accountSettings.put('/api/account-settings/customer-look',requireRole('owner','admin'),inputJsonBoundary(),async c=>{
 const body=await c.req.json<{accountId?:unknown;expectedVersion?:unknown;look?:unknown}>();
 if (typeof body.accountId !== 'string' || !body.accountId || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return c.json({success:false,error:'店と確認した版を指定してください'},422);
 if (!await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[body.accountId])) return c.json({success:false,error:'権限がありません'},403);
 const error=customerLookError(body.look);if(error)return c.json({success:false,error},422);
 const result=await saveVersionedAccountSetting(c.env.DB,{accountId:body.accountId,key:CUSTOMER_LOOK_KEY,expectedVersion:body.expectedVersion,data:resolveCustomerLook(body.look)});
 if(result.status==='conflict')return c.json({success:false,code:'SAVE_CONFLICT',error:'ほかの人が保存しました。最新の設定を読み直してください。'},409);
 return c.json({success:true,data:{version:result.setting.version,look:result.setting.data}});
});
accountSettings.get('/api/account-settings/customer-look',requireRole('owner','admin','staff'),async c=>{
 const accountId=c.req.query('accountId');
 if (!accountId) return c.json({success:false,error:'店を選んでください'},400);
 if (!await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[accountId])) return c.json({success:false,error:'権限がありません'},403);
 return c.json({success:true,data:await accountCustomerLook(c.env.DB,accountId)});
});
const MAX_TEST_RECIPIENTS = 90;

accountSettings.get('/api/account-settings/allergy-options', requireRole('owner','admin','staff'), async c => {
  const accountId=c.req.query('accountId');
  if (!accountId) return inputError(c,{success:false,error:'お店を選んでください'},400,['accountId']);
  if (!await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[accountId])) return c.json({success:false,error:'このお店の設定は読めません'},403);
  return c.json({success:true,data:await accountAllergyOptions(c.env.DB,accountId)});
});
accountSettings.put('/api/account-settings/allergy-options', requireRole('owner','admin'), inputJsonBoundary(), async c => {
  const body=await c.req.json<{accountId?:string;expectedVersion?:number;options?:unknown}>();
  if (!body.accountId || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion)<0) return inputError(c,{success:false,error:'お店と保存した版を確認してください'},400,['accountId','expectedVersion']);
  if (!await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[body.accountId])) return c.json({success:false,error:'このお店の設定は変えられません'},403);
  if (!Array.isArray(body.options)) return inputError(c,{success:false,error:'選択肢を確認してください'},422,['options']);
  const checked=validateAllergyValues(body.options);
  if (!checked.ok) return inputError(c,{success:false,error:checked.error},422,['options']);
  const result=await saveVersionedAccountSetting(c.env.DB,{accountId:body.accountId,key:ALLERGY_OPTIONS_KEY,expectedVersion:body.expectedVersion!,data:checked.values});
  return result.status==='conflict' ? c.json({success:false,code:'SAVE_CONFLICT',error:'ほかの人が先に保存しました',data:result.current},409) : c.json({success:true,data:{version:result.setting.version,options:result.setting.data}});
});

// GET /api/account-settings/test-recipients?accountId=xxx
accountSettings.get('/api/account-settings/test-recipients', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');

  const row = await c.env.DB.prepare(
    `SELECT value, confirmation_revision FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId).first<{ value: string; confirmation_revision: number }>();

  const friendIds: string[] = row ? JSON.parse(row.value) : [];

  if (friendIds.length === 0) {
    return c.json({ success: true, data: [], confirmationRevision: row?.confirmation_revision ?? 0 });
  }
  const placeholders = sqlIdSet(friendIds).sql;
  const friends = await c.env.DB.prepare(
    `SELECT id, display_name, picture_url FROM friends WHERE id IN (${placeholders})`
  ).bind(...(friendIds.length ? sqlIdSet(friendIds).binds : [])).all<{ id: string; display_name: string; picture_url: string | null }>();

  return c.json({
    success: true,
    confirmationRevision: row?.confirmation_revision ?? 0,
    data: friends.results.map(f => ({
      id: f.id,
      displayName: f.display_name,
      pictureUrl: f.picture_url,
    })),
  });
});

// GET /api/account-settings/test-recipient-login-users?accountId=xxx
//
// LINE連携済みのログインユーザーを、テスト送信先の候補として返す。
// staff_membersはログイン権限、friendsは実際のLINE送信先なので、
// line_user_idで両方が一致する有効な行だけを候補にする。
accountSettings.get('/api/account-settings/test-recipient-login-users', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  const tenantId = c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;

  const result = await c.env.DB.prepare(
    `SELECT
       f.id,
       COALESCE(NULLIF(f.display_name, ''), sm.name) AS display_name,
       f.picture_url,
       sm.name AS staff_name,
       CASE WHEN f.line_account_id = ? THEN 1 ELSE 0 END AS same_account
     FROM staff_members sm
     JOIN friends f ON f.line_user_id = sm.line_user_id
       AND (
         f.line_account_id = ?
         OR NOT EXISTS (
           SELECT 1 FROM friends scoped
            WHERE scoped.line_user_id = sm.line_user_id
              AND scoped.line_account_id = ?
         ) AND (
           EXISTS (
             SELECT 1 FROM line_accounts fallback_account
              WHERE fallback_account.id = f.line_account_id
                AND COALESCE(fallback_account.tenant_id, ?) = ?
           ) OR (f.line_account_id IS NULL AND ? = ?)
         )
       )
     WHERE sm.is_active = 1
       AND COALESCE(sm.tenant_id, ?) = ?
       AND sm.line_user_id IS NOT NULL
       AND f.is_following = 1
     ORDER BY same_account DESC, sm.created_at ASC`
  // C-2bで複合一意制約へ移行したら、上のNOT EXISTSフォールバックを外す。
  // 現在は既存の別アカウント・未割当行を候補から消さず、同じ応答を保つ。
  ).bind(
    accountId,
    accountId,
    accountId,
    DEFAULT_TENANT_ID,
    tenantId,
    tenantId,
    DEFAULT_TENANT_ID,
    DEFAULT_TENANT_ID,
    tenantId,
  ).all<{
    id: string;
    display_name: string | null;
    picture_url: string | null;
    staff_name: string;
    same_account: number;
  }>();

  return c.json({
    success: true,
    data: result.results.map((row) => ({
      id: row.id,
      displayName: row.display_name || row.staff_name,
      pictureUrl: row.picture_url,
      staffName: row.staff_name,
      sameAccount: row.same_account === 1,
    })),
  });
});

// PUT /api/account-settings/test-recipients
accountSettings.put('/api/account-settings/test-recipients', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"friendIds":["array"]}), async (c) => {
  const body = await c.req.json<{ accountId: string; friendIds: string[] }>();
  if (!body.accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!Array.isArray(body.friendIds)) {
    return inputError(c, { success: false, error: 'friendIds must be an array' }, 400, ["friendIds"]);
  }
  if (body.friendIds.length > MAX_TEST_RECIPIENTS) {
    return inputError(c, { success: false, error: `friendIds must contain at most ${MAX_TEST_RECIPIENTS} items` }, 400, ["friendIds"]);
  }
  if (body.friendIds.some((friendId) => typeof friendId !== 'string' || friendId.length === 0)) {
    return inputError(c, { success: false, error: 'friendIds must contain non-empty strings' }, 400, ["friendIds"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const uniqueFriendIds = [...new Set(body.friendIds)];
  if (uniqueFriendIds.length > 0) {
    const placeholders = sqlIdSet(uniqueFriendIds).sql;
    const matchingFriends = await c.env.DB.prepare(
      `SELECT id FROM friends WHERE line_account_id = ? AND id IN (${placeholders})`
    ).bind(body.accountId, ...(uniqueFriendIds.length ? sqlIdSet(uniqueFriendIds).binds : [])).all<{ id: string }>();
    if (matchingFriends.results.length !== uniqueFriendIds.length) {
      return inputError(c, { success: false, error: 'One or more friendIds are invalid for this account' }, 400, ["accountId","friendIds"]);
    }
  }

  const id = crypto.randomUUID();
  const now = japanCalendar().toISOString().replace('Z', '+09:00');

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'test_recipients', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?, confirmation_revision = confirmation_revision + 1`
  ).bind(
    id, body.accountId, JSON.stringify(body.friendIds), now, now,
    JSON.stringify(body.friendIds), now,
  ).run();

  return c.json({ success: true });
});

// ── link_base_url (global setting, stored under sentinel '__global__') ─────────


accountSettings.get('/api/account-settings/link-base-url', async (c) => {
  const value = await getLinkBaseUrl(c.env.DB, '__global__');
  return c.json({ success: true, data: value });
});

/**
 * PUT /api/account-settings/link-base-url
 * Body: { value: string }
 * - Empty string clears the setting.
 * - Must start with https:// (if non-empty).
 * - Trailing slash is stripped before saving.
 */
accountSettings.put('/api/account-settings/link-base-url', requireRole('owner'), inputJsonBoundary(), async (c) => {
  const body = await c.req
    .json<{ value?: string }>()
    .catch((): { value?: string } => ({}));
  const value = typeof body.value === 'string' ? body.value : '';

  try {
    await setLinkBaseUrl(c.env.DB, '__global__', value);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation error';
    return inputError(c, { success: false, error: message }, 400, ["value"]);
  }
});

// 計測リンクの独自ドメインは /t/* を Worker へ向ける必要がある。未設定なら WORKER_URL を使う。

accountSettings.get('/api/account-settings/tracked-link-base-url', async (c) => {
  const value = await getTrackedLinkBaseUrl(c.env.DB, '__global__');
  return c.json({ success: true, data: value });
});

accountSettings.put('/api/account-settings/tracked-link-base-url', requireRole('owner'), inputJsonBoundary(), async (c) => {
  const body = await c.req
    .json<{ value?: string }>()
    .catch((): { value?: string } => ({}));
  const value = typeof body.value === 'string' ? body.value : '';

  try {
    await setTrackedLinkBaseUrl(c.env.DB, '__global__', value);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation error';
    return inputError(c, { success: false, error: message }, 400, ["value"]);
  }
});

export { accountSettings };
