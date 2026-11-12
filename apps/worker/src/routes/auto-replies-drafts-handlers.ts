import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { isOperationCapabilityStopped } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getAutoReplies, getAutoReplyById, getAutoReplyHitCounts, getAutoReplyHitCountSince, getFriendById, createAutoReplyWithDraftVersion, getAutoReplyDraftVersion, getAutoReplyPublishedVersion, parseAutoReplyVersionSettings, publishAutoReplyDraftVersion, recordAutoReplyDraftTest, saveAutoReplyDraftVersion, jstNow } from '@line-crm/db';
import type { AutoReplyVersionRow } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { currentMonthRange } from '../lib/jst-range.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { evaluateAutoReplyCandidates, parseAutoReplyActions, previewAutoReplyContent } from '../features/auto-replies/auto-reply/index.js';
import { isOperatorHandling } from '../features/auto-replies/auto-reply-conditions/index.js';
import { conflictCounts, conflictPairs, buildAutomationKeywordIndex, actionExecutionCounts, internalMemosOf, SerializedAutoReply, serializeAutoReply, computeEffectiveAccounts, resolveStoppedByNames, autoReplyReceiveSummary, readDraftSettings, assertTemplateVisible, readIdempotencyKey, draftVersionResponse, idempotencyErrorResponse, validateDraft, conflictsForDraft, MESSAGE_KINDS, activeRulesWithDraft, AutoReplyDryRunResult, validIdempotencyKey } from './auto-replies-definition.js';
import type { Context } from 'hono';

export const get__api_auto_replies_1 = async (c: Context<Env, "/api/auto-replies">) => {
  try {
    const accountId = c.req.query('accountId');
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (accountId) {
      if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
        return c.json({ success: false, error: '自動応答を確認できません' }, 404);
      }
    }
    const items = (await getAutoReplies(c.env.DB, accountId || undefined)).filter((item) => {
      const itemAccountId = (item as { line_account_id?: string | null }).line_account_id ?? null;
      return itemAccountId == null
        ? scope.canSeeUnassigned
        : scope.allowedAccountIds.includes(itemAccountId);
    });
    const activeItems = items.filter((item) => item.is_active === 1);
    const conflictsById = conflictCounts(conflictPairs(activeItems));

    // active LINE accounts を取得 + automations の keyword -> accounts インデックスを構築
    const activeAccounts = scope.allowedAccountIds.length
      ? (await c.env.DB
        .prepare(
          `SELECT id, name FROM line_accounts
            WHERE is_active = 1
              AND id IN (${sqlIdSet(scope.allowedAccountIds).sql})
            ORDER BY name`,
        )
        .bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []))
        .all<{ id: string; name: string }>()).results ?? []
      : [];
    const automationIdx = await buildAutomationKeywordIndex(c.env.DB);

    // 当たった回数（152）。今月と累計を並べて出す。
    // 数が取れなくても一覧は出す。付随情報なので、落ちても本体は止めない。
    const range = currentMonthRange(jstNow());
    // 集計が取れないときは hits を付けない。0 で埋めると画面の
    // 「未取得は —」判定が常に真になり、数え損ないが「未ヒット 0 回」に見える。
    let hitsById: Map<string, { period: number; total: number }> | null = null;
    try {
      const counts = await getAutoReplyHitCounts(
        c.env.DB,
        accountId || null,
        range.from,
        range.to,
      );
      hitsById = new Map(counts.map((h) => [h.autoReplyId, { period: h.period, total: h.total }]));
    } catch (err) {
      logger.error("auto_replies.auto_replies_get_failed");
    }

    let actionsById: Map<string, number> | null = null;
    try {
      actionsById = await actionExecutionCounts(c.env.DB, accountId || null);
    } catch (err) {
      logger.error("auto_replies.auto_replies_get_failed");
    }

    const memos = await internalMemosOf(c.env.DB, items.map((item) => item.id));

    const data: SerializedAutoReply[] = await Promise.all(
      items.map(async (row) => {
        const base: SerializedAutoReply = {
          ...serializeAutoReply(row, memos.get(row.id) ?? null),
          ...(hitsById ? { hits: hitsById.get(row.id) ?? { period: 0, total: 0 } } : {}),
          actionExecutionCount: actionsById?.get(row.id) ?? (actionsById ? 0 : null),
          conflictAttentionCount: row.is_active === 1 ? conflictsById.get(row.id) ?? 0 : 0,
        };
        base.effectiveAccounts = await computeEffectiveAccounts(c.env.DB, row, activeAccounts, automationIdx);
        return base;
      }),
    );
    await resolveStoppedByNames(c.env.DB, data);

    // 共通一覧契約。page/limit を付けたときだけ新形（items/total/limit/sort）で返す。
    // 画面はまだ旧形（配列）を読むため、付けない限り形を変えない。
    if (c.req.query('page') !== undefined || c.req.query('limit') !== undefined) {
      const paging = parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') });
      return c.json({
        success: true,
        data: buildOffsetListResponse({
          items: data.slice(paging.offset, paging.offset + paging.limit),
          total: data.length,
          paging,
          sort: [
            { field: 'priority', direction: 'asc' },
            { field: 'created_at', direction: 'asc' },
          ],
        }),
      });
    }
    return c.json({ success: true, data });
  } catch (err) {
    throw err;
  }
};

export const get__api_auto_replies_conflicts_2 = async (c: Context<Env, "/api/auto-replies/conflicts">) => {
  try {
    const accountId = c.req.query('accountId') ?? c.req.query('account_id');
    if (!accountId) {
      return c.json({ success: false, error: 'accountId を指定してください' }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: '自動応答を確認できません' }, 404);
    }
    const rules = (await getAutoReplies(c.env.DB, accountId))
      .filter((item) => item.is_active === 1);
    const conflicts = conflictPairs(rules);
    const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1_000).toISOString();
    let receiveSourceCounts: Array<{ source: string; count: number }> | null = null;
    let matchedLast28Days: number | null = null;
    let dispatchStopped: boolean | null = null;
    try {
      dispatchStopped = await isOperationCapabilityStopped(c.env.DB, accountId, 'auto_reply_dispatch');
    } catch {
      logger.error('auto_replies.dispatch_status_read_failed');
    }
    try {
      const summary = await autoReplyReceiveSummary(c.env.DB, accountId, since);
      receiveSourceCounts = summary.receiveSourceCounts;
      matchedLast28Days = summary.matchedLast28Days;
    } catch (err) {
      logger.error("auto_replies.auto_replies_conflicts_get_failed");
    }
    return c.json({
      success: true,
      data: {
        conflicts,
        conflictCount: conflicts.length,
        receiveSourceCounts,
        matchedLast28Days,
        dispatchStopped,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_auto_replies_drafts_3 = async (c: Context<Env, "/api/auto-replies/drafts">) => {
  try {
    const parsed = await readDraftSettings(c.env.DB, await c.req.json());
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 400, []);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [parsed.value.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const templateError = await assertTemplateVisible(
      c.env.DB,
      c.get('staff'),
      parsed.value.templateId,
      parsed.templateLineAccountId,
    );
    if (templateError) return c.json({ success: false, error: templateError }, 403);
    // m26c : 確認キーがあれば再送を同じ下書きへ復帰させる。
    const draftKey = readIdempotencyKey(c);
    try {
      const created = await createAutoReplyWithDraftVersion(
        c.env.DB,
        parsed.value,
        draftKey ? { key: draftKey, fingerprint: JSON.stringify(parsed.value) } : undefined,
      );
      return c.json({ success: true, data: draftVersionResponse(created.version) }, 201);
    } catch (err) {
      const mapped = idempotencyErrorResponse(err);
      if (mapped) return inputError(c, { success: false, error: mapped.error }, mapped.status, ["triggerConfig"]);
      throw err;
    }
  } catch (err) {
    throw err;
  }
};

export const get__api_auto_replies_id_4 = async (c: Context<Env, "/api/auto-replies/:id">) => {
  try {
    const id = c.req.param('id');
    const item = await getAutoReplyById(c.env.DB, id);
    if (!item) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    const memos = await internalMemosOf(c.env.DB, [id]);
    const data = serializeAutoReply(item, memos.get(id) ?? null);
    await resolveStoppedByNames(c.env.DB, [data]);
    return c.json({ success: true, data });
  } catch (err) {
    throw err;
  }
};

export const get__api_auto_replies_id_draft_5 = async (c: Context<Env, "/api/auto-replies/:id/draft">) => {
  try {
    const id = c.req.param('id');
    const version = await getAutoReplyDraftVersion(c.env.DB, id)
      ?? await getAutoReplyPublishedVersion(c.env.DB, id);
    if (!version) return c.json({ success: false, error: '確認する設定がありません' }, 404);
    let matchedLast28Days: number | null = null;
    try {
      const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1_000).toISOString();
      matchedLast28Days = await getAutoReplyHitCountSince(c.env.DB, version.auto_reply_id, since);
    } catch (err) {
      logger.error("auto_replies.auto_replies_id_draft_get_failed");
    }
    return c.json({
      success: true,
      data: { ...draftVersionResponse(version), matchedLast28Days },
    });
  } catch (err) {
    throw err;
  }
};

export const put__api_auto_replies_id_draft_6 = async (c: Context<Env, "/api/auto-replies/:id/draft">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      return inputError(c, { success: false, error: 'expectedVersion を指定してください' }, 400, ["expectedVersion"]);
    }
    const current = await getAutoReplyDraftVersion(c.env.DB, c.req.param('id'))
      ?? await getAutoReplyPublishedVersion(c.env.DB, c.req.param('id'));
    if (!current) return c.json({ success: false, error: '自動応答が見つかりません' }, 404);
    if (Number(current.version_number) !== Number(body.expectedVersion)) {
      return c.json({
        success: false,
        code: 'VERSION_CONFLICT',
        error: 'ほかの変更が先に保存されました。最新の状態を読み直してください',
        data: { currentVersion: Number(current.version_number) },
      }, 409);
    }
    const parsed = await readDraftSettings(c.env.DB, body);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 400, []);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [parsed.value.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const templateError = await assertTemplateVisible(
      c.env.DB,
      c.get('staff'),
      parsed.value.templateId,
      parsed.templateLineAccountId,
    );
    if (templateError) return c.json({ success: false, error: templateError }, 403);
    // m26c : 読んだ版番号を更新条件に含め、同じ版からの後続保存を競合にする。
    const version = await saveAutoReplyDraftVersion(
      c.env.DB,
      c.req.param('id'),
      parsed.value,
      Number(body.expectedVersion),
    );
    return c.json({ success: true, data: draftVersionResponse(version) });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'AUTO_REPLY_NOT_FOUND') {
      return c.json({ success: false, error: '自動応答が見つかりません' }, 404);
    }
    // 同時作成の負け側は一意制約で落ちる。版の競合として同じ 409 に寄せる。
    if (code === 'AUTO_REPLY_VERSION_CONFLICT' || /unique constraint/i.test(code)) {
      // m26c : 先行内容を保ったまま、比較と読み直しの手がかりを返す。
      const current = await getAutoReplyDraftVersion(c.env.DB, c.req.param('id'))
        ?? await getAutoReplyPublishedVersion(c.env.DB, c.req.param('id'));
      const currentSettings = current ? parseAutoReplyVersionSettings(current) : null;
      return c.json({
        success: false,
        code: 'VERSION_CONFLICT',
        error: 'ほかの変更が先に保存されました。最新の状態を読み直してください',
        data: {
          currentVersion: current ? Number(current.version_number) : null,
          current: currentSettings
            ? {
              keyword: currentSettings.keyword,
              responseContent: currentSettings.responseContent,
              updatedAt: current?.updated_at ?? null,
            }
            : null,
        },
      }, 409);
    }
    throw err;
  }
};

export const post__api_auto_replies_id_validate_7 = async (c: Context<Env, "/api/auto-replies/:id/validate">) => {
  try {
    const version = await getAutoReplyDraftVersion(c.env.DB, c.req.param('id'));
    if (!version) return c.json({ success: false, error: '公開する下書きがありません' }, 404);
    return c.json({ success: true, data: await validateDraft(c.env.DB, version) });
  } catch (err) {
    throw err;
  }
};

export const get__api_auto_replies_id_conflicts_8 = async (c: Context<Env, "/api/auto-replies/:id/conflicts">) => {
  try {
    // m26c : 公開後は下書きが無い。下書き取得と同じく公開版へ読み替え、
    // 404 で完了 URL を壊さない。読み替えたことは source で区別する。
    const version = await getAutoReplyDraftVersion(c.env.DB, c.req.param('id'));
    const published = version ? null : await getAutoReplyPublishedVersion(c.env.DB, c.req.param('id'));
    const target = version ?? published;
    if (!target) return c.json({ success: false, error: '確認する下書きがありません' }, 404);
    const settings = parseAutoReplyVersionSettings(target);
    return c.json({
      success: true,
      data: {
        conflicts: await conflictsForDraft(c.env.DB, target.auto_reply_id, settings),
        source: version ? 'draft' : 'published',
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_auto_replies_id_test_9 = async (c: Context<Env, "/api/auto-replies/:id/test">) => {
  let version: AutoReplyVersionRow | null = null;
  try {
    const id = c.req.param('id');
    version = await getAutoReplyDraftVersion(c.env.DB, id);
    if (!version) return c.json({ success: false, error: '試す下書きがありません' }, 404);
    const settings = parseAutoReplyVersionSettings(version);
    const body = await c.req.json<{
      friendId?: unknown;
      incomingText?: unknown;
      messageKind?: unknown;
      occurredAt?: unknown;
    }>();
    if (typeof body.friendId !== 'string' || !body.friendId) {
      return inputError(c, { success: false, error: '試す友だちを選んでください' }, 400, ["friendId"]);
    }
    if (typeof body.incomingText !== 'string' || !body.incomingText.trim()) {
      return inputError(c, { success: false, error: '試すメッセージを入力してください' }, 400, ["incomingText"]);
    }
    if ([...body.incomingText].length > 2_000) {
      return inputError(c, { success: false, error: '試すメッセージは2000文字以内にしてください' }, 400, ["incomingText"]);
    }
    const messageKind = body.messageKind ?? 'text';
    if (typeof messageKind !== 'string' || !MESSAGE_KINDS.includes(messageKind)) {
      return inputError(c, { success: false, error: 'メッセージの種類が正しくありません' }, 400, ["messageKind"]);
    }
    const occurredAt = body.occurredAt === undefined ? new Date() : new Date(String(body.occurredAt));
    if (Number.isNaN(occurredAt.getTime())) {
      return inputError(c, { success: false, error: '試す日時が正しくありません' }, 400, ["occurredAt"]);
    }
    const friend = await getFriendById(c.env.DB, body.friendId);
    if (!friend || friend.line_account_id !== settings.lineAccountId) {
      return c.json({ success: false, error: '選んだアカウントの友だちを確認できません' }, 404);
    }

    const candidates = await activeRulesWithDraft(c.env.DB, id, settings);
    /*
      試験では勝者の後ろも全部評価する。同じ検証文に当たるのに優先順位で
      動かないルールを `higher_priority_won` の理由つきで返し、「なぜ
      実行されないか」を画面で説明できるようにする。本番の評価順と
      勝者は変わらない（先に通った1件だけが won）。
    */
    const evaluations = await evaluateAutoReplyCandidates(c.env.DB, candidates, {
      friendId: friend.id,
      incomingText: body.incomingText,
      messageKind,
      now: occurredAt,
    }, { continueAfterWinner: true });
    const winner = evaluations.find((item) => item.result === 'won')?.rule ?? null;
    // 有人対応の抑止が効く状態か。試した友だちのトークが「対応中」なら、
    // 「対応中は返さない」設定のルールだけが見送りになる——画面で抑止対象と
    // 解除条件（対応中が解除されると動く）を説明するために返す。
    const operatorActive = await isOperatorHandling(c.env.DB, friend.id);
    const draftWon = winner?.id === id;
    const preview = winner && winner.response_type !== 'silent'
      ? await previewAutoReplyContent(c.env.DB, friend, winner, c.env.WORKER_URL)
      : winner
        ? { messageType: 'silent', content: '返信せず、設定した処理だけを実行します' }
        : null;
    // m26c : 試験を始めたときの内容を掴む。記録時に変わっていたら
    // 古い成功を新内容に付けず、再試験を求める。
    const startedSnapshot = version.definition_snapshot;
    const result: AutoReplyDryRunResult = {
      matched: winner !== null,
      draftWon,
      operatorActive,
      winner: winner && preview
        ? {
            autoReplyId: winner.id,
            name: winner.name || winner.keyword || '名前は未設定',
            responseType: preview.messageType,
            responseContent: preview.content,
          }
        : null,
      candidates: evaluations.map((item) => ({
        autoReplyId: item.rule.id,
        name: item.rule.name || item.rule.keyword || '名前は未設定',
        priority: item.rule.priority,
        result: item.result,
        reasonCodes: item.reasonCodes,
        suppressWhenOperatorActive: item.rule.skip_when_operator_active === 1,
      })),
      actions: winner ? parseAutoReplyActions(winner.actions_json).map((action) => ({ kind: action.action_type })) : [],
      stateChanged: false,
    };
    const recorded = await recordAutoReplyDraftTest(c.env.DB, version.id, {
      succeeded: draftWon,
      staffId: c.get('staff')?.id ?? null,
    }, startedSnapshot);
    if (!recorded.applied) {
      return c.json({ success: true, data: { ...result, staleTest: true } });
    }
    return c.json({ success: true, data: result });
  } catch (err) {
    if (version) {
      await recordAutoReplyDraftTest(c.env.DB, version.id, {
        succeeded: false,
        staffId: c.get('staff')?.id ?? null,
      });
    }
    throw err;
  }
};

export const post__api_auto_replies_id_publish_10 = async (c: Context<Env, "/api/auto-replies/:id/publish">) => {
  try {
    const id = c.req.param('id');
    const requestKey = c.req.header('Idempotency-Key');
    if (!validIdempotencyKey(requestKey)) {
      return inputError(c, { success: false, error: '公開操作の確認キーが必要です' }, 400, []);
    }
    const version = await getAutoReplyDraftVersion(c.env.DB, id);
    // m26c /: 公開前チェック時の内容と、読取時の停止状態を掴む。
    // 公開 batch までの割込みは DB helper が競合として止める。
    const ruleBefore = await getAutoReplyById(c.env.DB, id);
    if (!version) {
      // 同じキーの再実行はDB helperが公開済みの結果を返す。
      const replay = await publishAutoReplyDraftVersion(c.env.DB, id, {
        staffId: c.get('staff')?.id ?? null,
        idempotencyKey: requestKey,
      });
      return c.json({
        success: true,
        data: {
          autoReplyId: id,
          versionId: replay.id,
          versionNumber: Number(replay.version_number),
          publishedAt: replay.published_at,
          acknowledgedConflictIds: [],
        },
      });
    }
    const validation = await validateDraft(c.env.DB, version);
    if (!validation.valid) {
      return inputError(c, { success: false, error: '公開前チェックに未完了があります', data: validation }, 422, []);
    }
    if (version.last_test_status !== 'succeeded') {
      return inputError(c, { success: false, error: 'この下書きを実際の相手と文面で試してください', data: validation }, 422, []);
    }
    const body: { acknowledgedConflictIds?: unknown } = await c.req
      .json<{ acknowledgedConflictIds?: unknown }>()
      .catch(() => ({}));
    const acknowledged = Array.isArray(body.acknowledgedConflictIds)
      ? body.acknowledgedConflictIds.filter((value): value is string => typeof value === 'string')
      : [];
    const missing = validation.conflicts
      .map((item) => item.autoReplyId)
      .filter((conflictId) => !acknowledged.includes(conflictId));
    if (missing.length > 0) {
      return c.json({
        success: false,
        error: '競合する自動応答を確認してください',
        data: validation,
      }, 409);
    }
    const published = await publishAutoReplyDraftVersion(c.env.DB, id, {
      staffId: c.get('staff')?.id ?? null,
      idempotencyKey: requestKey,
      expectedSnapshot: version.definition_snapshot,
      expectedStoppedAt: ruleBefore?.stopped_at ?? null,
      expectedIsActive: ruleBefore?.is_active ?? 0,
    });
    return c.json({
      success: true,
      data: {
        autoReplyId: id,
        versionId: published.id,
        versionNumber: Number(published.version_number),
        publishedAt: published.published_at,
        acknowledgedConflictIds: acknowledged,
      },
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'AUTO_REPLY_PUBLISH_KEY_CONFLICT') {
      return c.json({ success: false, error: '同じ確認キーが別の公開操作で使われています' }, 409);
    }
    if (code === 'AUTO_REPLY_DRAFT_CHANGED') {
      return c.json({
        success: false,
        error: '公開する直前に内容が変わりました。最新の状態を読み直し、確認・試験からやり直してください',
      }, 409);
    }
    if (code === 'AUTO_REPLY_STOPPED_AFTER_READ') {
      return c.json({
        success: false,
        error: '公開する直前に停止されました。停止のままにするか、最新の状態を読み直してください',
      }, 409);
    }
    if (code === 'AUTO_REPLY_DRAFT_NOT_FOUND' || code === 'AUTO_REPLY_DRAFT_ALREADY_PUBLISHED') {
      return c.json({ success: false, error: 'この下書きはすでに公開されています' }, 409);
    }
    if (code === 'AUTO_REPLY_DRAFT_NOT_TESTED') {
      return inputError(c, { success: false, error: 'この下書きを実際の相手と文面で試してください' }, 422, []);
    }
    throw err;
  }
};
