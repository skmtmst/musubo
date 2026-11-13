import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getRichMenuGroupById, getRichMenuGroupWithPages, getLineAccountById, getFollowingLineUserIdsByTag, recordRichMenuAssignmentsByLineUserIds, duplicateRichMenuGroupAtomic, createRichMenuTestApplyAtomic, getActiveRichMenuTestApply, getRichMenuTestApplyById, listRichMenuTestApplies, captureRichMenuTestApplyPrevious, recordRichMenuTestApplyShells, markRichMenuTestApplyApplied, markRichMenuTestApplyFailed, getStaffById, recordAuditEvent, maskAuditIp, auditDeviceFamily } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { resolveTrackedLinkBaseUrl } from '../lib/link-base-url.js';
import { buildSegmentWhere, parseCondition } from '../services/segment-query.js';
import { createRichMenuShells, linkRichMenuBulkChunked, RichMenuValidationError, buildAliasId, type R2Like, type GroupInput } from '../lib/rich-menu-publisher.js';
import { isJsonRecord, createLineClient, serializeGroupWithPages, maskLineUserId, serializeTestApply, resolveTrackedLinkUrls } from './rich-menu-groups-definition.js';
import type { Context } from 'hono';

async function destinationToken(lineUserId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lineUserId));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export const post__api_rich_menu_groups_groupId_apply_to_tag_1 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/apply-to-tag">) => {
  const groupId = c.req.param('groupId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
  }
  const r = isJsonRecord(body) ? body : {};
  const mode = typeof r.mode === 'string' ? r.mode : 'bulk-link';
  if (mode !== 'bulk-link' && mode !== 'set-default') {
    return inputError(c, { success: false, error: "mode must be 'bulk-link' or 'set-default'" }, 400, ["mode"]);
  }
  if (mode === 'bulk-link') {
    if (r.tagId !== null && r.tagId !== undefined && typeof r.tagId !== 'string') {
      return inputError(c, { success: false, error: 'tagId must be string or null' }, 400, ["tagId"]);
    }
  }
  const tagId = (r.tagId as string | null | undefined) ?? null;

  const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  if (group.status !== 'published') {
    return inputError(c, { success: false, error: 'group must be published before applying to friends' }, 400, []);
  }
  // default_page の line_richmenu_id を採用 (未設定なら order_index=0 の page)
  const targetPage =
    group.pages.find((p) => p.id === group.default_page_id) ??
    [...group.pages].sort((a, b) => a.order_index - b.order_index)[0];
  if (!targetPage?.line_richmenu_id) {
    return inputError(c, { success: false, error: 'no published rich menu found for default page' }, 400, ["order_index"]);
  }

  const account = await getLineAccountById(c.env.DB, group.account_id);
  if (!account) return fail(c, 500, 'LINE_ACCOUNT_NOT_FOUND');

  // ---- mode: set-default (LINE 全員のデフォルトに設定) ----
  if (mode === 'set-default') {
    try {
      const line = createLineClient(account.channel_access_token);
      await line.setDefaultRichMenu(targetPage.line_richmenu_id);
      // 同 account 内の他 group の is_default_for_all をリセットして、自分だけ true に。
      const now = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `UPDATE rich_menu_groups SET is_default_for_all = 0, version = version + 1, confirmation_revision = confirmation_revision + 1, updated_at = ?
              WHERE account_id = ? AND id != ? AND is_default_for_all <> 0`,
          )
          .bind(now, group.account_id, groupId),
        c.env.DB
          .prepare(
            `UPDATE rich_menu_groups SET is_default_for_all = 1, version = version + 1, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ? AND is_default_for_all <> 1`,
          )
          .bind(now, groupId),
      ]);
      return c.json({
        success: true,
        data: { mode: 'set-default', total: 0, chunks: 0, message: '全員のデフォルトに設定しました' },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  // ---- mode: bulk-link (タグ or 全 follower に link) ----
  // 中: 予約口と同じく Idempotency-Key を必須にする。同じ鍵での
  // やり直しは同じ runId になり、台帳への記録は ON CONFLICT で重複しない。
  // LINE への link 自体は同じメニューの付け直しで無害。
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey) {
    return inputError(c, { success: false, error: 'Idempotency-Key header required' }, 400, []);
  }
  const userIds = await getFollowingLineUserIdsByTag(
    c.env.DB,
    group.account_id,
    tagId,
  );
  if (userIds.length === 0) {
    return c.json({
      success: true,
      data: { chunks: 0, total: 0, runId: idempotencyKey, message: 'no matching followers' },
    });
  }

  let completedChunks = 0;
  try {
    const line = createLineClient(account.channel_access_token);
    const result = await linkRichMenuBulkChunked(
      line,
      targetPage.line_richmenu_id,
      userIds,
      async (linkedUserIds, chunkIndex) => {
        await recordRichMenuAssignmentsByLineUserIds(c.env.DB, {
          lineAccountId: group.account_id,
          groupId,
          lineRichMenuId: targetPage.line_richmenu_id!,
          lineUserIds: linkedUserIds,
          reasonKind: tagId ? 'tag_bulk_apply' : 'all_followers_bulk_apply',
          reasonEventId: idempotencyKey,
          idempotencyPrefix: `${idempotencyKey}:${chunkIndex}`,
        });
        completedChunks = chunkIndex + 1;
      },
    );
    return c.json({ success: true, data: { ...result, runId: idempotencyKey } });
  } catch (e) {
    // どこまで届いたか分からないままにしない。同じ鍵でやり直せるよう
    // runId と済んだ chunk 数を返す (途中からの再開には未対応)。
    throw new UnexpectedRouteError(c, {
      success: false,
      error: '一括適用の途中で失敗しました。同じ操作でやり直せます',
      data: { runId: idempotencyKey, completedChunks, total: userIds.length },
    });
  }
};

export const post__api_rich_menu_groups_groupId_duplicate_2 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/duplicate">) => {
    const groupId = c.req.param('groupId');
    const group = await getRichMenuGroupById(c.env.DB, groupId);
    if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      return inputError(c, { success: false, error: 'Idempotency-Key header required' }, 400, []);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // 名前の指定が無ければ「○○ のコピー」。本文なしも許す。
    }
    const requestedName = isJsonRecord(body) && typeof body.name === 'string' ? body.name : undefined;

    const result = await duplicateRichMenuGroupAtomic(c.env.DB, {
      requestId: crypto.randomUUID(),
      accountId: group.account_id,
      sourceGroupId: groupId,
      idempotencyKey,
      name: requestedName,
    });
    if (result.outcome === 'conflict') {
      return c.json(
        { success: false, error: 'Idempotency-Key is already used with different content' },
        409,
      );
    }
    const created = await getRichMenuGroupWithPages(c.env.DB, result.groupId);
    if (!created) return fail(c, 500, 'DUPLICATE_TARGET_NOT_FOUND');

    const staff = c.get('staff');
    c.set('auditRecorded', true);
    try {
      await recordAuditEvent(c.env.DB, {
        tenantId: staff?.tenantId,
        lineAccountId: group.account_id,
        category: 'business',
        actorPrincipalId: staff?.id,
        actorRole: staff?.role,
        action: 'rich_menu.duplicate',
        targetKind: 'rich_menu_group',
        targetId: groupId,
        result: 'success',
        after: { createdGroupId: result.groupId, replayed: result.outcome === 'existing' },
        requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
        ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
        deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
      });
    } catch (auditError) {
      logger.error("rich_menu_groups.rich_menu_groups_group_id_duplicate_post_failed");
    }

    return c.json(
      { success: true, data: serializeGroupWithPages(created) },
      result.outcome === 'existing' ? 200 : 201,
      result.outcome === 'existing' ? { 'Idempotency-Replayed': 'true' } : undefined,
    );
  };

export const get__api_rich_menu_groups_groupId_audience_summary_3 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/audience-summary">) => {
  const group = await getRichMenuGroupById(c.env.DB, c.req.param('groupId'));
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  try {
    const condition = group.targeting_enabled === 1
      ? parseCondition(group.targeting_condition)
      : null;
    if (group.targeting_enabled === 1 && group.targeting_condition && !condition) {
      return c.json({ success: false, error: '保存済みの対象条件を読み取れませんでした' }, 503);
    }
    const targetWhere = condition ? buildSegmentWhere(condition) : { sql: '1=1', bindings: [] };

    const [totalRow, matchedRow, higher] = await Promise.all([
      c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count FROM friends f
            WHERE f.line_account_id = ? AND f.is_following = 1`,
        )
        .bind(group.account_id)
        .first<{ count: number }>(),
      c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count
             FROM friends f
            WHERE f.line_account_id = ?
              AND f.is_following = 1
              AND (${targetWhere.sql})`,
        )
        .bind(group.account_id, ...targetWhere.bindings)
        .first<{ count: number }>(),
      c.env.DB
        .prepare(
          `SELECT targeting_condition
             FROM rich_menu_groups
            WHERE account_id = ?
              AND id <> ?
              AND status = 'published'
              AND targeting_enabled = 1
              AND targeting_priority < ?`,
        )
        .bind(group.account_id, group.id, group.targeting_priority)
        .all<{ targeting_condition: string | null }>(),
    ]);

    const higherParts: Array<{ sql: string; bindings: unknown[] }> = [];
    let unreadableHigher = false;
    for (const row of higher.results ?? []) {
      const parsed = parseCondition(row.targeting_condition);
      if (!parsed) {
        unreadableHigher = true;
        continue;
      }
      higherParts.push(buildSegmentWhere(parsed));
    }

    let excluded: number | null = 0;
    if (!unreadableHigher && higherParts.length > 0) {
      const higherSql = higherParts.map((part) => `(${part.sql})`).join(' OR ');
      const result = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count
             FROM friends f
            WHERE f.line_account_id = ?
              AND f.is_following = 1
              AND (${targetWhere.sql})
              AND (${higherSql})`,
        )
        .bind(group.account_id, ...targetWhere.bindings, ...higherParts.flatMap((p) => p.bindings))
        .first<{ count: number }>();
      excluded = result?.count ?? 0;
    } else if (unreadableHigher) {
      excluded = null;
    }

    const matched = matchedRow?.count ?? 0;
    return c.json({
      success: true,
      data: {
        // 件数だけ。個人・条件・他メニューの名前は返さない。
        total: { value: totalRow?.count ?? 0, state: 'available', reason: null },
        targeted: { value: matched, state: 'available', reason: null },
        excluded: excluded === null
          ? { value: null, state: 'unavailable', reason: 'higher_condition_unreadable' }
          : { value: excluded, state: 'available', reason: null },
        effective: excluded === null
          ? { value: null, state: 'unavailable', reason: 'higher_condition_unreadable' }
          : { value: Math.max(0, matched - excluded), state: 'available', reason: null },
      },
    });
  } catch (error) {
    logger.error("rich_menu_groups.rich_menu_groups_group_id_audience_summary_get_failed");
    return c.json({ success: false, error: '対象人数を確認できませんでした' }, 503);
  }
};

export const get__api_rich_menu_groups_groupId_test_apply_4 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/test-apply">) => {
  const group = await getRichMenuGroupById(c.env.DB, c.req.param('groupId'));
  if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
    return fail(c, 404, 'NOT_FOUND');
  }
  const staff = c.get('staff');
  const member = await getStaffById(c.env.DB, staff.id);
  const lineUserId = member?.line_user_id ?? null;
  const active = lineUserId
    ? await getActiveRichMenuTestApply(c.env.DB, group.id, staff.id)
    : null;
  const recent = await listRichMenuTestApplies(c.env.DB, group.id, 10);
  return c.json({
    success: true,
    data: {
      linked: Boolean(lineUserId),
      confirmationRevision: group.confirmation_revision,
      destinationToken: lineUserId ? await destinationToken(lineUserId) : null,
      // 連携方法の案内。未連携のとき画面はこの案内を出して適用ボタンを止める。
      linkGuidance: lineUserId
        ? null
        : 'テスト適用には、あなたのLINEアカウントとの連携が必要です。スタッフ設定からLINE連携を行ってください。',
      /*
       * 宛先の明示。試験適用でも「誰のどのLINEへ出るか」を画面が言えるよう、
       * 担当者名とマスクしたLINEユーザーIDを返す。未連携なら null。
       */
      destination: lineUserId
        ? { staffName: member?.name ?? null, lineUserIdMasked: maskLineUserId(lineUserId) }
        : null,
      active: active ? serializeTestApply(active) : null,
      recent: recent
        .filter((row) => row.staff_id === staff.id)
        .map(serializeTestApply),
    },
  });
};

export const post__api_rich_menu_groups_groupId_test_apply_5 = async (c: Context<Env, "/api/rich-menu-groups/:groupId/test-apply">) => {
    const groupId = c.req.param('groupId');
    const group = await getRichMenuGroupWithPages(c.env.DB, groupId);
    if (!group || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [group.account_id])) {
      return fail(c, 404, 'NOT_FOUND');
    }
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      return inputError(c, { success: false, error: 'Idempotency-Key header required' }, 400, []);
    }
    let body: { confirm?: unknown; expectedConfirmationRevision?: unknown; expectedDestinationToken?: unknown } = {};
    try {
      body = await c.req.json<{ confirm?: unknown; expectedConfirmationRevision?: unknown; expectedDestinationToken?: unknown }>();
    } catch {
      return inputError(c, { success: false, error: 'invalid JSON body' }, 400, []);
    }
    // 自分のLINE表示を変える操作なので、明示の確認を必須にする。
    if (body.confirm !== true) {
      return inputError(c, { success: false, error: 'テスト適用には確認（confirm: true）が必要です' }, 400, ["confirm"]);
    }

    const staff = c.get('staff');
    const member = await getStaffById(c.env.DB, staff.id);
    const lineUserId = member?.line_user_id ?? null;
    if (!lineUserId) {
      if (body.expectedDestinationToken !== undefined) {
        return c.json({ success: false, error: '対象が変わりました。読み直してください', current: { confirmationRevision: group.confirmation_revision, destinationToken: null } }, 409);
      }
      return inputError(c, {
          success: false,
          code: 'line_not_linked',
          error: 'あなたのLINEアカウントが連携されていません。スタッフ設定からLINE連携を行ってください。',
        }, 400, []);
    }

    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || (body.expectedConfirmationRevision as number) < 1)) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    }
    if (body.expectedDestinationToken !== undefined && (typeof body.expectedDestinationToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedDestinationToken))) {
      return inputError(c, { success: false, error: '確認した宛先が不正です' }, 400, ['expectedDestinationToken']);
    }
    const changed = async () => {
      const [currentGroup, currentMember] = await Promise.all([getRichMenuGroupById(c.env.DB, group.id), getStaffById(c.env.DB, staff.id)]);
      const token = currentMember?.line_user_id ? await destinationToken(currentMember.line_user_id) : null;
      return { conflict: (body.expectedConfirmationRevision !== undefined && currentGroup?.confirmation_revision !== body.expectedConfirmationRevision)
        || (body.expectedDestinationToken !== undefined && token !== body.expectedDestinationToken),
      current: { confirmationRevision: currentGroup?.confirmation_revision ?? null, destinationToken: token } };
    };
    if ((body.expectedConfirmationRevision !== undefined && group.confirmation_revision !== body.expectedConfirmationRevision)
      || (body.expectedDestinationToken !== undefined && await destinationToken(lineUserId) !== body.expectedDestinationToken)) {
      return c.json({ success: false, error: '対象が変わりました。読み直してください', current: { confirmationRevision: group.confirmation_revision, destinationToken: await destinationToken(lineUserId) } }, 409);
    }

    const applyResult = await createRichMenuTestApplyAtomic(c.env.DB, {
      id: crypto.randomUUID(),
      groupId: group.id,
      accountId: group.account_id,
      staffId: staff.id,
      lineUserId,
      idempotencyKey,
    });
    if (applyResult.outcome === 'conflict') {
      return c.json({ success: false, error: 'Idempotency-Key is already used with different content' }, 409);
    }
    let apply = applyResult.apply;
    if (apply.status === 'applied') {
      return c.json(
        { success: true, data: serializeTestApply(apply) },
        200,
        { 'Idempotency-Replayed': 'true' },
      );
    }
    if (apply.status === 'reverted') {
      return c.json({ success: false, error: 'このテスト適用はすでに取り消されました' }, 409);
    }
    if (apply.status === 'reverting') {
      return c.json({ success: false, error: 'このテスト適用は取り消し処理中です' }, 409);
    }
    // 同じ鍵の2本目が走っている途中（running）なら畳む。LINE操作の二重実行を防ぐ。
    if (apply.status === 'running' && applyResult.outcome === 'existing') {
      return c.json({ success: false, error: 'テスト適用を実行中です。少し待ってから確認してください。' }, 409);
    }
    // running でも、同じ担当者の別の進行中テストがあれば止める（二重適用防止）。
    if (applyResult.outcome === 'created') {
      const other = await getActiveRichMenuTestApply(c.env.DB, group.id, staff.id);
      if (other && other.id !== apply.id) {
        // 立てたばかりの行を running のまま残さない。
        await markRichMenuTestApplyFailed(c.env.DB, apply.id, 'superseded by existing active test apply');
        return c.json(
          { success: false, error: 'すでにこのメニューのテスト適用が進行中です。先に取り消してください。', data: serializeTestApply(other) },
          409,
        );
      }
    }

    const account = await getLineAccountById(c.env.DB, group.account_id);
    if (!account) return fail(c, 500, 'LINE_ACCOUNT_NOT_FOUND');
    const line = createLineClient(account.channel_access_token);
    if (!line.getRichMenuIdOfUser || !line.linkRichMenuToUser) {
      return c.json({ success: false, error: 'LINE client does not support per-user rich menu operations' }, 500);
    }

    try {
      if (body.expectedConfirmationRevision !== undefined || body.expectedDestinationToken !== undefined) {
        const current = await changed();
        if (current.conflict) {
          await markRichMenuTestApplyFailed(c.env.DB, apply.id, 'confirmation changed');
          return c.json({ success: false, error: '対象が変わりました。読み直してください', current: current.current }, 409);
        }
      }
      // 1) 適用前の表示を一度だけ記録する。これが無いと戻せない。
      if (apply.previous_captured !== 1) {
        const previous = await line.getRichMenuIdOfUser(lineUserId);
        await captureRichMenuTestApplyPrevious(c.env.DB, apply.id, previous);
        apply = (await getRichMenuTestApplyById(c.env.DB, apply.id))!;
      }

      // 2) 出すメニューを決める。
      let appliedRichMenuId: string;
      if (group.status === 'published') {
        const defaultPage = group.pages.find((p) => p.id === group.default_page_id)
          ?? [...group.pages].sort((a, b) => a.order_index - b.order_index)[0];
        if (!defaultPage?.line_richmenu_id) {
          throw new Error('このメニューのLINE上の実体が見つかりません。公開状態を確認してください。');
        }
        appliedRichMenuId = defaultPage.line_richmenu_id;
      } else {
        // 下書き: テスト専用メニュー（lht:）を作る。画像・切替を含めて実際の見え方を確かめられる。
        let testShellIds: string[] = [];
        try {
          testShellIds = JSON.parse(apply.test_shell_ids ?? '[]') as string[];
        } catch {
          testShellIds = [];
        }
        const r2Adapter: R2Like = {
          async get(key) {
            const obj = await c.env.IMAGES.get(key);
            if (!obj) return null;
            return { body: obj.body as ReadableStream };
          },
        };
        const trackedLinkUrls = await resolveTrackedLinkUrls(
          c.env.DB,
          () => resolveTrackedLinkBaseUrl(c.env.DB, c.env.WORKER_URL || new URL(c.req.url).origin),
          group,
        );
        const formBaseUrl = account.liff_id ? `https://liff.line.me/${account.liff_id}` : null;
        const groupInput: GroupInput = {
          id: group.id,
          size: group.size,
          chatBarText: group.chat_bar_text,
          isDefaultForAll: false,
          formBaseUrl,
          pages: group.pages.map((p) => ({
            id: p.id, orderIndex: p.order_index, name: p.name,
            imageR2Key: p.image_r2_key, imageContentType: p.image_content_type,
            lineRichMenuId: null,
            areas: p.areas.map((a) => ({
              id: a.id,
              bounds: { x: a.bounds_x, y: a.bounds_y, width: a.bounds_width, height: a.bounds_height },
              actionType: a.action_type, actionData: a.actionData, intent: a.intent, label: a.label,
              tagIds: a.tagIds, scoreChange: a.score_change, templateId: a.template_id, formId: a.form_id,
              trackedLinkUrl: a.tracked_link_id ? (trackedLinkUrls.get(a.tracked_link_id) ?? null) : null,
            })),
          })),
        };
        const orderedPages = [...group.pages].sort((a, b) => a.order_index - b.order_index);
        const existingShells = orderedPages.flatMap((page, index) => {
          const shellId = testShellIds[index];
          return shellId ? [{ pageId: page.id, orderIndex: page.order_index, newRichMenuId: shellId }] : [];
        });
        const { shells } = await createRichMenuShells(groupInput, line, r2Adapter, undefined, {
          existingShells,
          shellName: (page) => `lht:${apply.id}:${page.id}`,
          onShellCreated: async (shell) => {
            testShellIds.push(shell.newRichMenuId);
            await recordRichMenuTestApplyShells(c.env.DB, apply.id, testShellIds);
          },
        });
        // 切替ボタンが参照する lhx- alias をテストメニューへ張る。
        if (body.expectedConfirmationRevision !== undefined || body.expectedDestinationToken !== undefined) {
          const current = await changed();
          if (current.conflict) {
            await markRichMenuTestApplyFailed(c.env.DB, apply.id, 'confirmation changed');
            return c.json({ success: false, error: '対象が変わりました。読み直してください', current: current.current }, 409);
          }
        }
        for (const shell of shells) {
          await line.upsertRichMenuAlias(buildAliasId(group.id, shell.orderIndex), shell.newRichMenuId);
        }
        const defaultShell = shells.find((shell) => shell.pageId === (group.default_page_id ?? orderedPages[0]?.id))
          ?? shells[0];
        if (!defaultShell) throw new Error('テスト用メニューを作成できませんでした');
        appliedRichMenuId = defaultShell.newRichMenuId;
      }

      // 3) 本人へリンク。ここが最後の外側操作。
      if (body.expectedConfirmationRevision !== undefined || body.expectedDestinationToken !== undefined) {
        const current = await changed();
        if (current.conflict) {
          await markRichMenuTestApplyFailed(c.env.DB, apply.id, 'confirmation changed');
          return c.json({ success: false, error: '対象が変わりました。読み直してください', current: current.current }, 409);
        }
      }
      await line.linkRichMenuToUser(lineUserId, appliedRichMenuId);
      await markRichMenuTestApplyApplied(c.env.DB, apply.id, appliedRichMenuId);

      const staffForAudit = c.get('staff');
      c.set('auditRecorded', true);
      try {
        await recordAuditEvent(c.env.DB, {
          tenantId: staffForAudit?.tenantId,
          lineAccountId: group.account_id,
          category: 'business',
          actorPrincipalId: staffForAudit?.id,
          actorRole: staffForAudit?.role,
          action: 'rich_menu.test_apply',
          targetKind: 'rich_menu_group',
          targetId: group.id,
          result: 'success',
          after: { applyId: apply.id, appliedRichMenuId },
          requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
          ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
          deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
        });
      } catch (auditError) {
        logger.error("rich_menu_groups.rich_menu_groups_group_id_test_apply_post_failed");
      }

      const updated = await getRichMenuTestApplyById(c.env.DB, apply.id);
      return c.json({ success: true, data: serializeTestApply(updated ?? apply) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markRichMenuTestApplyFailed(c.env.DB, apply.id, message);
      if (e instanceof RichMenuValidationError) {
        return inputError(c, { success: false, error: message }, 400, ["pages"]);
      }
      throw new UnexpectedRouteError(c, { success: false, error: message, data: { applyId: apply.id } });
    }
  };
