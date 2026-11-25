import { readRestaurantFollowupResourceManagement } from '../services/restaurant-followup-resource-management.js';
import { logger } from '@line-crm/shared/server';
import { publicReminder } from './reminder-display.js';
import type { ReminderListRow } from './reminder-display.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { buildReminderStepMessage } from '../services/reminder-delivery.js';
import { getTemplateById } from '@line-crm/db';
import { getFriendById, getReminders, getRemindersByIds, reorderReminders, getReminderById, getReminderSteps, getReminderVersionSteps, createReminderWithDraftVersion, getReminderDraftVersion, getReminderPublishedVersion, parseReminderVersionSettings, publishReminderDraftVersion, recordReminderDraftTest, saveReminderDraftVersion, type ReminderDraftSettings } from '@line-crm/db';
import { fail } from '../lib/fail.js';


import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import { countReminderAudience, previewReminderDraft, resolveReminderTestRecipient, sampleReminderAudience, testReminderDraft, validateReminderDraft } from '../services/reminder-draft.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { escapedLike, REMINDER_LIST_SORTS, loadReminderListSummaries, readDraftSettings, validateReminderFolder, validateReminderDraftReferences, versionResponse, readTargetCondition } from './reminders-definition.js';
import type { Context } from 'hono';

export const patch__api_reminders_reorder_1 = async (c: Context<Env, "/api/reminders/reorder">) => {
  try {
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string')) {
      return inputError(c, { success: false, error: 'ids must be an array of reminder ids' }, 400, ["ids"]);
    }
    if (body.ids.length > 500) {
      return inputError(c, { success: false, error: 'too many ids' }, 400, ["ids"]);
    }
    /*
     * 渡されたidが操作できるアカウントのものか確かめる。範囲外が1件でも
     * 混ざったら並べ替え自体を行わない（他アカウントの並びを書き換えない）。
     */
    const targets = await getRemindersByIds(c.env.DB, body.ids as string[]);
    if (targets.length !== new Set(body.ids as string[]).size) {
      return c.json({ success: false, error: 'リマインダが見つかりません' }, 404);
    }
    const targetAccountIds = [...new Set(targets.map((row) => row.line_account_id))];
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), targetAccountIds)) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    await reorderReminders(c.env.DB, body.ids as string[]);
    return c.json({ success: true, data: { updated: body.ids.length } });
  } catch (err) {
    throw err;
  }
};

async function reminderAccounts(db: D1Database, rows: Array<{ line_account_id: string | null }>) {
  const ids = [...new Set(rows.map(row => row.line_account_id).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map<string, string>();
  const result = await db.prepare(`SELECT id, name FROM line_accounts WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<{ id: string; name: string }>();
  return new Map(result.results.map(row => [row.id, row.name]));
}

function reminderAccount(id: string | null, names: Map<string, string>) {
  return id === null ? null : { id, name: names.get(id) ?? null };
}

export const get__api_reminders_2 = async (c: Context<Env, "/api/reminders">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const paging = parseOffsetPaging({
      page: c.req.query('page'),
      limit: c.req.query('limit'),
    }, { defaultLimit: 20 });
    const q = (c.req.query('q') ?? '').trim().toLocaleLowerCase('ja-JP');
    const folderId = c.req.query('folderId') ?? '';
    const status = c.req.query('status') ?? '';
    const usesListContract = ['page', 'limit', 'q', 'folderId', 'status', 'sort']
      .some((key) => c.req.query(key) !== undefined);

    if (usesListContract) {
      const clauses = ['r.deleted_at IS NULL'];
      const bindings: unknown[] = [];
      if (lineAccountId) {
        if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
          return fail(c, 404, 'REMINDER_NOT_FOUND');
        }
        clauses.push('r.line_account_id = ?');
        bindings.push(lineAccountId);
      } else {
        const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
        const accountParts: string[] = [];
        if (scope.allowedAccountIds.length > 0) {
          accountParts.push(`r.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})`);
          bindings.push(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []));
        }
        if (scope.canSeeUnassigned) accountParts.push('r.line_account_id IS NULL');
        clauses.push(accountParts.length > 0 ? `(${accountParts.join(' OR ')})` : '1 = 0');
      }
      if (q) {
        // 「名前・内容で検索」と画面が言う以上、通知本文も対象にする。
        // JOIN だと通の数だけ行が増えて total がずれるので EXISTS で検査する。
        // 本文は公開済みが reminder_steps、まだ公開していない下書きが
        // current_draft_version_id のぶら下がる reminder_version_steps にある。
        clauses.push(`(LOWER(r.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(r.description, '')) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM reminder_steps search_steps
            WHERE search_steps.reminder_id = r.id
              AND LOWER(search_steps.message_content) LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM reminder_versions draft_version
            JOIN reminder_version_steps draft_steps ON draft_steps.reminder_version_id = draft_version.id
            WHERE draft_version.id = r.current_draft_version_id
              AND LOWER(draft_steps.message_content) LIKE ? ESCAPE '\\'))`);
        const searchPattern = `%${escapedLike(q)}%`;
        bindings.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }
      if (folderId === '__unfiled__') clauses.push('r.folder_id IS NULL');
      else if (folderId) {
        clauses.push('r.folder_id = ?');
        bindings.push(folderId);
      }
      if (status === 'failed') {
        clauses.push(`EXISTS (SELECT 1 FROM reminder_delivery_runs failed
          WHERE failed.reminder_id = r.id AND failed.status IN ('retry_wait', 'permanent_failed'))`);
      } else if (status === 'draft') clauses.push(`r.lifecycle_status = 'draft'`);
      else if (status === 'active') clauses.push(`COALESCE(r.lifecycle_status, 'published') NOT IN ('draft', 'stopped') AND r.is_active = 1`);
      else if (status === 'stopped') clauses.push(`(r.lifecycle_status = 'stopped' OR r.is_active = 0)`);
      else if (status) return c.json({ success: false, error: 'status is invalid' }, 400);

      // 並び順は画面の選択をそのままSQLへ流さず、白名簿で列へ写す。
      const sortKey = c.req.query('sort') ?? 'order';
      const sortSpec = REMINDER_LIST_SORTS[sortKey];
      if (!sortSpec) return c.json({ success: false, error: 'sort is invalid' }, 400);

      const where = clauses.join(' AND ');
      const totalRow = await c.env.DB
        .prepare(`SELECT COUNT(*) AS total FROM reminders r WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number | string }>();
      const result = await c.env.DB
        .prepare(`SELECT r.*,
            (SELECT COUNT(*) FROM reminder_steps steps WHERE steps.reminder_id = r.id) AS step_count,
            EXISTS (SELECT 1 FROM reminder_delivery_runs failed
              WHERE failed.reminder_id = r.id AND failed.status IN ('retry_wait', 'permanent_failed')) AS has_failure,
            (SELECT COUNT(*) FROM reminder_delivery_runs upcoming
              WHERE upcoming.reminder_id = r.id AND upcoming.status IN ('queued', 'retry_wait')) AS planned_count,
            (SELECT MIN(upcoming.scheduled_at) FROM reminder_delivery_runs upcoming
              WHERE upcoming.reminder_id = r.id AND upcoming.status IN ('queued', 'retry_wait')) AS next_scheduled_at,
            (SELECT COUNT(*) FROM reminder_delivery_runs failed
              WHERE failed.reminder_id = r.id AND failed.status IN ('retry_wait', 'permanent_failed')) AS failed_count
          FROM reminders r WHERE ${where}
          ORDER BY ${sortSpec.orderBy}
          LIMIT ? OFFSET ?`)
        .bind(...bindings, paging.limit, paging.offset)
        .all<ReminderListRow>();
      // REMINDER-10: 下書き版がある行は版の実値から日時・通数を組み立てる。
      const summaries = await loadReminderListSummaries(c.env.DB, result.results);
      const accountNames = await reminderAccounts(c.env.DB, result.results);
      const management=await readRestaurantFollowupResourceManagement(c.env.DB,'reminder',result.results.map(row=>({id:row.id,lineAccountId:row.line_account_id})));
      return c.json({
        success: true,
        data: buildOffsetListResponse({
          items: result.results.map((row) => {
            const summary = summaries.get(row.id);
            return {lineAccount: reminderAccount(row.line_account_id ?? null, accountNames), ...publicReminder(row, summary?.stepCount, undefined, summary?.timingSummary ?? null),...(management.has(row.id)?{followupManagement:management.get(row.id)}:{})};
          }),
          total: Number(totalRow?.total ?? 0),
          paging,
          sort: sortSpec.meta,
        }),
      });
    }

    let items: Awaited<ReturnType<typeof getReminders>>;
    if (lineAccountId) {
      if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
        return fail(c, 404, 'REMINDER_NOT_FOUND');
      }
      /*
       * 並びは getReminders と同じにする（161）。
       *
       * ここだけ created_at DESC のままだと、**画面から並べ替えても効かない。**
       * アカウントを選んでいるのが通常の状態（選択は既定で先頭のアカウントに
       * 入る）なので、効かないほうが既定になっていた。
       */
      const result = await c.env.DB
        .prepare(
          `SELECT * FROM reminders WHERE line_account_id = ? AND deleted_at IS NULL
            ORDER BY display_order ASC, created_at DESC, id ASC`,
        )
        .bind(lineAccountId)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getReminders>>;
    } else {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const rows = await getReminders(c.env.DB, scope);
      items = rows.filter((row) => {
        const accountId = (row as { line_account_id?: string | null }).line_account_id ?? null;
        return accountId == null
          ? scope.canSeeUnassigned
          : scope.allowedAccountIds.includes(accountId);
      });
    }
    /*
     * 通の数を1回のクエリでまとめて数える。
     *
     * 一覧に「何通持っているか」を出すため。リマインダごとに
     * /api/reminders/:id を叩くと、20件で20回になる。
     * 1つも無いリマインダは行が返らないので、既定を0にする。
     */
    const counts = await c.env.DB
      .prepare(`SELECT reminder_id, COUNT(*) AS c FROM reminder_steps
        WHERE reminder_id IN (SELECT value FROM json_each(?)) GROUP BY reminder_id`)
      .bind(JSON.stringify(items.map((item) => item.id)))
      .all<{ reminder_id: string; c: number }>();
    const stepCounts = new Map(counts.results.map((row) => [row.reminder_id, Number(row.c)]));

    const failures = await c.env.DB
      .prepare(`SELECT DISTINCT reminder_id FROM reminder_delivery_runs
        WHERE status IN ('retry_wait', 'permanent_failed')
          AND reminder_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(items.map((item) => item.id)))
      .all<{ reminder_id: string }>();
    const failedReminderIds = new Set(failures.results.map((row) => row.reminder_id));

    // REMINDER-10: 旧配列応答も、版を持つ行は版の実値で要約する。
    const summaries = await loadReminderListSummaries(c.env.DB, items);
    const accountNames = await reminderAccounts(c.env.DB, items);
    const management=await readRestaurantFollowupResourceManagement(c.env.DB,'reminder',items.map(row=>({id:row.id,lineAccountId:row.line_account_id})));
    const publicItems = items.map((r) => {
      const summary = summaries.get(r.id);
      return {lineAccount: reminderAccount(r.line_account_id ?? null, accountNames), ...publicReminder(
        r,
        summary?.stepCount ?? stepCounts.get(r.id) ?? 0,
        failedReminderIds.has(r.id),
        summary?.timingSummary ?? null,
      ),...(management.has(r.id)?{followupManagement:management.get(r.id)}:{})};
    });

    /* 旧配列応答は、移行期限（2026-10-31）まで未移行の呼び出しだけに残す。 */
    return c.json({ success: true, data: publicItems });
  } catch (err) {
    throw err;
  }
};

export const post__api_reminders_drafts_3 = async (c: Context<Env, "/api/reminders/drafts">) => {
  try {
    const parsed = readDraftSettings(await c.req.json<unknown>());
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, parsed.status === 422 ? 422 : 400, ["name","triggerType","triggerConfig"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [parsed.value.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const folderError = await validateReminderFolder(c.env.DB, parsed.value.folderId);
    if (folderError) return inputError(c, { success: false, error: folderError }, 422, ["folderId"]);
    const referenceError = await validateReminderDraftReferences(c.env.DB, parsed.value);
    if (referenceError) return inputError(c, { success: false, error: referenceError }, 422, ["steps"]);
    // 新規作成で省略された方針は要件の既定 'feb28'。
    parsed.value.leapYearPolicy ??= 'feb28';
    const created = await createReminderWithDraftVersion(c.env.DB, parsed.value);
    return c.json({
      success: true,
      data: { id: created.reminder.id, ...versionResponse(created.version) },
    }, 201);
  } catch (err) {
    throw err;
  }
};

export const get__api_reminders_id_4 = async (c: Context<Env, "/api/reminders/:id">) => {
  try {
    const id = c.req.param('id');
    const [reminder, steps, publishedVersion] = await Promise.all([
      getReminderById(c.env.DB, id),
      getReminderSteps(c.env.DB, id),
      getReminderPublishedVersion(c.env.DB, id),
    ]);
    if (!reminder) return fail(c, 404, 'REMINDER_NOT_FOUND');
    const management=await readRestaurantFollowupResourceManagement(c.env.DB,'reminder',[{id:reminder.id,lineAccountId:reminder.line_account_id}]);
    const accountNames = await reminderAccounts(c.env.DB, [reminder]);
    return c.json({
      success: true,
      data: {
        ...(management.has(reminder.id)?{followupManagement:management.get(reminder.id)}:{}),
        id: reminder.id,
        lineAccountId: reminder.line_account_id ?? null,
        lineAccount: reminderAccount(reminder.line_account_id ?? null, accountNames),
        name: reminder.name,
        description: reminder.description,
        isActive: Boolean(reminder.is_active),
        lifecycleStatus: reminder.lifecycle_status,
        currentDraftVersionId: reminder.current_draft_version_id,
        currentPublishedVersionId: reminder.current_published_version_id,
        publishedVersion: publishedVersion
          ? versionResponse(publishedVersion, reminder.leap_year_policy)
          : null,
        triggerType: reminder.trigger_type ?? 'manual',
        deliveryMode: reminder.delivery_mode ?? 'countdown',
        triggerFieldId: reminder.trigger_field_id ?? null,
        triggerEventId: reminder.trigger_event_id ?? null,
        repeatYearly: reminder.repeat_yearly === 1,
        leapYearPolicy: reminder.leap_year_policy,
        triggerOffsetMinutes: reminder.trigger_offset_minutes ?? null,
        sendAtTime: reminder.send_at_time ?? null,
        targetTagId: reminder.target_tag_id ?? null,
        folderId: reminder.folder_id ?? null,
        createdAt: reminder.created_at,
        updatedAt: reminder.updated_at,
        steps: steps.map((s) => ({
          id: s.id,
          reminderId: s.reminder_id,
          offsetMinutes: s.offset_minutes,
          messageType: s.message_type,
          messageContent: s.message_content,
          offsetDays: s.offset_days,
          sendAtTime: s.send_at_time,
          templateId: s.template_id,
          createdAt: s.created_at,
        })),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_reminders_id_draft_5 = async (c: Context<Env, "/api/reminders/:id/draft">) => {
  try {
    const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const reminderRow = await c.env.DB.prepare(
      `SELECT leap_year_policy FROM reminders WHERE id = ?`,
    ).bind(c.req.param('id')).first<{ leap_year_policy: 'feb28' | 'mar1' | 'skip' }>();
    return c.json({ success: true, data: versionResponse(draft, reminderRow?.leap_year_policy) });
  } catch (err) {
    throw err;
  }
};

export const put__api_reminders_id_draft_6 = async (c: Context<Env, "/api/reminders/:id/draft">) => {
  try {
    const rawBody = await c.req.json<unknown>();
    const parsed = readDraftSettings(rawBody);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, parsed.status === 422 ? 422 : 400, ["name","triggerType","triggerConfig"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [parsed.value.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const folderError = await validateReminderFolder(c.env.DB, parsed.value.folderId);
    if (folderError) return inputError(c, { success: false, error: folderError }, 422, ["folderId"]);
    const referenceError = await validateReminderDraftReferences(c.env.DB, parsed.value);
    if (referenceError) return inputError(c, { success: false, error: referenceError }, 422, ["steps"]);
    // 画面を開いたときの下書き版を送ってもらい、先に別の保存・公開が
    // 走っていたら 409 で止める。古い画面からの上書き保存を防ぐ。
    if (parsed.value.leapYearPolicy === undefined) {
      const currentDraft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
      const current = currentDraft
        ? parseReminderVersionSettings(currentDraft).leapYearPolicy
        : undefined;
      if (current) {
        parsed.value.leapYearPolicy = current;
      } else {
        const row = await c.env.DB.prepare(
          `SELECT leap_year_policy FROM reminders WHERE id = ?`,
        ).bind(c.req.param('id')).first<{ leap_year_policy: 'feb28' | 'mar1' | 'skip' }>();
        parsed.value.leapYearPolicy = row?.leap_year_policy ?? 'feb28';
      }
    }
    const expectedVersionId = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      && typeof (rawBody as Record<string, unknown>).expectedVersionId === 'string'
      ? (rawBody as Record<string, unknown>).expectedVersionId as string
      : undefined;
    //  監査：対象設定の保存も通知ステップと同じ条件にする。版IDに加え、
    // 保存のたびに変わる版時刻も照合し、ずれていれば 409 で止める。
    const expectedUpdatedAt = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      && typeof (rawBody as Record<string, unknown>).expectedUpdatedAt === 'string'
      ? (rawBody as Record<string, unknown>).expectedUpdatedAt as string
      : undefined;
    const saved = await saveReminderDraftVersion(
      c.env.DB, c.req.param('id'), parsed.value, { expectedVersionId, expectedUpdatedAt },
    );
    return c.json({ success: true, data: versionResponse(saved) });
  } catch (err) {
    if (err instanceof Error && err.message === 'REMINDER_DRAFT_CONFLICT') {
      return c.json({ success: false, error: 'この下書きは別の画面で先に更新されました。最新の内容を読み込み直してください' }, 409);
    }
    throw err;
  }
};

export const post__api_reminders_id_validate_7 = async (c: Context<Env, "/api/reminders/:id/validate">) => {
  try {
    const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const settings = parseReminderVersionSettings(draft);
    const referenceError = await validateReminderDraftReferences(c.env.DB, settings);
    if (referenceError) return inputError(c, { success: false, error: referenceError }, 422, ["steps"]);
    return c.json({ success: true, data: await validateReminderDraft(c.env.DB, settings, draft) });
  } catch (err) {
    throw err;
  }
};

export const post__api_reminders_id_audience_8 = async (c: Context<Env, "/api/reminders/:id/audience">) => {
  try {
    const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const settings = parseReminderVersionSettings(draft);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [settings.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const body = await c.req.json<{ condition?: unknown }>();
    // 条件が送られなければ保存済みのまま数える。送られたら (空を含む)
    // その通りに数える。空は「絞りなし」で、保存済みの条件は使わない。
    if (body.condition === undefined) {
      const audience = await countReminderAudience(c.env.DB, settings);
      const sample = await sampleReminderAudience(c.env.DB, settings);
      return c.json({
        success: true,
        data: { matched: audience.matched, excluded: audience.excluded, sample },
      });
    }
    const checked = readTargetCondition(body.condition);
    if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 422, ["condition"]);
    const effective: ReminderDraftSettings = { ...settings, targetCondition: checked.value };
    const audience = await countReminderAudience(c.env.DB, effective);
    const sample = await sampleReminderAudience(c.env.DB, effective);
    return c.json({
      success: true,
      data: { matched: audience.matched, excluded: audience.excluded, sample },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_reminders_id_message_preview_9 = async (c: Context<Env, "/api/reminders/:id/message-preview">) => {
  const draft=await getReminderDraftVersion(c.env.DB,c.req.param('id'));
  if(!draft)return c.json({success:false,error:'下書きが見つかりません'},404);
  const input=await c.req.json<{friendId:string;stableStepId:string;expectedDraftVersionId:string;expectedDraftUpdatedAt:string;deliveredAt?:string}>();
  if(input.expectedDraftVersionId!==draft.id||input.expectedDraftUpdatedAt!==draft.updated_at)return c.json({success:false,error:'下書きが更新されました。読み直してください'},409);
  const settings=parseReminderVersionSettings(draft),friend=typeof input.friendId==='string'?await getFriendById(c.env.DB,input.friendId):null;
  if(!friend||friend.line_account_id!==settings.lineAccountId||!friend.is_following)return c.json({success:false,error:'友だちが見つかりません'},404);
  const step=(await getReminderVersionSteps(c.env.DB,draft.id)).find(step=>step.id===input.stableStepId);
  if(!step)return c.json({success:false,error:'通知が見つかりません'},404);
  if(step.template_id){const template=await getTemplateById(c.env.DB,step.template_id);if(!template||template.line_account_id!==settings.lineAccountId)return c.json({success:false,error:'テンプレートが見つかりません'},404);}
  const deliveredAt=input.deliveredAt===undefined?new Date():new Date(input.deliveredAt);
  if(Number.isNaN(deliveredAt.getTime()))return inputError(c,{success:false,error:'日時を確認してください'},400,['deliveredAt']);
  const built=await buildReminderStepMessage(c.env.DB,step,friend,deliveredAt,'test_send',{previewOnly:true});
  const current=await getReminderDraftVersion(c.env.DB,c.req.param('id'));
  if(current?.id!==draft.id||current.updated_at!==draft.updated_at)return c.json({success:false,error:'下書きが更新されました。読み直してください'},409);
  c.header('Cache-Control','no-store');
  return c.json({success:true,data:{dryRun:true,sent:0,persistsSchedule:false,draftVersionId:draft.id,draftUpdatedAt:draft.updated_at,friendId:friend.id,friendName:friend.display_name,stableStepId:step.id,deliveredAt:deliveredAt.toISOString(),messageType:built.messageType,messageContent:built.messageContent,message:built.message}});
};

export const post__api_reminders_id_preview_10 = async (c: Context<Env, "/api/reminders/:id/preview">) => {
  try {
    const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const body = await c.req.json<{ targetDate?: unknown }>();
    /*
     * 目標日が無くても予定は返す。公開フローの画面は目標日を持たずに呼ぶ。
     * 無いときは1週間後を仮の基準日にする（仮の日付は結果の targetDate に入る）。
     * 文字列で来たのに日時として読めないものだけ 400 で止める。
     */
    let targetDate: Date;
    if (body.targetDate === undefined || body.targetDate === null) {
      targetDate = new Date(Date.now() + 7 * 86_400_000);
    } else {
      if (typeof body.targetDate !== 'string') {
        return inputError(c, { success: false, error: '基準日を指定してください' }, 400, ["targetDate"]);
      }
      targetDate = new Date(body.targetDate);
      if (Number.isNaN(targetDate.getTime())) {
        return inputError(c, { success: false, error: '基準日が正しくありません' }, 400, ["targetDate"]);
      }
    }
    const settings = parseReminderVersionSettings(draft);
    return c.json({ success: true, data: await previewReminderDraft(c.env.DB, settings, targetDate) });
  } catch (err) {
    throw err;
  }
};

export const get__api_reminders_id_test_recipient_11 = async (c: Context<Env, "/api/reminders/:id/test-recipient">) => {
  try {
    const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const settings = parseReminderVersionSettings(draft);
    // 送信先がどのアカウントの設定かを見てから返す。別アカウントの下書きを
    // 指されたときに、そのアカウントの送信先名を漏らさない。
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [settings.lineAccountId])) {
      return fail(c, 404, 'REMINDER_NOT_FOUND');
    }
    // REMINDER-12: 操作者を渡して本人宛て/登録宛先を区別する。実送信も同じ
    // 解決を使うので、ここで返した届け先と実際に届く先がずれない。
    const status = await resolveReminderTestRecipient(c.env.DB, settings.lineAccountId, {
      staffId: c.get('staff')?.id,
    });
    return c.json({ success: true, data: status });
  } catch (err) {
    throw err;
  }
};

export const post__api_reminders_id_test_send_12 = async (c: Context<Env, "/api/reminders/:id/test-send">) => {
  const draft = await getReminderDraftVersion(c.env.DB, c.req.param('id'));
  if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
  const requestKey = c.req.header('Idempotency-Key')?.trim();
  if (!isValidIdempotencyKey(requestKey)) {
    return inputError(c, { success: false, error: '有効なIdempotency-Keyが必要です' }, 400, []);
  }
  try {
    const settings = parseReminderVersionSettings(draft);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [settings.lineAccountId])) {
      return fail(c, 404, 'REMINDER_NOT_FOUND');
    }
    const referenceError = await validateReminderDraftReferences(c.env.DB, settings);
    if (referenceError) return inputError(c, { success: false, error: referenceError }, 422, ["steps"]);
    const result = await testReminderDraft(c.env.DB, draft, settings, requestKey, {
      staffId: c.get('staff')?.id,
    });
    await recordReminderDraftTest(c.env.DB, draft.id, {
      succeeded: true,
      staffId: c.get('staff').id,
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    await recordReminderDraftTest(c.env.DB, draft.id, {
      succeeded: false,
      staffId: c.get('staff').id,
    });
    const code = err instanceof Error ? err.message : '';
    if (code === 'REMINDER_TEST_RECIPIENT_NOT_CONFIGURED') {
      // 未設定と「設定済みだが届けられない」を分けて返す（画面の導線が違う）。
      return inputError(c, {
        success: false,
        error: 'テスト送信先を設定してください',
        code: 'TEST_RECIPIENT_NOT_CONFIGURED',
      }, 422, []);
    }
    if (code === 'REMINDER_TEST_RECIPIENT_NOT_AVAILABLE') {
      return inputError(c, {
        success: false,
        error: '設定済みのテスト送信先がこのアカウントで利用できません',
        code: 'TEST_RECIPIENT_NOT_AVAILABLE',
      }, 422, []);
    }
    if (code === 'REMINDER_TEST_STEP_NOT_FOUND') {
      return inputError(c, { success: false, error: '送る内容を1件以上設定してください' }, 422, []);
    }
    if (code === 'REMINDER_TEST_KEY_CONFLICT') {
      return c.json({ success: false, error: '同じキーが別のテスト送信に使われています' }, 409);
    }
    logger.error("reminders.reminders_id_test_send_post_failed");
    return c.json({ success: false, error: 'テスト送信に失敗しました' }, 502);
  }
};

export const post__api_reminders_id_publish_13 = async (c: Context<Env, "/api/reminders/:id/publish">) => {
  try {
    const reminderId = c.req.param('id');
    const draft = await getReminderDraftVersion(c.env.DB, reminderId);
    if (!draft) return c.json({ success: false, error: '下書きが見つかりません' }, 404);
    const settings = parseReminderVersionSettings(draft);
    const referenceError = await validateReminderDraftReferences(c.env.DB, settings);
    if (referenceError) return inputError(c, { success: false, error: referenceError }, 422, ["steps"]);
    const validation = await validateReminderDraft(c.env.DB, settings, draft);
    if (!validation.valid) {
      return inputError(c, { success: false, error: '公開前の確認が完了していません', data: validation }, 422, []);
    }
    const published = await publishReminderDraftVersion(c.env.DB, reminderId, c.get('staff').id);
    return c.json({ success: true, data: versionResponse(published) });
  } catch (err) {
    throw err;
  }
};
