import { serializeConversionPoint } from './conversion-point-serialization.js';
import { inputError } from '../lib/input-errors.js';
import { conversionApprovalCounts } from '../services/tab-counts.js';
import { fail } from '../lib/fail.js';
import { getConversionPoints, getConversionPointById, canRecordConversion, createConversionPoint, hasConversionPointActivity, updateConversionPoint, stopConversionPoint, trackConversion, getConversionEvents, getConversionApprovalQueue, addConversionDefinitionUsage, getConversionDefinitionReport, listConversionDefinitionsForExport, appendConversionReversal, getReversedEventIds, listConversionReversals, CONVERSION_DEFINITION_USAGE_KINDS } from '@line-crm/db';
import { IDENTITY_KEY_SQL } from '../lib/identity-key.js';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';

import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import type { ConversionDefinitionUsageKind } from '@line-crm/db';
import { conversionContractError, conversionRange, definitionFilters, conversionDefinitionScope, csvCell, jstDate, adminAccountScope, ConversionPointBody, readMeasureOptions, positiveVersion, CONVERSION_MEASURE_PATCH_KEYS, parseDate, APPROVAL_STATUSES } from './conversions-definition.js';
import type { Context } from 'hono';

export const post__api_conversions_definitions_id_usages_1 = async (c: Context<Env, "/api/conversions/definitions/:id/usages">) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: unknown;
      expectedVersion?: unknown;
      refKind?: unknown;
      refId?: unknown;
      refVersionId?: unknown;
    }>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'JSON本文が正しくありません' }, 400, []);
    const lineAccountId = typeof body.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
    const refId = typeof body.refId === 'string' ? body.refId.trim() : '';
    const expectedVersion = Number(body.expectedVersion);
    const refKind = body.refKind as ConversionDefinitionUsageKind;
    const refVersionId = body.refVersionId === null || body.refVersionId === undefined
      ? null
      : typeof body.refVersionId === 'string' ? body.refVersionId.trim() : '';
    if (!lineAccountId || !refId || refId.length > 200
      || !Number.isInteger(expectedVersion) || expectedVersion < 1
      || !CONVERSION_DEFINITION_USAGE_KINDS.includes(refKind)
      || (refVersionId !== null && (!refVersionId || refVersionId.length > 200))) {
      return inputError(c, { success: false, error: 'lineAccountId、expectedVersion、refKind、refIdを正しく指定してください' }, 400, ["lineAccountId","refId","expectedVersion","refKind","refVersionId"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    }
    const result = await addConversionDefinitionUsage(c.env.DB, {
      conversionPointId: c.req.param('id'),
      lineAccountId,
      expectedVersion,
      refKind,
      refId,
      refVersionId,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.usage.create', {
      kind: `conversion_definition_usage:${refKind}`,
      id: c.req.param('id'),
    });
    return c.json({ success: true, data: result }, result.created ? 201 : 200);
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_export_2 = async (c: Context<Env, "/api/conversions/export">) => {
  try {
    const range = conversionRange(c);
    if (!range.ok) return range.response;
    const filters = definitionFilters(c);
    if (!filters.ok) return filters.response;
    const scope = await conversionDefinitionScope(c, filters.value.lineAccountId);
    if (!scope.ok) return scope.response;
    const { items, truncated } = await listConversionDefinitionsForExport(c.env.DB, {
      scope: scope.value,
      ...filters.value,
      range: range.range,
    });
    const headers = [
      '期間開始', '期間終了', 'タイムゾーン', '純額定義', '成果地点ID', '成果地点名',
      '起点', '状態', '状態詳細', '成果件数', '純成果件数', '取消件数', '純金額', '利用先数', '更新日時',
    ];
    c.set('outputAudit', { count: items.length, accountId: filters.value.lineAccountId ?? undefined, accountIds: [...scope.value.allowedAccountIds], accountCounts: Object.fromEntries(scope.value.allowedAccountIds.map(id => [id, items.filter(item => item.lineAccountId === id).length])) });
    const rows = items.map((item) => [
      range.range.from,
      range.range.to,
      range.range.timeZone,
      item.metrics.reversalReason,
      item.id,
      item.name,
      item.sourceType,
      item.status,
      item.stateReason ?? '',
      item.metrics.recordedCount,
      item.metrics.netCount,
      item.metrics.reversedCount,
      item.metrics.netValue,
      item.usageCount,
      item.updatedAt,
    ]);
    // 件数で切ったCSVが全件に見えないよう、先頭行で打ち切りを明記する。
    const headerNote = truncated
      ? '# 成果地点の書出し…先頭10000件まで。続きは期間や絞り込みを分けて出してください。'
      : '# 成果地点の書出し…最大10000件まで';
    const csv = `\uFEFF${headerNote}\r\n${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
    auditLog(c, 'conversion.report.export', {
      kind: 'conversion_definition_export', id: String(items.length),
    });
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="conversion-definitions-${jstDate(new Date())}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_points_3 = async (c: Context<Env, "/api/conversions/points">) => {
  try {
    const { scope } = await adminAccountScope(c);
    const scopedItems = await getConversionPoints(c.env.DB, {
      allowedLineAccountIds: scope.allowedAccountIds,
      includeUnassigned: scope.canSeeUnassigned,
    });
    // SQL側で件数を絞ったうえで、DB実装やテスト用アダプタが誤って
    // 範囲外を返してもテナント境界を越えないよう返却直前にも確認する。
    const allowedAccountIds = new Set(scope.allowedAccountIds);
    const items = scopedItems.filter((item) => item.line_account_id === null
      ? scope.canSeeUnassigned
      : allowedAccountIds.has(item.line_account_id));
    return c.json({
      success: true,
      data: items.map(serializeConversionPoint),
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_conversions_points_4 = async (c: Context<Env, "/api/conversions/points">) => {
  try {
    const body = await c.req.json<ConversionPointBody>();

    if (!body.name || !body.eventType) {
      return inputError(c, { success: false, error: 'name and eventType are required' }, 400, ["name","eventType"]);
    }
    // 定義作成と同じ120文字上限。一覧表示が崩れないため。
    if (String(body.name).trim().length > 120) {
      return inputError(c, { success: false, error: 'name must be 120 characters or less' }, 400, ["name"]);
    }

    const options = readMeasureOptions(body);
    if (!options.ok) return inputError(c, { success: false, error: options.error }, 400, ["measureMethod","targetUrl","countRepeat","attributionDays","lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [options.value.lineAccountId as string | null])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }

    const point = await createConversionPoint(c.env.DB, {
      name: String(body.name),
      eventType: String(body.eventType),
      value: body.value === null || body.value === undefined ? null : Number(body.value),
      ...options.value,
    });
    return c.json({ success: true, data: serializeConversionPoint(point) }, 201);
  } catch (err) {
    throw err;
  }
};

export const put__api_conversions_points_id_5 = async (c: Context<Env, "/api/conversions/points/:id">) => {
  try {
    const id = c.req.param('id');
    const current = await getConversionPointById(c.env.DB, id);
    if (!current) return c.json({ success: false, error: 'Not found' }, 404);

    const body = await c.req.json<ConversionPointBody>();
    /*
     * 版は本文が正本。代理やプロキシで本文が落ちたときだけクエリを見る
     * 。定義系の stop / replace / delete と同じ約束にする。
     */
    const expectedVersion = positiveVersion(body.expectedVersion)
      ?? positiveVersion(c.req.query('expectedVersion'));
    if (expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください。本文が落ちる通信経路ではクエリでも指定できます' }, 400, ["expectedVersion"]);
    }
    if (current.version !== expectedVersion) {
      return c.json({
        success: false,
        error: '成果地点が更新されています。読み直してください',
        currentVersion: current.version,
      }, 409);
    }

    const options = readMeasureOptions(body, current);
    if (!options.ok) return inputError(c, { success: false, error: options.error }, 400, ["measureMethod","targetUrl","countRepeat","attributionDays","lineAccountId"]);
    if ('lineAccountId' in options.value
      && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [options.value.lineAccountId as string | null])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }

    const patch: Record<string, unknown> = { ...options.value };
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return inputError(c, { success: false, error: 'name must not be empty' }, 400, ["name"]);
      if (name.length > 120) return inputError(c, { success: false, error: 'name must be 120 characters or less' }, 400, ["name"]);
      patch.name = name;
    }
    if (body.eventType !== undefined) patch.eventType = String(body.eventType);
    if ('value' in body) {
      patch.value = body.value === null || body.value === '' ? null : Number(body.value);
    }

    const touchesMeasure = Object.keys(patch).some((key) => CONVERSION_MEASURE_PATCH_KEYS.has(key));
    if (touchesMeasure
      && (current.status === 'active' || await hasConversionPointActivity(c.env.DB, id))) {
      return c.json({
        success: false,
        error: '稼働中または成果・利用先のある地点の数え方は、この口では変えられません。新しい成果地点を作るか、停止してから変えてください',
      }, 409);
    }

    let point;
    try {
      point = await updateConversionPoint(c.env.DB, id, patch, { expectedVersion });
    } catch (error) {
      // 読み取りから書込みの間に別操作が版を進めたときだけここに来る。
      if (error instanceof Error && error.message === 'conversion_point_version_conflict') {
        const latest = await getConversionPointById(c.env.DB, id);
        return c.json({
          success: false,
          error: '成果地点が更新されています。読み直してください',
          currentVersion: latest?.version ?? current.version,
        }, 409);
      }
      throw error;
    }
    if (!point) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeConversionPoint(point) });
  } catch (err) {
    throw err;
  }
};

export const delete__api_conversions_points_id_6 = async (c: Context<Env, "/api/conversions/points/:id">) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion)
      ?? positiveVersion(c.req.query('expectedVersion'));
    if (expectedVersion === null) {
      return c.json({ success: false, error: 'expectedVersionを正しく指定してください。本文が落ちる通信経路ではクエリでも指定できます' }, 400);
    }
    try {
      await stopConversionPoint(c.env.DB, id, expectedVersion);
    } catch (error) {
      if (error instanceof Error && error.message === 'conversion_point_not_found') {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
      if (error instanceof Error && error.message === 'conversion_point_already_stopped') {
        return c.json({ success: false, error: 'この成果地点はすでに停止しています' }, 409);
      }
      if (error instanceof Error && error.message === 'conversion_point_version_conflict') {
        const latest = await getConversionPointById(c.env.DB, id);
        return c.json({
          success: false,
          error: '成果地点が更新されています。読み直してください',
          currentVersion: latest?.version ?? expectedVersion,
        }, 409);
      }
      throw error;
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
};

export const post__api_conversions_track_7 = async (c: Context<Env, "/api/conversions/track">) => {
  try {
    const body = await c.req.json<{
      conversionPointId: string;
      friendId: string;
      userId?: string | null;
      affiliateCode?: string | null;
      metadata?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
    }>();

    if (!body.conversionPointId || !body.friendId) {
      return inputError(c, { success: false, error: 'conversionPointId and friendId are required' }, 400, ["conversionPointId","friendId"]);
    }

    const [pointAccount, friendAccount] = await Promise.all([
      c.env.DB.prepare('SELECT line_account_id, status FROM conversion_points WHERE id = ?')
        .bind(body.conversionPointId).first<{ line_account_id: string | null; status: string }>(),
      c.env.DB.prepare('SELECT line_account_id FROM friends WHERE id = ?')
        .bind(body.friendId).first<{ line_account_id: string | null }>(),
    ]);
    if (!pointAccount || !friendAccount || !await canAccessAllLineAccounts(
      c.env.DB,
      c.get('staff'),
      [pointAccount.line_account_id, friendAccount.line_account_id],
    )) {
      return c.json({ success: false, error: 'このコンバージョンを記録する権限がありません' }, 403);
    }
    // 地点と友だちのアカウントの組み合わせも見る。両方を見られる職員でも
    // 交差記録はできない。地点が全アカウント対象(NULL)のときだけ交差を許可する。
    if (!canRecordConversion(pointAccount.line_account_id, friendAccount.line_account_id)) {
      return c.json({ success: false, error: '地点と友だちのアカウントが違うため記録できません' }, 403);
    }
    if (pointAccount.status === 'stopped') {
      return c.json({ success: false, error: 'この成果地点は計測を停止しています' }, 409);
    }
    if (
      body.idempotencyKey !== undefined
      && (typeof body.idempotencyKey !== 'string'
        || body.idempotencyKey.length < 1
        || body.idempotencyKey.length > 200)
    ) {
      return inputError(c, { success: false, error: 'idempotencyKey must be 1 to 200 characters' }, 400, ["idempotencyKey"]);
    }

    const event = await trackConversion(c.env.DB, {
      conversionPointId: body.conversionPointId,
      friendId: body.friendId,
      userId: body.userId,
      affiliateCode: body.affiliateCode,
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    return c.json({
      success: true,
      data: {
        id: event.id,
        conversionPointId: event.conversion_point_id,
        friendId: event.friend_id,
        userId: event.user_id,
        affiliateCode: event.affiliate_code,
        metadata: event.metadata,
        createdAt: event.created_at,
      },
    }, 201);
  } catch (err) {
    // 同じ冪等キーの別内容の使い回しは409。同じ再送は上で200/201相当を返している。
    if (err instanceof Error && err.message === 'conversion_idempotency_key_conflict') {
      return c.json({ success: false, error: 'このキーは別の内容で既に使われています' }, 409);
    }
    // helper内部の境界判定は公開 /t/:linkId を含む全callerで共通。
    // 管理口では競合中にaccountが変わった場合も権限エラーとして返す。
    if (err instanceof Error && err.message === 'conversion_account_mismatch') {
      return c.json({ success: false, error: '地点と友だちのアカウントが違うため記録できません' }, 403);
    }
    if (err instanceof Error && err.message === 'conversion_friend_not_found') {
      return c.json({ success: false, error: 'このコンバージョンを記録する権限がありません' }, 403);
    }
    // R40: 数えない条件に当てはまる人は記録しない。失敗ではなく対象外。
    if (err instanceof Error && err.message === 'conversion_excluded') {
      return inputError(c, { success: false, error: '「数えない条件」に当てはまるため記録できません' }, 422, []);
    }
    throw err;
  }
};

export const get__api_conversions_events_8 = async (c: Context<Env, "/api/conversions/events">) => {
  try {
    // 日付は他口と同じ厳密な暦日で見る。不正値は辞書順比較にせず400にする。
    const rawStart = c.req.query('startDate') ?? undefined;
    const rawEnd = c.req.query('endDate') ?? undefined;
    if ((rawStart !== undefined && !parseDate(rawStart)) || (rawEnd !== undefined && !parseDate(rawEnd))) {
      return c.json({ success: false, error: 'startDate と endDate は YYYY-MM-DD で正しく指定してください' }, 400);
    }
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const paging = parseOffsetPaging(
      { limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 100 },
    );
    const events = await getConversionEvents(c.env.DB, {
      scope: { allowedAccountIds: scope.allowedAccountIds, includeUnassigned: scope.canSeeUnassigned },
      conversionPointId: c.req.query('conversionPointId'),
      friendId: c.req.query('friendId'),
      affiliateCode: c.req.query('affiliateCode'),
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
      limit: paging.limit,
      offset: paging.offset,
    });

    // 取消は追記の台帳。最新の追記が 'reverse' のものだけを
    // 「取り消し中」として返す。
    const reversedIds = await getReversedEventIds(c.env.DB, events.map((e) => e.id));

    const responseItems = events.map((e) => ({
        id: e.id,
        conversionPointId: e.conversion_point_id,
        friendId: e.friend_id,
        userId: e.user_id,
        affiliateCode: e.affiliate_code,
        metadata: e.metadata,
        createdAt: e.created_at,
        reversed: reversedIds.has(e.id),
      }));
    return c.json(buildOffsetListResponse({ success: true, data: responseItems, items: responseItems, total: null, paging: { limit: paging.limit, offset: paging.offset }, sort: [] }));
  } catch (err) {
    throw err;
  }
};

export const get__api_conversions_events_id_reversals_9 = async (c: Context<Env, "/api/conversions/events/:id/reversals">) => {
    try {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const eventId = c.req.param('id');
      const event = await c.env.DB
        .prepare(
          `SELECT ce.id, cp.line_account_id
             FROM conversion_events ce
             JOIN conversion_points cp ON cp.id = ce.conversion_point_id
            WHERE ce.id = ?`,
        )
        .bind(eventId)
        .first<{ id: string; line_account_id: string | null }>();
      if (!event) return fail(c, 404, 'EVENT_NOT_FOUND');
      if (
        event.line_account_id !== null
        && !scope.allowedAccountIds.includes(event.line_account_id)
      ) {
        return fail(c, 404, 'EVENT_NOT_FOUND');
      }
      const rows = await listConversionReversals(c.env.DB, eventId);
      return c.json({
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          reason: r.reason,
          actorName: r.actor_name,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      throw err;
    }
  };

export const post__api_conversions_events_id_reversals_10 = async (c: Context<Env, "/api/conversions/events/:id/reversals">) => {
    try {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const eventId = c.req.param('id');
      const event = await c.env.DB
        .prepare(
          `SELECT ce.id, cp.line_account_id
             FROM conversion_events ce
             JOIN conversion_points cp ON cp.id = ce.conversion_point_id
            WHERE ce.id = ?`,
        )
        .bind(eventId)
        .first<{ id: string; line_account_id: string | null }>();
      if (!event) return fail(c, 404, 'EVENT_NOT_FOUND');
      if (
        event.line_account_id !== null
        && !scope.allowedAccountIds.includes(event.line_account_id)
      ) {
        return fail(c, 404, 'EVENT_NOT_FOUND');
      }

      const body = await c.req.json<{ kind?: unknown; reason?: unknown; expectedReversalId?: unknown; expectedApprovalStatus?: unknown; expectedCancelled?: unknown; expectedApprovalRevision?: unknown }>();
      if (body.expectedApprovalRevision !== undefined && (!Number.isSafeInteger(body.expectedApprovalRevision) || (body.expectedApprovalRevision as number) < 1 || body.expectedReversalId === undefined)) {
        return inputError(c, { success: false, error: '確認情報が正しくありません' }, 400, ['expectedApprovalRevision']);
      }
      if (body.expectedReversalId !== undefined && body.expectedReversalId !== null && (typeof body.expectedReversalId !== 'string' || !body.expectedReversalId)) {
        return inputError(c, { success: false, error: '確認情報が正しくありません' }, 400, ['expectedReversalId']);
      }
      if (body.expectedReversalId !== undefined &&
        (!(body.expectedApprovalStatus === null || body.expectedApprovalStatus === 'pending' || body.expectedApprovalStatus === 'approved' || body.expectedApprovalStatus === 'rejected') || typeof body.expectedCancelled !== 'boolean')) {
        return inputError(c, { success: false, error: '確認情報が正しくありません' }, 400, ['expectedApprovalStatus', 'expectedCancelled']);
      }
      const kind = body.kind === 'restore' ? 'restore' : body.kind === 'reverse' ? 'reverse' : null;
      if (!kind) {
        return inputError(c, { success: false, error: 'kind は reverse か restore で指定してください' }, 400, ["kind"]);
      }
      const reason = String(body.reason ?? '').trim();
      if (!reason || reason.length > 500) {
        return inputError(c, { success: false, error: '理由を入れてください（500文字以内）' }, 400, ["reason"]);
      }
      const staff = c.get('staff');
      try {
        const row = await appendConversionReversal(c.env.DB, {
          conversionEventId: eventId,
          kind,
          reason,
          actorId: staff?.id ?? null,
          actorName: staff?.name ?? null,
          expectedReversalId: body.expectedReversalId as string | null | undefined,
          expectedApprovalStatus: body.expectedApprovalStatus as 'pending' | 'approved' | 'rejected' | null | undefined,
          expectedApprovalRevision: body.expectedApprovalRevision as number | undefined,
          expectedCancelled: body.expectedCancelled as boolean | undefined,
        });
        auditLog(
          c,
          kind === 'reverse' ? 'conversion.event.reverse' : 'conversion.event.restore',
          { kind: 'conversion_event', id: eventId },
          { lineAccountId: event.line_account_id },
        );
        return c.json({
          success: true,
          data: { id: row.id, kind: row.kind, createdAt: row.created_at },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message === 'conversion_event_stale') {
          return c.json({ success: false, error: '成果の取消状態が変わりました。読み直してください' }, 409);
        }
        if (message === 'conversion_event_already_reversed') {
          return c.json({ success: false, error: 'この成果はすでに取り消されています' }, 409);
        }
        if (message === 'conversion_event_not_reversed') {
          return c.json({ success: false, error: 'この成果は取り消されていません' }, 409);
        }
        throw err;
      }
    } catch (err) {
      throw err;
    }
  };

export const get__api_conversions_report_11 = async (c: Context<Env, "/api/conversions/report">) => {
  try {
    if (c.req.query('startDate') !== undefined || c.req.query('endDate') !== undefined) {
      /*
       * 応答形式が異なっても集計値がずれないよう、getConversionDefinitionReport を共通で使う。
       * 暦日・スナップショット・取消控除を一致させ、旧形式の totalCount/totalValue は取消を含む総数へ戻す。
       */
      const startDate = c.req.query('startDate');
      const endDate = c.req.query('endDate');
      if ((startDate !== undefined && !parseDate(startDate))
        || (endDate !== undefined && !parseDate(endDate))) {
        return c.json({ success: false, error: 'startDate と endDate は YYYY-MM-DD で指定してください' }, 400);
      }
      const scope = await conversionDefinitionScope(c);
      if (!scope.ok) return scope.response;
      const data = await getConversionDefinitionReport(c.env.DB, {
        scope: scope.value,
        range: {
          from: startDate ? `${startDate} 00:00:00` : '0001-01-01 00:00:00',
          to: endDate ? `${endDate} 23:59:59` : '9999-12-31 23:59:59',
          timeZone: 'Asia/Tokyo',
        },
        // 旧形に前期間は無い。成立しない範囲を渡して0件にする。
        previousRange: { from: '9999-01-01 00:00:00', to: '0001-01-01 00:00:00', timeZone: 'Asia/Tokyo' },
      });
      const report = data.byDefinition
        .map((row) => ({
          conversionPointId: row.conversionPointId,
          conversionPointName: row.conversionPointName,
          eventType: row.sourceType,
          totalCount: row.netCount + (row.cancellationCount ?? 0),
          totalValue: row.netValue + (row.cancellationValue ?? 0),
        }))
        .sort((a, b) => b.totalCount - a.totalCount);
      return c.json({ success: true, data: report });
    }

    const range = conversionRange(c);
    if (!range.ok) return range.response;
    const lineAccountId = c.req.query('lineAccountId');
    const scope = await conversionDefinitionScope(c, lineAccountId);
    if (!scope.ok) return scope.response;
    const data = await getConversionDefinitionReport(c.env.DB, {
      scope: scope.value,
      lineAccountId,
      range: range.range,
      previousRange: range.previousRange,
    });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_approvals_counts_12 = async (c: Context<Env, "/api/conversions/approvals/counts">) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    return c.json({ success: true, data: await conversionApprovalCounts(c.env.DB, {
      allowedAccountIds: scope.allowedAccountIds, includeUnassigned: scope.canSeeUnassigned,
    }) });
  } catch (err) {
    throw err;
  }
};

export const get__api_conversions_approvals_13 = async (c: Context<Env, "/api/conversions/approvals">) => {
  try {
    const status = c.req.query('status') ?? 'pending';
    if (!APPROVAL_STATUSES.has(status)) {
      return c.json(
        { success: false, error: 'status must be pending, approved, or rejected' },
        400,
      );
    }

    const { limit, offset } = parseOffsetPaging(
      { limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 200 },
    );

    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const rows = await getConversionApprovalQueue(c.env.DB, {
      scope: { allowedAccountIds: scope.allowedAccountIds, includeUnassigned: scope.canSeeUnassigned },
      status: status as 'pending' | 'approved' | 'rejected',
      identityKeySql: IDENTITY_KEY_SQL,
      limit,
      offset,
    });

    const responseItems = rows;
    return c.json(buildOffsetListResponse({ success: true, data: responseItems, items: responseItems, total: null, paging: { limit, offset }, sort: [] }));
  } catch (err) {
    throw err;
  }
};
