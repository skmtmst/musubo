import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { outgoingEventTypes } from './webhook-event-types.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { FolderAssignmentError } from '@line-crm/db';
import { getIncomingWebhooks, getIncomingWebhookById, createIncomingWebhook, updateIncomingWebhook, deleteIncomingWebhook, restoreIncomingWebhook, getOutgoingWebhooks, createWebhookInteraction, finishWebhookInteraction, getOutgoingWebhookDeliverySummaries, updateIncomingWebhookConfig, hasWebhookSecret, resolveWebhookSecret, WEBHOOK_SECRET_MIN_LENGTH as MIN_SECRET_LENGTH, listIncomingWebhookUnmatched, countIncomingWebhookUnmatched, getIncomingWebhookUnmatchedById, resolveIncomingWebhookUnmatched, type IncomingWebhookIdentityMatch, type IncomingWebhookActionRef } from '@line-crm/db';



import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { auditLog } from '../lib/audit-log.js';
import { incomingTestIdempotencyKey, webhookFailureLabel, type IncomingTestOutcome } from '../services/webhook-interactions.js';
import { previewIncomingWebhook } from '../services/incoming-webhook-actions.js';
import { safeJson, incomingActionDisplayName, incomingUnexecutableReason, previousSecretUsableUntil, readIncomingConfig, validateWebhookName, generateWebhookSecret, validateSecret, webhookKeysOf, isEncryptionKeyError, MAX_INCOMING_BODY_BYTES } from './webhooks-definition.js';
import type { Context } from 'hono';

export const get__api_webhooks_incoming_1 = async (c: Context<Env, "/api/webhooks/incoming">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    // 一覧からも詳細と同じ権限検査を通し、権限キーなしの参照を防ぐ。
    // おらず、権限なし職員が一覧は見られるちぐはぐな状態だった。
    const incomingStaff = c.get('staff');
    if (incomingStaff?.role === 'staff' && !incomingStaff.permissionKeys?.includes('/webhooks')) {
      return c.json({ success: false, error: 'この機能を表示する権限がありません' }, 403);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const items = await getIncomingWebhooks(c.env.DB, lineAccountId);
    return c.json({
      success: true,
      data: items.map((w) => ({
        id: w.id,
        name: w.name,
        folderId: w.folder_id ?? null,
        sourceType: w.source_type,
        hasSecret: hasWebhookSecret(w),
        isActive: Boolean(w.is_active),
        version: w.version ?? 1,
        confirmationRevision: w.confirmation_revision,
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_webhooks_incoming_id_2 = async (c: Context<Env, "/api/webhooks/incoming/:id">) => {
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
    const item = await getIncomingWebhookById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    const identityMatching = safeJson<IncomingWebhookIdentityMatch>(item.identity_match_json, {
      methods: [], onNotFound: 'do_nothing',
    });
    const actions = safeJson<IncomingWebhookActionRef[]>(item.action_refs_json, []);
    const namedActions = await Promise.all(actions.map(async (action) => ({
      ...action,
      displayName: await incomingActionDisplayName(c.env.DB, action),
    })));
    const sample = safeJson<{ fields: Array<{ path: string; type: string; maskedValue: string }>; truncated: boolean } | null>(
      item.latest_masked_sample_json, null,
    );
    //  「未照合として確認する」「友だち候補を作る」を選んだ口が
    // 溜めている未確認の件数。箱の中身は /unmatched で見せる。
    const pendingUnmatched = await countIncomingWebhookUnmatched(c.env.DB, item.id, lineAccountId);
    // 既に保存済みの未対応種類は「接続済み」にしない。理由も添える。
    const unexecutableReason = actions
      .map((action) => incomingUnexecutableReason(action.refKind))
      .find((reason): reason is string => reason !== null) ?? null;
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        folderId: item.folder_id ?? null,
        sourceType: item.source_type,
        hasSecret: hasWebhookSecret(item),
        // 入れ替え中なら「前の合言葉が使える期限」。併用期間外は null。
        previousSecretUsableUntil: previousSecretUsableUntil(item),
        isActive: Boolean(item.is_active),
        version: Number(item.version ?? 1),
        confirmationRevision: item.confirmation_revision,
        identityMatching,
        actions: namedActions,
        pendingUnmatched,
        actionExecution: actions.length === 0
          ? { state: 'not_configured' as const, reason: null }
          : unexecutableReason
            ? { state: 'needs_attention' as const, reason: unexecutableReason }
            : { state: 'connected' as const, reason: null },
        latestSample: sample && item.latest_received_at
          ? { receivedAt: item.latest_received_at, ...sample }
          : null,
        templateFields: sample?.fields.map((field) => ({
          path: field.path,
          type: field.type,
          token: `{{payload${field.path.slice(1)}}}`,
        })) ?? [],
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (error) {
    throw error;
  }
};

export const patch__api_webhooks_incoming_id_config_3 = async (c: Context<Env, "/api/webhooks/incoming/:id/config">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const parsed = readIncomingConfig(await c.req.json<unknown>().catch(() => null));
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 400, []);
    const result = await updateIncomingWebhookConfig(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId,
      expectedVersion: parsed.expectedVersion,
      identityMatching: parsed.identityMatching,
      actions: parsed.actions,
    });
    if (result.status === 'not_found') return c.json({ success: false, error: 'Not found' }, 404);
    if (result.status === 'conflict') {
      return c.json({
        success: false,
        code: 'version_conflict',
        error: '受け取り口が更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    auditLog(c, 'webhook.incoming.config.update', { kind: 'incoming_webhook', id: result.item.id });
    return c.json({ success: true, data: { id: result.item.id, version: result.item.version } });
  } catch (error) {
    throw error;
  }
};

export const post__api_webhooks_incoming_4 = async (c: Context<Env, "/api/webhooks/incoming">) => {
  try {
    // 受信フックの登録は秘密値を扱う大事な操作（V）。
    if (!await sensitiveStepUpSatisfied(c, 'webhook.secret')) {
      return stepUpRequiredResponse(c, '秘密の値の登録には本人確認が必要です');
    }
    const body = await c.req.json<{ name: string; sourceType?: string; secret?: string; lineAccountId: string; folderId?: unknown; isActive?: boolean }>();
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive must be a boolean' }, 400, ["isActive"]);
    }
    const nameError = validateWebhookName(body.name);
    if (nameError) {
      return inputError(c, { success: false, error: nameError }, 400, ["name"]);
    }
    body.secret = generateWebhookSecret();
    const secretError = validateSecret(body.secret);
    if (secretError) {
      return inputError(c, { success: false, error: secretError }, 400, ["secret"]);
    }
    const lineAccountId = body.lineAccountId?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const item = await createIncomingWebhook(c.env.DB, {
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      name: body.name,
      sourceType: body.sourceType,
      folderId: body.folderId,
      secret: body.secret as string,
      lineAccountId,
    }, webhookKeysOf(c));
    auditLog(c, 'webhook.incoming.create', { kind: 'incoming_webhook', id: item.id }, { lineAccountId });
    return c.json(
      {
        success: true,
        data: {
          id: item.id,
          name: item.name,
          folderId: item.folder_id ?? null,
          sourceType: item.source_type,
          // 秘密値は作成時の1回だけコピー用に返し、以後の GET には出さない。行には暗号文だけを保存する。
          secret: body.secret,
          isActive: Boolean(item.is_active),
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

export const put__api_webhooks_incoming_id_5 = async (c: Context<Env, "/api/webhooks/incoming/:id">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const body = await c.req.json<{ name?: string; sourceType?: string; secret?: string; isActive?: boolean; folderId?: unknown; expectedVersion?: unknown; expectedConfirmationRevision?: unknown }>();
    const existing = await getIncomingWebhookById(c.env.DB, id, lineAccountId);
    if (!existing) return body.expectedConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedVersion']);
    }
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || (body.expectedConfirmationRevision as number) < 1)) return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    if (body.expectedConfirmationRevision !== undefined && body.expectedConfirmationRevision !== existing.confirmation_revision) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '受信口が変わりました。読み直してください。', data: { currentVersion: existing.version, confirmationRevision: existing.confirmation_revision } }, 409);
    // 秘密値の入れ替えを伴う更新は鍵・トークンの操作（V）。
    if (body.secret !== undefined && !await sensitiveStepUpSatisfied(c, 'webhook.secret')) {
      return stepUpRequiredResponse(c, '秘密の値の変更には本人確認が必要です');
    }
    if (body.name !== undefined) {
      const nameError = validateWebhookName(body.name);
      if (nameError) {
        return inputError(c, { success: false, error: nameError }, 400, ["name"]);
      }
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive must be a boolean' }, 400, ["isActive"]);
    }
    if (body.secret !== undefined) {
      body.secret = generateWebhookSecret();
      const secretError = validateSecret(body.secret);
      if (secretError) {
        return inputError(c, { success: false, error: secretError }, 400, ["secret"]);
      }
    }
    // isActive だけの更新でも、不正な保存済み秘密値のまま再開させない。復号して長さを確認し、復号不能なら再入力まで停止する。
    if (body.isActive === true) {
      let effectiveSecret = body.secret;
      if (effectiveSecret === undefined) {
        try {
          effectiveSecret = await resolveWebhookSecret(existing, webhookKeysOf(c)) ?? undefined;
        } catch {
          return c.json({ success: false, error: 'secret を確認できませんでした。secret を入れ直してください' }, 503);
        }
      }
      if (!effectiveSecret || effectiveSecret.length < MIN_SECRET_LENGTH) {
        return inputError(c, {
            success: false,
            error: `Cannot activate webhook: secret must be at least ${MIN_SECRET_LENGTH} characters. Update the secret first.`,
          }, 400, ["secret"]);
      }
    }
    const saved = body.expectedConfirmationRevision !== undefined
      ? await updateIncomingWebhook(c.env.DB, id, lineAccountId, body, webhookKeysOf(c), body.expectedVersion as number | undefined, body.expectedConfirmationRevision as number)
      : body.expectedVersion === undefined
        ? await updateIncomingWebhook(c.env.DB, id, lineAccountId, body, webhookKeysOf(c))
        : await updateIncomingWebhook(c.env.DB, id, lineAccountId, body, webhookKeysOf(c), body.expectedVersion as number);
    const updated = await getIncomingWebhookById(c.env.DB, id, lineAccountId);
    if (!updated) return body.expectedConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if ((body.expectedVersion !== undefined || body.expectedConfirmationRevision !== undefined) && !saved) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '受信口が変わりました。読み直してください。', data: { currentVersion: updated.version, confirmationRevision: updated.confirmation_revision } }, 409);
    //  動かす/止める・合言葉の入れ直し・その他の変更を分けて記録する。
    if (body.isActive !== undefined) {
      auditLog(c, body.isActive ? 'webhook.incoming.activate' : 'webhook.incoming.deactivate',
        { kind: 'incoming_webhook', id }, { lineAccountId });
    }
    if (body.secret !== undefined) {
      auditLog(c, 'webhook.incoming.secret.rotate', { kind: 'incoming_webhook', id }, { lineAccountId });
    }
    if (body.folderId !== undefined || body.name !== undefined || body.sourceType !== undefined) {
      auditLog(c, 'webhook.incoming.update', { kind: 'incoming_webhook', id }, { lineAccountId });
    }
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        folderId: updated.folder_id ?? null,
        sourceType: updated.source_type,
        hasSecret: hasWebhookSecret(updated),
        ...(body.secret !== undefined ? { secret: body.secret } : {}),
        previousSecretUsableUntil: previousSecretUsableUntil(updated),
        isActive: Boolean(updated.is_active),
        version: updated.version ?? 1,
        confirmationRevision: updated.confirmation_revision,
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

export const delete__api_webhooks_incoming_id_6 = async (c: Context<Env, "/api/webhooks/incoming/:id">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const rawVersion = c.req.query('expectedVersion');
    const rawConfirmationRevision = c.req.query('expectedConfirmationRevision');
    const existing = await getIncomingWebhookById(c.env.DB, id, lineAccountId);
    if (!existing) return rawConfirmationRevision === undefined ? c.json({ success: false, error: 'Not found' }, 404) : c.json({ success: false, code: 'VERSION_CONFLICT', error: '対象が変わりました。読み直してください。', data: null }, 409);
    if (rawConfirmationRevision !== undefined && (!/^[1-9]\d*$/.test(rawConfirmationRevision) || !Number.isSafeInteger(Number(rawConfirmationRevision)))) return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    if (rawVersion !== undefined && (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)))) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedVersion']);
    }
    const deleted = await deleteIncomingWebhook(c.env.DB, id, lineAccountId, c.get('staff')?.id, rawVersion === undefined ? undefined : Number(rawVersion), rawConfirmationRevision === undefined ? undefined : Number(rawConfirmationRevision));
    if ((rawVersion !== undefined || rawConfirmationRevision !== undefined) && !deleted) {
      const current = await getIncomingWebhookById(c.env.DB, id, lineAccountId);
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: '受信口が変わりました。読み直してください。', data: current ? { currentVersion: current.version, confirmationRevision: current.confirmation_revision } : null }, 409);
    }
    auditLog(c, 'webhook.incoming.delete', { kind: 'incoming_webhook', id }, { lineAccountId });
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_incoming_id_restore_7 = async (c: Context<Env, "/api/webhooks/incoming/:id/restore">) => {
  try {
    const id = c.req.param('id');
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを変更する権限がありません' }, 403);
    }
    const restored = await restoreIncomingWebhook(c.env.DB, id, lineAccountId);
    if (!restored) return c.json({ success: false, error: 'Not found' }, 404);
    const item = await getIncomingWebhookById(c.env.DB, id, lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    auditLog(c, 'webhook.incoming.restore', { kind: 'incoming_webhook', id }, { lineAccountId });
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        folderId: item.folder_id ?? null,
        sourceType: item.source_type,
        hasSecret: hasWebhookSecret(item),
        previousSecretUsableUntil: previousSecretUsableUntil(item),
        isActive: Boolean(item.is_active),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_webhooks_incoming_id_unmatched_8 = async (c: Context<Env, "/api/webhooks/incoming/:id/unmatched">) => {
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
    const webhook = await getIncomingWebhookById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!webhook) return c.json({ success: false, error: 'Not found' }, 404);
    const status = c.req.query('status');
    const listStatus = status === 'resolved' || status === 'dismissed' ? status : 'pending';
    // 50件超えは limit/offset で辿る。空表示の判定に使う総数も返す。
    const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 50, limitPolicy: { fallback: 'falsy', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'falsy', minimum: 0 } });
    const [items, total] = await Promise.all([
      listIncomingWebhookUnmatched(c.env.DB, webhook.id, lineAccountId, listStatus, limit, offset),
      countIncomingWebhookUnmatched(c.env.DB, webhook.id, lineAccountId, listStatus),
    ]);
    /*
     * 複数一致で保留した届物は、人が選べるよう候補の友だちを
     * 名前つきで返す。候補に載っていない友だちが選ばれても構わない
     * (運用者が別途確かめた場合を塞がない)。
     */
    const candidateIds = [...new Set(items.flatMap((item) =>
      safeJson<string[]>(item.candidate_friend_ids_json, [])))];
    const candidateNames = new Map<string, string | null>();
    if (candidateIds.length > 0) {
      const placeholders = sqlIdSet(candidateIds).sql;
      const rows = await c.env.DB.prepare(
        `SELECT id, display_name FROM friends WHERE line_account_id = ? AND id IN (${placeholders})`,
      ).bind(lineAccountId, ...(candidateIds.length ? sqlIdSet(candidateIds).binds : [])).all<{ id: string; display_name: string | null }>();
      for (const row of rows.results ?? []) candidateNames.set(row.id, row.display_name);
    }
    const responseItems = items.map((item) => {
        const friendIds = item.kind === 'ambiguous'
          ? safeJson<string[]>(item.candidate_friend_ids_json, [])
          : [];
        return {
          id: item.id,
          kind: item.kind,
          status: item.status,
          identityAttempts: safeJson<Array<{ kind: string; path: string; value: string }>>(
            item.identity_attempts_json, [],
          ),
          maskedShape: safeJson<unknown>(item.masked_shape_json, null),
          candidates: friendIds.map((friendId) => ({
            friendId,
            displayName: candidateNames.get(friendId) ?? null,
          })),
          resolvedFriendId: item.resolved_friend_id,
          resolvedAt: item.resolved_at,
          receivedAt: item.received_at,
        };
      });
    return c.json(buildOffsetListResponse({ success: true,
      total,
      data: responseItems, items: responseItems, paging: { limit, offset }, sort: [] }));
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_incoming_id_test_9 = async (c: Context<Env, "/api/webhooks/incoming/:id/test">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    const staff = c.get('staff');
    if (staff?.role === 'staff' && !staff.permissionKeys?.includes('/webhooks')) {
      return c.json({ success: false, error: 'この機能を表示する権限がありません' }, 403);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, staff, [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const declaredLength = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INCOMING_BODY_BYTES) {
      return c.json({ success: false, error: 'Payload too large' }, 413);
    }
    const body = await c.req.json<{ payload?: unknown }>().catch(() => null);
    if (!body || body.payload === undefined) {
      return inputError(c, { success: false, error: '試すJSONを payload に入れてください' }, 400, ["payload"]);
    }
    const webhook = await getIncomingWebhookById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!webhook) return c.json({ success: false, error: 'Not found' }, 404);
    const preview = await previewIncomingWebhook(c.env.DB, {
      lineAccountId,
      payload: body.payload,
      identityMatching: safeJson<IncomingWebhookIdentityMatch>(webhook.identity_match_json, {
        methods: [], onNotFound: 'do_nothing',
      }),
      actions: safeJson<IncomingWebhookActionRef[]>(webhook.action_refs_json, []),
    });
    // 試しの結果はやり取り台帳へ test 種別で分けて残す。本文は残さない。
    // d23d : 「試しが終わった」と「照合できた」は別の話。試算の結果を
    // 記録へ残し、一覧で実際の受信の「結びつきました」と見分けが付くようにする。
    const outcome: IncomingTestOutcome = preview.actions.some((action) => !action.ok)
      ? 'invalid'
      : preview.match.status === 'matched'
        ? 'matched'
        : preview.match.status === 'ambiguous'
          ? 'ambiguous'
          : 'not_found';
    const outcomeSummary = {
      matched: '友だちと照合できた',
      ambiguous: '照合候補が複数あった',
      not_found: '照合相手がいなかった',
      invalid: '行動の確認で不備があった',
    }[outcome];
    const started = Date.now();
    try {
      const interaction = await createWebhookInteraction(c.env.DB, {
        lineAccountId,
        direction: 'incoming',
        webhookId: webhook.id,
        webhookName: webhook.name,
        eventType: 'incoming_webhook.test',
        triggerSummary: `${webhook.name}の受け取りを試した・${outcomeSummary}`,
        requestBodyJson: null,
        // 試しは再送しないので冪等キーは使われない。結果の種類を印として残す。
        idempotencyKey: incomingTestIdempotencyKey(outcome),
      });
      await finishWebhookInteraction(c.env.DB, interaction.id, lineAccountId, {
        status: 'succeeded',
        // 相手へ送信しない試しに「相手の応答番号」は存在しない。
        responseStatus: null,
        attemptCount: 1,
        durationMs: Date.now() - started,
      });
    } catch (logError) {
      // 台帳の一時障害で試し自体を止めない。
      logger.error("webhooks.webhooks_incoming_id_test_post_failed");
    }
    auditLog(c, 'webhook.incoming.test', { kind: 'incoming_webhook', id: webhook.id }, { lineAccountId });
    return c.json({
      success: true,
      data: {
        match: preview.match.status === 'matched'
          ? { status: 'matched' as const, friendId: preview.match.friendId }
          : preview.match.status === 'ambiguous'
            ? { status: 'ambiguous' as const, friendIds: preview.match.friendIds }
            : { status: 'not_found' as const },
        identityAttempts: preview.identityAttempts,
        actions: await Promise.all(preview.actions.map(async (action) => ({
          refIndex: action.refIndex,
          refKind: action.ref.refKind,
          refId: action.ref.refId,
          displayName: await incomingActionDisplayName(c.env.DB, action.ref),
          ok: action.ok,
          plan: action.ok ? action.plan : undefined,
          error: action.ok ? undefined : action.error,
        }))),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_webhooks_unmatched_id_resolve_10 = async (c: Context<Env, "/api/webhooks/unmatched/:id/resolve">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const body = await c.req.json<{ action?: unknown; friendId?: unknown }>().catch(() => null);
    const action = body?.action;
    if (action !== 'dismiss' && action !== 'link') {
      return inputError(c, { success: false, error: 'action は dismiss か link を指定してください' }, 400, ["action"]);
    }
    const item = await getIncomingWebhookUnmatchedById(c.env.DB, c.req.param('id'), lineAccountId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    let friendId: string | undefined;
    if (action === 'link') {
      if (typeof body?.friendId !== 'string' || !body.friendId.trim()) {
        return inputError(c, { success: false, error: '結び付ける友だちを指定してください' }, 400, ["friendId"]);
      }
      friendId = body.friendId.trim();
      const friend = await c.env.DB.prepare(
        'SELECT id FROM friends WHERE id = ? AND line_account_id = ?',
      ).bind(friendId, lineAccountId).first<{ id: string }>();
      if (!friend) return c.json({ success: false, error: 'その友だちはこのLINEアカウントにいません' }, 404);
    }
    const resolved = await resolveIncomingWebhookUnmatched(
      c.env.DB, item.id, lineAccountId,
      action === 'link' ? { action: 'link', friendId: friendId! } : { action: 'dismiss' },
      c.get('staff')?.id,
    );
    if (!resolved) return c.json({ success: false, error: 'すでに処理済みです' }, 409);
    auditLog(c, 'webhook.incoming.unmatched.resolve',
      { kind: 'incoming_webhook_unmatched', id: item.id }, { lineAccountId });
    return c.json({ success: true, data: { id: item.id, status: action === 'link' ? 'resolved' : 'dismissed' } });
  } catch (err) {
    throw err;
  }
};

export const get__api_webhooks_outgoing_11 = async (c: Context<Env, "/api/webhooks/outgoing">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    // 受信の詳細口と同じ境界に寄せる( 中)。
    const outgoingStaff = c.get('staff');
    if (outgoingStaff?.role === 'staff' && !outgoingStaff.permissionKeys?.includes('/webhooks')) {
      return c.json({ success: false, error: 'この機能を表示する権限がありません' }, 403);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const [items, summaries] = await Promise.all([
      getOutgoingWebhooks(c.env.DB, lineAccountId),
      getOutgoingWebhookDeliverySummaries(c.env.DB, lineAccountId, 30),
    ]);
    const summaryById = new Map(summaries.map((summary) => [summary.webhook_id, summary]));
    return c.json({
      success: true,
      data: items.map((w) => {
        const summary = summaryById.get(w.id);
        const succeeded = Number(summary?.succeeded ?? 0);
        const total = Number(summary?.total ?? 0);
        return {
          id: w.id,
          name: w.name,
          folderId: w.folder_id ?? null,
          url: w.url,
          eventTypes: outgoingEventTypes(w.event_types, w.id),
          hasSecret: hasWebhookSecret(w),
          isActive: Boolean(w.is_active),
          maxRetries: w.max_retries ?? 0,
          consecutiveFailures: w.consecutive_failures ?? 0,
          lastFailedAt: w.last_failed_at ?? null,
          deliverySummary: {
            periodDays: 30,
            total,
            succeeded,
            failed: Number(summary?.failed ?? 0),
            pending: Number(summary?.pending ?? 0),
            successRate: total > 0 ? Math.round((succeeded / total) * 10_000) / 100 : null,
            lastResult: summary?.last_status ? {
              status: summary.last_status,
              responseStatus: summary.last_response_status,
              completedAt: summary.last_completed_at,
              failureReason: webhookFailureLabel(summary.last_failure_reason),
            } : null,
            canRetry: Boolean(summary?.can_retry),
          },
          createdAt: w.created_at,
          updatedAt: w.updated_at,
          version: w.version ?? 1,
          confirmationRevision: w.confirmation_revision,
          updatedBy: w.updated_by_staff_id ?? null,
        };
      }),
    });
  } catch (error) {
    throw error;
  }
};
