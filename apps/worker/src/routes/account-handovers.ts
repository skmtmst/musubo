import { logger } from '@line-crm/shared/server';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  cancelHandover,
  compareProviders,
  completeHandover,
  countsAddUp,
  getHandoverById,
  issueHandoverCode,
  linkHandover,
  listDecisions,
  listHandoversForAccount,
  markExecuting,
  markResolved,
  rollbackDeadlineOf,
  rollbackHandover,
  saveDecision,
  savePreview,
  unresolvedReviewCount,
  MATCH_BUCKETS,
  type HandoverRow,
  type MatchBucket,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { moveHandoverFriend } from '../services/account-handover-move.js';

/**
 * LINEアカウントの乗り換え（引き継ぎ）。設計 ★33-4（`nx3XW`）。台帳。
 *
 * 5段の流れ。
 *   1 引き継ぎコードを出す   POST /api/account-handovers
 *   2 受け取り先で読む       POST /api/account-handovers/link
 *   3 事前確認               POST /api/account-handovers/:id/preview
 *   4 競合の判断             PUT  /api/account-handovers/:id/decisions
 *   5 本実行と照合           POST /api/account-handovers/:id/execute
 *   6 切り戻し（7日以内）    POST /api/account-handovers/:id/rollback
 *
 * **事前確認だけでは元のアカウントを何も変えない。**
 * 段3が触るのは `account_handovers` の数の列だけで、`friends` には書かない。
 */
const accountHandovers = new Hono<Env>();

function serialize(row: HandoverRow) {
  return {
    id: row.id,
    confirmationRevision: row.confirmation_revision,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    code: row.code,
    codeExpiresAt: row.code_expires_at,
    status: row.status,
    providerMatch: row.provider_match,
    /*
      **数はまとめて出すか、まとめて出さないか。** 片方だけ出すと、
      画面が「合計が合わない」と読む。事前確認が終わるまでは全部 null。
    */
    counts:
      row.source_friend_total === null
        ? null
        : {
            sourceTotal: row.source_friend_total,
            auto: row.auto_count ?? 0,
            review: row.review_count ?? 0,
            unmatched: row.unmatched_count ?? 0,
            lookalike: row.lookalike_count ?? 0,
          },
    movedCount: row.moved_count,
    failedCount: row.failed_count,
    failureReason: row.failure_reason,
    // 移し元システム側の申告件数と、切り戻しの期限・記録（X-3）。
    declaredFriendTotal: row.declared_friend_total ?? null,
    rollbackDeadline: rollbackDeadlineOf(row),
    rolledBackAt: row.rolled_back_at ?? null,
    rolledBackBy: row.rolled_back_by ?? null,
    rollbackNote: row.rollback_note ?? null,
    createdAt: row.created_at,
    linkedAt: row.linked_at,
    previewedAt: row.previewed_at,
    resolvedAt: row.resolved_at,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
  };
}

/** 見られる引き継ぎだけを返す。**片方のアカウントだけ見えても通さない。** */
async function loadAccessible(
  db: D1Database,
  staff: Parameters<typeof canAccessAllLineAccounts>[1],
  id: string,
): Promise<HandoverRow | null> {
  const handover = await getHandoverById(db, id);
  if (!handover) return null;
  const ids = [handover.from_account_id, handover.to_account_id].filter(
    (v): v is string => typeof v === 'string',
  );
  if (!(await canAccessAllLineAccounts(db, staff, ids))) return null;
  return handover;
}

/** 段1。引き継ぎコードを出す。 */
accountHandovers.post('/api/account-handovers', requireRole('owner', 'admin'), inputJsonBoundary({"fromAccountId":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ fromAccountId?: string }>();
    if (!body.fromAccountId) {
      return inputError(c, { success: false, error: 'fromAccountId が要ります' }, 400, ["fromAccountId"]);
    }
    if (!(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.fromAccountId]))) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const staff = c.get('staff');
    const handover = await issueHandoverCode(c.env.DB, {
      fromAccountId: body.fromAccountId,
      createdBy: staff?.id ?? null,
    });
    return c.json({ success: true, data: serialize(handover) }, 201);
  } catch (err) {
    throw err;
  }
});

/** 段2。受け取り先でコードを読む。 */
accountHandovers.post('/api/account-handovers/link', requireRole('owner', 'admin'), inputJsonBoundary({"code":["string"],"toAccountId":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ code?: string; toAccountId?: string }>();
    if (!body.code || !body.toAccountId) {
      return inputError(c, { success: false, error: 'code と toAccountId が要ります' }, 400, ["code","toAccountId"]);
    }
    if (!(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.toAccountId]))) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    /*
      プロバイダーが同じか。**LINE は返さないので、こちらに入っている値で見る。**
      どちらかが未入力なら unknown。同じだと決めつけない。
    */
    const rows = await c.env.DB.prepare(
      `SELECT id, provider_id FROM line_accounts WHERE id IN (
         SELECT from_account_id FROM account_handovers WHERE code = ?
       ) OR id = ?`,
    )
      .bind(body.code, body.toAccountId)
      .all<{ id: string; provider_id: string | null }>();
    const toProvider = rows.results.find((r) => r.id === body.toAccountId)?.provider_id ?? null;
    const fromProvider = rows.results.find((r) => r.id !== body.toAccountId)?.provider_id ?? null;

    const linked = await linkHandover(c.env.DB, {
      code: body.code,
      toAccountId: body.toAccountId,
      providerMatch: compareProviders(fromProvider, toProvider),
    });
    if (!linked.ok) return inputError(c, { success: false, error: linked.error }, 422, ["code","toAccountId"]);
    return c.json({ success: true, data: serialize(linked.handover) });
  } catch (err) {
    throw err;
  }
});

accountHandovers.get('/api/account-handovers/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        ...serialize(handover),
        decisions: await listDecisions(c.env.DB, handover.id),
        unresolvedReviews: await unresolvedReviewCount(c.env.DB, handover.id),
      },
    });
  } catch (err) {
    throw err;
  }
});

accountHandovers.get('/api/line-accounts/:id/handovers', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const accountId = c.req.param('id');
    if (!(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId]))) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const rows = await listHandoversForAccount(c.env.DB, accountId);
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    throw err;
  }
});

/**
 * 段3。事前確認。
 *
 * **合計が合わない結果は受け取らない。** 受け取ると画面がそれを出し、
 * 運用者は「どこかの人が消えた」と読む。
 * **ここでは `friends` に一切書かない**（設計の「ここで止めても、元の
 * アカウントは何も変わりません」）。
 */
accountHandovers.post('/api/account-handovers/:id/preview', requireRole('owner', 'admin'), inputJsonBoundary({"sourceFriendTotal":["number"],"counts":["object"],"declaredFriendTotal":["null","number"]}), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    if (!handover.to_account_id) {
      return inputError(c, { success: false, error: '受け取り先がまだ決まっていません' }, 422, []);
    }
    const body = await c.req.json<{
      sourceFriendTotal?: number;
      counts?: Record<string, number>;
      declaredFriendTotal?: number | null;
    }>();
    const total = body.sourceFriendTotal;
    const counts = body.counts;
    if (typeof total !== 'number' || !counts) {
      return inputError(c, { success: false, error: 'sourceFriendTotal と counts が要ります' }, 400, ["sourceFriendTotal","counts"]);
    }
    for (const bucket of MATCH_BUCKETS) {
      if (typeof counts[bucket] !== 'number') {
        return inputError(c, { success: false, error: `${bucket} の人数が要ります` }, 400, ["counts"]);
      }
    }
    const value = {
      auto: counts.auto,
      review: counts.review,
      unmatched: counts.unmatched,
      lookalike: counts.lookalike,
    };
    if (!countsAddUp(value, total)) {
      return inputError(c, { success: false, error: '区分の合計が元の友だち数と合いません' }, 422, ["counts","sourceFriendTotal"]);
    }
    /*
      **申告の人数をうのみにしない。** 画面の表示数・手作り呼び出しが
      そのまま「事前確認の結果」として残るのを、元の友だち数を
      数え直して防ぐ。合わなければ確認のやり直しを求める。
    */
    const actual = await c.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ?',
    ).bind(handover.from_account_id).first<{ count: number }>();
    const actualTotal = actual?.count ?? 0;
    if (total !== actualTotal) {
      return inputError(c, { success: false, error: `元の友だち数が変わっています（今は${actualTotal}人）。事前確認をやり直してください` }, 422, ["sourceFriendTotal"]);
    }
    const declaredTotal = body.declaredFriendTotal;
    if (declaredTotal !== undefined && declaredTotal !== null
      && (!Number.isInteger(declaredTotal) || declaredTotal < 0)) {
      return inputError(c, { success: false, error: 'declaredFriendTotal は0以上の整数で入れてください' }, 422, ["declaredFriendTotal"]);
    }
    const saved = await savePreview(c.env.DB, handover.id, {
      sourceFriendTotal: total,
      counts: value,
      declaredFriendTotal: declaredTotal ?? null,
    });
    if (!saved.ok) return inputError(c, { success: false, error: saved.error }, 422, ["sourceFriendTotal","counts","declaredFriendTotal"]);
    return c.json({ success: true, data: serialize((await getHandoverById(c.env.DB, handover.id))!) });
  } catch (err) {
    throw err;
  }
});

/** 段4。競合の判断を保存する。 */
accountHandovers.put('/api/account-handovers/:id/decisions', requireRole('owner', 'admin'), inputJsonBoundary({"decisions":["array"]}), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<{
      decisions?: Array<{
        fromFriendId?: string;
        toFriendId?: string | null;
        decision?: string;
        bucket?: string;
        note?: string | null;
      }>;
    }>();
    const decisions = body.decisions ?? [];
    if (decisions.length === 0) {
      return inputError(c, { success: false, error: 'decisions が要ります' }, 400, ["decisions"]);
    }
    for (const d of decisions) {
      const source = await c.env.DB.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=?').bind(d.fromFriendId ?? '', handover.from_account_id).first();
      const target = !d.toFriendId || await c.env.DB.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=?').bind(d.toFriendId, handover.to_account_id).first();
      if (!source || !target) return c.json({ success: false, error: 'Not found' }, 404);
    }
    const staff = c.get('staff');
    for (const d of decisions) {
      if (!d.fromFriendId) {
        return inputError(c, { success: false, error: 'fromFriendId が要ります' }, 400, ["decisions"]);
      }
      if (d.decision !== 'link' && d.decision !== 'new' && d.decision !== 'skip') {
        return inputError(c, { success: false, error: '決めたことを確認してください' }, 400, ["decisions"]);
      }
      /*
        **「同じ人として結びつける」のに相手がいない、を通さない。**
        通すと本実行で行き先の無い人ができ、静かに消える。
      */
      if (d.decision === 'link' && !d.toFriendId) {
        return inputError(c, { success: false, error: '結びつける相手が要ります' }, 422, ["decisions"]);
      }
      if (!MATCH_BUCKETS.includes(d.bucket as MatchBucket)) {
        return inputError(c, { success: false, error: '区分を確認してください' }, 400, ["decisions"]);
      }
      await saveDecision(c.env.DB, {
        handoverId: handover.id,
        fromFriendId: d.fromFriendId,
        toFriendId: d.toFriendId ?? null,
        decision: d.decision,
        bucket: d.bucket as MatchBucket,
        note: d.note ?? null,
        decidedBy: staff?.id ?? null,
      });
    }
    const unresolved = await unresolvedReviewCount(c.env.DB, handover.id);
    if (unresolved !== null && unresolved <= 0) await markResolved(c.env.DB, handover.id);
    return c.json({
      success: true,
      data: {
        ...serialize((await getHandoverById(c.env.DB, handover.id))!),
        unresolvedReviews: await unresolvedReviewCount(c.env.DB, handover.id),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'HANDOVER_STATE_CONFLICT') {
      const current = await getHandoverById(c.env.DB,c.req.param('id'));
      return c.json({ success: false, error: '引き継ぎが変わりました。読み直してください', current: current ? serialize(current) : null }, 409);
    }
    throw err;
  }
});

/**
 * 段5。本実行。
 *
 * **「要確認」を全部決めるまで通さない。** 決めていない人がいるまま進めると、
 * その人がどちらにも入らずに消える。
 */
accountHandovers.post('/api/account-handovers/:id/execute', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    // 友だちを実際に動かす本実行は大事な操作（V・X-3）。本人確認を求める。
    if (!await sensitiveStepUpSatisfied(c, 'account_handover.execute')) {
      return stepUpRequiredResponse(c, '引き継ぎの本実行には本人確認が必要です');
    }
    const body = await c.req.json<{ expectedConfirmationRevision?: number }>().catch(() => ({} as { expectedConfirmationRevision?: number }));
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || body.expectedConfirmationRevision < 1)) return c.json({ success:false,error:'確認した版が正しくありません' },400);
    if (body.expectedConfirmationRevision !== undefined && body.expectedConfirmationRevision !== handover.confirmation_revision) return c.json({success:false,error:'引き継ぎが変わりました。読み直してください',current:serialize(handover)},409);
    if (handover.source_friend_total === null) {
      return inputError(c, { success: false, error: '先に事前確認をしてください' }, 422, []);
    }
    /*
      件数照合（X-3、-33 §12-6）。移し元システム側の申告件数が
      事前確認の合計と違うままでは本実行しない。
    */
    if (
      handover.declared_friend_total !== null
      && handover.declared_friend_total !== undefined
      && handover.declared_friend_total !== handover.source_friend_total
    ) {
      return inputError(c, {
          success: false,
          error: `申告された友だち数（${handover.declared_friend_total}人）と事前確認の合計（${handover.source_friend_total}人）が違います。差の理由を確かめてから、件数を直して進めてください`,
        }, 422, []);
    }
    const unresolved = await unresolvedReviewCount(c.env.DB, handover.id);
    if (unresolved !== null && unresolved > 0) {
      return inputError(c, { success: false, error: `要確認が${unresolved}件のこっています。全部決めてから実行してください` }, 422, []);
    }
    if (handover.status === 'completed' || handover.status === 'executing') {
      return c.json({ success: false, error: 'その引き継ぎはもう実行されています' }, 409);
    }
    if (await markExecuting(c.env.DB, handover.id, body.expectedConfirmationRevision) === false) {
      const current = await getHandoverById(c.env.DB,handover.id);
      return c.json({success:false,error:'引き継ぎが変わりました。読み直してください',current:current ? serialize(current) : null},409);
    }

    const decisions = await listDecisions(c.env.DB, handover.id);
    const moving = decisions.filter((d) => d.decision === 'link' || d.decision === 'new');
    let moved = 0;
    let failed = 0;
    for (const d of moving) {
      try {
        const result = await moveHandoverFriend(c.env.DB,{handoverId:handover.id,friendId:d.from_friend_id,fromAccountId:handover.from_account_id,toAccountId:handover.to_account_id!,targetFriendId:d.to_friend_id});
        if (result) moved += 1;
        else failed += 1;
      } catch (err) {
        logger.error("account_handovers.by_id_execute_create_failed");
        failed += 1;
      }
    }
    /*
      照合。**動かした数と、動かすつもりだった数を突き合わせる。**
      合わなければ理由を残す。数だけ返して「終わりました」と言わない。
    */
    const reason =
      failed > 0 ? `${failed}件を移せませんでした` : moved === moving.length ? null : '数が合いません';
    await completeHandover(c.env.DB, handover.id, {
      movedCount: moved,
      failedCount: failed,
      failureReason: reason,
    });
    return c.json({
      success: true,
      data: {
        ...serialize((await getHandoverById(c.env.DB, handover.id))!),
        plannedCount: moving.length,
      },
    });
  } catch (err) {
    throw err;
  }
});

accountHandovers.post('/api/account-handovers/:id/cancel', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<{ expectedConfirmationRevision?: number }>().catch(() => ({} as { expectedConfirmationRevision?: number }));
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || body.expectedConfirmationRevision < 1)) return c.json({success:false,error:'確認した版が正しくありません'},400);
    if (body.expectedConfirmationRevision !== undefined && body.expectedConfirmationRevision !== handover.confirmation_revision) return c.json({success:false,error:'引き継ぎが変わりました。読み直してください',current:serialize(handover)},409);
    if (handover.status === 'completed') {
      return c.json({ success: false, error: '終わった引き継ぎはやめられません' }, 409);
    }
    if (await cancelHandover(c.env.DB, handover.id, body.expectedConfirmationRevision) === false) {
      const current = await getHandoverById(c.env.DB,handover.id);
      return c.json({success:false,error:'引き継ぎが変わりました。読み直してください',current:current ? serialize(current) : null},409);
    }
    return c.json({ success: true, data: serialize((await getHandoverById(c.env.DB, handover.id))!) });
  } catch (err) {
    throw err;
  }
});

/**
 * 段6。切り戻し（X-3、-33 §12-2）。
 * 本実行から7日間だけ。動かした友だちを元のアカウントへ戻す。
 */
accountHandovers.post('/api/account-handovers/:id/rollback', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const handover = await loadAccessible(c.env.DB, c.get('staff'), c.req.param('id'));
    if (!handover) return c.json({ success: false, error: 'Not found' }, 404);
    // 切り戻しも友だちを動かす。本実行と同じ確認を求める。
    if (!await sensitiveStepUpSatisfied(c, 'account_handover.execute')) {
      return stepUpRequiredResponse(c, '引き継ぎの切り戻しには本人確認が必要です');
    }
    const body = await c.req
      .json<{ note?: string | null; expectedConfirmationRevision?: number }>()
      .catch(() => ({} as { note?: string | null; expectedConfirmationRevision?: number }));
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || body.expectedConfirmationRevision < 1)) return c.json({success:false,error:'確認した版が正しくありません'},400);
    if (body.expectedConfirmationRevision !== undefined && body.expectedConfirmationRevision !== handover.confirmation_revision) return c.json({success:false,error:'引き継ぎが変わりました。読み直してください',current:serialize(handover)},409);
    const result = await rollbackHandover(c.env.DB, handover.id, {
      rolledBackBy: c.get('staff')?.id ?? null,
      note: typeof body.note === 'string' ? body.note : null,
      expectedRevision: body.expectedConfirmationRevision,
    });
    if (!result.ok) {
      if (result.conflict) { const current = await getHandoverById(c.env.DB,handover.id); return c.json({success:false,error:result.error,current:current ? serialize(current) : null},409); }
      return inputError(c, { success: false, error: result.error }, 422, ["note"]);
    }
    auditLog(c, 'account_handover.rollback', { id: handover.id, kind: 'account_handover' });
    return c.json({
      success: true,
      data: {
        ...serialize((await getHandoverById(c.env.DB, handover.id))!),
        restoredCount: result.restoredCount,
      },
    });
  } catch (err) {
    throw err;
  }
});

export { accountHandovers };
