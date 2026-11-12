import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { checkMediaGate } from '../services/file-scan.js';
import { getPinnedMediaObject } from '../services/media-upload-storage.js';
import { logger } from '@line-crm/shared/server';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getRichMenuGroups, getRichMenuGroupById, getRichMenuGroupWithPages, getRichMenuDeleteImpact, createRichMenuGroup, saveRichMenuGroupDraft, deleteRichMenuGroup, setRichMenuPageImage, listRichMenuSchedulesByGroup, cancelRichMenuSchedule, getMediaById, jstNow } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { validateRichMenuImage } from '../lib/image-validator.js';
import { buildSegmentWhere, parseCondition } from '../services/segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';
import { countPreviewRules, PREVIEW_MAX_RULES, serializeGroupWithPages, parseCreateBody, isJsonRecord, parsePatchBody } from './rich-menu-groups-definition.js';
import type { Context } from 'hono';

export const get__api_rich_menu_groups_groupId_delete_impact_1 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/delete-impact">) => {
    try {
      const impact = await getRichMenuDeleteImpact(c.env.DB, c.req.param('groupId'));
      if (
        !impact
        || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [impact.group.accountId])
      ) {
        return fail(c, 404, 'NOT_FOUND');
      }
      return c.json({ success: true, data: impact });
    } catch (error) {
      logger.error("rich_menu_groups.rich_menu_groups_group_id_delete_impact_get_failed");
      return c.json(
        { success: false, error: '削除したときの影響を確認できませんでした' },
        503,
      );
    }
  };

export const post__api_rich_menu_groups_groupId_preview_targets_2 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/preview-targets">) => {
  const group = await getRichMenuGroupById(c.env.DB, c.req.param('groupId'));
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }

  let body: { conditions?: unknown } = {};
  try {
    body = await c.req.json<{ conditions?: unknown }>();
  } catch {
    // 本文を省いたときは保存済み条件を使う。
  }
  const supplied = body.conditions;
  const condition = supplied === undefined
    ? parseCondition(group.targeting_condition)
    : supplied as SegmentCondition;
  if (supplied === undefined && group.targeting_condition && !condition) {
    return c.json({ success: false, error: '保存済みの対象条件を読み取れませんでした' }, 503);
  }
  if (
    condition
    && (typeof condition !== 'object'
      || (condition.operator !== 'AND' && condition.operator !== 'OR')
      || !Array.isArray(condition.rules))
  ) {
    return inputError(c, { success: false, error: 'conditions are invalid' }, 400, ["conditions"]);
  }
  if (condition && countPreviewRules(condition, 1) > PREVIEW_MAX_RULES) {
    return inputError(c, { success: false, error: '条件が複雑すぎます。条件を減らしてください' }, 400, ["conditions"]);
  }

  try {
    const targetWhere = condition ? buildSegmentWhere(condition) : { sql: '1=1', bindings: [] };
    const matched = await c.env.DB
      .prepare(
        `SELECT COUNT(*) AS count
           FROM friends f
          WHERE f.line_account_id = ?
            AND f.is_following = 1
            AND (${targetWhere.sql})`,
      )
      .bind(group.account_id, ...targetWhere.bindings)
      .first<{ count: number }>();

    const higher = await c.env.DB
      .prepare(
        `SELECT id, name, targeting_condition
           FROM rich_menu_groups
          WHERE account_id = ?
            AND id <> ?
            AND status = 'published'
            AND targeting_enabled = 1
            AND targeting_priority < ?
          ORDER BY targeting_priority ASC, created_at ASC`,
      )
      .bind(group.account_id, group.id, group.targeting_priority)
      .all<{ id: string; name: string; targeting_condition: string | null }>();

    const higherParts: Array<{ sql: string; bindings: unknown[] }> = [];
    const higherNames: string[] = [];
    let unreadableHigherCondition = false;
    for (const row of higher.results ?? []) {
      higherNames.push(row.name);
      const parsed = parseCondition(row.targeting_condition);
      if (!parsed) {
        unreadableHigherCondition = true;
        continue;
      }
      higherParts.push(buildSegmentWhere(parsed));
    }

    let overlap: number | null = 0;
    let overlapReason: string | null = null;
    if (unreadableHigherCondition) {
      overlap = null;
      overlapReason = 'higher_condition_unreadable';
    } else if (higherParts.length > 0) {
      const higherSql = higherParts.map((part) => `(${part.sql})`).join(' OR ');
      const higherBindings = higherParts.flatMap((part) => part.bindings);
      const result = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count
             FROM friends f
            WHERE f.line_account_id = ?
              AND f.is_following = 1
              AND (${targetWhere.sql})
              AND (${higherSql})`,
        )
        .bind(group.account_id, ...targetWhere.bindings, ...higherBindings)
        .first<{ count: number }>();
      overlap = result?.count ?? 0;
    }

    const matchedValue = matched?.count ?? 0;
    return c.json({
      success: true,
      data: {
        matched: { value: matchedValue, state: 'available', reason: null },
        overlap: overlap === null
          ? { value: null, state: 'unavailable', reason: overlapReason }
          : { value: overlap, state: 'available', reason: null },
        effective: overlap === null
          ? { value: null, state: 'unavailable', reason: overlapReason }
          : { value: Math.max(0, matchedValue - overlap), state: 'available', reason: null },
        higherMenus: higherNames,
        priority: group.targeting_priority + 1,
      },
    });
  } catch (error) {
    logger.error("rich_menu_groups.rich_menu_groups_group_id_preview_targets_post_failed");
    return c.json({ success: false, error: '対象人数を確認できませんでした' }, 503);
  }
};

export const get__api_rich_menu_groups_groupId_usages_3 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/usages">) => {
  try {
    const impact = await getRichMenuDeleteImpact(c.env.DB, c.req.param('groupId'));
    if (!impact || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [impact.group.accountId])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    return c.json({
      success: true,
      data: {
        currentAudience: impact.currentAudience,
        nextDisplay: impact.nextDisplay,
        incomingSwitches: impact.incomingSwitches,
        operationalReferences: impact.operationalReferences,
      },
    });
  } catch (error) {
    logger.error("rich_menu_groups.rich_menu_groups_group_id_usages_get_failed");
    return c.json({ success: false, error: '使用先を確認できませんでした' }, 503);
  }
};

export const post__api_rich_menu_groups_groupId_schedule_4 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/schedule">) => {
    const group = await getRichMenuGroupWithPages(c.env.DB, c.req.param('groupId'));
    if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      return inputError(c, { success: false, error: 'Idempotency-Key header required' }, 400, []);
    }

    let body: { mode?: unknown; startsAt?: unknown; endsAt?: unknown; restoreGroupId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
    }
    if (body.mode !== 'scheduled' && body.mode !== 'period') {
      return inputError(c, { success: false, error: 'mode must be scheduled or period' }, 400, ["mode"]);
    }
    if (typeof body.startsAt !== 'string' || !Number.isFinite(Date.parse(body.startsAt))) {
      return inputError(c, { success: false, error: 'startsAt must be ISO 8601' }, 400, ["startsAt"]);
    }
    const endsAt = typeof body.endsAt === 'string' && body.endsAt.length > 0 ? body.endsAt : null;
    if (body.mode === 'period') {
      if (!endsAt || !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(body.startsAt)) {
        return inputError(c, { success: false, error: 'endsAt must be later than startsAt' }, 400, ["endsAt","startsAt"]);
      }
    }
    const requestedRestoreGroupId = typeof body.restoreGroupId === 'string' && body.restoreGroupId.length > 0
      ? body.restoreGroupId
      : null;
    // 明示の指定があれば検証して保存する。指定なし(「前のメニューに戻す」)は
    // nullのまま保存し、実行開始直前・切替前に実LINE defaultを固定する(365)。
    // 予約時点では確定しない(期間中の管理画面外の変更にずれないようにする)。
    const restoreGroupId: string | null = requestedRestoreGroupId;
    if (restoreGroupId) {
      const restore = await getRichMenuGroupById(c.env.DB, restoreGroupId);
      if (!restore || restore.account_id !== group.account_id || restore.status !== 'published') {
        return inputError(c, { success: false, error: 'restoreGroupId must be a published menu in the same account' }, 400, ["restoreGroupId"]);
      }
    }

    // 同時2要求でも片方だけ作るため atomic にINSERTし、同key異内容は成功扱いにしない。
    const { createRichMenuScheduleAtomic } = await import('@line-crm/db');
    const now = jstNow();
    const id = crypto.randomUUID();
    const definitionSnapshot = JSON.stringify(serializeGroupWithPages(group));
    const created = await createRichMenuScheduleAtomic(c.env.DB, {
      id,
      groupId: group.id,
      accountId: group.account_id,
      mode: body.mode,
      startsAt: body.startsAt as string,
      endsAt,
      restoreGroupId,
      definitionSnapshot,
      idempotencyKey,
      requestedByStaffId: c.get('staff').id,
      now,
    });
    if (created.outcome === 'conflict') {
      return c.json(
        { success: false, error: 'Idempotency-Key is already used with different content', id: created.id, status: created.status },
        409,
      );
    }
    if (created.outcome === 'existing') {
      return c.json({ success: true, data: { id: created.id, status: created.status } });
    }
    return c.json({
      success: true,
      data: {
        id,
        status: 'scheduled',
        restoreGroupId,
        // 戻し先の固定は実行開始直前に行う。予約時点では未確定。
        restoreDefaultState: null,
      },
    }, 201);
  };

export const get__api_rich_menu_groups_groupId_schedules_5 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/schedules">) => {
  const group = await getRichMenuGroupWithPages(c.env.DB, c.req.param('groupId'));
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  const rows = await listRichMenuSchedulesByGroup(c.env.DB, group.id, 50);
  return c.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      restoreGroupId: row.restore_group_id,
      // 実行開始直前に固定した切替前defaultの状態。capturedは固定メニューへ
      // 戻し、no_defaultは明示解除する。nullは未固定(未実行)。
      restoreDefaultState: row.restore_default_state,
      status: row.status,
      attemptCount: row.attempt_count,
      nextRetryAt: row.next_retry_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
    })),
  });
};

export const post__api_rich_menu_groups_groupId_schedules_scheduleId_cancel_6 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/schedules/:scheduleId/cancel">) => {
    const group = await getRichMenuGroupWithPages(c.env.DB, c.req.param('groupId'));
    if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    const scheduleId = c.req.param('scheduleId');
    const cancelled = await cancelRichMenuSchedule(c.env.DB, scheduleId, group.id, group.account_id);
    if (cancelled) return c.json({ success: true, data: { id: scheduleId, status: 'cancelled' } });
    const rows = await listRichMenuSchedulesByGroup(c.env.DB, group.id, 200);
    const current = rows.find((row) => row.id === scheduleId);
    if (!current) return fail(c, 404, 'NOT_FOUND');
    return c.json({ success: false, error: 'already started', status: current.status }, 409);
  };

export const get__api_rich_menu_groups_groupId_7 = async (c: Context<Env, "/api/rich-menu-groups/:groupId">) => {
  const groupId = c.req.param('groupId');
  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  return c.json({ success: true, data: (await withStyleSampleMetadata(c.env.DB,[serializeGroupWithPages(group)],'rich_menu'))[0] });
};

export const post__api_rich_menu_groups_8 = async (c: Context<Env, "/api/rich-menu-groups">) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
  }
  const parsed = parseCreateBody(body);
  if (!parsed.ok) return inputError(c, { success: false, error: parsed.error, field: parsed.field }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [parsed.value.accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const created = await createRichMenuGroup(c.env.DB, parsed.value);
  // 登録メディアを選んで作った場合、既定ページの画像としてここで登録する。
  // 作成と別口の「画像アップロード」を要しないため、作成画面へ戻った選択が
  // そのまま下書きへ反映される。失敗しても下書き自体は残し、編集画面で
  // やり直せることを応答で伝える。
  const imageMediaId = isJsonRecord(body) && typeof body.imageMediaId === 'string' && body.imageMediaId.length > 0
    ? body.imageMediaId
    : null;
  if (imageMediaId) {
    try {
      const media = await getMediaById(c.env.DB, imageMediaId, parsed.value.accountId)
        ?? await getMediaById(c.env.DB, imageMediaId, null);
      if (!media || media.kind !== 'image' || media.archived_at) {
        return inputError(c, { success: false, error: '選ばれたメディアはこのアカウントの画像として使えません', data: serializeGroupWithPages(created) }, 400, ["imageMediaId"]);
      }
      const gate = await checkMediaGate(c.env.DB, c.env.IMAGES, {
        id: media.id, lineAccountId: media.line_account_id, r2Key: media.r2_key,
        filename: media.filename, mimeType: media.mime_type, sizeBytes: media.size_bytes,
        width: media.width, height: media.height,
      });
      if (!gate.allowed) return inputError(c, { success: false, code: gate.code, error: gate.message, data: serializeGroupWithPages(created) }, 400, ['imageMediaId']);
      const obj = await getPinnedMediaObject(c.env.IMAGES, media.r2_key, gate.etag);
      if (!obj) throw new Error('media object not found in storage');
      const buf = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const validation = validateRichMenuImage(buf, buf.byteLength);
      if (!validation.ok) {
        return inputError(c, { success: false, error: `選ばれた画像を使えません: ${validation.error}`, data: serializeGroupWithPages(created) }, 400, ["imageR2Key"]);
      }
      if (validation.size !== created.size) {
        return inputError(c, {
            success: false,
            error: `選ばれた画像の大きさ（${validation.size === 'large' ? '大きい' : '小さい'}向け）がメニューの大きさと合いません`,
            data: serializeGroupWithPages(created),
          }, 400, ["imageR2Key"]);
      }
      const defaultPage = created.pages.find((p) => p.id === created.default_page_id)
        ?? created.pages[0];
      const contentType = media.mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const ext = contentType === 'image/png' ? 'png' : 'jpg';
      const key = `rich-menus/${parsed.value.accountId}/${created.id}/${defaultPage.id}/${crypto.randomUUID()}.${ext}`;
      await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType } });
      try {
        await setRichMenuPageImage(c.env.DB, defaultPage.id, key, contentType);
      } catch (dbError) {
        // と同じく、DB への記録に失敗したら上げた画像を片付ける。
        try {
          await c.env.IMAGES.delete(key);
        } catch {
          logger.error("rich_menu_groups.rich_menu_groups_post_failed");
        }
        throw dbError;
      }
      const refreshed = await getRichMenuGroupWithPages(c.env.DB, created.id);
      return c.json({ success: true, data: serializeGroupWithPages(refreshed ?? created) });
    } catch (error) {
      throw new UnexpectedRouteError(c, {
          success: false,
          error: '下書きは作成しましたが、画像の登録に失敗しました。編集画面で画像を登録してください。',
          data: serializeGroupWithPages(created),
        });
    }
  }
  return c.json({ success: true, data: serializeGroupWithPages(created) });
};

export const patch__api_rich_menu_groups_groupId_9 = async (c: Context<Env, "/api/rich-menu-groups/:groupId">) => {
  const groupId = c.req.param('groupId');
  const existing = await getRichMenuGroupById(c.env.DB, groupId);
  if (!existing || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [existing.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
  }
  const parsed = parsePatchBody(body);
  if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["name","size","chatBarText"]);

  // 保存に版を付ける (タグ編集の expectedVersion と同じ約束)。
  // 無し・不正は 400、古い版は 409。先に読んだ側の変更が黙って消えないようにする。
  const rawVersion = isJsonRecord(body) ? body.expectedVersion : undefined;
  if (rawVersion === undefined) {
    return inputError(c, {
        success: false,
        error: '保存の版情報がありません。画面を読み込み直して、もう一度保存してください。',
      }, 400, ["expectedVersion"]);
  }
  const expectedVersion = Number(rawVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return inputError(c, {
        success: false,
        error: '保存の版情報が正しくありません。画面を読み込み直して、もう一度保存してください。',
      }, 400, ["expectedVersion"]);
  }

  // 作成口と同じ検査を保存口にも入れる。「条件で出し分ける」のに
  // 条件が無いメニューは誰にも出ない。片方だけの変更でも、残りと合わせた
  // 形で見る。
  const effectiveTargetingEnabled = parsed.value.meta.targetingEnabled
    ?? (existing.targeting_enabled === 1);
  const effectiveTargetingCondition = parsed.value.meta.targetingCondition !== undefined
    ? parsed.value.meta.targetingCondition
    : existing.targeting_condition;
  if (effectiveTargetingEnabled && !effectiveTargetingCondition) {
    return inputError(c, {
        success: false,
        error: '「条件で出し分ける」を使うには、出し分けの条件が必要です。条件を設定するか、「条件で出し分ける」をオフにしてください。',
      }, 400, ["targetingCondition"]);
  }

  //  公開中の定義(LINEに出ている形)は直接上書きしない。ページ構成・
  // トークバー文言・全員既定の指定を変えるには、いったん取り下げて下書きへ戻すか、
  // 取り込み/新規作成で別IDの下書きを作る。名前・出し分け条件・フォルダ・並び順は
  // 公開中でも運用変更として従来どおり許す。
  if (
    existing.status === 'published'
    && (parsed.value.pages !== undefined
      || parsed.value.meta.chatBarText !== undefined
      || parsed.value.meta.isDefaultForAll !== undefined
      || parsed.value.meta.defaultOpen !== undefined)
  ) {
    return c.json(
      {
        success: false,
        error: '公開中のメニューは直接変更できません。LINEから取り下げて下書きに戻してから編集してください',
      },
      409,
    );
  }

  // meta と pages を同じ取引で確定する。pages が失敗したら meta も
  // 戻る (saveRichMenuGroupDraft が 1 batch で流す)。古い版は書かず 409。
  const saved = await saveRichMenuGroupDraft(c.env.DB, groupId, {
    meta: parsed.value.meta,
    pages: parsed.value.pages,
    expectedVersion,
  });
  if (!saved.ok) {
    // 保存の直前に消されていたら、不在として一覧へ戻す。
    if (saved.currentVersion === null) {
      return c.json(
        {
          success: false,
          error: 'このリッチメニューは見つかりません。削除された可能性があります。一覧から選び直してください。',
        },
        404,
      );
    }
    return c.json(
      {
        success: false,
        error: 'ほかの人がこのメニューを先に保存しました。画面を読み込み直してから、もう一度保存してください。',
      },
      409,
    );
  }
  const refreshed = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!refreshed) return c.json({ success: false, error: 'group disappeared after update' }, 500);
  return c.json({ success: true, data: serializeGroupWithPages(refreshed) });
};

export const post__api_rich_menu_groups_reorder_priorities_10 = async (c: Context<Env, "/api/rich-menu-groups/reorder-priorities">) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
    }
    const r = isJsonRecord(body) ? body : {};
    if (typeof r.accountId !== 'string' || r.accountId.length === 0) {
      return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    }
    if (!Array.isArray(r.orderedIds) || r.orderedIds.some((id) => typeof id !== 'string')) {
      return inputError(c, { success: false, error: 'orderedIds must be string array' }, 400, ["orderedIds"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [r.accountId])) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const current = await getRichMenuGroups(c.env.DB, r.accountId);
    const currentIds = new Set(current.map((g) => g.id));
    const seen = new Set<string>();
    const hasAll = r.orderedIds.length === current.length
      && r.orderedIds.every((id) => {
        if (seen.has(id) || !currentIds.has(id)) return false;
        seen.add(id);
        return true;
      });
    if (!hasAll) {
      return inputError(c, { success: false, error: 'orderedIds must contain every group of the account exactly once' }, 400, ["orderedIds"]);
    }
    const now = jstNow();
    await c.env.DB.batch(
      r.orderedIds.map((id, index) =>
        c.env.DB
          .prepare(
            `UPDATE rich_menu_groups
                SET targeting_priority = ?, display_order = ?, confirmation_revision = confirmation_revision + 1, updated_at = ?
              WHERE id = ? AND account_id = ?`,
          )
          .bind(index, index, now, id, r.accountId),
      ),
    );
    return c.json({ success: true, data: { updated: r.orderedIds.length } });
  };

export const delete__api_rich_menu_groups_groupId_11 = async (c: Context<Env, "/api/rich-menu-groups/:groupId">) => {
  const groupId = c.req.param('groupId');
  let impact: Awaited<ReturnType<typeof getRichMenuDeleteImpact>>;
  try {
    impact = await getRichMenuDeleteImpact(c.env.DB, groupId);
  } catch (error) {
    logger.error("rich_menu_groups.rich_menu_groups_group_id_delete_failed");
    return c.json(
      { success: false, error: '削除したときの影響を確認できませんでした' },
      503,
    );
  }
  if (
    !impact
    || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [impact.group.accountId])
  ) {
    return fail(c, 404, 'NOT_FOUND');
  }
  const rawVersion = c.req.query('expectedVersion');
  if (rawVersion !== undefined && (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)) || Number(rawVersion) < 1)) {
    return inputError(c, { success: false, error: '下書きの版が正しくありません' }, 400, ['expectedVersion']);
  }
  if (rawVersion !== undefined) {
    const current = await getRichMenuGroupById(c.env.DB, groupId);
    if (!current || current.status !== 'draft' || current.version !== Number(rawVersion)) {
      return c.json({ success: false, code: 'draft_changed', error: '下書きの状態が変わったため消せません。読み直して確認してください。' }, 409);
    }
  }
  // query に force=true が残っていても、影響確認を迂回させない。公開中、LINE上に
  // 実体が残る、別設定から参照される、のどれかなら必ず止める。
  if (!impact.canDelete) {
    return c.json(
      {
        success: false,
        code: 'rich_menu_delete_blocked',
        error: '削除する前に、公開状態と使われている場所を確認してください',
        data: impact,
      },
      409,
    );
  }
  const ok = rawVersion === undefined ? await deleteRichMenuGroup(c.env.DB, groupId) : await deleteRichMenuGroup(c.env.DB, groupId, Number(rawVersion));
  if (!ok) return rawVersion === undefined ? fail(c, 404, 'NOT_FOUND') : c.json({ success: false, code: 'draft_changed', error: '下書きの状態が変わったため消せません。読み直して確認してください。' }, 409);
  return c.json({ success: true });
};
