import { deleteCustomerData, deletionJournal, DeletionFailure } from '../services/customer-data-deletion.js';
import { inputError } from '../lib/input-errors.js';
import { cleanupDeliveryOrphans } from '../services/delivery-orphan-cleanup.js';
import { logger } from '@line-crm/shared/server';

import { getFriendById, getSavedSearchById, getSavedSearches, createSavedSearch, countSavedSearches, validateSearchConditions, SAVED_SEARCH_LIMIT } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { compileSavedSearch } from '../services/saved-search-filter.js';
import { friendSavedViewAccess, serializeFriendSavedView } from './friends-definition.js';
import type { Context } from 'hono';

export const delete__api_friends_id_data_1 = async (c: Context<Env, "/api/friends/:id/data">) => {
  const id = c.req.param('id');
  try {
    const journal = await deletionJournal(c.env.DB, 'friend_data', id);
    if (journal && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [journal.detail.accountId])) return c.json({ success: false, error: '友だちが見つかりません' }, 404);
    if (journal?.action === 'deleted') return c.json({ success: true, data: { deleted: true, replayed: true } });
    const friend = await getFriendById(c.env.DB, id);
    const accountId = friend ? (friend as unknown as { line_account_id: string | null }).line_account_id : null;
    if (!friend || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) return c.json({ success: false, error: '友だちが見つかりません' }, 404);
    const data = await deleteCustomerData(c.env, { kind: 'friend_data', id, friendId: id, accountId, lineUserId: friend.line_user_id }, c.get('staff')!.id);
    try { await cleanupDeliveryOrphans(c.env.DB); } catch { logger.error('delivery_orphan_cleanup.failed'); }
    return c.json({ success: true, data });
  } catch (error) {
    if (error instanceof DeletionFailure && error.code === 'deletion_schema_approval_required') return c.json({ success: false, code: error.code, error: '支払・監査の記録を残すため、データ構造の変更承認が必要です。オーナーか管理者に頼んでください。' }, 409);
    if (error instanceof DeletionFailure) return c.json({ success: false, code: error.code, error: error.status === 409 ? '削除中です。少し待ってから、もう一度お試しください。' : '削除を完了できませんでした。同じ友だちで、もう一度削除してください。' }, error.status);
    return c.json({ success: false, code: 'deletion_retry_required', error: '削除を完了できませんでした。同じ友だちで、もう一度削除してください。' }, 503);
  }
};

export const get__api_friends_saved_views_2 = async (c: Context<Env, "/api/friends/saved-views">) => {
  try {
    const access = await friendSavedViewAccess(c);
    if (access instanceof Response) return access;
    const id = c.req.query('id')?.trim();
    if (id) {
      const row = await getSavedSearchById(c.env.DB, id, access.lineAccountId);
      if (!row || row.scope !== 'friends' || (row.condition_format ?? 'search_v1') !== 'search_v1'
          || (!access.canManageAll && !row.is_shared && row.created_by !== access.staffId)) {
        return c.json({ success: false, error: '保存した検索が見つかりません' }, 404);
      }
      return c.json({ success: true, data: await serializeFriendSavedView(c.env.DB, row) });
    }
    const rows = await getSavedSearches(c.env.DB, 'friends', access, 'search_v1');
    const items = await Promise.all(rows.map((row) => serializeFriendSavedView(c.env.DB, row)));
    return c.json({ success: true, data: { items, total: items.length } });
  } catch (error) {
    throw error;
  }
};

export const post__api_friends_saved_views_3 = async (c: Context<Env, "/api/friends/saved-views">) => {
  try {
    const access = await friendSavedViewAccess(c);
    if (access instanceof Response) return access;
    const body = await c.req.json<Record<string, unknown>>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) {
      return inputError(c, { success: false, error: '名前は1文字以上40文字以内で入力してください' }, 422, ["name"]);
    }
    if (body.isShared === true && !access.canManageAll) {
      return c.json({ success: false, error: '共有の検索を作る権限がありません' }, 403);
    }
    const validated = validateSearchConditions(body.conditions);
    if (!validated.ok) return inputError(c, { success: false, error: validated.error }, 422, ["conditions"]);
    const compiled = compileSavedSearch(validated.value);
    if (!compiled.ok) return inputError(c, { success: false, error: compiled.error }, 422, ["conditions"]);
    const duplicate = await c.env.DB.prepare(
      `SELECT id FROM saved_searches
        WHERE scope = 'friends' AND condition_format = 'search_v1'
          AND line_account_id = ? AND created_by = ?
          AND lower(trim(name)) = lower(trim(?))
        LIMIT 1`,
    ).bind(access.lineAccountId, access.staffId, name).first<{ id: string }>();
    if (duplicate) {
      return c.json({ success: false, error: '同じ名前の保存した検索があります' }, 409);
    }
    const count = await countSavedSearches(c.env.DB, {
      scope: 'friends',
      conditionFormat: 'search_v1',
      createdBy: access.staffId,
      lineAccountId: access.lineAccountId,
    });
    if (count >= SAVED_SEARCH_LIMIT) {
      return inputError(c, { success: false, error: `保存できる検索は${SAVED_SEARCH_LIMIT}件までです` }, 422, []);
    }
    const saved = await createSavedSearch(c.env.DB, {
      name,
      scope: 'friends',
      conditionFormat: 'search_v1',
      conditions: validated.value,
      createdBy: access.staffId,
      lineAccountId: access.lineAccountId,
      isShared: body.isShared === true,
    });
    return c.json({ success: true, data: await serializeFriendSavedView(c.env.DB, saved) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique/i.test(message)) {
      return c.json({ success: false, error: '同じ名前の保存した検索があります' }, 409);
    }
    if (error instanceof SyntaxError) {
      return inputError(c, { success: false, error: '送信内容のJSONが正しくありません' }, 400, []);
    }
    throw error;
  }
};
