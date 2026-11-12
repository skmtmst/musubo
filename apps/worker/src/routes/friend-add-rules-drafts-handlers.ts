import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';

import { archiveFriendAddRule, restoreFriendAddRule, createFriendAddRuleDraft, ensureFriendAddFallbackRules, getFriendAddRule, getFriendByLineUserIdForAccount, getLineAccountById, jstNow, listFriendAddRules, publishFriendAddRule, saveFriendAddRuleDraft, stopFriendAddRule, type FriendAddRuleKind, type FriendAddRuleRow } from '@line-crm/db';

import { LineClient } from '@line-crm/line-sdk';
import { CommonVarResolutionFailedError, expandSendCommonVars } from '../services/interpolation-context.js';
import type { Env } from '../worker-env.js';

import { areFriendAddConditionsOverlapping, doFriendAddTimeWindowsOverlap, doFriendAddWeekdaySetsOverlap } from '../features/friends/friend-add-routing/index.js';
import { accountIdFrom, KINDS, canUseAccount, parseSnapshot, RuleTestInput, ruleTestResponse, RuleInput, validateInput, normalizeDefinition, validateReferences, loadOptions, toRule } from './friend-add-rules-definition.js';
import type { Context } from 'hono';

export const get__api_friend_add_rules_conflicts_1 = async (c: Context<Env, "/api/friend-add-rules/conflicts">) => {
  const accountId = accountIdFrom(c);
  const kind = c.req.query('kind') as FriendAddRuleKind | undefined;
  if (!accountId || !kind || !KINDS.has(kind)) return c.json({ success: false, error: 'account_id と kind が必要です' }, 400);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  try {
    const [rows, countRows] = await Promise.all([
      listFriendAddRules(c.env.DB, { lineAccountId: accountId, friendKind: kind }),
      c.env.DB.prepare(
        `SELECT routing_rule_id AS rule_id, COUNT(*) AS count
           FROM friend_add_events
          WHERE line_account_id = ? AND friend_kind = ? AND routing_rule_id IS NOT NULL
            AND occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-28 days')
          GROUP BY routing_rule_id`,
      ).bind(accountId, kind).all<{ rule_id: string; count: number }>(),
    ]);
    const matched = new Map((countRows.results ?? []).map((row) => [row.rule_id, row.count]));
    const conflicts: Array<{
      code: string;
      ruleIds: string[];
      message: string;
      matchedLast28Days: Record<string, number>;
    }> = [];
    const pushConflict = (code: string, a: FriendAddRuleRow, b: FriendAddRuleRow, message: string) => {
      conflicts.push({
        code,
        ruleIds: [a.id, b.id],
        message,
        matchedLast28Days: { [a.id]: matched.get(a.id) ?? 0, [b.id]: matched.get(b.id) ?? 0 },
      });
    };
    // 定義の読み解きは1行1回だけにする。二重ループの中で毎回読むと
    // 設定が増えるほど競合確認が遅くなる (-軽)。
    const parsed = rows.map((row) => ({ row, definition: parseSnapshot(row.definition_snapshot) }));
    for (let left = 0; left < parsed.length; left += 1) {
      for (let right = left + 1; right < parsed.length; right += 1) {
        const a = parsed[left].row;
        const b = parsed[right].row;
        const aDefinition = parsed[left].definition;
        const bDefinition = parsed[right].definition;
        if (a.priority === b.priority) {
          pushConflict('same_priority', a, b, '同じ優先順位の設定があります。');
        }
        const aRoutes = new Set(aDefinition.routeIds);
        if (bDefinition.routeIds.some((id) => aRoutes.has(id))) {
          pushConflict('same_route', a, b, '同じ流入リンクを使う設定があります。優先順位が小さい設定だけが動きます。');
        }
        // 重なりの見方は本番の実行時評価と同じ関数。片方だけの絞り・空は競合にしない。
        if (doFriendAddWeekdaySetsOverlap(aDefinition.weekdays, bDefinition.weekdays)) {
          pushConflict('overlapping_weekday', a, b, '同じ曜日に動く設定があります。');
        }
        if (doFriendAddTimeWindowsOverlap(aDefinition.timeWindows, bDefinition.timeWindows)) {
          pushConflict('overlapping_time', a, b, '同じ時間帯に動く設定があります。');
        }
        if (areFriendAddConditionsOverlapping(aDefinition.friendCondition, bDefinition.friendCondition)) {
          pushConflict('same_friend_condition', a, b, '同じ友だち条件を使う設定があります。');
        }
      }
    }
    return c.json({
      success: true,
      data: {
        conflicts,
        rules: parsed.map(({ row, definition }) => {
          return {
            id: row.id,
            name: row.name,
            priority: row.priority,
            weekdays: definition.weekdays ?? [],
            timeWindows: definition.timeWindows ?? [],
            friendCondition: definition.friendCondition || null,
            matchedLast28Days: matched.get(row.id) ?? 0,
          };
        }),
      },
    });
  } catch (error) {
    throw error;
  }
};

export const post__api_friend_add_rules_test_2 = async (c: Context<Env, "/api/friend-add-rules/test">) => {
  const body = await c.req.json<RuleTestInput>();
  const accountId = accountIdFrom(c, body);
  if (!accountId || !body.ruleId) return inputError(c, { success: false, error: 'accountId と ruleId が必要です' }, 400, ["accountId","ruleId"]);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  return ruleTestResponse(c, accountId, body.ruleId, {
    routeId: body.routeId ?? null,
    expectedAt: body.expectedAt ?? null,
    friendId: body.friendId ?? null,
  });
};

export const post__api_friend_add_rules_drafts_3 = async (c: Context<Env, "/api/friend-add-rules/drafts">) => {
  const body = await c.req.json<RuleInput>();
  const accountId = accountIdFrom(c, body);
  const idempotencyKey = c.req.header('Idempotency-Key');
  const problem = validateInput(body);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return inputError(c, { success: false, error: '保存には有効な冪等キーが必要です' }, 400, []);
  if (problem) return inputError(c, { success: false, error: problem }, 400, ["name","friendKind","priority","definition"]);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  await ensureFriendAddFallbackRules(c.env.DB, accountId);
  const definition = normalizeDefinition(body.definition);
  // 下書きは未完成のまま保存できる (R30)。全体の必須はテスト・公開前確認で見る。
  // 書いた参照先がこのアカウントの持ち物かの確認はここでも行う。
  const referenceErrors = await validateReferences(c.env.DB, accountId, definition, body.friendKind!, { allowIncomplete: true });
  if (referenceErrors.length > 0) {
    return inputError(c, {
      success: false,
      error: referenceErrors[0].message,
      details: referenceErrors.map((error) => error.message),
    }, 400, ["accountId","definition","friendKind"]);
  }
  const row = await createFriendAddRuleDraft(c.env.DB, {
    lineAccountId: accountId,
    friendKind: body.friendKind!,
    name: body.name!.trim(),
    folderName: body.folderName?.trim() || null,
    priority: body.priority!,
    definition,
    idempotencyKey,
  });
  return c.json({ success: true, data: { id: row.id } }, 201);
};

export const get__api_friend_add_rules_id_4 = async (c: Context<Env, "/api/friend-add-rules/:id">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  const row = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
  if (!row) return c.json({ success: false, error: '設定が見つかりません' }, 404);
  const options = await loadOptions(c.env.DB, accountId);
  const notificationSetting = await c.env.DB.prepare(
    `SELECT value FROM account_settings
      WHERE line_account_id = ? AND key IN ('friend_add_staff_notification', 'slack_notification')
      ORDER BY CASE key WHEN 'friend_add_staff_notification' THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(accountId).first<{ value: string }>();
  let staffNotificationStatus: 'connected' | 'disconnected' | 'unconfigured' | null = 'unconfigured';
  if (notificationSetting) {
    try {
      const setting = JSON.parse(notificationSetting.value) as { enabled?: unknown; webhookUrl?: unknown; channelId?: unknown };
      staffNotificationStatus = setting.enabled === false
        ? 'disconnected'
        : (typeof setting.webhookUrl === 'string' && setting.webhookUrl) || (typeof setting.channelId === 'string' && setting.channelId)
          ? 'connected'
          : 'unconfigured';
    } catch {
      staffNotificationStatus = null;
    }
  }
  return c.json({
    success: true,
    data: {
      rule: toRule(
        row,
        new Map(options.routes.map((route) => [route.id, route.name])),
        new Map(options.scenarios.map((scenario) => [scenario.id, scenario.name])),
      ),
      options,
      staffNotification: {
        status: staffNotificationStatus,
        reason: staffNotificationStatus === null ? '保存済みの通知設定を読み取れません' : null,
      },
    },
  });
};

export const put__api_friend_add_rules_id_draft_5 = async (c: Context<Env, "/api/friend-add-rules/:id/draft">) => {
  const body = await c.req.json<RuleInput>();
  const accountId = accountIdFrom(c, body);
  const idempotencyKey = c.req.header('Idempotency-Key');
  const problem = validateInput(body);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return inputError(c, { success: false, error: '保存には有効な冪等キーが必要です' }, 400, []);
  if (problem) return inputError(c, { success: false, error: problem }, 400, ["name","friendKind","priority","definition"]);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
  if (!current) return c.json({ success: false, error: '設定が見つかりません' }, 404);
  if (current.friend_kind !== body.friendKind) return inputError(c, { success: false, error: '判定する人は途中で変更できません' }, 400, ["accountId","friendKind"]);
  const definition = normalizeDefinition(body.definition);
  // 下書きは未完成のまま保存できる (R30)。全体の必須はテスト・公開前確認で見る。
  const referenceErrors = await validateReferences(c.env.DB, accountId, definition, body.friendKind!, { allowIncomplete: true });
  if (referenceErrors.length > 0) {
    return inputError(c, {
      success: false,
      error: referenceErrors[0].message,
      details: referenceErrors.map((error) => error.message),
    }, 400, ["accountId","definition","friendKind"]);
  }
  try {
    const saved = await saveFriendAddRuleDraft(c.env.DB, {
      lineAccountId: accountId,
      ruleId: c.req.param('id'),
      name: body.name!.trim(),
      folderName: body.folderName?.trim() || null,
      priority: body.priority!,
      definition,
      idempotencyKey,
      expectedVersion: Number.isInteger(body.version) ? body.version! : current.lock_version,
    });
    return c.json({ success: true, data: { id: saved.id, versionId: saved.version_id, version: saved.lock_version } });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_VERSION_CONFLICT') {
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの画面で更新されています。最新の内容を読み直してください' }, 409);
    }
    throw error;
  }
};

export const post__api_friend_add_rules_id_validate_6 = async (c: Context<Env, "/api/friend-add-rules/:id/validate">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  const row = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
  if (!row) return c.json({ success: false, error: '設定が見つかりません' }, 404);
  const definition = parseSnapshot(row.definition_snapshot);
  const errors = await validateReferences(c.env.DB, accountId, definition, row.friend_kind, {
    isFallback: row.is_unknown_route_fallback === 1,
  });
  /*
   * 確認は鍵付きで返す。画面は鍵で突き合わせ、説明文はサーバの値をそのまま出す。
   * 順番 (配列の位置) に意味を持たせない。
   */
  const suppressesResend = (definition.resendSuppressionHours ?? 24) > 0;
  return c.json({
    success: true,
    data: {
      canPublish: errors.length === 0 && row.version_status === 'draft',
      checks: [
        ...(errors.length === 0
          ? [{
              key: row.friend_kind,
              status: 'passed',
              label: '配信内容と参照先を確認できました。',
              detail: '保存済みのルールと参照先を確認できました。',
            }]
          : errors.map((error) => ({
              key: error.key,
              status: 'failed',
              label: error.message,
              detail: error.message,
            }))),
        {
          key: 'duplicate_prevention',
          status: suppressesResend ? 'passed' : 'warning',
          label: '二重送信防止',
          detail: '同じ友だち追加通知は1回だけ処理します。',
        },
      ],
    },
  });
};

export const post__api_friend_add_rules_id_test_7 = async (c: Context<Env, "/api/friend-add-rules/:id/test">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  let body: Partial<RuleTestInput> = {};
  try { body = await c.req.json<RuleTestInput>(); } catch { /* 本文なしの呼び出しは「いま・経路不問」で確かめる */ }
  return ruleTestResponse(c, accountId, c.req.param('id'), {
    routeId: body.routeId ?? null,
    expectedAt: body.expectedAt ?? null,
    friendId: body.friendId ?? null,
  });
};

export const post__api_friend_add_rules_id_test_send_8 = async (c: Context<Env, "/api/friend-add-rules/:id/test-send">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const staff = c.get('staff');
    if (staff.role === 'staff' && !staff.permissionKeys?.includes('/friend-add-settings')) {
      return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    }
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      return inputError(c, { success: false, error: 'テスト送信には有効な冪等キーが必要です' }, 400, []);
    }
    const row = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
    if (!row || !row.definition_snapshot) return c.json({ success: false, error: '設定が見つかりません' }, 404);
    const definition = parseSnapshot(row.definition_snapshot);
    if (definition.messageType !== 'text' || !definition.messageText.trim()) {
      return inputError(c, { success: false, error: 'テスト送信できるのはテキストの本文がある版だけです' }, 422, []);
    }
    // 送り先は操作者本人だけ。staff の LINE 連携からこのアカウントの友だちを引く。
    const staffRow = await c.env.DB.prepare(
      `SELECT line_user_id FROM staff_members WHERE id = ? AND is_active = 1`,
    ).bind(staff.id).first<{ line_user_id: string | null }>();
    const friend = staffRow?.line_user_id
      ? await getFriendByLineUserIdForAccount(c.env.DB, staffRow.line_user_id, accountId)
      : null;
    if (!friend || friend.line_account_id !== accountId || !friend.is_following) {
      return c.json({
        success: false,
        error: 'あなたのLINEがこのアカウントの友だちに見つかりません。先に友だち追加してブロックを解除してください',
      }, 409);
    }
    // 短時間の二度押しは送らず止める（一斉配信のテスト送信と同じ形）。
    const claim = await c.env.DB.prepare(
      `INSERT INTO operation_audit (id, target_kind, target_id, action, actor_id, detail_json)
       SELECT ?, 'friend_add_rule', ?, 'test_send', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM operation_audit
          WHERE target_kind = 'friend_add_rule' AND target_id = ?
            AND action = 'test_send' AND actor_id = ?
            AND datetime(created_at) >= datetime('now', '+9 hours', '-10 seconds')
       )`,
    ).bind(
      crypto.randomUUID(),
      row.id,
      staff.id,
      JSON.stringify({ versionId: row.version_id }),
      row.id,
      staff.id,
    ).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      return c.json({ success: false, error: '短時間に繰り返し送信しています。10秒待ってからやり直してください' }, { status: 429, headers: { 'Retry-After': '10' } });
    }
    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) return inputError(c, { success: false, error: 'LINEアカウントが見つかりません' }, 400, []);
    // 共通情報の差し込みは厳格に解く。解けなければ送らない。
    let resolvedBody: string;
    try {
      resolvedBody = await expandSendCommonVars(
        c.env.DB,
        definition.messageText,
        { kind: 'test_send', id: row.id },
        { lineAccountId: accountId },
      );
    } catch (error) {
      if (error instanceof CommonVarResolutionFailedError) {
        return inputError(c, {
          success: false,
          code: 'UNRESOLVED_TEMPLATE_VARIABLES',
          error: `共通情報を解決できません: ${error.failures.map((f) => `{{var.${f.varKey}}}`).join(', ')}`,
        }, 422, []);
      }
      throw error;
    }
    const text = `【テスト配信】\n${resolvedBody}`;
    try {
      await new LineClient(account.channel_access_token)
        .pushMessage(friend.line_user_id, [{ type: 'text', text }], idempotencyKey);
    } catch (error) {
      logger.error("friend_add_rules.friend_add_rules_id_test_send_post_failed");
      return c.json({ success: false, error: 'LINEへ送信できませんでした' }, 502);
    }
    await c.env.DB.prepare(
      `INSERT INTO messages_log
         (id, friend_id, direction, message_type, content, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, 'test', 'manual', ?, ?)`,
    ).bind(crypto.randomUUID(), friend.id, text, accountId, jstNow()).run();
    return c.json({
      success: true,
      data: {
        sent: 1,
        versionId: row.version_id,
        versionNumber: row.version_number,
        recipientKind: 'self',
      },
    });
  } catch (error) {
    throw error;
  }
};

export const post__api_friend_add_rules_id_publish_9 = async (c: Context<Env, "/api/friend-add-rules/:id/publish">) => {
  const accountId = accountIdFrom(c);
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    return inputError(c, { success: false, error: '公開には有効な冪等キーが必要です' }, 400, []);
  }
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  try {
    const row = await publishFriendAddRule(c.env.DB, {
      lineAccountId: accountId,
      ruleId: c.req.param('id'),
      staffId: c.get('staff').id,
      idempotencyKey,
    });
    return c.json({ success: true, data: { id: row.id, versionNumber: row.version_number, publishedAt: row.published_at } });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_DRAFT_NOT_TESTED') {
      return c.json({ success: false, error: '公開前にテストを成功させてください' }, 409);
    }
    /*
     * 削除との競合を500にしないよう、公開対象の有無を再確認する。対象がなければ404、対象があり下書きがなければ409で返す。
     */
    if (error instanceof Error && (
      error.message === 'FRIEND_ADD_RULE_NOT_FOUND'
      || error.message === 'FRIEND_ADD_RULE_DRAFT_NOT_FOUND'
      || error.message === 'FRIEND_ADD_RULE_NOT_PUBLISHED'
    )) {
      const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
      if (!current) {
        return c.json({ success: false, error: '見つかりません（一覧を読み直してください）' }, 404);
      }
      return c.json({ success: false, error: '公開できる下書きがありません。最新の状態を読み直してください' }, 409);
    }
    throw error;
  }
};

export const post__api_friend_add_rules_id_stop_10 = async (c: Context<Env, "/api/friend-add-rules/:id/stop">) => {
  const accountId = accountIdFrom(c);
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) return inputError(c, { success: false, error: '停止には有効な冪等キーが必要です' }, 400, []);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  let body: { version?: number } = {};
  try { body = await c.req.json<{ version?: number }>(); } catch { /* 従来クライアントは本文なし */ }
  const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
  if (!current) return c.json({ success: false, error: '設定が見つかりません' }, 404);
  try {
    await stopFriendAddRule(c.env.DB, {
      lineAccountId: accountId,
      ruleId: c.req.param('id'),
      staffId: c.get('staff').id,
      idempotencyKey,
      expectedVersion: Number.isInteger(body.version) ? body.version! : current.lock_version,
    });
    const stopped = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
    return c.json({ success: true, data: { version: stopped?.lock_version ?? current.lock_version } });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_VERSION_CONFLICT') {
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの画面で更新されています。最新の内容を読み直してください' }, 409);
    }
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_NOT_STOPPED') {
      return c.json({ success: false, code: 'STATE_CONFLICT', error: 'この配信ルールは停止できる状態ではありません' }, 409);
    }
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_FALLBACK_REQUIRED') {
      return c.json({
        success: false,
        code: 'FALLBACK_REQUIRED',
        error: '経路が分からない人の有効な受け皿がないため停止できません',
      }, 409);
    }
    throw error;
  }
};

export const post__api_friend_add_rules_id_unarchive_11 = async (c: Context<Env, "/api/friend-add-rules/:id/unarchive">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: number }>().catch(() => ({} as { expectedVersion?: number }));
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion! < 1) return inputError(c, { success: false, error: '版番号が必要です' }, 422, ['expectedVersion']);
  const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id'), includeArchived: true });
  if (!current) return c.json({ success: false, error: 'Not found' }, 404);
  const restored = await restoreFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: current.id, expectedVersion: body.expectedVersion! });
  if (!restored) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '状態が変わっています。一覧を読み直してください' }, 409);
  return c.json({ success: true, data: { id: restored.id, status: restored.status, version: restored.lock_version } });
};

export const post__api_friend_add_rules_id_duplicate_12 = async (c: Context<Env, "/api/friend-add-rules/:id/duplicate">) => {
  const accountId = accountIdFrom(c);
  const key = c.req.header('Idempotency-Key');
  if (!accountId || !key || key.length < 16 || key.length > 200) return c.json({ success: false, error: 'アカウントと操作の鍵が必要です' }, 400);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: 'Not found' }, 404);
  const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id'), includeArchived: true });
  if (!current) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: number }>().catch(() => ({} as { expectedVersion?: number }));
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion! < 1) return inputError(c, { success: false, error: '版番号が必要です' }, 422, ['expectedVersion']);
  if (body.expectedVersion !== current.lock_version) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '一覧を読み直してください' }, 409);
  const definition = parseSnapshot(current.definition_snapshot);
  const created = await createFriendAddRuleDraft(c.env.DB, { lineAccountId: accountId,
    friendKind: current.friend_kind, name: `${current.name}（複製）`, folderName: current.folder_name,
    priority: current.priority, definition, idempotencyKey: key });
  return c.json({ success: true, data: { id: created.id, status: 'draft' } }, 201);
};

export const delete__api_friend_add_rules_id_13 = async (c: Context<Env, "/api/friend-add-rules/:id">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
  /*
   * 存在しない設定と共通あいさつ（受け皿）を分ける。無いときは 404。
   */
  const versionParam = c.req.query('expected_version');
  const expectedStatus = c.req.query('expected_status');
  if ((versionParam === undefined) !== (expectedStatus === undefined)
      || (versionParam !== undefined && (!/^[1-9]\d*$/.test(versionParam) || !Number.isSafeInteger(Number(versionParam)) || !['draft', 'published', 'stopped'].includes(expectedStatus ?? '')))) {
    return c.json({ success: false, error: '確認した版と状態を指定してください' }, 400);
  }
  const current = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
  if (!current) {
    return c.json({ success: false, error: '見つかりません（一覧を読み直してください）' }, 404);
  }
  if (current.is_unknown_route_fallback === 1) {
    return c.json({ success: false, error: '経路が分からなかった人の設定は削除できません' }, 409);
  }
  try {
    await archiveFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id'), ...(versionParam === undefined ? {} : { expectedVersion: Number(versionParam), expectedStatus }) });
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_VERSION_CONFLICT') {
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: '設定が変更されました。一覧を読み直してください' }, 409);
    }
    // 先の確認と更新の間に消えたときは 404。残っているときは受け皿相当の 409。
    const gone = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId: c.req.param('id') });
    if (!gone) {
      return c.json({ success: false, error: '見つかりません（一覧を読み直してください）' }, 404);
    }
    return c.json({ success: false, error: '経路が分からなかった人の設定は削除できません' }, 409);
  }
};
