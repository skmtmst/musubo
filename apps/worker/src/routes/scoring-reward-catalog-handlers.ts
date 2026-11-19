import { getEcMileageFriends, resolveMileageSource } from '../services/mileage-ec-source.js';
import { blockEcMileageWrite } from '../services/mileage-write-guard.js';
import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { recordAuditEvent } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { listMileageRewardFolders, createMileageRewardFolder, reorderMileageRewardFolders, moveMileageRewardToFolder, getMileageAdminHistory, getMileageEarningRulesV6, getMileageFriendsV6, getMileageRewardReachMetrics, saveMileageEarningRuleDraft, getActionScoreOverview, createMileageRewardDraft, createMileageRewardDraftFromPublished, getMileageReward, getMileageRewardAdminOverview, getMileageRedemption, isMileageRefundComplete, listMileageRedemptions, refundMileageRewardRedemption, importMileageRewardCodes, publishMileageReward, reorderMileageEarningRules, reorderMileageRewards, reserveMileageRewardRedemption, setMileageRewardStatus, encryptCredential, MileageRewardError } from '@line-crm/db';
import type { MileageRedemptionListStatus, MileageRewardDraftInput } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';

import { getVisibleLineAccountScope } from '../services/account-access.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { sha256Hex } from '../middleware/auth.js';
import { deliverMileageReward } from '../features/mileage/mileage-reward-delivery/index.js';
import { canUseMileageAccount, mileageCsvCell, mileageRewardError, publicMileageRedemption, MILEAGE_REDEMPTION_LIST_STATUSES, mileageV6Error } from './scoring-definition.js';
import type { Context, Next } from 'hono';

export const post__api_mileage_exports_1 = async (c: Context<Env, "/api/mileage/exports">, next: Next) => {
  const staff = c.get('staff');
  if (!staff || staff.readOnly || staff.role === 'staff' || (staff.role !== 'owner' && !staff.permissionKeys?.some(key => ['mileage.ledger.export','action_score.list.export'].includes(key)))) return c.json({ success: false, error: 'CSVを書き出す権限がありません' }, 403);
  return next();
};

export const post__api_mileage_exports_2 = async (c: Context<Env, "/api/mileage/exports">) => {
  try {
    const body = await c.req.json<{ accountId?: string; kind?: string; reason?: string }>();
    const accountId = body.accountId?.trim() ?? '';
    if (!accountId || !await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: '対象のアカウントが見つかりません' }, 404);
    if (!body.reason?.trim() || body.reason.length > 300) return inputError(c, { success: false, error: '書き出す理由を300字以内で入力してください' }, 400, ['reason']);
    const kind = body.kind;
    const staffForExport = c.get('staff');
    if (staffForExport.role !== 'owner' && !staffForExport.permissionKeys?.includes(kind === 'scores' ? 'action_score.list.export' : 'mileage.ledger.export')) return c.json({ success: false, error: 'CSVを書き出す権限がありません' }, 403);
    if (!['balances', 'history', 'rewards', 'scores'].includes(kind ?? '')) return inputError(c, { success: false, error: '書き出す種類を指定してください' }, 400, ['kind']);
    const rows: Record<string, unknown>[] = [];
    if (kind === 'rewards') rows.push(...(await getMileageRewardAdminOverview(c.env.DB, accountId)).rewards.map(row => ({ ...row })));
    else {
      let offset = 0;
      while (true) {
        const result = kind === 'balances'
          ? await getMileageFriendsV6(c.env.DB, { lineAccountId: accountId, visibleAccountIds: [accountId], search: '', limit: 100, offset })
          : kind === 'history'
            ? await getMileageAdminHistory(c.env.DB, { accountId, visibleAccountIds: [accountId], limit: 100, offset })
            : await getActionScoreOverview(c.env.DB, { accountId, limit: 100, offset });
        rows.push(...result.items as unknown as Record<string, unknown>[]);
        offset += result.items.length;
        if (result.items.length === 0 || offset >= result.pagination.total) break;
      }
    }
    const columns: Array<[string, string]> = kind === 'balances'
      ? [['friendId','友だちID'],['displayName','名前'],['available','利用可能マイル'],['pending','確定待ち'],['lastChangedAt','更新日時']]
      : kind === 'history'
        ? [['id','記録ID'],['displayName','名前'],['amount','マイル'],['reason','理由'],['occurredAt','日時']]
        : kind === 'scores'
          ? [['friendId','友だちID'],['displayName','名前'],['currentScore','スコア'],['lastReason','理由'],['lastChangedAt','更新日時']]
          : [['id','使い道ID'],['name','名前'],['status','状態'],['requiredMiles','必要マイル']];
    const csv = '\uFEFF' + [columns.map(([,label])=>label), ...rows.map(row=>columns.map(([key])=>row[key]))]
      .map(row=>row.map(mileageCsvCell).join(',')).join('\r\n') + '\r\n';
    const staff = c.get('staff');
    await recordAuditEvent(c.env.DB, { tenantId: staff?.tenantId, lineAccountId: accountId,
      category: 'business', actorPrincipalId: staff?.id, actorRole: staff?.role ?? 'unknown',
      action: kind === 'scores' ? 'action_score.list.export' : 'mileage.ledger.export',
      targetKind: kind!, targetId: accountId, result: 'success', reason: body.reason.trim() });
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}.csv"`, 'Cache-Control': 'no-store' } });
  } catch (error) { throw error; }
};

export const get__api_mileage_reward_folders_3 = async (c: Context<Env, "/api/mileage/reward-folders">) => {
  try {
    const accountId = c.req.query('accountId')?.trim() ?? '';
    if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: await listMileageRewardFolders(c.env.DB, accountId) });
  } catch (error) { return mileageRewardError(c, error); }
};

export const post__api_mileage_reward_folders_4 = async (c: Context<Env, "/api/mileage/reward-folders">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; name?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
    if (typeof body.name !== 'string') return inputError(c, { success: false, error: 'フォルダ名を入力してください' }, 422, ["name"]);
    return c.json({ success: true, data: await createMileageRewardFolder(c.env.DB, accountId, body.name) }, 201);
  } catch (error) { return mileageRewardError(c, error); }
};

export const put__api_mileage_reward_folders_order_5 = async (c: Context<Env, "/api/mileage/reward-folders/order">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; ids?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) return inputError(c, { success: false, error: 'フォルダの順番を指定してください' }, 422, ["ids"]);
    await reorderMileageRewardFolders(c.env.DB, accountId, body.ids);
    return c.json({ success: true, data: await listMileageRewardFolders(c.env.DB, accountId) });
  } catch (error) { return mileageRewardError(c, error); }
};

export const put__api_mileage_rewards_id_folder_6 = async (c: Context<Env, "/api/mileage/rewards/:id/folder">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; folderId?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
    if (body.folderId !== null && (typeof body.folderId !== 'string' || !body.folderId)) return inputError(c, { success: false, error: 'フォルダか未分類を指定してください' }, 422, ["folderId"]);
    await moveMileageRewardToFolder(c.env.DB, accountId, c.req.param('id'), body.folderId);
    return c.json({ success: true, data: await getMileageReward(c.env.DB, { id: c.req.param('id'), lineAccountId: accountId }) });
  } catch (error) { return mileageRewardError(c, error); }
};

export const get__api_mileage_rewards_7 = async (c: Context<Env, "/api/mileage/rewards">) => {
  try {
    const accountId = c.req.query('accountId')?.trim() ?? '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const [overview, reachMetrics] = await Promise.all([
      getMileageRewardAdminOverview(c.env.DB, accountId),
      getMileageRewardReachMetrics(c.env.DB, accountId),
    ]);
    return c.json({
      success: true,
      data: {
        ...overview,
        reachMetrics,
        rankBenefits: reachMetrics.filter((item) => item.rewardKind === 'rank'),
        measuredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const get__api_mileage_rewards_id_8 = async (c: Context<Env, "/api/mileage/rewards/:id">) => {
  try {
    const accountId = c.req.query('accountId')?.trim() ?? '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const reward = await getMileageReward(c.env.DB, { id: c.req.param('id'), lineAccountId: accountId });
    if (!reward) return c.json({ success: false, error: '使い道が見つかりません' }, 404);
    return c.json({ success: true, data: reward });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_9 = async (c: Context<Env, "/api/mileage/rewards">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; draft?: MileageRewardDraftInput }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    if (!body.draft) return inputError(c, { success: false, error: '使い道の内容を入力してください' }, 400, ["draft"]);
    const reward = await createMileageRewardDraft(c.env.DB, {
      lineAccountId: accountId,
      createdBy: c.get('staff').id,
      draft: body.draft,
    });
    auditLog(c, 'mileage.reward.create', { kind: 'mileage_reward', id: reward.id });
    return c.json({ success: true, data: reward }, 201);
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_id_draft_10 = async (c: Context<Env, "/api/mileage/rewards/:id/draft">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const reward = await createMileageRewardDraftFromPublished(c.env.DB, {
      id: c.req.param('id'), lineAccountId: accountId, createdBy: c.get('staff').id,
    });
    return c.json({ success: true, data: reward }, 201);
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_id_publish_11 = async (c: Context<Env, "/api/mileage/rewards/:id/publish">) => {
    try {
      const body = await c.req.json<{
        accountId?: unknown;
        expectedVersionId?: unknown;
        expectedRevision?: unknown;
      }>();
      const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      const expectedVersionId = typeof body.expectedVersionId === 'string'
        && body.expectedVersionId.trim() ? body.expectedVersionId.trim() : null;
      const expectedRevision = typeof body.expectedRevision === 'number'
        && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 1
        ? body.expectedRevision
        : null;
      if (!await canUseMileageAccount(c, accountId)) {
        return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
      }
      const reward = await publishMileageReward(c.env.DB, {
        id: c.req.param('id'), lineAccountId: accountId, publishedBy: c.get('staff').id,
        expectedVersionId, expectedRevision,
      });
      auditLog(c, 'mileage.reward.publish', { kind: 'mileage_reward', id: reward.id });
      return c.json({ success: true, data: reward });
    } catch (error) {
      return mileageRewardError(c, error);
    }
  };

export const post__api_mileage_rewards_id_test_12 = async (c: Context<Env, "/api/mileage/rewards/:id/test">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const reward = await getMileageReward(c.env.DB, { id: c.req.param('id'), lineAccountId: accountId });
    if (!reward?.currentVersion) {
      return c.json({ success: false, error: '使い道が見つかりません' }, 404);
    }
    const canDeliver = reward.rewardKind !== 'coupon' || (reward.availableCodeCount ?? 0) > 0;
    return c.json({
      success: true,
      data: {
        rewardId: reward.id,
        versionId: reward.currentVersion.id,
        requiredMiles: reward.currentVersion.requiredMiles,
        canDeliver,
        warning: canDeliver ? null : '交換コードを1件以上登録してください',
        ledgerChanged: false,
      },
    });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_id_stop_13 = async (c: Context<Env, "/api/mileage/rewards/:id/stop">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const reward = await setMileageRewardStatus(c.env.DB, {
      id: c.req.param('id'), lineAccountId: accountId, status: 'stopped',
    });
    auditLog(c, 'mileage.reward.status', { kind: 'mileage_reward', id: reward.id });
    return c.json({ success: true, data: reward });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_id_status_14 = async (c: Context<Env, "/api/mileage/rewards/:id/status">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; status?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const status = body.status === 'published' || body.status === 'stopped' || body.status === 'archived'
      ? body.status
      : null;
    if (!status) return inputError(c, { success: false, error: '状態を確認してください' }, 400, ["status"]);
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const reward = await setMileageRewardStatus(c.env.DB, {
      id: c.req.param('id'), lineAccountId: accountId, status,
    });
    auditLog(c, 'mileage.reward.status', { kind: 'mileage_reward', id: reward.id });
    return c.json({ success: true, data: reward });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const put__api_mileage_rewards_order_15 = async (c: Context<Env, "/api/mileage/rewards-order">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; ids?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const ids = Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')
      ? body.ids as string[]
      : [];
    await reorderMileageRewards(c.env.DB, { lineAccountId: accountId, ids });
    return c.json({ success: true, data: null });
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_rewards_id_codes_16 = async (c: Context<Env, "/api/mileage/rewards/:id/codes">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; codes?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const codes = Array.isArray(body.codes)
      ? [...new Set(body.codes.filter((code): code is string => typeof code === 'string')
        .map((code) => code.trim()).filter(Boolean))]
      : [];
    if (!codes.length || codes.length > 10_000) {
      return inputError(c, { success: false, error: '交換コードは1〜10,000件で登録してください' }, 400, ["codes"]);
    }
    const protectedCodes = await Promise.all(codes.map(async (code) => ({
      ciphertext: await encryptCredential(code, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY),
      fingerprint: await sha256Hex(code),
    })));
    const result = await importMileageRewardCodes(c.env.DB, {
      rewardId: c.req.param('id'), lineAccountId: accountId, codes: protectedCodes,
    });
    auditLog(c, 'mileage.reward.codes.import', { kind: 'mileage_reward', id: c.req.param('id') });
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    return mileageRewardError(c, error);
  }
};

export const post__api_mileage_redemptions_17 = async (c: Context<Env, "/api/mileage/redemptions">) => {
    try {
      const body = await c.req.json<{
        accountId?: unknown;
        friendId?: unknown;
        rewardId?: unknown;
      }>();
      const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      const friendId = typeof body.friendId === 'string' ? body.friendId.trim() : '';
      const rewardId = typeof body.rewardId === 'string' ? body.rewardId.trim() : '';
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
      if (!friendId || !rewardId || !isValidIdempotencyKey(idempotencyKey)) {
        return inputError(c, { success: false, error: '友だち、使い道、処理IDを確認してください' }, 400, ["friendId","rewardId","requestId"]);
      }
      if (!await canUseMileageAccount(c, accountId)) {
        return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
      }
      const blocked = await blockEcMileageWrite(c, accountId);
      if (blocked) return blocked;
      const requestFingerprint = await sha256Hex(`${accountId}\n${friendId}\n${rewardId}`);
      const reserved = await reserveMileageRewardRedemption(c.env.DB, {
        lineAccountId: accountId,
        friendId,
        rewardId,
        idempotencyKey,
        requestFingerprint,
      });
      const delivery = await deliverMileageReward(c.env.DB, reserved.redemption.id, {
        credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
      });
      auditLog(c, 'mileage.redemption.create', {
        kind: 'mileage_redemption', id: reserved.redemption.id,
      });
      return c.json({
        success: delivery.status === 'succeeded' || delivery.status === 'pending',
        data: {
          replayed: reserved.kind === 'existing',
          redemption: publicMileageRedemption(reserved.redemption),
          delivery,
        },
      }, delivery.status === 'succeeded' ? 201 : 202);
    } catch (error) {
      return mileageRewardError(c, error);
    }
  };

export const get__api_mileage_redemptions_18 = async (c: Context<Env, "/api/mileage/redemptions">) => {
    try {
      const accountId = c.req.query('accountId')?.trim() ?? '';
      if (!await canUseMileageAccount(c, accountId)) {
        return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
      }
      const statusValue = c.req.query('status')?.trim() || 'needs_attention';
      if (!MILEAGE_REDEMPTION_LIST_STATUSES.has(statusValue)) {
        return c.json({ success: false, error: 'status is invalid' }, 400);
      }
      const { limit: requestedLimit, offset: requestedOffset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 20, limitPolicy: { fallback: 'finite', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'finite', minimum: 0 } });
      const listed = await listMileageRedemptions(c.env.DB, {
        lineAccountId: accountId,
        status: statusValue as MileageRedemptionListStatus,
        limit: requestedLimit,
        offset: requestedOffset,
      });
      return c.json({
        success: true,
        data: buildOffsetListResponse({ items: listed.items.map((item) => publicMileageRedemption(item)),
          pagination: listed.pagination, total: listed.pagination.total, paging: { limit: listed.pagination.limit, offset: listed.pagination.offset }, sort: [{ field: 'updatedAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] }),
      });
    } catch (error) {
      return mileageRewardError(c, error);
    }
  };

export const get__api_mileage_redemptions_id_19 = async (c: Context<Env, "/api/mileage/redemptions/:id">) => {
    try {
      const accountId = c.req.query('accountId')?.trim() ?? '';
      if (!await canUseMileageAccount(c, accountId)) {
        return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
      }
      const redemption = await getMileageRedemption(c.env.DB, c.req.param('id'));
      if (!redemption || redemption.lineAccountId !== accountId) {
        return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
      }
      return c.json({ success: true, data: publicMileageRedemption(redemption) });
    } catch (error) {
      return mileageRewardError(c, error);
    }
  };

export const post__api_mileage_redemptions_id_retry_fulfillment_20 = async (c: Context<Env, "/api/mileage/redemptions/:id/retry-fulfillment">) => {
    try {
      const body = await c.req.json<{ accountId?: unknown }>();
      const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      if (!await canUseMileageAccount(c, accountId)) {
        return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
      }
      const redemption = await getMileageRedemption(c.env.DB, c.req.param('id'));
      if (!redemption || redemption.lineAccountId !== accountId) {
        return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
      }
      const blocked = await blockEcMileageWrite(c, accountId);
      if (blocked) return blocked;
      /*
       * 失敗中と配送中だけやり直せる。成功済み・返金済みの再実行は
       * 二重特典の素、予約中の再実行は最初の配送と競合するので断る。
       * 配送中（照合待ち）のやり直しも受け付けるが、送ったか
       * 確かめられない手順は送り直さず照合待ちに残す。
       * やり直しは同じ交換IDを続け、残高の減算はしない
       * (deliverMileageReward は予約時の減算に触らない)。
       *
       * 返却確定後に書き込みが中断した交換だけは例外。
       * 台帳なしの refunded は残高が戻っていない取り残しなので、
       * 欠けた書き込みを足して202で返す。書き込み済みの refunded は
       * 従来どおり409で断る（二重返却なし）。
       */
      if (redemption.status === 'refunded') {
        if (await isMileageRefundComplete(c.env.DB, redemption.id)) {
          return c.json({
            success: false,
            error: '失敗中・配送中の交換だけやり直せます',
            code: 'redemption_not_retryable',
          }, 409);
        }
        try {
          await refundMileageRewardRedemption(c.env.DB, {
            redemptionId: redemption.id,
            reason: '中断した返却の再開',
          });
        } catch (error) {
          if (!(error instanceof MileageRewardError && error.code === 'already_delivered')) {
            throw error;
          }
        }
        auditLog(c, 'mileage.redemption.retry', { kind: 'mileage_redemption', id: redemption.id });
        const resumed = await deliverMileageReward(c.env.DB, redemption.id, {
          credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        });
        const fresh = await getMileageRedemption(c.env.DB, redemption.id);
        const resumedData = { ...resumed, redemption: publicMileageRedemption(fresh ?? redemption) };
        return c.json({ success: resumed.status === 'succeeded', data: resumedData },
          resumed.status === 'succeeded' ? 200 : 202);
      }
      if (redemption.status !== 'delivery_failed' && redemption.status !== 'delivering') {
        return c.json({
          success: false,
          error: '失敗中・配送中の交換だけやり直せます',
          code: 'redemption_not_retryable',
        }, 409);
      }
      const delivery = await deliverMileageReward(c.env.DB, redemption.id, {
        credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
      });
      auditLog(c, 'mileage.redemption.retry', { kind: 'mileage_redemption', id: redemption.id });
      /*
       * 配送成否だけでなく交換の今の状態も返す。返却が完了したら
       * 画面は返却済みとして案内し、古い再試行の行を外せる。
       */
      const fresh = await getMileageRedemption(c.env.DB, redemption.id);
      const data = { ...delivery, redemption: publicMileageRedemption(fresh ?? redemption) };
      return c.json({ success: delivery.status === 'succeeded' || delivery.status === 'pending', data },
        delivery.status === 'succeeded' ? 200 : 202);
    } catch (error) {
      return mileageRewardError(c, error);
    }
  };

export const get__api_mileage_friends_21 = async (c: Context<Env, "/api/mileage/friends">) => {
  try {
    const accountId = c.req.query('accountId')?.trim() ?? '';
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    const accountScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (!accountScope.allowedAccountIds.includes(accountId)) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const { limit: requestedLimit, offset: requestedOffset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 20, limitPolicy: { fallback: 'finite', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'finite', minimum: 0 } });
    const input = {
      lineAccountId: accountId,
      visibleAccountIds: accountScope.allowedAccountIds,
      search: c.req.query('search')?.trim() ?? '',
      friendId: c.req.query('friendId')?.trim() || undefined,
      limit: requestedLimit,
      offset: requestedOffset,
    };
    const source = await resolveMileageSource(c.env.DB, accountId);
    if (source === 'ec') {
      const data = await getEcMileageFriends(c.env.DB, input);
      return c.json({ success: true, data: buildOffsetListResponse({ ...data, total: data.pagination.total, paging: { limit: data.pagination.limit, offset: data.pagination.offset }, sort: [{ field: 'available', direction: 'desc' }, { field: 'displayName', direction: 'asc' }, { field: 'friendId', direction: 'asc' }] }) });
    }
    const data = await getMileageFriendsV6(c.env.DB, input);
    return c.json({ success: true, data: buildOffsetListResponse({ ...data, balanceSource: 'musubo' as const, total: data.pagination.total, paging: { limit: data.pagination.limit, offset: data.pagination.offset }, sort: [{ field: 'available', direction: 'desc' }, { field: 'displayName', direction: 'asc' }, { field: 'friendId', direction: 'asc' }] }) });
  } catch (error) {
    return mileageV6Error(c, error);
  }
};

export const get__api_mileage_earning_rules_22 = async (c: Context<Env, "/api/mileage/earning-rules">) => {
  try {
    const accountId = c.req.query('accountId')?.trim() ?? '';
    if (!await canUseMileageAccount(c, accountId)) {
      return inputError(c, { success: false, error: 'LINE account not found' }, accountId ? 404 : 400, []);
    }
    const { limit: requestedLimit, offset: requestedOffset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 20, limitPolicy: { fallback: 'finite', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'finite', minimum: 0 } });
    const data = await getMileageEarningRulesV6(c.env.DB, {
      lineAccountId: accountId,
      limit: requestedLimit,
      offset: requestedOffset,
    });
    return c.json({ success: true, data: buildOffsetListResponse({ ...data, total: data.pagination.total, paging: { limit: data.pagination.limit, offset: data.pagination.offset }, sort: [{ field: 'sortOrder', direction: 'asc' }, { field: 'createdAt', direction: 'asc' }, { field: 'id', direction: 'asc' }] }) });
  } catch (error) {
    return mileageV6Error(c, error);
  }
};

export const put__api_mileage_earning_rules_order_23 = async (c: Context<Env, "/api/mileage/earning-rules-order">) => {
  try {
    const body = await c.req.json<{ accountId?: unknown; ids?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    const ids = Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')
      ? body.ids as string[]
      : [];
    await reorderMileageEarningRules(c.env.DB, {
      lineAccountId: accountId,
      ids,
      updatedByStaffId: c.get('staff').id,
    });
    auditLog(c, 'mileage.rule.update', { kind: 'mileage_rule' }, { lineAccountId: accountId });
    return c.json({ success: true, data: null });
  } catch (error) {
    return mileageV6Error(c, error);
  }
};

export const patch__api_mileage_earning_rules_id_draft_24 = async (c: Context<Env, "/api/mileage/earning-rules/:id/draft">) => {
  try {
    type Body = { accountId?: unknown; expectedVersion?: unknown; draft?: unknown };
    const body = await c.req.json<Body>().catch((): Body => ({}));
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) {
      return inputError(c, { success: false, error: 'LINE account not found' }, accountId ? 404 : 400, []);
    }
    const expectedVersion = body.expectedVersion === null || body.expectedVersion === undefined
      ? null
      : Number(body.expectedVersion);
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
      return inputError(c, { success: false, error: 'expectedVersion is invalid' }, 400, ["expectedVersion"]);
    }
    const data = await saveMileageEarningRuleDraft(c.env.DB, {
      ruleId: c.req.param('id'),
      lineAccountId: accountId,
      expectedVersion,
      draft: body.draft,
      updatedByStaffId: c.get('staff').id,
    });
    auditLog(c, 'mileage.rule.update', {
      kind: 'mileage_rule', id: c.req.param('id'),
    });
    return c.json({ success: true, data });
  } catch (error) {
    return mileageV6Error(c, error);
  }
};
