import { folderNameConflict, inputError } from '../lib/input-errors.js';

import { getFolderById, createFolder, updateFolder, swapFolderOrder, FolderConflictError, FolderNameConflictError, deleteFolder, isFolderKind } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { getVisibleLineAccountScope } from '../services/account-access.js';
import { COLOR_PATTERN, serializeFolder, folderBoundary } from './friend-attributes-definition.js';
import type { Context } from 'hono';

export const post__api_folders_1 = async (c: Context<Env, "/api/folders">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    if (!isFolderKind(body.kind)) {
      return inputError(c, { success: false, error: '知らないフォルダの種類です' }, 400, ["kind"]);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return inputError(c, { success: false, error: 'フォルダ名を入力してください' }, 400, ["name"]);

    const integrationKind = ['automation', 'common_action', 'webhook', 'conversion', 'affiliate', 'affiliate_offer', 'mileage_reward', 'friend_add_rule'].includes(body.kind);
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    // テンプレートのフォルダはアカウント単位。accountId なしで作れるのは
    // 全アカウントを見られる人だけ（タグと同じ決まり）。画面は必ず選択中の
    // アカウントを送る。回答フォームの箱（R25）も同じく選択中のアカウントに付ける。
    if (!accountId) {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!scope.canSeeUnassigned) return inputError(c, { success: false, error: 'account_id_required' }, 400, ["accountId"]);
    }
    if (integrationKind || body.kind === 'webinar' || accountId) {
      if (!accountId) return inputError(c, { success: false, error: 'account_id_required' }, 400, ["kind","accountId"]);
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!scope.allowedAccountIds.includes(accountId)) {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }

    // 入れ子は1段まで。深くすると画面が組み立てられなくなる。
    if (body.parentId) {
      const parent = await getFolderById(c.env.DB, String(body.parentId));
      if (!parent) return inputError(c, { success: false, error: '親フォルダが見つかりません' }, 400, ["parentId"]);
      if (parent.parent_id) {
        return inputError(c, { success: false, error: 'フォルダは2段までです' }, 422, ["parentId"]);
      }
      if (parent.kind !== body.kind) {
        return inputError(c, { success: false, error: '別の種類のフォルダには入れられません' }, 422, ["parentId","kind"]);
      }
      if ((parent.account_id ?? null) !== (accountId || null)) {
        return inputError(c, { success: false, error: '親フォルダが見つかりません' }, 400, ["parentId","kind","accountId"]);
      }
    }

    // 色はフォルダに付く。既存の COLOR_PATTERN と同じ決まりで見る。
    let color: string | null = null;
    if (body.color !== undefined && body.color !== null && body.color !== '') {
      const raw = String(body.color);
      if (!COLOR_PATTERN.test(raw)) {
        return inputError(c, { success: false, error: '色は #RRGGBB の形で指定してください' }, 400, ["color"]);
      }
      color = raw;
    }

    const folder = await createFolder(c.env.DB, {
      kind: body.kind,
      name,
      parentId: body.parentId ? String(body.parentId) : null,
      displayOrder: Number(body.displayOrder ?? 0),
      color,
      accountId: accountId || null,
    });
    return c.json({ success: true, data: serializeFolder(folder) }, 201);
  } catch (err) {
    if (err instanceof FolderNameConflictError) return folderNameConflict(c);
    if (err instanceof FolderConflictError) return c.json({success:false,code:'VERSION_CONFLICT',error:'フォルダが更新されました'},409);
    throw err;
  }
};

export const patch__api_folders_id_2 = async (c: Context<Env, "/api/folders/:id">) => {
  try {
    const id = c.req.param('id');
    const existing = await getFolderById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = await c.req.json<Record<string, unknown>>();
    const access = await folderBoundary(c, existing, typeof body.accountId === 'string' ? body.accountId.trim() : c.req.query('account_id')?.trim());
    if (access) return access;
    let webinarAccountId = '';
    if (existing.kind === 'webinar') {
      webinarAccountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      if (!webinarAccountId) return inputError(c, { success: false, error: 'account_id_required' }, 400, ["accountId"]);
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!scope.allowedAccountIds.includes(webinarAccountId) || existing.account_id !== webinarAccountId) {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }
    const patch: Parameters<typeof updateFolder>[2] = {};
    if (body.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<1) return inputError(c, {success:false,error:'版を確認してください'},422,['expectedRevision']);
      patch.expectedRevision = Number(body.expectedRevision);
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return inputError(c, { success: false, error: 'フォルダ名を入力してください' }, 400, ["name"]);
      patch.name = name;
    }
    if ('parentId' in body) {
      const parentId = body.parentId ? String(body.parentId) : null;
      // 自分を自分の親にはできない。一覧の描画が無限に回る。
      if (parentId === id) {
        return inputError(c, { success: false, error: '自分自身を親にはできません' }, 422, ["parentId"]);
      }
      patch.parentId = parentId;
      if (parentId) {
        const parent = await getFolderById(c.env.DB, parentId);
        if (!parent || parent.kind !== existing.kind
          || (parent.account_id ?? null) !== (existing.account_id ?? null)) {
          return inputError(c, { success: false, error: '親フォルダが見つかりません' }, 400, ["parentId"]);
        }
        if (parent.parent_id) {
          return inputError(c, { success: false, error: 'フォルダは2段までです' }, 422, ["parentId"]);
        }
      }
    }
    if (body.displayOrder !== undefined) patch.displayOrder = Number(body.displayOrder);
    if ('color' in body) {
      const raw = body.color;
      if (raw === null || raw === '') {
        patch.color = null;
      } else {
        const value = String(raw);
        if (!COLOR_PATTERN.test(value)) {
          return inputError(c, { success: false, error: '色は #RRGGBB の形で指定してください' }, 400, ["color"]);
        }
        patch.color = value;
      }
    }

    const folder = await updateFolder(c.env.DB, id, patch);
    return c.json({ success: true, data: serializeFolder(folder!) });
  } catch (err) {
    if (err instanceof FolderNameConflictError) return folderNameConflict(c);
    if (err instanceof FolderConflictError) return c.json({success:false,code:'VERSION_CONFLICT',error:'フォルダが更新されました'},409);
    throw err;
  }
};

export const post__api_folders_id_swap_order_3 = async (c: Context<Env, "/api/folders/:id/swap-order">) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const withId = typeof body.withId === 'string' ? body.withId.trim() : '';
    if (!withId || withId === id) {
      return inputError(c, { success: false, error: '入れ替える相手のフォルダを指定してください' }, 400, ["withId"]);
    }
    const [a, b] = await Promise.all([getFolderById(c.env.DB, id), getFolderById(c.env.DB, withId)]);
    if (!a || !b) return c.json({ success: false, error: 'Not found' }, 404);
    const requested = typeof body.accountId === 'string' ? body.accountId.trim() : c.req.query('account_id')?.trim();
    for (const folder of [a, b]) {
      const access = await folderBoundary(c, folder, requested);
      if (access) return access;
    }
    if (a.kind === 'webinar') {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!requested) return inputError(c, { success: false, error: 'account_id_required' }, 400, ["accountId","account_id"]);
      if (!scope.allowedAccountIds.includes(requested) || a.account_id !== requested) {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }
    if (a.kind !== b.kind || (a.account_id ?? null) !== (b.account_id ?? null) || (a.parent_id ?? null) !== (b.parent_id ?? null)) {
      return inputError(c, { success: false, error: '同じ場所のフォルダだけ並べ替えられます' }, 400, ["a","kind","account_id","parent_id"]);
    }
    for (const [folder, revision] of [[a,body.expectedRevision],[b,body.withExpectedRevision]] as const) {
      if (revision !== undefined && revision !== folder.revision) return c.json({success:false,error:'フォルダが更新されました'},409);
    }
    await swapFolderOrder(c.env.DB, a, b);
    return c.json({ success: true, data: { swapped: [id, withId] } });
  } catch (err) {
    if (err instanceof FolderConflictError) return c.json({success:false,code:'VERSION_CONFLICT',error:'フォルダが更新されました'},409);
    throw err;
  }
};

export const delete__api_folders_id_4 = async (c: Context<Env, "/api/folders/:id">) => {
  try {
    const id = c.req.param('id');
    const existing = await getFolderById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (existing.kind === 'webinar') {
      const accountId = c.req.query('account_id')?.trim();
      if (!accountId) return c.json({ success: false, error: 'account_id_required' }, 400);
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!scope.allowedAccountIds.includes(accountId) || existing.account_id !== accountId) {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }
    const denied = await folderBoundary(c, existing, c.req.query('account_id')?.trim());
    if (denied) return denied;
    const revision = c.req.query('expectedRevision');
    if (revision !== undefined && (!Number.isSafeInteger(Number(revision)) || Number(revision)<1)) return c.json({success:false,error:'版を確認してください'},422);
    if (!(await deleteFolder(c.env.DB, id, revision === undefined ? undefined : Number(revision)))) {
      return c.json({ success: false, error: 'フォルダの店舗境界を確認してください' }, 409);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    if (err instanceof FolderConflictError) return c.json({success:false,code:'VERSION_CONFLICT',error:'フォルダが更新されました'},409);
    throw err;
  }
};
