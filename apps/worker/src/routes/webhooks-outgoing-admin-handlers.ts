import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { fail } from '../lib/fail.js';
import { logger } from '@line-crm/shared/server';
import { outgoingEventTypes } from './webhook-event-types.js';
import { exportWebhookInteractions } from './webhook-interactions-export.js';
import { inputError } from '../lib/input-errors.js';
import { FolderAssignmentError } from '@line-crm/db';

import { getOutgoingWebhookById, createOutgoingWebhook, updateOutgoingWebhook, deleteOutgoingWebhook, restoreOutgoingWebhook, createWebhookInteraction, finishWebhookInteraction, getWebhookInteractionById, listFailedWebhookInteractionsForRetry, countFailedWebhookInteractionsForRetry, countExcludedFailedWebhookInteractions, countUnverifiedWebhookInteractions, listWebhookInteractions, backfillWebhookSecrets, hasWebhookSecret, resolveWebhookSecret, WEBHOOK_SECRET_MIN_LENGTH as MIN_SECRET_LENGTH, isOperationCapabilityStopped } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { auditLog } from '../lib/audit-log.js';
import { maskInteractionPayload } from '../lib/mask-payload.js';
import { retryWebhookInteraction } from '../services/webhook-interactions.js';
import { buildOutgoingWebhookBody, deliverOnce, failureReasonForDelivery } from '../services/outgoing-webhook-delivery.js';
import { validateWebhookName, validateEventTypes, validateHttpsUrl, generateWebhookSecret, validateSecret, readMaxRetries, webhookKeysOf, isEncryptionKeyError, requireInteractionAccount, serializeInteraction } from './webhooks-definition.js';
import type { Context } from 'hono';

export const get__api_webhooks_outgoing_id_1 = async (c: Context<Env, "/api/webhooks/outgoing/:id">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    const staff = c.get('staff');
    if (staff?.role === 'staff' && !staff.permissionKeys?.includes('/webhooks')) {
      return c.json({ success: false, error: 'この機能を表示する権限がありません' }, 403);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, staff, [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const item = await getOutgoingWebhookById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        folderId: item.folder_id ?? null,
        url: item.url,
        eventTypes: outgoingEventTypes(item.event_types, item.id),
        hasSecret: hasWebhookSecret(item),
        isActive: Boolean(item.is_active),
        maxRetries: item.max_retries ?? 0,
        consecutiveFailures: item.consecutive_failures ?? 0,
        lastFailedAt: item.last_failed_at ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        version: item.version ?? 1,
        confirmationRevision: item.confirmation_revision,
        updatedBy: item.updated_by_staff_id ?? null,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_outgoing_2 = async (c: Context<Env, "/api/webhooks/outgoing">) => {
  try {
    // 送信フックの登録は署名用の秘密値を扱う大事な操作（V）。
    if (!await sensitiveStepUpSatisfied(c, 'webhook.secret')) {
      return stepUpRequiredResponse(c, '秘密の値の登録には本人確認が必要です');
    }
    const body = await c.req.json<{
      name: string;
      url: string;
      eventTypes?: string[];
      secret?: string;
      maxRetries?: unknown;
      folderId?: unknown;
      isActive?: boolean;
      lineAccountId: string;
    }>();
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive must be a boolean' }, 400, ["isActive"]);
    }
    const nameError = validateWebhookName(body.name);
    if (nameError) {
      return inputError(c, { success: false, error: nameError }, 400, ["name"]);
    }
    const eventTypesError = validateEventTypes(body.eventTypes);
    if (eventTypesError) {
      return inputError(c, { success: false, error: eventTypesError }, 400, ["eventTypes"]);
    }
    const urlError = validateHttpsUrl(body.url);
    if (urlError) {
      return inputError(c, { success: false, error: urlError }, 400, ["url"]);
    }
    body.secret = generateWebhookSecret();
    const secretError = validateSecret(body.secret);
    if (secretError) {
      return inputError(c, { success: false, error: secretError }, 400, ["secret"]);
    }
    let maxRetries = 0;
    if (body.maxRetries !== undefined) {
      const parsed = readMaxRetries(body.maxRetries);
      if (!parsed.ok) {
        return inputError(c, { success: false, error: 'maxRetries must be an integer between 0 and 7' }, 400, ["maxRetries"]);
      }
      maxRetries = parsed.value;
    }
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const item = await createOutgoingWebhook(c.env.DB, {
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      name: body.name,
      url: body.url,
      folderId: body.folderId,
      eventTypes: (body.eventTypes ?? []).map((item) => item.trim()),
      secret: body.secret as string,
      maxRetries,
      lineAccountId,
    }, webhookKeysOf(c));
    auditLog(c, 'webhook.outgoing.create', { kind: 'outgoing_webhook', id: item.id }, { lineAccountId });
    return c.json(
      {
        success: true,
        data: {
          id: item.id,
          name: item.name,
          folderId: item.folder_id ?? null,
          url: item.url,
          eventTypes: outgoingEventTypes(item.event_types, item.id),
          // 作成時にだけ秘密値を返し、行には暗号文だけを保存する。
          secret: body.secret,
          isActive: Boolean(item.is_active),
          maxRetries: item.max_retries ?? 0,
          createdAt: item.created_at,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof FolderAssignmentError) return inputError(c, { success: false, code: err.code, error: err.message }, 422, ["folderId"]);
    if (isEncryptionKeyError(err)) {
      return c.json({ success: false, error: 'secret を安全に保存できませんでした' }, 503);
    }
    throw err;
  }
};

export const put__api_webhooks_outgoing_id_3 = async (c: Context<Env, "/api/webhooks/outgoing/:id">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const body = await c.req.json<{
      name?: string;
      url?: string;
      eventTypes?: string[];
      secret?: string;
      isActive?: boolean;
      maxRetries?: unknown;
      expectedVersion?: number;
      expectedConfirmationRevision?: number;
      folderId?: unknown;
    }>();
    const existing = await getOutgoingWebhookById(c.env.DB, id, lineAccountId);
    if (!existing) return body.expectedConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if (body.expectedVersion !== undefined &&
        (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) {
      return inputError(c, { success: false, error: 'expectedVersion は1以上の整数を指定してください' }, 400, ["expectedVersion"]);
    }
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || body.expectedConfirmationRevision < 1)) return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    const conflict = (current: typeof existing) => fail(c, 409, 'VERSION_CONFLICT', {
      error: '送り先が更新されています。読み直してください',
      data: { currentVersion: current.version ?? 1, confirmationRevision: current.confirmation_revision, updatedBy: current.updated_by_staff_id ?? null,
        updatedAt: current.updated_at },
    });
    if ((body.expectedVersion !== undefined && body.expectedVersion !== (existing.version ?? 1)) || (body.expectedConfirmationRevision !== undefined && body.expectedConfirmationRevision !== existing.confirmation_revision)) {
      return conflict(existing);
    }
    // 秘密値の入れ替えを伴う更新は鍵・トークンの操作（V）。
    if (body.secret !== undefined && !await sensitiveStepUpSatisfied(c, 'webhook.secret')) {
      return stepUpRequiredResponse(c, '秘密の値の変更には本人確認が必要です');
    }
    // 検証済みの値だけを別に持つ。body をそのまま書き換えると unknown のまま
    // 下流へ渡ることになる。
    let maxRetries: number | undefined;
    if (body.maxRetries !== undefined) {
      const parsed = readMaxRetries(body.maxRetries);
      if (!parsed.ok) {
        return inputError(c, { success: false, error: 'maxRetries must be an integer between 0 and 7' }, 400, ["maxRetries"]);
      }
      maxRetries = parsed.value;
    }
    if (body.name !== undefined) {
      const nameError = validateWebhookName(body.name);
      if (nameError) {
        return inputError(c, { success: false, error: nameError }, 400, ["name"]);
      }
    }
    const eventTypesError = validateEventTypes(body.eventTypes);
    if (eventTypesError) {
      return inputError(c, { success: false, error: eventTypesError }, 400, ["eventTypes"]);
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive must be a boolean' }, 400, ["isActive"]);
    }
    if (body.url !== undefined) {
      const urlError = validateHttpsUrl(body.url);
      if (urlError) {
        return inputError(c, { success: false, error: urlError }, 400, ["url"]);
      }
    }
    if (body.secret !== undefined) {
      body.secret = generateWebhookSecret();
      const secretError = validateSecret(body.secret);
      if (secretError) {
        return inputError(c, { success: false, error: secretError }, 400, ["secret"]);
      }
    }
    // 部分更新後の秘密値と HTTPS URL を検査し、isActive だけで不正な保存値を再有効化させない。復号不能なら再入力まで停止する。
    if (body.isActive === true) {
      let effectiveSecret = body.secret;
      if (effectiveSecret === undefined) {
        try {
          effectiveSecret = await resolveWebhookSecret(existing, webhookKeysOf(c)) ?? undefined;
        } catch {
          return c.json({ success: false, error: 'secret を確認できませんでした。secret を入れ直してください' }, 503);
        }
      }
      const effectiveUrl = body.url ?? existing.url;
      if (!effectiveSecret || effectiveSecret.length < MIN_SECRET_LENGTH) {
        return inputError(c, {
            success: false,
            error: `Cannot activate webhook: secret must be at least ${MIN_SECRET_LENGTH} characters. Update the secret first.`,
          }, 400, ["secret"]);
      }
      const urlError = validateHttpsUrl(effectiveUrl);
      if (urlError) {
        return inputError(c, { success: false, error: `Cannot activate webhook: ${urlError}` }, 400, ["url","lineAccountId"]);
      }
    }
    const saved = await updateOutgoingWebhook(c.env.DB, id, lineAccountId, {
      ...body,
      eventTypes: body.eventTypes?.map((item) => item.trim()),
      maxRetries,
    }, webhookKeysOf(c), { expectedVersion: body.expectedVersion, expectedConfirmationRevision: body.expectedConfirmationRevision, updatedByStaffId: c.get('staff')?.id });
    const updated = await getOutgoingWebhookById(c.env.DB, id, lineAccountId);
    if (!updated) return body.expectedConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if (saved === false) return conflict(updated);
    //  動かす/止める・合言葉の入れ直し・その他の変更を分けて記録する。
    if (body.isActive !== undefined) {
      auditLog(c, body.isActive ? 'webhook.outgoing.activate' : 'webhook.outgoing.deactivate',
        { kind: 'outgoing_webhook', id }, { lineAccountId });
    }
    if (body.secret !== undefined) {
      auditLog(c, 'webhook.outgoing.secret.rotate', { kind: 'outgoing_webhook', id }, { lineAccountId });
    }
    if (body.folderId !== undefined || body.name !== undefined || body.url !== undefined
      || body.eventTypes !== undefined || body.maxRetries !== undefined) {
      auditLog(c, 'webhook.outgoing.update', { kind: 'outgoing_webhook', id }, { lineAccountId });
    }
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        folderId: updated.folder_id ?? null,
        url: updated.url,
        eventTypes: outgoingEventTypes(updated.event_types, updated.id),
        hasSecret: hasWebhookSecret(updated),
        ...(body.secret !== undefined ? { secret: body.secret } : {}),
        isActive: Boolean(updated.is_active),
        maxRetries: updated.max_retries ?? 0,
        consecutiveFailures: updated.consecutive_failures ?? 0,
        lastFailedAt: updated.last_failed_at ?? null,
        version: updated.version ?? 1,
        confirmationRevision: updated.confirmation_revision,
        updatedBy: updated.updated_by_staff_id ?? null,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    if (err instanceof FolderAssignmentError) return inputError(c, { success: false, code: err.code, error: err.message }, 422, ["folderId"]);
    if (isEncryptionKeyError(err)) {
      return c.json({ success: false, error: 'secret を安全に保存できませんでした' }, 503);
    }
    throw err;
  }
};

export const post__api_webhooks_outgoing_id_test_4 = async (c: Context<Env, "/api/webhooks/outgoing/:id/test">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const request = await c.req.json<{ expectedVersion?: unknown; expectedConfirmationRevision?: unknown }>().catch(() => ({} as { expectedVersion?: unknown; expectedConfirmationRevision?: unknown }));
    const expectedVersion = request.expectedVersion;
    const expectedConfirmationRevision = request.expectedConfirmationRevision;
    if (expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(expectedConfirmationRevision) || (expectedConfirmationRevision as number) < 1)) return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedVersion']);
    }
    const webhook = await getOutgoingWebhookById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!webhook) return expectedConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'version_conflict', error: '送り先が変わりました。読み直してください。', data: null }, 409);
    if ((expectedVersion !== undefined && webhook.version !== expectedVersion) || (expectedConfirmationRevision !== undefined && webhook.confirmation_revision !== expectedConfirmationRevision)) {
      return c.json({ success: false, code: 'version_conflict', error: '送り先が変わりました。読み直してください。', data: { version: webhook.version, confirmationRevision: webhook.confirmation_revision, url: webhook.url } }, 409);
    }
    if (!webhook.is_active) return c.json({ success: false, error: '止めている送り先は試せません' }, 409);
    // 緊急停止 : webhook_outgoing 停止中は試し送信も受け付けない。
    if (await isOperationCapabilityStopped(c.env.DB, lineAccountId, 'webhook_outgoing')) {
      return c.json({ success: false, error: '緊急停止中のため試し送信できません' }, 409);
    }
    // 署名は送信直前に復号した値で付ける。secretが設定済みで読めない
    // (鍵不足・復号失敗)ときだけ送らずに止める。未設定の旧行は従来どおり試す。
    let sendSecret: string | null = null;
    if (webhook.secret_encrypted || webhook.secret) {
      try {
        sendSecret = await resolveWebhookSecret(webhook, webhookKeysOf(c));
      } catch {
        sendSecret = null;
      }
      if (!sendSecret) {
        return c.json({ success: false, error: 'secret を確認できないため試し送信を止めました' }, 503);
      }
    }
    // 試し送信も共通封筒で送る。イベントIDと冪等キーは同じ値にし、
    // 記録のやり直しでも同じ出来事として届く。
    const eventId = crypto.randomUUID();
    const body = buildOutgoingWebhookBody({
      eventId,
      eventType: 'webhook.test',
      occurredAt: new Date().toISOString(),
      accountId: lineAccountId,
      data: { test: true, source: 'line-harness-admin' },
      attempt: 1,
    });
    const interaction = await createWebhookInteraction(c.env.DB, {
      lineAccountId, direction: 'outgoing', webhookId: webhook.id, webhookName: webhook.name,
      eventType: 'webhook.test', triggerSummary: '管理画面から1回試した', requestBodyJson: body,
      idempotencyKey: eventId,
    });
    if (expectedVersion !== undefined || expectedConfirmationRevision !== undefined) {
      const current = await getOutgoingWebhookById(c.env.DB, webhook.id, lineAccountId);
      if (!current || (expectedVersion !== undefined && current.version !== expectedVersion) || (expectedConfirmationRevision !== undefined && current.confirmation_revision !== expectedConfirmationRevision) || !current.is_active) {
        await finishWebhookInteraction(c.env.DB, interaction.id, lineAccountId, {
          status: 'failed', attemptCount: 0, durationMs: 0, failureReason: 'processing_failed',
        });
        return c.json({ success: false, code: 'version_conflict', error: '送り先が変わりました。読み直してください。', data: current ? { version: current.version, confirmationRevision: current.confirmation_revision, url: current.url } : null }, 409);
      }
    }
    const started = Date.now();
    // d23b : 試し送信は1回だけ。画面の案内（届いたかを試す1回）と
    // 自動の送り直しを混ぜないため、送り直しを0回に固定して送る。
    // 署名用の復号は配送側が行う。ここは早い段階で 503 を返すための
    // 事前確認だけに使い、鍵はそのまま渡す。
    const result = await deliverOnce(webhook, body, {
      idempotencyKey: eventId,
      credentialKeys: webhookKeysOf(c),
    });
    await finishWebhookInteraction(c.env.DB, interaction.id, lineAccountId, {
      status: result.ok ? 'succeeded' : 'failed',
      responseStatus: result.lastStatus ?? null,
      attemptCount: result.attempts,
      durationMs: Date.now() - started,
      // d23b /: 他経路と同じ理由を残す。届いたか分からない
      // 失敗を「処理できなかった」と記録しない。
      failureReason: result.ok ? null : failureReasonForDelivery(result),
    });
    auditLog(c, 'webhook.outgoing.test', { kind: 'outgoing_webhook', id: webhook.id }, { lineAccountId });
    return c.json({ success: true, data: { delivered: result.ok, responseStatus: result.lastStatus ?? null } });
  } catch (err) {
    logger.error("webhooks.webhooks_outgoing_id_test_post_failed");
    return c.json({ success: false, error: '試し送信に失敗しました' }, 502);
  }
};

export const delete__api_webhooks_outgoing_id_5 = async (c: Context<Env, "/api/webhooks/outgoing/:id">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const rawVersion = c.req.query('expectedVersion');
    const rawConfirmationRevision = c.req.query('expectedConfirmationRevision');
    const existing = await getOutgoingWebhookById(c.env.DB, id, lineAccountId);
    if (!existing) return rawConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if (rawConfirmationRevision !== undefined && (!/^[1-9]\d*$/.test(rawConfirmationRevision) || !Number.isSafeInteger(Number(rawConfirmationRevision)))) return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    if (rawVersion !== undefined && (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)))) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedVersion']);
    }
    const deleted = await deleteOutgoingWebhook(c.env.DB, id, lineAccountId, c.get('staff')?.id, rawVersion === undefined ? undefined : Number(rawVersion), rawConfirmationRevision === undefined ? undefined : Number(rawConfirmationRevision));
    if ((rawVersion !== undefined || rawConfirmationRevision !== undefined) && !deleted) {
      const current = await getOutgoingWebhookById(c.env.DB, id, lineAccountId);
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: '送り先が変わりました。読み直してください。', data: current ? { currentVersion: current.version, confirmationRevision: current.confirmation_revision, url: current.url } : null }, 409);
    }
    auditLog(c, 'webhook.outgoing.delete', { kind: 'outgoing_webhook', id }, { lineAccountId });
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_outgoing_id_restore_6 = async (c: Context<Env, "/api/webhooks/outgoing/:id/restore">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const restored = await restoreOutgoingWebhook(c.env.DB, id, lineAccountId);
    if (!restored) return c.json({ success: false, error: 'Not found' }, 404);
    const item = await getOutgoingWebhookById(c.env.DB, id, lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    auditLog(c, 'webhook.outgoing.restore', { kind: 'outgoing_webhook', id }, { lineAccountId });
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        folderId: item.folder_id ?? null,
        url: item.url,
        eventTypes: outgoingEventTypes(item.event_types, item.id),
        hasSecret: hasWebhookSecret(item),
        isActive: Boolean(item.is_active),
        maxRetries: item.max_retries ?? 0,
        consecutiveFailures: item.consecutive_failures ?? 0,
        lastFailedAt: item.last_failed_at ?? null,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_webhooks_interactions_export_csv_7 = async (c: Context<Env, "/api/webhooks/interactions/export.csv">) => {
  const access=await requireInteractionAccount(c);if('error' in access)return access.error;
  return exportWebhookInteractions(c, access.lineAccountId);
};

export const get__api_webhooks_interactions_8 = async (c: Context<Env, "/api/webhooks/interactions">) => {
  try {
    const access = await requireInteractionAccount(c);
    if ('error' in access) return access.error;
    const direction = c.req.query('direction');
    const status = c.req.query('status');
    const result = await listWebhookInteractions(c.env.DB, {
      lineAccountId: access.lineAccountId,
      periodDays: Number(c.req.query('periodDays') ?? 30),
      direction: direction === 'incoming' || direction === 'outgoing' ? direction : undefined,
      status: status === 'succeeded' || status === 'failed' ? status : undefined,
      search: c.req.query('search'),
      ...parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') }, { defaultLimit: 20, limitPolicy: {}, pagePolicy: {} }),
    });
    return c.json({
      success: true,
      data: buildOffsetListResponse({ items: result.items.map(serializeInteraction),
        total: result.total,
        page: result.page,
        limit: result.limit,
        summary: result.summary, paging: { limit: result.limit, offset: (result.page - 1) * result.limit }, sort: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_webhooks_interactions_id_payload_9 = async (c: Context<Env, "/api/webhooks/interactions/:id/payload">) => {
  try {
    const access = await requireInteractionAccount(c);
    if ('error' in access) return access.error;
    const original = await getWebhookInteractionById(c.env.DB, c.req.param('id'), access.lineAccountId);
    if (!original) return c.json({ success: false, error: 'Not found' }, 404);
    // 本文は伏せて返す。元やDBは変えない。
    const masked = maskInteractionPayload(original.request_body_json);
    return c.json({
      success: true,
      data: { id: original.id, body: masked.body, available: masked.available },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_interactions_id_retry_10 = async (c: Context<Env, "/api/webhooks/interactions/:id/retry">) => {
  try {
    const access = await requireInteractionAccount(c);
    if ('error' in access) return access.error;
    let body: { confirmed?: unknown; interactionRevision?: unknown; webhookRevision?: unknown } = {};
    try { body = (await c.req.json()) ?? {}; } catch { /* 旧呼び出しは本文なしでも受け付ける */ }
    const hasRevision = body.interactionRevision !== undefined || body.webhookRevision !== undefined;
    if (hasRevision && (!Number.isSafeInteger(body.interactionRevision) || Number(body.interactionRevision) < 1 || !Number.isSafeInteger(body.webhookRevision) || Number(body.webhookRevision) < 1)) {
      return c.json({ success: false, error: '確認した版が正しくありません' }, 400);
    }
    const expected = hasRevision ? { interactionRevision: Number(body.interactionRevision), webhookRevision: Number(body.webhookRevision) } : undefined;
    const original = await getWebhookInteractionById(c.env.DB, c.req.param('id'), access.lineAccountId);
    if (!original) return hasRevision ? c.json({ success: false, error: 'confirmation_conflict', current: null }, 409) : c.json({ success: false, error: 'Not found' }, 404);
    if (expected) {
      const destination = original.webhook_id ? await getOutgoingWebhookById(c.env.DB, original.webhook_id, access.lineAccountId) : null;
      if (original.confirmation_revision !== expected.interactionRevision || destination?.confirmation_revision !== expected.webhookRevision || !destination?.is_active) {
        return c.json({ success: false, error: 'confirmation_conflict', current: { ...serializeInteraction(original), webhookRevision: destination?.confirmation_revision ?? null } }, 409);
      }
    }
    /*
      「届いたか分からない」失敗を無条件で再送しない。
      相手先で同じ処理が記録されていないか確かめた、という運用者の確認
      (confirmed=true)が無い要求は 409 で止める。確認後の再送は同じ
      冪等キーで行うので、届いていても相手先で二重処理されない。
    */
    if (original.failure_reason === 'unknown') {
      if (body.confirmed !== true) {
        return c.json({ success: false, error: 'result_unknown_needs_check' }, 409);
      }
    }
    const retried = expected
      ? await retryWebhookInteraction(c.env.DB, original, webhookKeysOf(c), expected)
      : await retryWebhookInteraction(c.env.DB, original, webhookKeysOf(c));
    auditLog(c, 'webhook.interaction.retry',
      { kind: 'webhook_interaction', id: original.id }, { lineAccountId: access.lineAccountId });
    return c.json({ success: true, data: serializeInteraction(retried) });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'retry_failed';
    if (code === 'confirmation_conflict') {
      const access = await requireInteractionAccount(c);
      if ('error' in access) return access.error;
      const current = await getWebhookInteractionById(c.env.DB, c.req.param('id'), access.lineAccountId);
      const destination = current?.webhook_id ? await getOutgoingWebhookById(c.env.DB, current.webhook_id, access.lineAccountId) : null;
      return c.json({ success: false, error: code, current: current ? { ...serializeInteraction(current), webhookRevision: destination?.confirmation_revision ?? null } : null }, 409);
    }
    if (code === 'not_retryable' || code === 'already_retried') {
      return c.json({ success: false, error: code }, 409);
    }
    /*
      d23b : 同じ通知が自動で届き済み・自動の送り直しが動いている
      場合は手動のやり直しを重ねず、理由を画面へ返す。
    */
    if (code === 'already_delivered') {
      return c.json({ success: false, error: code }, 409);
    }
    if(code==='retry_after_pending')return c.json({success:false,code,error:'連携先の待機期限を確認してください。期限前の再送はできません。'},409);
    if (code === 'auto_retry_scheduled') {
      return c.json({ success: false, error: code }, 409);
    }
    if (code === 'webhook_secret_unavailable') {
      return c.json({ success: false, error: 'secret を確認できないため送り直しを止めました' }, 503);
    }
    if (code === 'emergency_stopped') {
      return c.json({ success: false, error: '緊急停止中のため再送できません' }, 409);
    }
    if (code === 'webhook_not_found') return c.json({ success: false, error: code }, 404);
    if (code === 'webhook_inactive' || code === 'payload_unavailable') {
      return inputError(c, { success: false, error: code }, 400, []);
    }
    throw err;
  }
};

export const post__api_webhooks_interactions_retry_failed_11 = async (c: Context<Env, "/api/webhooks/interactions/retry-failed">) => {
  try {
    const access = await requireInteractionAccount(c);
    if ('error' in access) return access.error;
    // 1件につき最大6回の外部通信になる。1リクエストの外部通信上限を越えないよう5件まで。
    // 結果不明(届いたか分からない)の記録はここには含まれない。
    //
    // d23b : 選ぶ段階で、送り先が消えた・止まった・内容が残っていない
    // 記録と、自動の送り直しが動いている記録は外す。先頭に固まった対象外の
    // 記録で、後ろの送れる記録へ届かなくなることはなくなった。
    const failed = await listFailedWebhookInteractionsForRetry(c.env.DB, access.lineAccountId, 5);
    // 対象外に残る件数を先に数えて返す。まとめて操作で黙って残さない。
    const totalFailed = await countFailedWebhookInteractionsForRetry(c.env.DB, access.lineAccountId);
    const remaining = Math.max(0, totalFailed - failed.length);
    // 結果不明の失敗は無条件に再送しない代わりに、件数を返して
    // 「相手先で確かめてから1件ずつやり直す」ことを画面へ伝える。
    const needsReview = await countUnverifiedWebhookInteractions(c.env.DB, access.lineAccountId);
    // d23b : 対象外に残った件数（消えた・止まった送り先、内容が無い
    // 記録、自動の送り直しが動いている記録）も返す。画面が「何件が今回の
    // 対象外だったか」を説明できるようにする。
    const excluded = await countExcludedFailedWebhookInteractions(c.env.DB, access.lineAccountId);
    let succeeded = 0;
    let failedAgain = 0;
    let skipped = 0;
    await Promise.all(failed.map(async (item) => {
      try {
        const result = await retryWebhookInteraction(c.env.DB, item, webhookKeysOf(c));
        if (result.status === 'succeeded') succeeded++;
        else failedAgain++;
      } catch {
        skipped++;
      }
    }));
    if (failed.length > 0) {
      auditLog(c, 'webhook.interaction.retry_failed',
        { kind: 'outgoing_webhook' }, { lineAccountId: access.lineAccountId });
    }
    return c.json({
      success: true,
      data: { requested: failed.length, succeeded, failed: failedAgain, skipped, remaining, needsReview, excluded },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_maintenance_secret_backfill_12 = async (c: Context<Env, "/api/webhooks/maintenance/secret-backfill">) => {
  try {
    // 秘密値の一括補完は鍵・トークンの操作（V）。
    if (!await sensitiveStepUpSatisfied(c, 'webhook.secret')) {
      return stepUpRequiredResponse(c, '秘密の値の補完には本人確認が必要です');
    }
    const body = await c.req.json<{
      lineAccountId?: string; dryRun?: boolean; batchSize?: unknown;
    }>().catch(() => null);
    const lineAccountId = body?.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    let batchSize = 50;
    if (body?.batchSize !== undefined) {
      const parsed = Number(body.batchSize);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        return inputError(c, { success: false, error: 'batchSize must be an integer between 1 and 500' }, 400, ["batchSize"]);
      }
      batchSize = parsed;
    }
    const report = await backfillWebhookSecrets(c.env.DB, {
      lineAccountId,
      dryRun: body?.dryRun ?? true,
      batchSize,
      keys: webhookKeysOf(c),
    });
    return c.json({ success: true, data: report });
  } catch (err) {
    if (err instanceof FolderAssignmentError) return inputError(c, { success: false, code: err.code, error: err.message }, 422, ["folderId"]);
    if (isEncryptionKeyError(err)) {
      return c.json({ success: false, error: 'secret の移行に必要な鍵がありません' }, 503);
    }
    throw err;
  }
};
