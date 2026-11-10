import { readPriority } from '../features/auto-replies/auto-reply-priority/index.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getAutoReplyById, createAutoReply, updateAutoReply, deleteAutoReply, restoreAutoReply, stopAutoReply, getTemplateById, autoReplyDraftSettingsFromRow, autoReplyRuleCreateFingerprint, createAutoReplyWithDraftVersion, getAutoReplyDraftVersion, getAutoReplyPublishedVersion, parseAutoReplyVersionSettings, saveAutoReplyDraftVersion } from '@line-crm/db';
import type { AutoReply as DbAutoReply, AutoReplyDraftSettings } from '@line-crm/db';


import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { validateFlexContent } from '@line-crm/shared';
import { AUTO_REPLY_KEYWORD_MAX, AUTO_REPLY_RESPONSE_MAX, requireCommonRuleOwner, parseHhmm, parseCooldown, COOLDOWN_RANGE_ERROR, readMessageKinds, MESSAGE_KINDS, assertTemplateVisible, readExtras, validateAutoReplyFolder, readIdempotencyKey, jsonText, conflictsForCreate, idempotencyErrorResponse, internalMemosOf, conflictsForDraft, serializeAutoReply, readDraftSettings, draftInputFromSettings, validIdempotencyKey, AUTO_REPLY_STOP_REASON_MAX, resolveStoppedByNames } from './auto-replies-definition.js';
import type { Context } from 'hono';

export const post__api_auto_replies_1 = async (c: Context<Env, "/api/auto-replies">) => {
  try {
    const body = await c.req.json<{
      keyword: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
      isActive?: unknown;
      activeFrom?: unknown;
      activeUntil?: unknown;
      cooldownMinutes?: unknown;
      skipWhenOperatorActive?: unknown;
      priority?: unknown;
      messageKinds?: unknown;
      respondToAll?: boolean;
      name?: string | null;
      keywordMatchMode?: 'any' | 'all';
      normalizeKeywords?: boolean;
      folderId?: string | null;
    }>();

    // 一律で応答するルール（157）はキーワードを見ないので、空でも作れる。
    // ただし列は NOT NULL なので、空文字を入れておく。
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive must be a boolean' }, 400, ["isActive"]);
    }
    if (!body.keyword && body.respondToAll !== true) {
      return inputError(c, { success: false, error: 'keyword is required' }, 400, ["keyword","respondToAll"]);
    }
    if (typeof body.keyword === 'string' && [...body.keyword].length > AUTO_REPLY_KEYWORD_MAX) {
      return inputError(c, { success: false, error: `keyword must be ${AUTO_REPLY_KEYWORD_MAX} characters or fewer` }, 400, ["keyword"]);
    }
    if (typeof body.responseContent === 'string' && [...body.responseContent].length > AUTO_REPLY_RESPONSE_MAX) {
      return inputError(c, { success: false, error: `responseContent must be ${AUTO_REPLY_RESPONSE_MAX} characters or fewer` }, 400, ["responseContent"]);
    }
    if (body.lineAccountId !== null && body.lineAccountId !== undefined
      && (!body.lineAccountId
        || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId]))) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    // m26c : 全アカウント共通の作成は統括だけ。本文が null でも検査を飛ばさない。
    if (body.lineAccountId === null || body.lineAccountId === undefined) {
      const ownerCheck = await requireCommonRuleOwner(c.env.DB, c.get('staff'));
      if (!ownerCheck.ok) {
        return c.json({ success: false, error: ownerCheck.error }, 403);
      }
    }
    // template_id があれば content は空でも OK (template から resolve される)。
    // silent も content 不要。それ以外は inline content 必須。
    if (!body.templateId && !body.responseContent && body.responseType !== 'silent') {
      return inputError(c, { success: false, error: 'templateId or responseContent required (unless responseType=silent)' }, 400, ["templateId","responseContent","responseType"]);
    }

    const activeFrom = parseHhmm(body.activeFrom);
    const activeUntil = parseHhmm(body.activeUntil);
    const cooldown = parseCooldown(body.cooldownMinutes);
    if (!activeFrom.ok || !activeUntil.ok) {
      return inputError(c, { success: false, error: 'activeFrom/activeUntil must be HH:MM' }, 400, ["activeFrom","activeUntil"]);
    }
    if (!cooldown.ok) {
      return inputError(c, { success: false, error: COOLDOWN_RANGE_ERROR }, 400, ["cooldownMinutes"]);
    }
    const priority = body.priority === undefined ? { ok: true as const, value: 0 } : readPriority(body.priority);
    if (!priority.ok) {
      return inputError(c, { success: false, error: 'priority must be an integer between -9999 and 9999' }, 400, ["priority"]);
    }
    const messageKinds = readMessageKinds(body.messageKinds);
    if (!messageKinds.ok) {
      return inputError(c, { success: false, error: `messageKinds must be an array of ${MESSAGE_KINDS.join(', ')}` }, 400, ["messageKinds"]);
    }

    // template_id が来てて content/type が空の場合、template の現在値を inline
    // snapshot として保存する。これがないと ON DELETE SET NULL で template_id が
    // クリアされた時に webhook resolve が空メッセージにフォールバックしてしまう。
    let resolvedResponseType = body.responseType ?? 'text';
    let resolvedResponseContent = body.responseContent ?? '';
    // m26c : テンプレートの本文を取り込む前に所属の閲覧権限を見る。
    // 内容を送らず ID だけ送った場合も、ID を指定した場合は必ず検査する。
    if (body.templateId) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      const templateError = await assertTemplateVisible(
        c.env.DB,
        c.get('staff'),
        body.templateId,
        tpl ? (tpl.line_account_id ?? null) : null,
      );
      if (templateError) return c.json({ success: false, error: templateError }, 403);
      if (!body.responseContent || !body.responseType) {
        if (tpl) {
          if (!body.responseType) resolvedResponseType = tpl.message_type;
          if (!body.responseContent) resolvedResponseContent = tpl.message_content;
        }
      }
    }

    const extras = readExtras(body as Record<string, unknown>);
    if (!extras.ok) return inputError(c, { success: false, error: extras.error, field: extras.field }, 400, []);
    const folderError = await validateAutoReplyFolder(c.env.DB, extras.value.folderId);
    if (folderError) return inputError(c, { success: false, error: folderError }, 422, ["folderId"]);
    /*
     * 直接入力のカードは構造まで見る。テンプレートから写した中身
     * （content を送らず templateId だけ送った場合）は対象外にする。
     */
    if (body.responseContent) {
      const flexError = validateFlexContent(resolvedResponseType, resolvedResponseContent);
      if (flexError) return inputError(c, { success: false, error: flexError }, 400, ["responseType","responseContent"]);
    }

    // F7: 有効で作る要求があれば、作る前に既存の有効ルールと当てる。
    // 当たれば有効化せず下書きで作り、理由を社内メモへ残す。
    // 当たらなければ要求どおりすぐ有効にする。
    // 停止指定・省略は従来どおり停止のまま（AUTOREPLY-08）。
    let blockedDraftSettings: AutoReplyDraftSettings | null = null;
    let activationBlocked = false;
    let activationBlockedReason: string | null = null;
    // m26c : 確認キーがあれば再送を同じ行へ復帰させる。
    const ruleKey = readIdempotencyKey(c);
    const createInput = {
      ...extras.value,
      keyword: body.keyword ?? '',
      matchType: body.matchType,
      responseType: resolvedResponseType,
      responseContent: resolvedResponseContent,
      templateId: body.templateId ?? null,
      lineAccountId: body.lineAccountId ?? null,
      isActive: body.isActive === true,
      activeFrom: activeFrom.value,
      activeUntil: activeUntil.value,
      cooldownMinutes: cooldown.value,
      skipWhenOperatorActive: body.skipWhenOperatorActive === true,
      priority: priority.value,
      messageKinds: messageKinds.value,
    };
    if (createInput.isActive) {
      const createSettings: AutoReplyDraftSettings = {
        keyword: createInput.keyword,
        matchType: createInput.matchType ?? 'exact',
        responseType: createInput.responseType ?? 'text',
        responseContent: createInput.responseContent,
        templateId: createInput.templateId ?? null,
        lineAccountId: createInput.lineAccountId ?? null,
        activeFrom: createInput.activeFrom ?? null,
        activeUntil: createInput.activeUntil ?? null,
        cooldownMinutes: createInput.cooldownMinutes ?? null,
        skipWhenOperatorActive: createInput.skipWhenOperatorActive === true,
        priority: createInput.priority ?? 0,
        messageKinds: jsonText(createInput.messageKinds),
        receiveSources: ['line'],
        friendConditions: jsonText(createInput.friendConditions),
        actions: jsonText(createInput.actions),
        responseWeekdays: jsonText(createInput.responseWeekdays),
        responseHolidayRule: createInput.responseHolidayRule ?? null,
        oncePerFriend: createInput.oncePerFriend === true,
        keywords: jsonText(createInput.keywords),
        respondToAll: createInput.respondToAll === true,
        name: createInput.name ?? null,
        keywordMatchMode: createInput.keywordMatchMode ?? 'any',
        folderId: createInput.folderId ?? null,
        internalMemo: createInput.internalMemo ?? null,
      };
      const preConflicts = await conflictsForCreate(c.env.DB, createSettings);
      if (preConflicts.length > 0) {
        activationBlocked = true;
        activationBlockedReason = preConflicts.map((item) => item.reason).join(' ');
        createInput.isActive = false;
        const names = [...new Set(preConflicts.map((item) => item.name))].join('／');
        const reasonHead = `競合のため下書きで作成（${names}と重なります）。有効にする前に競合を確認してください。`;
        const userMemo = createInput.internalMemo ?? null;
        const merged = userMemo ? `${reasonHead}\n${userMemo}` : reasonHead;
        // 社内メモは1000文字まで。理由を優先して残す。
        createInput.internalMemo = [...merged].length > 1000
          ? [...merged].slice(0, 1000).join('')
          : merged;
        blockedDraftSettings = { ...createSettings, internalMemo: createInput.internalMemo };
      }
    }
    let item: DbAutoReply;
    try {
      const idempotency = ruleKey
        ? { key: ruleKey, fingerprint: autoReplyRuleCreateFingerprint(createInput) }
        : undefined;
      const created = blockedDraftSettings
        ? await createAutoReplyWithDraftVersion(c.env.DB, blockedDraftSettings, idempotency)
        : await createAutoReply(c.env.DB, createInput, idempotency);
      item = created.rule;
    } catch (err) {
      const mapped = idempotencyErrorResponse(err);
      if (mapped) return inputError(c, { success: false, error: mapped.error }, mapped.status, ["triggerConfig"]);
      throw err;
    }

    const memos = await internalMemosOf(c.env.DB, [item.id]);
    // F7: 作成直後の競合一覧も返す。止めて作った理由は社内メモに残してある。
    const createdSettings = autoReplyDraftSettingsFromRow(item);
    const createConflicts = await conflictsForDraft(c.env.DB, item.id, createdSettings);
    return c.json({
      success: true,
      data: {
        ...serializeAutoReply(item, memos.get(item.id) ?? null),
        conflicts: createConflicts,
        conflictDetected: createConflicts.length > 0,
        activationBlocked,
        activationBlockedReason,
      },
    }, 201);
  } catch (err) {
    throw err;
  }
};

export const put__api_auto_replies_id_2 = async (c: Context<Env, "/api/auto-replies/:id">) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      keyword?: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
      isActive?: boolean;
      activeFrom?: unknown;
      activeUntil?: unknown;
      cooldownMinutes?: unknown;
      skipWhenOperatorActive?: unknown;
      priority?: unknown;
      messageKinds?: unknown;
    }>();

    const input: Record<string, unknown> = {};
    if (body.keyword !== undefined) {
      if (typeof body.keyword === 'string' && [...body.keyword].length > AUTO_REPLY_KEYWORD_MAX) {
        return inputError(c, { success: false, error: `keyword must be ${AUTO_REPLY_KEYWORD_MAX} characters or fewer` }, 400, ["keyword"]);
      }
      input.keyword = body.keyword;
    }
    if (body.matchType !== undefined) input.matchType = body.matchType;
    if (body.responseType !== undefined) input.responseType = body.responseType;
    if (body.responseContent !== undefined) {
      if (typeof body.responseContent === 'string' && [...body.responseContent].length > AUTO_REPLY_RESPONSE_MAX) {
        return inputError(c, { success: false, error: `responseContent must be ${AUTO_REPLY_RESPONSE_MAX} characters or fewer` }, 400, ["responseContent"]);
      }
      /*
       * カード種別を名指しで送ってきた中身は構造まで見る。
       * 種別を送らず中身だけの更新は、既存の種別が読めないため
       * 下書き保存口の検査に任せる。
       */
      if (typeof body.responseContent === 'string' && body.responseType === 'flex') {
        const flexError = validateFlexContent(body.responseType, body.responseContent);
        if (flexError) return inputError(c, { success: false, error: flexError }, 400, ["responseType","responseContent"]);
      }
      input.responseContent = body.responseContent;
    }
    if ('templateId' in body) input.templateId = body.templateId;
    if ('lineAccountId' in body) {
      if (body.lineAccountId !== null && body.lineAccountId !== undefined) {
        if (!body.lineAccountId
          || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId])) {
          return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
        }
      }
      input.lineAccountId = body.lineAccountId;
    }
    if (body.isActive !== undefined) input.isActive = body.isActive;
    if ('activeFrom' in body) {
      const parsed = parseHhmm(body.activeFrom);
      if (!parsed.ok) return inputError(c, { success: false, error: 'activeFrom must be HH:MM' }, 400, ["activeFrom"]);
      input.activeFrom = parsed.value;
    }
    if ('activeUntil' in body) {
      const parsed = parseHhmm(body.activeUntil);
      if (!parsed.ok) return inputError(c, { success: false, error: 'activeUntil must be HH:MM' }, 400, ["activeUntil"]);
      input.activeUntil = parsed.value;
    }
    if ('cooldownMinutes' in body) {
      const parsed = parseCooldown(body.cooldownMinutes);
      if (!parsed.ok) {
        return inputError(c, { success: false, error: COOLDOWN_RANGE_ERROR }, 400, ["cooldownMinutes"]);
      }
      input.cooldownMinutes = parsed.value;
    }
    if ('skipWhenOperatorActive' in body) {
      input.skipWhenOperatorActive = body.skipWhenOperatorActive === true;
    }
    if ('priority' in body) {
      const parsed = readPriority(body.priority);
      if (!parsed.ok) {
        return inputError(c, { success: false, error: 'priority must be an integer between -9999 and 9999' }, 400, ["priority"]);
      }
      input.priority = parsed.value;
    }
    if ('messageKinds' in body) {
      const parsed = readMessageKinds(body.messageKinds);
      if (!parsed.ok) {
        return inputError(c, { success: false, error: `messageKinds must be an array of ${MESSAGE_KINDS.join(', ')}` }, 400, ["messageKinds"]);
      }
      input.messageKinds = parsed.value;
    }

    // templateId が新たに set されて responseContent が来てない場合は template の
    // 現在値を inline snapshot として書き込む (ON DELETE SET NULL の fallback 用)。
    if (body.templateId && body.responseContent === undefined) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      if (tpl) {
        input.responseContent = tpl.message_content;
        if (body.responseType === undefined) input.responseType = tpl.message_type;
      }
    }

    const extras = readExtras(body as Record<string, unknown>);
    if (!extras.ok) return inputError(c, { success: false, error: extras.error, field: extras.field }, 400, []);
    const folderError = await validateAutoReplyFolder(c.env.DB, extras.value.folderId);
    if (folderError) return inputError(c, { success: false, error: folderError }, 422, ["folderId"]);
    Object.assign(input, extras.value);

    // m26c /: 分岐のために既存行を読む。可視性は middleware が見ている。
    const existing = await getAutoReplyById(c.env.DB, id);
    if (!existing) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    // isActive の素の切替以外の入力は、内容の変更として扱う。
    const contentChanged = Object.keys(input).some((key) => key !== 'isActive');
    const wantsCommon = 'lineAccountId' in input
      && (input.lineAccountId === null || input.lineAccountId === undefined);
    // m26c : 共通化・共通ルールの内容変更は統括だけ。
    if (wantsCommon || (existing.line_account_id === null && contentChanged)) {
      const ownerCheck = await requireCommonRuleOwner(c.env.DB, c.get('staff'));
      if (!ownerCheck.ok) {
        return c.json({ success: false, error: ownerCheck.error }, 403);
      }
    }
    // m26c : テンプレート ID の指定は所属の閲覧権限を見る。
    if (body.templateId) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      const templateError = await assertTemplateVisible(
        c.env.DB,
        c.get('staff'),
        body.templateId,
        tpl ? (tpl.line_account_id ?? null) : null,
      );
      if (templateError) return c.json({ success: false, error: templateError }, 403);
    }
    /*
     * m26c : 公開中ルールの内容変更は、稼働定義を直接書き換えない。
     * 下書き版へ保存し、検査・試し応答・競合確認を経た公開だけが版を
     * 切り替える。共通ルールの共通化は統括の直接操作のままにする。
     */
    const live = existing.is_active === 1 || existing.lifecycle_status === 'published';
    if (live && contentChanged && existing.line_account_id !== null && !wantsCommon) {
      const baseVersion = await getAutoReplyDraftVersion(c.env.DB, id)
        ?? await getAutoReplyPublishedVersion(c.env.DB, id);
      const base = baseVersion
        ? parseAutoReplyVersionSettings(baseVersion)
        : autoReplyDraftSettingsFromRow(existing);
      const reparsed = await readDraftSettings(c.env.DB, {
        ...draftInputFromSettings(base),
        ...input,
      });
      if (!reparsed.ok) return inputError(c, { success: false, error: reparsed.error, field: reparsed.field }, 400, []);
      const templateRedirectError = await assertTemplateVisible(
        c.env.DB,
        c.get('staff'),
        reparsed.value.templateId,
        reparsed.templateLineAccountId,
      );
      if (templateRedirectError) {
        return c.json({ success: false, error: templateRedirectError }, 403);
      }
      try {
        const draftVersion = await saveAutoReplyDraftVersion(
          c.env.DB,
          id,
          reparsed.value,
          baseVersion ? Number(baseVersion.version_number) : 0,
        );
        const memos = await internalMemosOf(c.env.DB, [id]);
        return c.json({
          success: true,
          data: {
            ...serializeAutoReply(existing, memos.get(id) ?? null),
            draftSaved: true,
            draftVersionNumber: Number(draftVersion.version_number),
          },
          message: '稼働中の定義は変えていません。下書きに保存しました。競合の確認・テストを経て公開してください。',
        });
      } catch (redirectErr) {
        if (redirectErr instanceof Error && redirectErr.message === 'AUTO_REPLY_VERSION_CONFLICT') {
          return c.json({
            success: false,
            code: 'VERSION_CONFLICT',
            error: 'ほかの変更が先に保存されました。最新の状態を読み直してください',
          }, 409);
        }
        throw redirectErr;
      }
    }

    const updated = await updateAutoReply(c.env.DB, id, input as Parameters<typeof updateAutoReply>[2]);

    if (!updated) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }

    const memos = await internalMemosOf(c.env.DB, [updated.id]);
    return c.json({ success: true, data: serializeAutoReply(updated, memos.get(updated.id) ?? null) });
  } catch (err) {
    throw err;
  }
};

export const post__api_auto_replies_id_stop_3 = async (c: Context<Env, "/api/auto-replies/:id/stop">) => {
  try {
    const requestKey = c.req.header('Idempotency-Key');
    if (!validIdempotencyKey(requestKey)) {
      return inputError(c, { success: false, error: '停止操作の確認キーが必要です' }, 400, []);
    }
    let body: { reason?: unknown; expectedVersion?: unknown } = {};
    const raw = await c.req.text().catch(() => '');
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as typeof body;
        else if (/expectedVersion/i.test(raw)) return inputError(c, { success: false, error: 'invalid_confirmation_version' }, 400, ['expectedVersion']);
      } catch {
        if (/expectedVersion/i.test(raw)) return inputError(c, { success: false, error: 'invalid_confirmation_version' }, 400, ['expectedVersion']);
      }
    }
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) return inputError(c, { success: false, error: 'invalid_confirmation_version' }, 400, ['expectedVersion']);
    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string') {
        return inputError(c, { success: false, error: '停止の理由は文字列で入力してください' }, 400, ["reason"]);
      }
      const trimmed = body.reason.trim();
      if ([...trimmed].length > AUTO_REPLY_STOP_REASON_MAX) {
        return inputError(c, {
          success: false,
          error: `停止の理由は${AUTO_REPLY_STOP_REASON_MAX}文字以内で入力してください`,
        }, 400, ["reason"]);
      }
      reason = trimmed === '' ? null : trimmed;
    }
    const stopped = await stopAutoReply(c.env.DB, {
      id: c.req.param('id'),
      staffId: c.get('staff')?.id ?? null,
      reason,
      idempotencyKey: requestKey,
      expectedVersion: body.expectedVersion as number | undefined,
    });
    if (!stopped) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    const memos = await internalMemosOf(c.env.DB, [stopped.id]);
    const data = serializeAutoReply(stopped, memos.get(stopped.id) ?? null);
    await resolveStoppedByNames(c.env.DB, [data]);
    return c.json({ success: true, data });
  } catch (err) {
    if (err instanceof Error && err.message === 'AUTO_REPLY_CONFIRMATION_CONFLICT') {
      const current = await getAutoReplyById(c.env.DB, c.req.param('id'));
      return c.json({ success: false, code: 'auto_reply_confirmation_conflict', error: '自動応答が変更されました。最新の内容を確認してください', data: current ? serializeAutoReply(current) : null }, 409);
    }
    throw err;
  }
};

export const delete__api_auto_replies_id_4 = async (c: Context<Env, "/api/auto-replies/:id">) => {
  try {
    const id = c.req.param('id');
    const item = await getAutoReplyById(c.env.DB, id);
    if (!item) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    await deleteAutoReply(c.env.DB, id, c.get('staff')?.id ?? null);
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
};

export const post__api_auto_replies_id_restore_5 = async (c: Context<Env, "/api/auto-replies/:id/restore">) => {
  try {
    const restored = await restoreAutoReply(c.env.DB, c.req.param('id'));
    if (!restored) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    const memos = await internalMemosOf(c.env.DB, [restored.id]);
    const data = serializeAutoReply(restored, memos.get(restored.id) ?? null);
    await resolveStoppedByNames(c.env.DB, [data]);
    return c.json({ success: true, data });
  } catch (err) {
    throw err;
  }
};
