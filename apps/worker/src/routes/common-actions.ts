import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import {
  archiveCommonAction,
  CommonActionValidationError,
  createCommonAction,
  createCommonActionDraft,
  duplicateCommonAction,
  getCommonActionDetail,
  getCommonActionsSummary,
  listCommonActionResources,
  listCommonActions,
  publishCommonActionDraft,
  unarchiveCommonAction,
  updateCommonActionBindingVersion,
  updateCommonActionDraft,
} from '../services/common-actions.js';

const commonActions = new Hono<Env>();

function accountId(c: Context<Env>): string | null {
  return c.req.query('account_id') || c.req.query('lineAccountId') || null;
}

async function requireAccount(c: Context<Env>): Promise<string | Response> {
  const id = accountId(c);
  if (!id) return inputError(c, { success: false, error: 'LINE公式アカウントを選んでください' }, 400, ["lineAccountId"]);
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (!scope.ids.includes(id)) {
    return c.json({ success: false, error: '対象のLINE公式アカウントが見つかりません' }, 404);
  }
  return id;
}

function validationResponse(c: Context<Env>, error: CommonActionValidationError): Response {
  // 監査 ・・・: 改訂・利用版・参照先の競合は409で再確認へ導く。
  const conflict = new Set(['version_conflict', 'draft_exists', 'draft_revision_conflict', 'reference_updated']);
  const notFound = new Set([
    'not_found', 'draft_not_found', 'base_version_not_found', 'version_not_found', 'binding_not_found',
  ]);
  const status = conflict.has(error.code) ? 409 : notFound.has(error.code) ? 404 : 422;
  return inputError(c, {
    success: false,
    error: error.message,
    code: error.code,
    ...(error.field ? { field: error.field } : {}),
  }, status, []);
}

function nonNegativeInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseOffsetPaging({ limit: value }, { defaultLimit: Number.NaN, limitPolicy: {} }).limit;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CommonActionValidationError('pagination_invalid', 'ページ指定を確認してください', field);
  }
  return parsed;
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function commonActionsCsv(items: Awaited<ReturnType<typeof listCommonActions>>['items']): string {
  const header = ['名前', '状態', '公開版', '中の処理', '呼び出し場所', '今月の実行', '今月の失敗', '最終実行'];
  const rows = items.map((item) => [
    item.name,
    item.status,
    item.publishedVersion,
    item.actionCount,
    item.bindingCount,
    item.executionCountThisMonth,
    item.failureCountThisMonth,
    item.lastRunAt,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function endpoint<T>(
  c: Context<Env>,
  run: () => Promise<T>,
  successStatus = 200,
): Promise<Response> {
  try {
    const data = await run();
    return c.json({ success: true, data }, successStatus as 200);
  } catch (error) {
    if (error instanceof CommonActionValidationError) return validationResponse(c, error);
    throw error;
  }
}

commonActions.get('/api/common-actions', requireRole('owner', 'admin', 'staff'), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  try {
    const format = c.req.query('format');
    if (format && format !== 'csv') {
      throw new CommonActionValidationError('format_invalid', '書き出し形式を確認してください', 'format');
    }
    if (format === 'csv') {
      const staff = c.get('staff');
      if (staff?.role === 'staff' && !staff.permissionKeys?.includes('automation.run.export')) {
        return c.json({ success: false, error: 'CSVを書き出す権限がありません' }, 403);
      }
    }
    const requestedLimit = nonNegativeInteger(c.req.query('limit'), 'limit');
    const limit = requestedLimit === undefined ? undefined : parseOffsetPaging({ limit: String(requestedLimit) }, { limitPolicy: { minimum: 1, maximum: 500 } }).limit;
    const offset = nonNegativeInteger(c.req.query('offset'), 'offset') ?? 0;
    const [result, summary] = await Promise.all([
      listCommonActions(c.env.DB, {
        lineAccountId: id,
        status: c.req.query('status'),
        query: c.req.query('query'),
        folderId: c.req.query('folder_id'),
        ...(format === 'csv' ? {} : { limit, offset }),
      }),
      // 札・KPI用の集計。絞り込みに依らずアカウント全体で数える。
      // 画面が全件取得を2回投げないための口（ 点検中2）。
      format === 'csv' ? null : getCommonActionsSummary(c.env.DB, id),
    ]);
    if (format === 'csv') {
      c.set('outputAudit', { count: result.items.length, accountId: id });
      return c.body(commonActionsCsv(result.items), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="common-actions.csv"',
      });
    }
    const responseItems = result.items;
    return c.json(buildOffsetListResponse({ success: true,
      data: responseItems,
      pagination: { total: result.total, limit: limit ?? null, offset },
      summary,
      freshness: 'available', items: responseItems, total: result.total, paging: { limit: limit ?? result.total, offset }, sort: [{ field: 'updatedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }));
  } catch (error) {
    if (error instanceof CommonActionValidationError) return validationResponse(c, error);
    throw error;
  }
});

commonActions.post('/api/common-actions', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  const body = await c.req.json<{
    folderId?: unknown;
    name?: unknown;
    description?: unknown;
    actions?: unknown;
    clientRequestKey?: unknown;
  }>().catch(() => ({} as {
    folderId?: unknown;
    name?: unknown;
    description?: unknown;
    actions?: unknown;
    clientRequestKey?: unknown;
  }));
  return endpoint(c, () => createCommonAction(c.env.DB, {
    lineAccountId: id,
    folderId: body.folderId,
    name: body.name,
    description: body.description,
    actions: body.actions,
    createdBy: c.get('staff')?.id,
    // 監査 : 応答消失からの再試行で二重作成にしない鍵。
    clientRequestKey: body.clientRequestKey,
  }), 201);
});

commonActions.get('/api/common-actions/resources', requireRole('owner', 'admin'), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  const trigger = c.req.query('trigger');
  if (trigger && trigger !== 'tag.added') {
    return c.json({
      success: false,
      code: 'trigger_invalid',
      error: '対応していないきっかけです',
    }, 422);
  }
  return endpoint(c, () => listCommonActionResources(c.env.DB, {
    lineAccountId: id,
    excludeCommonActionId: c.req.query('exclude_id'),
    trigger: trigger === 'tag.added' ? trigger : undefined,
  }));
});

commonActions.get('/api/common-actions/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  return endpoint(c, () => getCommonActionDetail(c.env.DB, {
    id: c.req.param('id'),
    lineAccountId: id,
  }));
});

// 監査 : 未使用の共通アクションを保管する。利用中は422で利用先を示す。
commonActions.post('/api/common-actions/:id/archive', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  return endpoint(c, async () => {
    await archiveCommonAction(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: id,
    });
    return { archived: true };
  });
});

commonActions.post('/api/common-actions/:id/unarchive', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  return endpoint(c, async () => {
    await unarchiveCommonAction(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: id,
    });
    return { unarchived: true };
  });
});

commonActions.post('/api/common-actions/:id/duplicate', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  return endpoint(c, () => duplicateCommonAction(c.env.DB, {
    id: c.req.param('id'),
    lineAccountId: id,
    createdBy: c.get('staff')?.id,
  }), 201);
});

commonActions.put('/api/common-actions/:id/draft', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  const body = await c.req.json<{
    expectedDraftVersionId?: unknown;
    expectedDraftRevision?: unknown;
    folderId?: unknown;
    name?: unknown;
    description?: unknown;
    actions?: unknown;
  }>().catch(() => ({} as {
    expectedDraftVersionId?: unknown;
    expectedDraftRevision?: unknown;
    folderId?: unknown;
    name?: unknown;
    description?: unknown;
    actions?: unknown;
  }));
  return endpoint(c, async () => {
    await updateCommonActionDraft(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: id,
      expectedDraftVersionId: body.expectedDraftVersionId,
      expectedDraftRevision: body.expectedDraftRevision,
      folderId: body.folderId,
    name: body.name,
      description: body.description,
      actions: body.actions,
    });
    return { updated: true };
  });
});

commonActions.post('/api/common-actions/:id/versions', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = await requireAccount(c);
  if (typeof id !== 'string') return id;
  const body = await c.req.json<{ fromVersionId?: unknown }>()
    .catch(() => ({} as { fromVersionId?: unknown }));
  return endpoint(c, () => createCommonActionDraft(c.env.DB, {
    id: c.req.param('id'),
    lineAccountId: id,
    fromVersionId: body.fromVersionId,
    createdBy: c.get('staff')?.id,
  }), 201);
});

commonActions.post(
  '/api/common-actions/:id/versions/:versionId/publish',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const id = await requireAccount(c);
    if (typeof id !== 'string') return id;
    // 監査 : 公開確認に使った下書きの改訂番号を照合する。
    const body = await c.req.json<{ expectedDraftRevision?: unknown }>()
      .catch(() => ({} as { expectedDraftRevision?: unknown }));
    return endpoint(c, () => publishCommonActionDraft(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: id,
      draftVersionId: c.req.param('versionId'),
      expectedDraftRevision: body.expectedDraftRevision,
    }));
  },
);

commonActions.post(
  '/api/common-actions/:id/bindings/:bindingId/version',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const id = await requireAccount(c);
    if (typeof id !== 'string') return id;
    const body = await c.req.json<{ versionId?: unknown; expectedVersionId?: unknown; expectedConfirmationRevision?: unknown }>()
      .catch(() => ({} as { versionId?: unknown; expectedVersionId?: unknown; expectedConfirmationRevision?: unknown }));
    try {
      await updateCommonActionBindingVersion(c.env.DB, {
        id: c.req.param('id'),
        bindingId: c.req.param('bindingId'),
        lineAccountId: id,
        versionId: body.versionId,
        expectedVersionId: body.expectedVersionId,
        expectedConfirmationRevision: body.expectedConfirmationRevision,
        actorId: c.get('staff')?.id,
      });
      return c.json({ success: true, data: { updated: true } });
    } catch (error) {
      if (error instanceof CommonActionValidationError && error.code === 'version_conflict') {
        const current = await c.env.DB.prepare(`SELECT id, common_action_version_id AS versionId, confirmation_revision AS confirmationRevision
          FROM common_action_bindings WHERE id = ? AND common_action_id = ? AND line_account_id = ?`)
          .bind(c.req.param('bindingId'), c.req.param('id'), id).first();
        return c.json({ success: false, error: error.message, code: error.code, current }, 409);
      }
      if (error instanceof CommonActionValidationError) return validationResponse(c, error);
      throw error;
    }
  },
);

export { commonActions };
