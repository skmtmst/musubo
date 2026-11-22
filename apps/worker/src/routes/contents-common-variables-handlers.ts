import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { jstNow, getCommonVarById, createCommonVar, updateCommonVar, CommonVarFolderError, CommonVarKeyConflictError, deleteCommonVar, getCommonVarUsageImpact, getCommonVarReplacementCandidates, getCommonVarReplacementPlan, applyCommonVarReplacementPlan, CommonVarVersionConflictError, getCommonVarSchedules, createCommonVarSchedule, deleteCommonVarSchedule, validateFieldKey, COMMON_VAR_TYPES, normalizeCommonVarValue, isSecretLikeValue, setCommonVarStatus, CommonVarReasonRequiredError, CommonVarStatusTransitionError, type CommonVarType } from '@line-crm/db';

import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { parseCommonVarValidity, serializeVar, RequestBodyError, parseCommonVarImpactProof, commonVarUsageRevision, serializeCommonVarDeleteImpact, serializeCommonVarChangeImpact, buildCommonVarImpactProof, commonVarReplacementRevision, serializeCommonVarReplacementPlan, serializeSchedule, isValidScheduleDateTime } from './contents-definition.js';
import type { Context } from 'hono';

export const post__api_common_vars_1 = async (c: Context<Env, "/api/common-vars">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return inputError(c, { success: false, error: '名前を入力してください' }, 400, ["name"]);

    // 差し込み名の決まりは友だち情報欄と同じ。片方だけ緩めると、
    // 「情報欄では使えないのに共通情報では使える名前」ができて混乱する。
    const keyCheck = validateFieldKey(body.varKey);
    if (!keyCheck.ok) return inputError(c, { success: false, error: keyCheck.error }, 422, ["varKey"]);

    // 不正な種別は黙って標準にしない。誤った種別での登録に気づけなくなる。
    const typeRaw = body.type === undefined ? 'text' : String(body.type);
    if (!(COMMON_VAR_TYPES as readonly string[]).includes(typeRaw)) {
      return inputError(c, { success: false, error: '種別が正しくありません。選び直してください' }, 400, ["type"]);
    }
    const type = typeRaw as CommonVarType;

    // 編集画面の入力欄と同じ上限を口でも守る。超えた値は送信時に落ち、
    // 原因がこの操作と結びつかなくなる。
    const rawValue = body.value == null ? '' : String(body.value);
    const value = normalizeCommonVarValue(type, rawValue);
    const memo = body.memo == null ? '' : String(body.memo);
    if (name.length > 200) {
      return inputError(c, { success: false, error: '名前は200文字までで入力してください' }, 400, ["name"]);
    }
    if (value === null) {
      // VAR-06: 何が悪いかを画面へ返す。画像はURL形だけを受け（VAR-03）、
      // URL型は http/https のURLだけを受ける。
      return inputError(c, {
        success: false,
        error: type === 'image'
          ? '画像には https:// からはじまるURLを入力してください'
          : type === 'url'
            ? 'URLの値は http:// または https:// からはじまる形で入力してください'
            : '種別に合う値を入力してください',
      }, 400, ["type","value"]);
    }
    if (memo.length > 1000) {
      return inputError(c, { success: false, error: 'メモは1000文字までで入力してください' }, 400, ["memo"]);
    }
    const validity = parseCommonVarValidity(body);
    const fallbackValue = validity.fallbackValue === null
      ? null
      : normalizeCommonVarValue(type, validity.fallbackValue);
    if (validity.fallbackValue !== null && fallbackValue === null) {
      return inputError(c, { success: false, error: '代替値は種別に合う値を入力してください' }, 400, ["valid_from","valid_until","expiryBehavior","expiry_behavior","fallbackValue","fallback_value","type"]);
    }
    // 鍵やトークンのような秘密の値は共通情報に置かせない。
    if (isSecretLikeValue(value) || (fallbackValue !== null && isSecretLikeValue(fallbackValue))) {
      return inputError(c, {
        success: false,
        code: 'secret_value_not_allowed',
        error: '鍵やトークンのような秘密の値は共通情報に保存できません。外部連携の設定へ登録してください',
      }, 422, ["type","value","valid_from","valid_until","expiryBehavior","expiry_behavior","fallbackValue","fallback_value"]);
    }
    const statusRaw = body.status === undefined ? 'active' : String(body.status);
    if (statusRaw !== 'active' && statusRaw !== 'draft') {
      return inputError(c, { success: false, error: '状態は「下書き」か「使用中」で登録してください' }, 400, ["status"]);
    }

    const created = await createCommonVar(c.env.DB, {
      lineAccountId: accountId,
      name,
      varKey: String(body.varKey),
      type,
      value,
      memo,
      actorId: c.get('staff').id,
      folderId: body.folderId ? String(body.folderId) : null,
      validFrom: validity.validFrom.value,
      validUntil: validity.validUntil.value,
      fallbackValue,
      expiryBehavior: validity.expiryBehavior,
      status: statusRaw as 'draft' | 'active',
    });
    return c.json({ success: true, data: serializeVar(created) }, 201);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    if (err instanceof CommonVarFolderError) {
      return inputError(c, { success: false, error: '指定のフォルダが見つかりません。フォルダを選び直してください' }, 400, ["folderId"]);
    }
    if (err instanceof CommonVarKeyConflictError) {
      return c.json({ success: false, error: 'その差し込み名は既に使われています' }, 409);
    }
    throw err;
  }
};

export const patch__api_common_vars_id_2 = async (c: Context<Env, "/api/common-vars/:id">) => {
  try {
    const id = c.req.param('id');
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getCommonVarById(c.env.DB, id, accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = await c.req.json<Record<string, unknown>>();
    const expectedVersion = body.expectedVersion === undefined
      ? undefined
      : Number(body.expectedVersion);
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
      return inputError(c, { success: false, error: 'expectedVersion must be a positive integer' }, 400, ["expectedVersion"]);
    }
    // 差し込み名は変えられない。変えるとテンプレートの差し込みが黙って空になる。
    if (body.varKey !== undefined && body.varKey !== existing.var_key) {
      return inputError(c, {
          success: false,
          error:
            '差し込み名は後から変えられません。テンプレートの差し込みが空になるためです。新しく作ってください。',
        }, 422, ["varKey","accountId"]);
    }
    if (expectedVersion === undefined) return inputError(c, { success: false, code: 'EXPECTED_VERSION_REQUIRED', error: '確認した版が必要です' }, 400, ['expectedVersion']);
    // 空の名前は作れない(登録時と同じ)。
    const patchName = body.name === undefined ? undefined : String(body.name).trim();
    if (patchName !== undefined && !patchName) {
      return inputError(c, { success: false, error: '名前を入力してください' }, 400, ["name"]);
    }
    if (patchName !== undefined && patchName.length > 200) {
      return inputError(c, { success: false, error: '名前は200文字までで入力してください' }, 400, ["name"]);
    }
    const patchValue = body.value === undefined ? undefined : normalizeCommonVarValue(existing.type as CommonVarType, String(body.value));
    if (patchValue === null) {
      return inputError(c, {
        success: false,
        error: existing.type === 'image'
          ? '画像には https:// からはじまるURLを入力してください'
          : existing.type === 'url'
            ? 'URLの値は http:// または https:// からはじまる形で入力してください'
            : '種別に合う値を入力してください',
      }, 400, ["value","accountId"]);
    }
    const patchMemo = body.memo === undefined ? undefined : String(body.memo);
    if (patchMemo !== undefined && patchMemo.length > 1000) {
      return inputError(c, { success: false, error: 'メモは1000文字までで入力してください' }, 400, ["memo"]);
    }
    // 変える理由は必須。後から履歴を見た人が「なぜ変えたか」を追えるようにする。
    const changeReason = typeof body.changeReason === 'string' ? body.changeReason.trim() : '';
    if (!changeReason) {
      return inputError(c, {
        success: false,
        code: 'change_reason_required',
        error: '変える理由を入力してください',
      }, 400, ["changeReason"]);
    }
    if (patchValue !== undefined && isSecretLikeValue(patchValue)) {
      return inputError(c, {
        success: false,
        code: 'secret_value_not_allowed',
        error: '鍵やトークンのような秘密の値は共通情報に保存できません。外部連携の設定へ登録してください',
      }, 422, ["value","accountId"]);
    }
    const validity = parseCommonVarValidity(body, existing);
    const normalizedFallback = validity.fallbackValue === null
      ? null
      : normalizeCommonVarValue(existing.type as CommonVarType, validity.fallbackValue);
    if (validity.fallbackValue !== null && normalizedFallback === null) {
      return inputError(c, { success: false, error: '代替値は種別に合う値を入力してください' }, 400, ["accountId","valid_from","valid_until","expiryBehavior","expiry_behavior","fallbackValue","fallback_value"]);
    }
    if (normalizedFallback !== null && isSecretLikeValue(normalizedFallback)) {
      return inputError(c, {
        success: false,
        code: 'secret_value_not_allowed',
        error: '鍵やトークンのような秘密の値は代替値にも保存できません',
      }, 422, ["accountId","valid_from","valid_until","expiryBehavior","expiry_behavior","fallbackValue","fallback_value"]);
    }
    // 影響確認なしの保存を止める。確認値は対象ID・版・使用先集合の写し。
    // 形の検査は先に済ませているため、ここからは確認値だけを見る。
    const presentedProof = parseCommonVarImpactProof(body.impactProof);
    if (!presentedProof) {
      return c.json({
        success: false,
        code: 'impact_confirmation_required',
        error: '影響を確認してから保存してください。値を確認画面で見直すと確認値が発行されます。',
      }, 428);
    }
    if (presentedProof.varId !== id) {
      return c.json({
        success: false,
        code: 'impact_proof_mismatch',
        error: '別の共通情報の確認値です。保存する項目で影響を確認し直してください。',
      }, 409);
    }
    if (presentedProof.version !== existing.version) {
      return c.json({
        success: false,
        code: 'impact_proof_stale',
        error: '別の担当者が先に更新しました。最新内容を読み直してください。',
        currentVersion: existing.version,
      }, 409);
    }
    const freshImpact = await getCommonVarUsageImpact(c.env.DB, existing.var_key, accountId);
    const freshHex = await commonVarUsageRevision(existing, freshImpact);
    if (freshHex !== presentedProof.hex) {
      return c.json({
        success: false,
        code: 'impact_usage_changed',
        error: '確認後に使用先が変わりました。影響を確認し直してください。',
      }, 409);
    }
    const updated = await updateCommonVar(c.env.DB, id, accountId, {
      name: patchName,
      value: patchValue,
      memo: patchMemo,
      expectedVersion,
      actorId: c.get('staff').id,
      changeReason,
      ...(validity.validFrom.present ? { validFrom: validity.validFrom.value } : {}),
      ...(validity.validUntil.present ? { validUntil: validity.validUntil.value } : {}),
      ...(validity.fallbackPresent ? { fallbackValue: normalizedFallback } : {}),
      ...(body.expiryBehavior !== undefined ? { expiryBehavior: validity.expiryBehavior } : {}),
      ...(('folderId' in body) ? { folderId: body.folderId ? String(body.folderId) : null } : {}),
    });
    return c.json({ success: true, data: serializeVar(updated!) });
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    if (err instanceof CommonVarReasonRequiredError) {
      return inputError(c, { success: false, code: 'change_reason_required', error: '変える理由を入力してください' }, 400, ["reason"]);
    }
    if (err instanceof CommonVarFolderError) {
      return inputError(c, { success: false, error: '指定のフォルダが見つかりません。フォルダを選び直してください' }, 400, ["folderId"]);
    }
    if (err instanceof CommonVarVersionConflictError) {
      return c.json({
        success: false,
        error: '別の担当者が先に更新しました。最新内容を読み直してください。',
        code: 'common_var_version_conflict',
        currentVersion: err.currentVersion,
      }, 409);
    }
    throw err;
  }
};

export const post__api_common_vars_id_status_3 = async (c: Context<Env, "/api/common-vars/:id/status">) => {
  try {
    const id = c.req.param('id');
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const to = String(body.to ?? '');
    if (to !== 'active' && to !== 'stopped') {
      return inputError(c, { success: false, error: '状態は「使用中」か「止めた」のどちらかにしてください' }, 400, ["to"]);
    }
    const changeReason = typeof body.changeReason === 'string' ? body.changeReason.trim() : '';
    if (!changeReason) {
      return inputError(c, {
        success: false,
        code: 'change_reason_required',
        error: '変える理由を入力してください',
      }, 400, ["changeReason"]);
    }
    const expectedVersion = body.expectedVersion === undefined
      ? undefined
      : Number(body.expectedVersion);
    const updated = await setCommonVarStatus(c.env.DB, id, accountId, {
      to,
      changeReason,
      expectedVersion,
      actorId: c.get('staff').id,
    });
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeVar(updated) });
  } catch (err) {
    if (err instanceof CommonVarStatusTransitionError) {
      return inputError(c, {
        success: false,
        code: 'invalid_status_transition',
        error: `今の状態（${err.from === 'draft' ? '下書き' : err.from === 'active' ? '使用中' : '止めた'}）からはその操作ができません`,
      }, 422, []);
    }
    if (err instanceof CommonVarReasonRequiredError) {
      return inputError(c, { success: false, code: 'change_reason_required', error: '変える理由を入力してください' }, 400, ["reason"]);
    }
    if (err instanceof CommonVarVersionConflictError) {
      return c.json({
        success: false,
        error: '別の担当者が先に更新しました。最新内容を読み直してください。',
        code: 'common_var_version_conflict',
        currentVersion: err.currentVersion,
      }, 409);
    }
    throw err;
  }
};

export const get__api_common_vars_id_delete_impact_4 = async (c: Context<Env, "/api/common-vars/:id/delete-impact">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const impact = await getCommonVarUsageImpact(c.env.DB, existing.var_key, accountId);
    return c.json({ success: true, data: serializeCommonVarDeleteImpact(existing, impact) });
  } catch (err) {
    logger.error("contents.common_vars_id_delete_impact_get_failed");
    return c.json(
      { success: false, error: '使用先を確認できないため削除できません' },
      503,
    );
  }
};

export const post__api_common_vars_id_impact_preview_5 = async (c: Context<Env, "/api/common-vars/:id/impact-preview">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (typeof body.nextValue !== 'string') {
      return inputError(c, { success: false, error: '変更後の値を入力してください' }, 400, ["nextValue"]);
    }
    const existing = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (body.expectedVersion !== undefined) {
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return inputError(c, { success: false, error: 'expectedVersion must be a positive integer' }, 400, ["expectedVersion"]);
      }
      if (expectedVersion !== existing.version) {
        return c.json({
          success: false,
          error: '別の担当者が先に更新しました。最新内容を読み直してください。',
          code: 'common_var_version_conflict',
          currentVersion: existing.version,
        }, 409);
      }
    }
    const impact = await getCommonVarUsageImpact(c.env.DB, existing.var_key, accountId);
    const serialized = serializeCommonVarChangeImpact(existing, impact, body.nextValue);
    const usageHex = await commonVarUsageRevision(existing, impact);
    return c.json({
      success: true,
      data: {
        ...serialized,
        version: existing.version,
        usageByKind: impact.byKind,
        scheduledUsageCount: impact.items.filter((item) => item.source_status === 'scheduled').length,
        publishedUsageCount: impact.items.filter((item) =>
          item.source_status === 'active' || item.source_status === 'sending'
            || item.source_status === 'published').length,
        // 送信開始時の値で固定済みの配信中。保存しても変わらない側へ数える。
        sendingFixedUsageCount: impact.items.filter(
          (item) => item.source_status === 'sending_fixed').length,
        usageRevision: usageHex,
        // 保存口へ添える確認値。対象ID・版・使用先集合の写しで使い回し不可。
        impactProof: buildCommonVarImpactProof(existing.id, existing.version, usageHex),
      },
    });
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    logger.error("contents.common_vars_id_impact_preview_post_failed");
    return c.json(
      { success: false, error: '影響する場所を確認できませんでした' },
      503,
    );
  }
};

export const post__api_common_vars_id_replace_6 = async (c: Context<Env, "/api/common-vars/:id/replace">) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const source = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
    if (!source) return c.json({ success: false, error: 'Not found' }, 404);
    const replacementId = typeof body.replacementId === 'string' ? body.replacementId.trim() : '';
    if (!replacementId) {
      const candidates = await getCommonVarReplacementCandidates(c.env.DB, source);
      return c.json({
        success: true,
        data: {
          source: { id: source.id, name: source.name, type: source.type, version: source.version },
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            varKey: candidate.var_key,
            type: candidate.type,
            value: candidate.value,
            version: candidate.version,
          })),
        },
      });
    }
    const replacement = await getCommonVarById(c.env.DB, replacementId, accountId);
    if (!replacement) return c.json({ success: false, error: 'Not found' }, 404);
    if (source.id === replacement.id || source.type !== replacement.type) {
      return inputError(c, { success: false, error: '同じ種類の別の共通情報を選んでください' }, 422, ["accountId","replacementId"]);
    }
    const plan = await getCommonVarReplacementPlan(c.env.DB, source, replacement);
    const revision = await commonVarReplacementRevision(plan);
    const preview = serializeCommonVarReplacementPlan(plan, revision);
    if (body.apply !== true) return c.json({ success: true, data: preview });

    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return inputError(c, { success: false, error: 'expectedVersion is required' }, 400, ["expectedVersion"]);
    }
    if (expectedVersion !== source.version) {
      return c.json({
        success: false,
        error: '別の担当者が先に更新しました。最新内容を読み直してください。',
        code: 'common_var_version_conflict',
        currentVersion: source.version,
      }, 409);
    }
    if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== revision) {
      return c.json({
        success: false,
        error: '使用先が変わりました。影響をもう一度確認してください。',
        code: 'common_var_usage_changed',
        data: preview,
      }, 409);
    }
    if (!preview.canReplace) {
      return c.json({
        success: false,
        error: '差し替えられない使用先があります。先に個別に確認してください。',
        code: 'common_var_replacement_blocked',
        data: preview,
      }, 409);
    }
    // 差し替えて保管するときも、やった人の理由を版履歴に残す。
    const replaceReason = typeof body.changeReason === 'string' ? body.changeReason.trim() : '';
    if (!replaceReason) {
      return inputError(c, { success: false, error: '変えた・消した理由を入力してください', code: 'common_var_reason_required' }, 400, ["changeReason"]);
    }
    const result = await applyCommonVarReplacementPlan(c.env.DB, plan, c.get('staff').id, replaceReason);
    let remainingUsageCount: number | null = null;
    try {
      const remaining = await getCommonVarUsageImpact(c.env.DB, source.var_key, accountId);
      remainingUsageCount = remaining.blockingTotal;
    } catch {
      // 差し替え自体は完了している。再走査不能を0件と偽らずnullで返す。
    }
    return c.json({
      success: true,
      data: {
        ...result,
        sourceId: source.id,
        replacementId: replacement.id,
        remainingUsageCount,
        verification: remainingUsageCount === null
          ? 'unavailable'
          : remainingUsageCount === 0 ? 'verified' : 'partial',
        completedAt: jstNow(),
      },
    });
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    if (err instanceof CommonVarVersionConflictError) {
      return c.json({
        success: false,
        error: '別の担当者が先に更新しました。最新内容を読み直してください。',
        code: 'common_var_version_conflict',
        currentVersion: err.currentVersion,
      }, 409);
    }
    logger.error("contents.common_vars_id_replace_post_failed");
    return c.json({ success: false, error: '差し替えの影響を確認できませんでした' }, 503);
  }
};

export const delete__api_common_vars_id_7 = async (c: Context<Env, "/api/common-vars/:id">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    // 消すときも理由が必須。版履歴に残すので空欄や自動入力は受けない。
    const deleteReason = c.req.query('reason')?.trim() ?? '';
    if (!deleteReason) {
      return c.json(
        { success: false, error: '消した理由を入力してください', code: 'common_var_reason_required' },
        400,
      );
    }
    const impact = await getCommonVarUsageImpact(c.env.DB, existing.var_key, accountId);
    const deleteImpact = serializeCommonVarDeleteImpact(existing, impact);
    if (!deleteImpact.canDelete) {
      return c.json(
        {
          success: false,
          error: `${impact.blockingTotal}件で使用中のため削除できません`,
          code: 'common_var_delete_blocked',
          data: deleteImpact,
        },
        409,
      );
    }
    await deleteCommonVar(c.env.DB, existing.id, accountId, c.get('staff').id, deleteReason);
    return c.json({ success: true, data: null });
  } catch (err) {
    logger.error("contents.common_vars_id_delete_failed");
    return c.json(
      { success: false, error: '使用先を確認できないため削除できません' },
      503,
    );
  }
};

export const get__api_common_vars_id_schedules_8 = async (c: Context<Env, "/api/common-vars/:id/schedules">) => {
  const accountId = c.req.query('accountId')?.trim();
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const existing = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const items = await getCommonVarSchedules(c.env.DB, c.req.param('id'));
  return c.json({ success: true, data: items.map(serializeSchedule) });
};

export const post__api_common_vars_id_schedules_9 = async (c: Context<Env, "/api/common-vars/:id/schedules">) => {
  try {
    const varId = c.req.param('id');
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getCommonVarById(c.env.DB, varId, accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    // 同じ画面の impact-preview・replace と同じ16KB制限にする。
    const body = await c.req.json<Record<string, unknown>>();
    const effectiveFrom = typeof body.effectiveFrom === 'string' ? body.effectiveFrom : '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(effectiveFrom)
      || !isValidScheduleDateTime(effectiveFrom)) {
      return inputError(c, { success: false, error: '切り替える日時は 2026-09-01T10:00 の形で指定してください' }, 400, ["effectiveFrom"]);
    }
    // 過ぎた日時は受け付けない。入れた瞬間に次のCronで当たり、
    // 「予約したつもりが今すぐ変わった」になる。
    const jstNowIso = japanCalendar().toISOString().slice(0, 16);
    if (effectiveFrom < jstNowIso) {
      return inputError(c, { success: false, error: '過去の日時は指定できません' }, 400, ["effectiveFrom"]);
    }

    // VAR-06: 予約の値も登録・編集と同じ型検査を通す。ここを素通りさせると
    // Cron が型に合わない値をそのまま書き込む（真偽の変数へ 'yes' 等）。
    const scheduledValue = typeof body.value === 'string' ? body.value : '';
    const normalizedScheduled = normalizeCommonVarValue(
      existing.type as CommonVarType,
      scheduledValue,
    );
    if (normalizedScheduled === null) {
      return inputError(c, { success: false, error: '更新後の値は種別に合う値を入力してください' }, 400, ["accountId","value"]);
    }
    // 予約で入る値も秘密の値は受け付けない（登録・編集と同じ口）。
    if (isSecretLikeValue(normalizedScheduled)) {
      return inputError(c, {
        success: false,
        code: 'secret_value_not_allowed',
        error: '鍵やトークンのような秘密の値は共通情報に保存できません',
      }, 422, ["accountId","value"]);
    }

    const created = await createCommonVarSchedule(c.env.DB, {
      varId,
      effectiveFrom,
      value: normalizedScheduled,
    });
    return c.json({ success: true, data: serializeSchedule(created) }, 201);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    throw err;
  }
};

export const delete__api_common_vars_id_schedules_scheduleId_10 = async (c: Context<Env, "/api/common-vars/:id/schedules/:scheduleId">) => {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getCommonVarById(c.env.DB, c.req.param('id'), accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    await deleteCommonVarSchedule(c.env.DB, c.req.param('scheduleId'), existing.id);
    return c.json({ success: true, data: null });
  };
