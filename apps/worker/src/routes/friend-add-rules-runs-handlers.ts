import { buildOffsetListResponse, listQueryNumber } from '../lib/list-paging.js';
import { inputError } from '../lib/input-errors.js';

import { deleteFriendAddRuleFolder, ensureFriendAddFallbackRules, listFriendAddRuleOrderIds, listFriendAddRulesPage, reorderFriendAddRulePriorities, reorderFriendAddRulePrioritiesCAS, type FriendAddRuleKind, type FriendAddRuleRow } from '@line-crm/db';

import type { Env } from '../worker-env.js';

import { retryFailedFriendAddActions } from '../features/friends/friend-add-routing/index.js';
import { isFolderSelectColor } from '@line-crm/shared';
import { accountIdFrom, runPeriod, parseRunCursor, RUN_STATUSES, KINDS, RUN_ATTRIBUTIONS, canUseAccount, runFailureKind, runFriendReadModel, makeRunCursor, parseSnapshot, safeActionErrorCode, RULE_STATUSES, loadOptions, getFriendAddOrderVersion, toRule } from './friend-add-rules-definition.js';
import type { Context } from 'hono';

export const get__api_friend_add_runs_1 = async (c: Context<Env, "/api/friend-add-runs">) => {
  const isStaff = c.get('staff').role === 'staff';
  const accountId = accountIdFrom(c);
  const range = runPeriod(c.req.query('period'), c.req.query('from'), c.req.query('to'));
  const periodSpecified = Boolean(c.req.query('period') || c.req.query('from') || c.req.query('to'));
  if (!range) return c.json({ success: false, error: '期間が正しくありません' }, 400);
  const status = c.req.query('status');
  const ruleId = c.req.query('rule_id');
  const kind = c.req.query('kind');
  const attribution = c.req.query('attribution');
  const limit = listQueryNumber(c.req.query('limit'), 20);
  const cursorValue = c.req.query('cursor');
  const cursor = parseRunCursor(cursorValue);
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  if (status && !RUN_STATUSES.has(status)) return c.json({ success: false, error: 'status が正しくありません' }, 400);
  if (kind && !KINDS.has(kind as FriendAddRuleKind)) return c.json({ success: false, error: 'kind が正しくありません' }, 400);
  if (attribution && !RUN_ATTRIBUTIONS.has(attribution)) return c.json({ success: false, error: 'attribution が正しくありません' }, 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ success: false, error: 'limit は1〜100で指定してください' }, 400);
  if (cursorValue && !cursor) return c.json({ success: false, error: 'cursor が正しくありません' }, 400);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const clauses = ['e.line_account_id = ?'];
    const bindings: Array<string | number> = [accountId];
    if (range.from) { clauses.push(`julianday(CASE WHEN substr(e.occurred_at, -1) = 'Z' OR substr(e.occurred_at, -6, 1) IN ('+', '-') THEN e.occurred_at ELSE e.occurred_at || '+09:00' END) >= julianday(?)`); bindings.push(range.from); }
    if (range.to) { clauses.push(`julianday(CASE WHEN substr(e.occurred_at, -1) = 'Z' OR substr(e.occurred_at, -6, 1) IN ('+', '-') THEN e.occurred_at ELSE e.occurred_at || '+09:00' END) < julianday(?)`); bindings.push(range.to); }
    if (status) { clauses.push('e.routing_status = ?'); bindings.push(status); }
    if (ruleId) { clauses.push('e.routing_rule_id = ?'); bindings.push(ruleId); }
    // 種類・経路の絞り込みはサーバ側で行う。取得済み20件への表示絞りでは
    // 2ページ目以降が漏れるため、ここで絞って件数も合わせる。
    if (kind) { clauses.push('e.friend_kind = ?'); bindings.push(kind); }
    if (attribution) { clauses.push('e.attribution_status = ?'); bindings.push(attribution); }
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM friend_add_events e
       JOIN friends f ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
       WHERE ${clauses.join(' AND ')}`,
    ).bind(...bindings).first<{ count: number }>();
    // 上部の集計も同じ絞り込みの中だけを数える。絞り込み中に
    // アカウント全体の数が出ると、対象範囲が読み手に伝わらない。
    const listClauses = [...clauses];
    const listBindings = [...bindings];
    if (cursor) {
      listClauses.push('(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))');
      listBindings.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }
    const [result, summary, failures] = await Promise.all([
      c.env.DB.prepare(
        `SELECT e.id, e.friend_id, f.display_name, e.friend_kind, e.attribution_status,
                e.entry_route_id, er.name AS entry_route_name, e.ref_code,
                e.routing_status, e.error_code, e.occurred_at, e.processed_at,
                r.id AS rule_id, r.name AS rule_name,
                v.id AS version_id, v.version_number,
                json_extract(v.definition_snapshot, '$.scenarioId') AS scenario_id,
                s.name AS scenario_name,
                e.scenario_enrollment_id AS enrollment_id,
                e.delivery_count,
                COALESCE(ar.action_count, 0) AS action_count,
                COALESCE(ar.failed_action_count, 0) AS failed_action_count
           FROM friend_add_events e
           JOIN friends f ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
           LEFT JOIN entry_routes er ON er.id = e.entry_route_id
           LEFT JOIN friend_add_rules r ON r.id = e.routing_rule_id AND r.line_account_id = e.line_account_id
           LEFT JOIN friend_add_rule_versions v ON v.id = e.winning_rule_version_id AND v.rule_id = r.id
           LEFT JOIN scenarios s ON s.id = json_extract(v.definition_snapshot, '$.scenarioId')
           LEFT JOIN (
             SELECT event_id, COUNT(*) AS action_count,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_action_count
               FROM friend_add_action_runs
              GROUP BY event_id
           ) ar ON ar.event_id = e.id
          WHERE ${listClauses.join(' AND ')}
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
      ).bind(...listBindings, limit + 1).all<{
        id: string; friend_id: string; display_name: string | null; friend_kind: string;
        attribution_status: string; entry_route_id: string | null; entry_route_name: string | null;
        ref_code: string | null; routing_status: string; error_code: string | null;
        occurred_at: string; processed_at: string | null; rule_id: string | null;
        rule_name: string | null; version_id: string | null; version_number: number | null;
        scenario_id: string | null; scenario_name: string | null; enrollment_id: string | null;
        delivery_count: number; action_count: number; failed_action_count: number;
      }>(),
      /*
       * 「直近28日の追加」は人数（同じ人の再追加は1人）と回数（記録数）を
       * 分けて数える。期間の境界はJSTで計算し、オフセットなしで保存した
       * 古い行とも比較できるよう空白区切りを T に揃えてから比べる。
       * last_delivery_at は実際に送った記録だけの最新日時で、一覧の先頭行の
       * 処理時刻（届いていない記録を含む）とは別物。
       */
      c.env.DB.prepare(
        `SELECT COUNT(DISTINCT CASE WHEN e.attribution_status = 'captured' THEN e.friend_id END) AS captured_friends,
                SUM(CASE WHEN e.friend_kind = 'returning' THEN 1 ELSE 0 END) AS returning_runs,
                COUNT(DISTINCT e.friend_id) AS period_friends,
                COUNT(*) AS period_events,
                COUNT(DISTINCT CASE WHEN REPLACE(e.occurred_at, ' ', 'T') >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-28 days') THEN e.friend_id END) AS recent_friends,
                SUM(CASE WHEN REPLACE(e.occurred_at, ' ', 'T') >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-28 days') THEN 1 ELSE 0 END) AS recent_events,
                SUM(e.delivery_count) AS delivery_count,
                SUM(CASE WHEN e.routing_status IN ('failed', 'partial_failed') THEN 1 ELSE 0 END) AS failed_runs,
                AVG(CASE WHEN e.first_delivery_sent_at IS NOT NULL
                    THEN (julianday(e.first_delivery_sent_at) - julianday(REPLACE(e.occurred_at, ' ', 'T'))) * 86400000 END) AS average_send_ms,
                SUM(CASE WHEN e.scenario_enrollment_id IS NOT NULL THEN 1 ELSE 0 END) AS scenario_starts,
                MAX(e.first_delivery_sent_at) AS last_delivery_at
           FROM friend_add_events e
           JOIN friends f ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
          WHERE ${clauses.join(' AND ')}`,
      ).bind(...bindings).first<{
        captured_friends: number; returning_runs: number; period_friends: number; period_events: number;
        recent_friends: number; recent_events: number | null; delivery_count: number | null;
        failed_runs: number | null; average_send_ms: number | null; scenario_starts: number | null;
        last_delivery_at: string | null;
      }>(),
      c.env.DB.prepare(`SELECT e.error_code, COUNT(*) AS count FROM friend_add_events e
        JOIN friends f ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
        WHERE ${clauses.join(' AND ')} AND e.routing_status IN ('failed', 'partial_failed') GROUP BY e.error_code`)
        .bind(...bindings).all<{ error_code: string | null; count: number }>(),
    ]);
    const failureCounts = new Map<string, number>();
    for (const failure of failures.results ?? []) {
      const kind = runFailureKind(failure.error_code) ?? 'other';
      failureCounts.set(kind, (failureCounts.get(kind) ?? 0) + failure.count);
    }
    const allRows = result.results ?? [];
    const items = allRows.slice(0, limit);
    return c.json({
      success: true,
      data: buildOffsetListResponse({ items: items.map((row) => ({
          id: row.id,
          receivedAt: row.occurred_at,
          processedAt: row.processed_at,
          friend: runFriendReadModel(row, isStaff),
          friendKind: row.friend_kind,
          attribution: {
            status: row.attribution_status,
            routeId: row.entry_route_id,
            routeName: row.entry_route_name,
            reason: row.ref_code,
          },
          rule: row.rule_id ? {
            id: row.rule_id,
            name: row.rule_name,
            versionId: row.version_id,
            versionNumber: row.version_number,
          } : null,
          scenario: row.scenario_id ? {
            id: row.scenario_id,
            name: row.scenario_name,
            enrollmentId: row.enrollment_id,
            started: row.enrollment_id !== null,
          } : null,
          actions: { total: row.action_count, failed: row.failed_action_count },
          deliveryCount: row.delivery_count,
          status: row.routing_status,
          errorCode: row.error_code,
          failureKind: row.routing_status === 'failed' || row.routing_status === 'partial_failed' ? runFailureKind(row.error_code) ?? 'other' : null,
        })),
        period: { key: c.req.query('period') ?? (periodSpecified ? 'custom' : 'all'), ...range },
        total: total?.count ?? 0,
        nextCursor: allRows.length > limit && items.length > 0 ? makeRunCursor(items[items.length - 1]) : null,
        summary: {
          recentFriends: (periodSpecified ? summary?.period_friends : summary?.recent_friends) ?? 0,
          recentEvents: (periodSpecified ? summary?.period_events : summary?.recent_events) ?? 0,
          capturedFriends: summary?.captured_friends ?? 0,
          returning: summary?.returning_runs ?? 0,
          testPending: null,
          testPendingState: { state: 'unavailable', reason: '実行記録にテスト待ちを区別する情報がありません' },
          failureKinds: Array.from(failureCounts, ([kind, count]) => ({ kind, count })),
          cumulativeDeliveries: summary?.delivery_count ?? 0,
          scenarioStarts: summary?.scenario_starts ?? 0,
          averageSendTimeMs: summary?.average_send_ms == null ? null : Math.max(0, Math.round(summary.average_send_ms)),
          failed: summary?.failed_runs ?? 0,
          lastDeliveryAt: summary?.last_delivery_at ?? null,
          staffHandoffs: { value: null, state: 'unavailable', reason: '担当者引き継ぎと実行イベントを結ぶ記録がありません' },
        }, paging: { limit }, sort: [{ field: 'receivedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }),
    });
  } catch (error) {
    throw error;
  }
};

export const get__api_friend_add_runs_id_2 = async (c: Context<Env, "/api/friend-add-runs/:id">) => {
  const isStaff = c.get('staff').role === 'staff';
  const accountId = accountIdFrom(c);
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const row = await c.env.DB.prepare(
      `SELECT e.id, e.friend_id, f.display_name, e.friend_kind, e.attribution_status,
              e.entry_route_id, er.name AS entry_route_name, e.ref_code,
              e.routing_status, e.error_code, e.occurred_at, e.processed_at,
              r.id AS rule_id, r.name AS rule_name,
              v.id AS version_id, v.version_number, v.definition_snapshot
         FROM friend_add_events e
         JOIN friends f ON f.id = e.friend_id AND f.line_account_id = e.line_account_id
         LEFT JOIN entry_routes er ON er.id = e.entry_route_id
         LEFT JOIN friend_add_rules r ON r.id = e.routing_rule_id AND r.line_account_id = e.line_account_id
         LEFT JOIN friend_add_rule_versions v ON v.id = e.winning_rule_version_id AND v.rule_id = r.id
        WHERE e.id = ? AND e.line_account_id = ? LIMIT 1`,
    ).bind(c.req.param('id'), accountId).first<{
      id: string; friend_id: string; display_name: string | null; friend_kind: string;
      attribution_status: string; entry_route_id: string | null; entry_route_name: string | null;
      ref_code: string | null; routing_status: string; error_code: string | null;
      occurred_at: string; processed_at: string | null; rule_id: string | null; rule_name: string | null;
      version_id: string | null; version_number: number | null; definition_snapshot: string | null;
    }>();
    if (!row) return c.json({ success: false, error: '実行結果が見つかりません' }, 404);
    const definition = row.definition_snapshot ? parseSnapshot(row.definition_snapshot) : null;
    const actions = await c.env.DB.prepare(
      `SELECT id, action_stable_id, action_type, status, attempt_count, next_retry_at,
              last_error_code, started_at, completed_at, created_at, updated_at
         FROM friend_add_action_runs WHERE event_id = ? ORDER BY created_at ASC, id ASC`,
    ).bind(row.id).all<{
      id: string; action_stable_id: string; action_type: string; status: string; attempt_count: number;
      next_retry_at: string | null; last_error_code: string | null; started_at: string | null;
      completed_at: string | null; created_at: string; updated_at: string;
    }>();
    return c.json({
      success: true,
      data: {
        id: row.id,
        receivedAt: row.occurred_at,
        processedAt: row.processed_at,
        friend: runFriendReadModel(row, isStaff),
        friendKind: row.friend_kind,
        attribution: {
          status: row.attribution_status,
          routeId: row.entry_route_id,
          routeName: row.entry_route_name,
          reason: row.ref_code,
        },
        rule: row.rule_id ? {
          id: row.rule_id,
          name: row.rule_name,
          versionId: row.version_id,
          versionNumber: row.version_number,
          ...(isStaff ? {} : { definition }),
        } : null,
        ...(isStaff ? {} : { configuredActions: definition?.actions ?? [] }),
        actionRuns: (actions.results ?? []).map((action) => ({
          id: action.id,
          stableId: action.action_stable_id,
          type: action.action_type,
          status: action.status,
          attemptCount: action.attempt_count,
          nextRetryAt: action.next_retry_at,
          errorCode: safeActionErrorCode(action.last_error_code),
          startedAt: action.started_at ?? action.created_at,
          completedAt: action.completed_at,
          updatedAt: action.updated_at,
        })),
        status: row.routing_status,
        errorCode: row.error_code,
        failureKind: row.routing_status === 'failed' || row.routing_status === 'partial_failed' ? runFailureKind(row.error_code) ?? 'other' : null,
      },
    });
  } catch (error) {
    throw error;
  }
};

export const post__api_friend_add_runs_id_retry_3 = async (c: Context<Env, "/api/friend-add-runs/:id/retry">) => {
  const accountId = accountIdFrom(c);
  if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
  try {
    if (!await canUseAccount(c, accountId)) {
      return c.json({ success: false, error: '実行結果が見つかりません' }, 404);
    }
    const result = await retryFailedFriendAddActions(c.env.DB, {
      eventId: c.req.param('id'),
      lineAccountId: accountId,
    });
    if (!result.found) return c.json({ success: false, error: '実行結果が見つかりません' }, 404);
    if (!result.acquired) {
      return c.json({ success: false, error: '再試行できる失敗処理がないか、すでに再試行中です' }, 409);
    }
    return c.json({
      success: true,
      data: { status: result.status, retried: result.retried ?? 0 },
    });
  } catch (error) {
    throw error;
  }
};

export const post__api_friend_add_rules_folders_4 = async (c: Context<Env, "/api/friend-add-rules/folders">) => {
  const body = await c.req.json<{ accountId?: string; name?: string; color?: string | null }>();
  const accountId = accountIdFrom(c, body);
  const name = body.name?.trim() ?? '';
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (body.color !== undefined && !isFolderSelectColor(body.color)) return inputError(c, { success: false, error: 'フォルダの色を確認してください' }, 422, ["color"]);
  if (!accountId) return inputError(c, { success: false, error: 'accountId が必要です' }, 400, ["accountId"]);
  if (!name || name.length > 60) return inputError(c, { success: false, error: 'フォルダ名は1〜60文字で入力してください' }, 400, ["name"]);
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    return inputError(c, { success: false, error: '保存には有効な冪等キーが必要です' }, 400, []);
  }
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const replay = await c.env.DB.prepare(
      `SELECT id, name, color, created_at FROM friend_add_rule_folders
        WHERE line_account_id = ? AND create_idempotency_key = ? LIMIT 1`,
    ).bind(accountId, idempotencyKey).first<{ id: string; name: string; color: string | null; created_at: string }>();
    if (replay) {
      return c.json({ success: true, data: { id: replay.id, name: replay.name, color: replay.color, createdAt: replay.created_at } });
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO friend_add_rule_folders
        (id, line_account_id, name, color, create_idempotency_key, created_by_staff_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
               strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))`,
    ).bind(id, accountId, name, body.color ?? null, idempotencyKey, c.get('staff').id).run();
    const created = await c.env.DB.prepare(
      `SELECT id, name, color, created_at FROM friend_add_rule_folders
        WHERE id = ? AND line_account_id = ?`,
    ).bind(id, accountId).first<{ id: string; name: string; color: string | null; created_at: string }>();
    return c.json({
      success: true,
      data: { id, name, color: created?.color ?? null, createdAt: created?.created_at ?? null },
    }, 201);
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      return c.json({ success: false, code: 'DUPLICATE_FOLDER_NAME', error: '同じ名前のフォルダがあります' }, 409);
    }
    throw error;
  }
};

export const patch__api_friend_add_rules_folders_id_5 = async (c: Context<Env, "/api/friend-add-rules/folders/:id">) => {
  const body = await c.req.json<{ accountId?: string; name?: string; color?: string | null }>();
  const accountId = accountIdFrom(c, body);
  if (!accountId) return inputError(c, { success: false, error: 'accountId が必要です' }, 400, ["accountId"]);
  if (body.color !== undefined && !isFolderSelectColor(body.color)) return inputError(c, { success: false, error: 'フォルダの色を確認してください' }, 422, ["color"]);
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60)) return inputError(c, { success: false, error: 'フォルダ名は1〜60文字で入力してください' }, 400, ["name"]);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const id = c.req.param('id');
    const folder = await c.env.DB.prepare('SELECT id, name, color FROM friend_add_rule_folders WHERE id=? AND line_account_id=?').bind(id, accountId).first<{ id: string; name: string; color: string | null }>();
    if (!folder) return c.json({ success: false, error: 'フォルダが見つかりません' }, 404);
    const name = body.name === undefined ? folder.name : body.name.trim();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE friend_add_rule_folders SET name=?,color=CASE WHEN ? THEN ? ELSE color END,updated_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id=? AND line_account_id=?").bind(name, body.color !== undefined ? 1 : 0, body.color ?? null, id, accountId),
      c.env.DB.prepare("UPDATE friend_add_rules SET folder_name=?,lock_version=lock_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE line_account_id=? AND folder_name=(SELECT name FROM friend_add_rule_folders WHERE id=? AND line_account_id=?) AND folder_name<>?").bind(name, accountId, id, accountId, name),
    ]);
    const updated = await c.env.DB.prepare('SELECT id,name,color FROM friend_add_rule_folders WHERE id=? AND line_account_id=?').bind(id, accountId).first();
    return c.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) return c.json({ success: false, error: '同じ名前のフォルダがあります' }, 409);
    throw error;
  }
};

export const delete__api_friend_add_rules_folders_id_6 = async (c: Context<Env, "/api/friend-add-rules/folders/:id">) => {
  const text = await c.req.text();
  let body: { accountId?: string } | null;
  try { body = text.trim() ? JSON.parse(text) : null; }
  catch { return c.json({ success: false, error: '入力を確認してください' }, 400); }
  if (body !== null && (typeof body !== 'object' || Array.isArray(body) || (body.accountId !== undefined && typeof body.accountId !== 'string'))) {
    return c.json({ success: false, error: '入力を確認してください' }, 400);
  }
  const accountId = accountIdFrom(c, body ?? undefined);
  if (!accountId) return c.json({ success: false, error: 'accountId が必要です' }, 400);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const id = c.req.param('id');
    const result = await deleteFriendAddRuleFolder(c.env.DB, { lineAccountId: accountId, folderId: id });
    if (result === 'not_found') return c.json({ success: false, error: 'フォルダが見つかりません' }, 404);
    if (result === 'conflict') return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'フォルダが更新されました。読み直してください' }, 409);
    return c.json({ success: true, data: { id, deleted: true } satisfies import('@line-crm/shared').FriendAddRuleFolderDeleteResult });
  } catch (error) {
    throw error;
  }
};

export const get__api_friend_add_rules_7 = async (c: Context<Env, "/api/friend-add-rules">) => {
  const accountId = accountIdFrom(c);
  const kind = c.req.query('kind') as FriendAddRuleKind | undefined;
  if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
  if (!kind || !KINDS.has(kind)) return c.json({ success: false, error: 'kind が正しくありません' }, 400);
  const status = c.req.query('status');
  if (status && !RULE_STATUSES.has(status)) return c.json({ success: false, error: 'status が正しくありません' }, 400);
  // 検索とフォルダ絞りはサーバ側で行う。取得済みページ内だけに効かせると
  // 21件目以降が検索に出ず、フォルダ件数もページ内の数になる。
  const search = c.req.query('q')?.trim() || undefined;
  const folder = c.req.query('folder')?.trim() || undefined;
  const limit = listQueryNumber(c.req.query('limit'), 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ success: false, error: 'limit は1〜100で指定してください' }, 400);
  try {
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    await ensureFriendAddFallbackRules(c.env.DB, accountId);
    const [page, options, summary, ruleSummary, folderCounts, orderVersion] = await Promise.all([
      listFriendAddRulesPage(c.env.DB, {
        lineAccountId: accountId,
        friendKind: kind,
        status: status as FriendAddRuleRow['status'] | undefined,
        cursor: c.req.query('cursor'),
        limit,
        search,
        folderName: folder,
        highlightId: c.req.query('highlight'),
      }),
      loadOptions(c.env.DB, accountId),
      /*
       * R31: まとめの数はすべて直近7日にそろえる。直近7日の友だち追加だけに
       * 期間を付け、ほかを通算にすると同じ期間の成果として比べられない。
       * 「送信成功」は配送処理の完了件数ではなく、実際に送った通数
       * (delivery_count の合計) とし、送信履歴の「累計配信」と同じ数え方に
       * する。失敗は送信履歴の「エラー」と同じく failed と partial_failed
       * (再送待ち) を合わせる。
       */
      c.env.DB.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-7 days') THEN 1 ELSE 0 END), 0) AS recent_adds,
           COALESCE(SUM(CASE WHEN occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-7 days') AND attribution_status = 'captured' THEN 1 ELSE 0 END), 0) AS captured,
           COALESCE(SUM(CASE WHEN occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-7 days') AND attribution_status = 'unavailable' THEN 1 ELSE 0 END), 0) AS unknown_route,
           COALESCE(SUM(CASE WHEN occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-7 days') THEN COALESCE(delivery_count, 0) ELSE 0 END), 0) AS delivered,
           COALESCE(SUM(CASE WHEN occurred_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-7 days') AND routing_status IN ('failed', 'partial_failed') THEN 1 ELSE 0 END), 0) AS failed
         FROM friend_add_events WHERE line_account_id = ? AND friend_kind = ?`,
      ).bind(accountId, kind).first<{
        recent_adds: number | null; captured: number | null; unknown_route: number | null;
        delivered: number | null; failed: number | null;
      }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS rules,
                SUM(CASE WHEN status = 'published' AND is_unknown_route_fallback = 0 THEN 1 ELSE 0 END) AS active
           FROM friend_add_rules
          WHERE line_account_id = ? AND friend_kind = ? AND archived_at IS NULL`,
      ).bind(accountId, kind).first<{ rules: number; active: number | null }>(),
      // フォルダ欄の件数は全ページの合計 (絞り・検索の影響を受けない)。
      c.env.DB.prepare(
        `SELECT folder_name AS folder_name, COUNT(*) AS count
           FROM friend_add_rules
          WHERE line_account_id = ? AND friend_kind = ? AND archived_at IS NULL
          GROUP BY folder_name`,
      ).bind(accountId, kind).all<{ folder_name: string | null; count: number }>(),
      // F8: 並びの版。PUT /order の expectedVersion に使う。
      getFriendAddOrderVersion(c.env.DB, accountId, kind),
    ]);
    const rows = page.items;
    const routeNames = new Map(options.routes.map((route) => [route.id, route.name]));
    const scenarioNames = new Map(options.scenarios.map((scenario) => [scenario.id, scenario.name]));
    return c.json({
      success: true,
      data: buildOffsetListResponse({ items: rows.map((row) => toRule(row, routeNames, scenarioNames)),
        total: page.total,
        nextCursor: page.nextCursor,
        orderVersion,
        folderCounts: (folderCounts.results ?? []).map((entry) => ({
          name: entry.folder_name,
          count: entry.count,
        })),
        summary: {
          rules: ruleSummary?.rules ?? page.total,
          active: ruleSummary?.active ?? 0,
          recentAdds: summary?.recent_adds ?? null,
          captured: summary?.captured ?? null,
          unknownRoute: summary?.unknown_route ?? null,
          delivered: summary?.delivered ?? null,
          failed: summary?.failed ?? null,
        },
        options, paging: { limit }, sort: [] }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIEND_ADD_RULE_CURSOR_INVALID') {
      return c.json({ success: false, error: 'cursor が正しくありません' }, 400);
    }
    throw error;
  }
};

export const patch__api_friend_add_rules_reorder_8 = async (c: Context<Env, "/api/friend-add-rules/reorder">) => {
  try {
    const body = await c.req.json<{ accountId?: string; friendKind?: FriendAddRuleKind; ids?: unknown }>();
    const accountId = accountIdFrom(c, body);
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
    const kind = body.friendKind;
    if (!kind || !KINDS.has(kind)) return inputError(c, { success: false, error: 'friendKind が正しくありません' }, 400, ["friendKind"]);
    if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string')) {
      return inputError(c, { success: false, error: 'ids must be an array of rule ids' }, 400, ["ids"]);
    }
    const ids = body.ids as string[];
    if (ids.length > 500 || new Set(ids).size !== ids.length) {
      return inputError(c, { success: false, error: 'ids must be unique and at most 500' }, 400, ["ids"]);
    }
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const current = await listFriendAddRuleOrderIds(c.env.DB, { lineAccountId: accountId, friendKind: kind });
    if (current.length !== ids.length || !current.every((id) => ids.includes(id))) {
      return c.json({ success: false, code: 'ORDER_CHANGED', error: 'ほかの画面で一覧が変わっています。読み直してから、もう一度お試しください' }, 409);
    }
    await reorderFriendAddRulePriorities(c.env.DB, { lineAccountId: accountId, friendKind: kind, ids });
    return c.json({ success: true, data: { updated: ids.length } });
  } catch (error) {
    throw error;
  }
};

export const put__api_friend_add_rules_order_9 = async (c: Context<Env, "/api/friend-add-rules/order">) => {
  try {
    const body = await c.req.json<{
      accountId?: string; friendKind?: FriendAddRuleKind; ids?: unknown; expectedVersion?: unknown;
    }>();
    const accountId = accountIdFrom(c, body);
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["accountId"]);
    const kind = body.friendKind;
    if (!kind || !KINDS.has(kind)) return inputError(c, { success: false, error: 'friendKind が正しくありません' }, 400, ["friendKind"]);
    if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string')) {
      return inputError(c, { success: false, error: 'ids must be an array of rule ids' }, 400, ["ids"]);
    }
    const ids = body.ids as string[];
    if (ids.length > 500 || new Set(ids).size !== ids.length) {
      return inputError(c, { success: false, error: 'ids must be unique and at most 500' }, 400, ["ids"]);
    }
    if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
      return inputError(c, { success: false, error: 'expectedVersion は0以上の整数で指定してください' }, 400, ["expectedVersion"]);
    }
    if (!await canUseAccount(c, accountId)) return c.json({ success: false, error: '対象のLINEアカウントが見つかりません' }, 404);
    const current = await listFriendAddRuleOrderIds(c.env.DB, { lineAccountId: accountId, friendKind: kind });
    if (current.length !== ids.length || !current.every((id) => ids.includes(id))) {
      return c.json({ success: false, code: 'ORDER_CHANGED', error: 'ほかの画面で一覧が変わっています。読み直してから、もう一度お試しください' }, 409);
    }
    const currentVersion = await getFriendAddOrderVersion(c.env.DB, accountId, kind);
    if (currentVersion !== body.expectedVersion) {
      return c.json({
        success: false,
        code: 'ORDER_VERSION_CONFLICT',
        error: 'ほかの画面で並びが変わっています。最新の状態を読み直してください',
        data: { currentVersion },
      }, 409);
    }
    /*
     * F8補修: 版確認と全順序更新を1文のCASで結ぶ。確認と書込のあいだへ
     * 割り込まれても、版がずれていれば1行も書かず409にする。
     */
    try {
      await reorderFriendAddRulePrioritiesCAS(c.env.DB, {
        lineAccountId: accountId,
        friendKind: kind,
        ids,
        expectedVersion: body.expectedVersion as number,
      });
    } catch {
      // 確認後に割り込まれた。何が変わったか読み直して理由を分ける。
      const raced = await listFriendAddRuleOrderIds(c.env.DB, { lineAccountId: accountId, friendKind: kind });
      if (raced.length !== ids.length || !raced.every((id) => ids.includes(id))) {
        return c.json({ success: false, code: 'ORDER_CHANGED', error: 'ほかの画面で一覧が変わっています。読み直してから、もう一度お試しください' }, 409);
      }
      const racedVersion = await getFriendAddOrderVersion(c.env.DB, accountId, kind);
      return c.json({
        success: false,
        code: 'ORDER_VERSION_CONFLICT',
        error: 'ほかの画面で並びが変わっています。最新の状態を読み直してください',
        data: { currentVersion: racedVersion },
      }, 409);
    }
    const orderVersion = await getFriendAddOrderVersion(c.env.DB, accountId, kind);
    return c.json({ success: true, data: { updated: ids.length, orderVersion } });
  } catch (error) {
    throw error;
  }
};
