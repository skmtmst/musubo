import { logger } from '@line-crm/shared/server';
import { consumePublicIngressReceipt } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { trackConversion, listConversionDefinitions, getConversionDefinitionDetail, createConversionDefinition, previewConversionDefinition, getConversionDefinitionDeleteImpact, stopConversionDefinition, replaceConversionDefinitionUsages, reviseConversionDefinition, deleteUnusedConversionDefinition, publishConversionDefinition, issueConversionIngestSecret, setConversionIngestDisabled, getConversionPointForIngest, resolveConversionIngestSecret, recordConversionIngestionEvent, listConversionIngestionEvents, listConversionDefinitionEvents, CONVERSION_DEFINITION_USAGE_KINDS } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { buildOffsetListResponse, listLimit, listQueryNumber, parseOffsetPaging } from '../lib/list-paging.js';
import { computeHmacSha256Hex, safeEqualHex } from '../lib/hmac.js';
import { maskedPayloadShape } from '../services/incoming-webhook-actions.js';
import { sha256Hex } from '../middleware/auth.js';
import type { ConversionDefinitionUsageKind } from '@line-crm/db';
import { conversionRange, definitionFilters, conversionDefinitionScope, conversionContractError, findConversionIngestFriends, readDefinitionInput, plainObject, positiveVersion, readReason, MAX_INGEST_BODY_BYTES, INGEST_SIGNATURE_HEADER, INGEST_EVENT_ID_HEADER } from './conversions-definition.js';
import type { Context } from 'hono';

export const get__api_conversions_definitions_1 = async (c: Context<Env, "/api/conversions/definitions">) => {
  try {
    const range = conversionRange(c);
    if (!range.ok) return range.response;
    const filters = definitionFilters(c);
    if (!filters.ok) return filters.response;
    const scope = await conversionDefinitionScope(c, filters.value.lineAccountId);
    if (!scope.ok) return scope.response;
    const cursorRaw = c.req.query('cursor') ?? '0';
    const cursor = listQueryNumber(cursorRaw, Number.NaN);
    if (!/^\d+$/.test(cursorRaw) || !Number.isSafeInteger(cursor)) {
      return c.json({ success: false, error: 'cursor は0以上の整数で指定してください' }, 400);
    }
    const data = await listConversionDefinitions(c.env.DB, {
      scope: scope.value,
      ...filters.value,
      range: range.range,
      cursor,
      limit: listLimit(c.req.query('limit'), 50),
    });
    return c.json({ success: true, data: buildOffsetListResponse({ ...data, total: data.pagination.total, paging: { limit: data.pagination.limit }, sort: [] }) });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_2 = async (c: Context<Env, "/api/conversions/definitions">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'JSON本文が正しくありません' }, 400, []);
    const definition = readDefinitionInput(body);
    const rawUsages = Array.isArray(body.usages) ? body.usages : [];
    const usages = rawUsages.map((raw) => {
      const usage = plainObject(raw);
      return usage && CONVERSION_DEFINITION_USAGE_KINDS.includes(usage.refKind as ConversionDefinitionUsageKind)
        && typeof usage.refId === 'string' && usage.refId.trim() && usage.refId.length <= 200
        ? {
            refKind: usage.refKind as ConversionDefinitionUsageKind,
            refId: usage.refId.trim(),
            refVersionId: typeof usage.refVersionId === 'string' && usage.refVersionId.trim()
              ? usage.refVersionId.trim() : null,
          }
        : null;
    });
    if (!definition || usages.some((usage) => usage === null)) {
      return inputError(c, { success: false, error: '成果地点の入力内容を正しく指定してください' }, 400, ["name","sourceType","sourceConfig","lineAccountId","deduplicationMode","valueMode","reversalPolicy","deduplicationWindowDays","fixedValue","attributionDays","targetUrl","usages"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [definition.lineAccountId])) {
      return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    }
    const data = await createConversionDefinition(c.env.DB, {
      ...definition,
      folderId: body.folderId,
      usages: usages.filter((usage): usage is NonNullable<typeof usage> => usage !== null),
      staffId: c.get('staff')!.id,
      // 下書きで保存すると公開まで計測しない。
      draft: body.draft === true,
    });
    auditLog(c, 'conversion.definition.create', { kind: 'conversion_definition', id: data!.id });
    return c.json({ success: true, data }, 201);
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_preview_3 = async (c: Context<Env, "/api/conversions/definitions/preview">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'JSON本文が正しくありません' }, 400, []);
    const definition = readDefinitionInput({ name: '保存前試算', reversalPolicy: 'manual', ...body });
    if (!definition) return inputError(c, { success: false, error: '試算する入力内容を正しく指定してください' }, 400, ["definition"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [definition.lineAccountId])) {
      return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    }
    const scope = await conversionDefinitionScope(c, definition.lineAccountId);
    if (!scope.ok) return scope.response;
    const range = conversionRange(c);
    if (!range.ok) return range.response;
    const data = await previewConversionDefinition(c.env.DB, {
      scope: scope.value,
      lineAccountId: definition.lineAccountId,
      sourceType: definition.sourceType,
      // 保存と同じ一式を渡し、URL・窓・取消条件も試算へ反映する。
      sourceConfig: definition.sourceConfig,
      measureMethod: definition.measureMethod,
      targetUrl: definition.targetUrl,
      deduplicationMode: definition.deduplicationMode,
      deduplicationWindowDays: definition.deduplicationWindowDays,
      valueMode: definition.valueMode,
      fixedValue: definition.fixedValue,
      reversalPolicy: definition.reversalPolicy,
      range: range.range,
    });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_definitions_id_4 = async (c: Context<Env, "/api/conversions/definitions/:id">) => {
  try {
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await getConversionDefinitionDetail(c.env.DB, c.req.param('id'), scope.value);
    if (!data) return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_definitions_id_delete_impact_5 = async (c: Context<Env, "/api/conversions/definitions/:id/delete-impact">) => {
  try {
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await getConversionDefinitionDeleteImpact(c.env.DB, c.req.param('id'), scope.value);
    if (!data) return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_stop_6 = async (c: Context<Env, "/api/conversions/definitions/:id/stop">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const parsedReason = readReason(body);
    if (!parsedReason.ok) return inputError(c, { success: false, error: parsedReason.error }, 400, ["reason"]);
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await stopConversionDefinition(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      reason: parsedReason.reason,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.stop', { kind: 'conversion_definition', id: c.req.param('id') });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_revise_7 = async (c: Context<Env, "/api/conversions/definitions/:id/revise">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const parsedReason = readReason(body);
    if (!parsedReason.ok) return inputError(c, { success: false, error: parsedReason.error }, 400, ["reason"]);
    const definition = readDefinitionInput(body, { requireAccount: false });
    if (!definition) {
      return inputError(c, { success: false, error: '成果地点の入力内容を正しく指定してください' }, 400, ["name","sourceType","sourceConfig","lineAccountId","deduplicationMode","valueMode","reversalPolicy","deduplicationWindowDays","fixedValue","attributionDays","targetUrl"]);
    }
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await reviseConversionDefinition(c.env.DB, {
      id: c.req.param('id'),
      scope: scope.value,
      expectedVersion,
      name: definition.name,
      folderId: body.folderId,
      sourceType: definition.sourceType,
      sourceConfig: definition.sourceConfig,
      measureMethod: definition.measureMethod,
      targetUrl: definition.targetUrl,
      deduplicationMode: definition.deduplicationMode,
      deduplicationWindowDays: definition.deduplicationWindowDays,
      valueMode: definition.valueMode,
      fixedValue: definition.fixedValue,
      reversalPolicy: definition.reversalPolicy,
      attributionDays: definition.attributionDays,
      reason: parsedReason.reason,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.revise', { kind: 'conversion_definition', id: c.req.param('id') });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_replace_8 = async (c: Context<Env, "/api/conversions/definitions/:id/replace">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    const replacementExpectedVersion = positiveVersion(body?.replacementExpectedVersion);
    const replacementId = typeof body?.replacementId === 'string' ? body.replacementId.trim() : '';
    if (!body || expectedVersion === null || replacementExpectedVersion === null || !replacementId) {
      return inputError(c, { success: false, error: '差し替え先と版を正しく指定してください' }, 400, ["expectedVersion","replacementExpectedVersion","replacementId"]);
    }
    const parsedReason = readReason(body);
    if (!parsedReason.ok) return inputError(c, { success: false, error: parsedReason.error }, 400, ["reason"]);
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await replaceConversionDefinitionUsages(c.env.DB, {
      id: c.req.param('id'), replacementId, scope: scope.value,
      expectedVersion, replacementExpectedVersion,
      reason: parsedReason.reason,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.replace', { kind: 'conversion_definition', id: c.req.param('id') });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const delete__api_conversions_definitions_id_9 = async (c: Context<Env, "/api/conversions/definitions/:id">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    /*
     * 版は本文が正本。代理やプロキシで本文が落ちたときだけクエリを見る
     * 。どちらも無ければ案内文で400にする。
     */
    const expectedVersion = positiveVersion(body?.expectedVersion)
      ?? positiveVersion(c.req.query('expectedVersion'));
    if (expectedVersion === null) {
      return c.json({ success: false, error: 'expectedVersionを正しく指定してください。本文が落ちる通信経路ではクエリでも指定できます' }, 400);
    }
    const parsedReason = readReason(body);
    if (!parsedReason.ok) return c.json({ success: false, error: parsedReason.error }, 400);
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await deleteUnusedConversionDefinition(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      reason: parsedReason.reason,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.delete', { kind: 'conversion_definition', id: c.req.param('id') });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_publish_10 = async (c: Context<Env, "/api/conversions/definitions/:id/publish">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await publishConversionDefinition(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.publish', { kind: 'conversion_definition', id: c.req.param('id') });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_ingest_secret_11 = async (c: Context<Env, "/api/conversions/definitions/:id/ingest-secret">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await issueConversionIngestSecret(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      staffId: c.get('staff')!.id,
      keys: {
        current: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        previous: typeof (c.env as unknown as Record<string, unknown>).LINE_CREDENTIAL_PREVIOUS_KEYS === 'string'
          ? (c.env as unknown as Record<string, string>).LINE_CREDENTIAL_PREVIOUS_KEYS
          : undefined,
      },
    });
    auditLog(c, 'conversion.definition.ingest_secret.issue', {
      kind: 'conversion_definition', id: c.req.param('id'),
    });
    return c.json({
      success: true,
      data: {
        ...data,
        endpoint: `/api/conversions/ingest/${encodeURIComponent(c.req.param('id'))}`,
      },
    });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_ingest_disable_12 = async (c: Context<Env, "/api/conversions/definitions/:id/ingest-disable">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await setConversionIngestDisabled(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      disabled: true,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.ingest.disable', {
      kind: 'conversion_definition', id: c.req.param('id'),
    });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_definitions_id_ingest_enable_13 = async (c: Context<Env, "/api/conversions/definitions/:id/ingest-enable">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = positiveVersion(body?.expectedVersion);
    if (!body || expectedVersion === null) {
      return inputError(c, { success: false, error: 'expectedVersionを正しく指定してください' }, 400, ["expectedVersion"]);
    }
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const data = await setConversionIngestDisabled(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, expectedVersion,
      disabled: false,
      staffId: c.get('staff')!.id,
    });
    auditLog(c, 'conversion.definition.ingest.enable', {
      kind: 'conversion_definition', id: c.req.param('id'),
    });
    return c.json({ success: true, data });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_definitions_id_ingest_events_14 = async (c: Context<Env, "/api/conversions/definitions/:id/ingest-events">) => {
  try {
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const paging = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 50 });
    const data = await listConversionIngestionEvents(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, limit: paging.limit,
    });
    if (!data) return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    return c.json({ success: true, data: buildOffsetListResponse({ items: data, total: null, paging, sort: [] }) });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const get__api_conversions_definitions_id_events_15 = async (c: Context<Env, "/api/conversions/definitions/:id/events">) => {
  try {
    const scope = await conversionDefinitionScope(c);
    if (!scope.ok) return scope.response;
    const paging = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 50 });
    const data = await listConversionDefinitionEvents(c.env.DB, {
      id: c.req.param('id'), scope: scope.value, limit: paging.limit,
    });
    if (!data) return c.json({ success: false, error: '成果地点が見つかりません' }, 404);
    return c.json({ success: true, data: buildOffsetListResponse({ items: data, total: null, paging, sort: [] }) });
  } catch (error) {
    return conversionContractError(c, error);
  }
};

export const post__api_conversions_ingest_id_16 = async (c: Context<Env, "/api/conversions/ingest/:id">) => {
  const pointId = c.req.param('id');
  const log = async (
    entry: Omit<Parameters<typeof recordConversionIngestionEvent>[1], 'conversionPointId'>,
  ) => {
    try {
      await recordConversionIngestionEvent(c.env.DB, { conversionPointId: pointId, ...entry });
    } catch (logError) {
      logger.error("conversions.record_ingestion_event_failed");
    }
  };
  try {
    // 巨大な本文を署名計算の前に止める(受信Webhookと同じ手順)。
    const declaredLength = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BODY_BYTES) {
      return c.json({ success: false, error: 'Payload too large' }, 413);
    }

    const point = await getConversionPointForIngest(c.env.DB, pointId);
    if (!point) {
      await log({ result: 'rejected', reason: 'point_not_found' });
      return fail(c, 404, 'CONVERSION_POINT_NOT_FOUND');
    }
    if (point.status !== 'active') {
      await log({
        result: 'rejected',
        reason: point.status === 'draft' ? 'point_draft' : 'point_stopped',
      });
      return c.json({ success: false, error: 'Conversion point is not measuring' }, 409);
    }
    if (point.ingest_disabled_at) {
      await log({ result: 'rejected', reason: 'ingest_disabled' });
      return c.json({ success: false, error: 'External ingestion is disabled for this point' }, 403);
    }

    // 照合の直前に復号する。鍵不足・復号失敗は fail-closed。
    let verifySecret: string | null;
    try {
      verifySecret = await resolveConversionIngestSecret(point, {
        current: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        previous: typeof (c.env as unknown as Record<string, unknown>).LINE_CREDENTIAL_PREVIOUS_KEYS === 'string'
          ? (c.env as unknown as Record<string, string>).LINE_CREDENTIAL_PREVIOUS_KEYS
          : undefined,
      });
    } catch {
      verifySecret = null;
    }
    if (!verifySecret) {
      await log({ result: 'rejected', reason: 'secret_not_issued' });
      return c.json({ success: false, error: 'Ingestion key is not issued for this point' }, 503);
    }

    const signature = (c.req.header(INGEST_SIGNATURE_HEADER) ?? '').trim().toLowerCase();
    if (!signature) {
      await log({ result: 'rejected', reason: 'signature_missing' });
      return c.json({ success: false, error: `${INGEST_SIGNATURE_HEADER} header is required` }, 401);
    }

    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_INGEST_BODY_BYTES) {
      return c.json({ success: false, error: 'Payload too large' }, 413);
    }
    const expected = await computeHmacSha256Hex(verifySecret, rawBody);
    const signatureHash = await sha256Hex(signature);
    if (!safeEqualHex(signature, expected)) {
      await log({ result: 'rejected', reason: 'signature_mismatch', signatureSha256: signatureHash });
      return c.json({ success: false, error: 'Invalid signature' }, 401);
    }

    let payload: Record<string, unknown> | null;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      payload = plainObject(parsed);
    } catch {
      payload = null;
    }
    if (!payload) {
      await log({ result: 'rejected', reason: 'invalid_json', signatureSha256: signatureHash });
      return inputError(c, { success: false, error: 'Invalid JSON body' }, 400, []);
    }
    // 時刻とnonceも本文HMACの対象。署名だけを別のイベントへ使い回せない。
    const timestamp = payload.timestamp;
    const nonce = payload.nonce;
    if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)
        || Math.abs(Date.now() / 1000 - timestamp) > 300
        || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      await log({ result: 'rejected', reason: 'invalid_freshness', signatureSha256: signatureHash });
      return c.json({ success: false, error: '有効な送信時刻とnonceが必要です', code: 'INVALID_FRESHNESS' }, 401);
    }
    if (!await consumePublicIngressReceipt(c.env.DB, { kind: 'conversion_nonce', scopeId: pointId, key: await sha256Hex(nonce) })) {
      await log({ result: 'rejected', reason: 'nonce_reused', signatureSha256: signatureHash });
      return c.json({ success: false, error: '同じnonceは再利用できません', code: 'NONCE_REUSED' }, 409);
    }
    const payloadShape = maskedPayloadShape(payload);
    /*
     * 検証の受信か。
     *
     * 本文に `"test": true` が付いた受信は、署名・イベントID・友だちの
     * 解決まで本番と同じ検査を通す。違いは書き込みだけ——成果表には
     * 書かず台帳へ「検証の受信」としてだけ残すので、試験イベントが
     * 売上・報酬・集計へ混入しないことを書き込まない形で保証する。
     * 失敗した検証も isTest 付きで残し、本番の失敗と見分けられるようにする。
     */
    const isTest = payload.test === true;
    const sourceEventId = (c.req.header(INGEST_EVENT_ID_HEADER) ?? '')
      || (typeof payload.sourceEventId === 'string' ? payload.sourceEventId : '');
    if (!sourceEventId.trim()) {
      await log({
        result: 'rejected', reason: 'source_event_id_missing', isTest,
        payloadShape, signatureSha256: signatureHash,
      });
      return inputError(c, {
        success: false,
        error: `${INGEST_EVENT_ID_HEADER} header or sourceEventId is required`,
      }, 400, ["sourceEventId"]);
    }

    const friendId = typeof payload.friendId === 'string' ? payload.friendId.trim() : '';
    const lineUserId = typeof payload.lineUserId === 'string' ? payload.lineUserId.trim() : '';
    if (!friendId && !lineUserId) {
      await log({
        result: 'rejected', reason: 'friend_missing', isTest,
        sourceEventId: sourceEventId.trim().slice(0, 200),
        payloadShape, signatureSha256: signatureHash,
      });
      return inputError(c, { success: false, error: 'friendId or lineUserId is required' }, 400, ["friendId"]);
    }
    const friends = await findConversionIngestFriends(c.env.DB, point, friendId ? { friendId } : { lineUserId });
    if (friends.length !== 1) {
      await log({
        result: 'rejected', reason: friends.length > 1 ? 'friend_ambiguous' : 'friend_not_found', isTest,
        sourceEventId: sourceEventId.trim().slice(0, 200), payloadShape, signatureSha256: signatureHash,
      });
      return fail(c, 422, 'FRIEND_NOT_FOUND_OR_OUT_OF_SCOPE', {}, []);
    }
    const resolvedFriendId = friends[0]!.id;
    const value = payload.value === null || payload.value === undefined
      ? null : Number(payload.value);

    if (isTest) {
      await log({
        result: 'recorded', isTest: true,
        sourceEventId: sourceEventId.trim().slice(0, 200),
        friendId: resolvedFriendId, payloadShape, signatureSha256: signatureHash,
      });
      return c.json({
        success: true,
        data: { received: true, test: true, duplicated: false },
      });
    }

    try {
      const outcome: { deduplicated?: boolean } = {};
      const event = await trackConversion(c.env.DB, {
        conversionPointId: pointId,
        friendId: resolvedFriendId,
        metadata: JSON.stringify({
          source: 'external_ingest',
          sourceEventId: sourceEventId.trim().slice(0, 200),
          ...(plainObject(payload.metadata) ?? {}),
        }),
        // 同じイベントの再送は地点ごとの冪等キーで1件にする。
        idempotencyKey: `cvingest:${pointId}:${sourceEventId.trim().slice(0, 120)}`,
        value,
      }, undefined, outcome);
      await log({
        result: outcome.deduplicated ? 'duplicate' : 'recorded',
        sourceEventId: sourceEventId.trim().slice(0, 200),
        friendId: resolvedFriendId,
        payloadShape, signatureSha256: signatureHash,
      });
      return c.json({
        success: true,
        data: { received: true, duplicated: outcome.deduplicated === true, eventId: event.id },
      });
    } catch (trackError) {
      const message = trackError instanceof Error ? trackError.message : '';
      if (message === 'conversion_idempotency_conflict') {
        await log({
          result: 'rejected', reason: 'idempotency_conflict',
          sourceEventId: sourceEventId.trim().slice(0, 200),
          friendId: resolvedFriendId, payloadShape, signatureSha256: signatureHash,
        });
        return c.json({ success: false, error: 'Same event id with different payload' }, 409);
      }
      if (message === 'conversion_friend_not_found' || message === 'conversion_account_mismatch') {
        await log({
          result: 'rejected', reason: message.replace('conversion_', ''),
          sourceEventId: sourceEventId.trim().slice(0, 200),
          friendId: resolvedFriendId, payloadShape, signatureSha256: signatureHash,
        });
        return fail(c, 422, 'FRIEND_NOT_FOUND_OR_OUT_OF_SCOPE', {}, []);
      }
      // 数えない条件に当てはまる受信は、失敗ではなく対象外として残す。
      if (message === 'conversion_excluded') {
        await log({
          result: 'rejected', reason: 'excluded_by_condition',
          sourceEventId: sourceEventId.trim().slice(0, 200),
          friendId: resolvedFriendId, payloadShape, signatureSha256: signatureHash,
        });
        return inputError(c, { success: false, error: 'Excluded by the conversion point exclusion condition' }, 422, []);
      }
      throw trackError;
    }
  } catch (error) {
    throw error;
  }
};
