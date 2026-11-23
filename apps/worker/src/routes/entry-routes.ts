import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { serialize } from './entry-route-display.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { availableEntryCoupon } from '../services/entry-route-coupon.js';
import { createQrImage, QrInputError } from '../lib/qr-response.js';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  getEntryRoutes,
  getEntryRouteById,
  getLineAccountById,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
  getEntryRouteFunnel,
  getEntryRouteSources,
  getEntryRouteGenres,
  createEntryRouteGenre,
  updateEntryRouteGenre,
} from '@line-crm/db';
import type { EntryRoute, EntryRouteGenre } from '@line-crm/db';
import { QrCapacityError, encodeQr } from '../lib/qr-matrix.js';
import { QrPdfError, buildQrPrintPdf } from '../lib/qr-print-pdf.js';


import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { resolveRequestBoundary } from '../services/request-boundary.js';

const entryRoutes = new Hono<Env>();
const INFLOW_LINKS_PERMISSION = '/inflow-links';

/**
 * 流入経路の運用は、役割ではなく画面権限にも委譲する。
 * 完全削除は不可逆なので、この門番を使わず従来どおり owner/admin に限定する。
 */
function requireEntryRouteManagement(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    const allowed = staff && (
      staff.role === 'owner'
      || staff.role === 'admin'
      || (staff.role === 'staff' && staff.permissionKeys?.includes(INFLOW_LINKS_PERMISSION))
    );
    if (!allowed) {
      return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    }
    return next();
  };
}

async function couponSettingsError(db: D1Database, body: {
  couponEnabled?: boolean; couponAssetId?: string | null; couponAudience?: 'new_friends' | 'all_friends';
}, accountId: string | null, existing?: EntryRoute): Promise<string | null> {
  if (body.couponEnabled !== undefined && typeof body.couponEnabled !== 'boolean') return 'クーポンのオン・オフが正しくありません';
  if (body.couponAssetId !== undefined && body.couponAssetId !== null && (typeof body.couponAssetId !== 'string' || !body.couponAssetId.trim())) return 'クーポンを選んでください';
  if (body.couponAudience !== undefined && !['new_friends', 'all_friends'].includes(body.couponAudience)) return '渡す相手が正しくありません';
  const enabled = body.couponEnabled ?? (existing?.coupon_enabled === 1);
  const assetId = body.couponAssetId !== undefined ? body.couponAssetId : existing?.coupon_asset_id;
  // 期限切れ・公開停止後も、同じ設定をオフにして保存できる。
  // 別のクーポンへ変更する場合と再度オンにする場合は、公開版を確かめる。
  if (enabled || (body.couponAssetId != null && body.couponAssetId !== existing?.coupon_asset_id)) {
    if (!assetId || !accountId || !await availableEntryCoupon(db, assetId, accountId)) return 'このアカウントで利用できる公開中のクーポンを選んでください';
  }
  return null;
}

function serializeGenre(row: EntryRouteGenre) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canAccessEntryRoute(row: EntryRoute, tenantId: string): boolean {
  return row.tenant_id === tenantId || (row.tenant_id === null && tenantId === DEFAULT_TENANT_ID);
}

async function canAccessEntryRouteAccount(
  db: D1Database,
  staff: NonNullable<Env['Variables']['staff']>,
  row: EntryRoute,
): Promise<boolean> {
  // migration 308 より前の未割当行は従来どおりtenant境界で扱う。
  // 所有accountがある行は、同じtenantのowner/adminでも担当外なら変更させない。
  const accountId = row.line_account_id ?? null;
  if (accountId === null) return true;
  return (await resolveRequestBoundary(db, staff, accountId)).allowed;
}

entryRoutes.get('/api/entry-route-genres', async (c) => {
  try {
    const rows = await getEntryRouteGenres(c.env.DB);
    return c.json({ success: true, data: rows.map(serializeGenre) });
  } catch (err) {
    throw err;
  }
});

entryRoutes.post('/api/entry-route-genres', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ name?: string }>();
    const name = body.name?.trim();
    if (!name || name.length > 80) {
      return inputError(c, { success: false, error: 'ジャンル名は1〜80文字で入力してください' }, 400, ["name"]);
    }
    const row = await createEntryRouteGenre(c.env.DB, name);
    return c.json({ success: true, data: serializeGenre(row) }, 201);
  } catch (err) {
    logger.error("entry_routes.entry_route_genres_create_failed");
    if (String(err).includes('UNIQUE constraint failed: entry_route_genres.name')) {
      return c.json({ success: false, error: '同じ名前のジャンルが既にあります' }, 409);
    }
    throw err;
  }
});

entryRoutes.patch('/api/entry-route-genres/:id', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"]}), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ name?: string }>();
    const name = body.name?.trim();
    if (!name || name.length > 80) {
      return inputError(c, { success: false, error: 'ジャンル名は1〜80文字で入力してください' }, 400, ["name"]);
    }
    const row = await updateEntryRouteGenre(c.env.DB, id, name);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeGenre(row) });
  } catch (err) {
    logger.error("entry_routes.entry_route_genres_by_id_update_failed");
    if (String(err).includes('UNIQUE constraint failed: entry_route_genres.name')) {
      return c.json({ success: false, error: '同じ名前のジャンルが既にあります' }, 409);
    }
    throw err;
  }
});

// GET /api/entry-routes — list all
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const staff = c.get('staff');
    const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
    // 選択accountをAPIへ渡し、DBの行と共通境界で照合する。
    // 範囲外の指定は「ない」ものとして404にする。
    const requested = (c.req.query('account_id') ?? '').trim();
    const decision = await resolveRequestBoundary(c.env.DB, staff, requested || undefined);
    if (!decision.allowed) return c.json({ success: false, error: 'Not found' }, 404);
    const scope = decision.scope;
    const rows = await getEntryRoutes(c.env.DB, tenantId);
    const visible = rows.filter((row) => {
      const accountId = (row as { line_account_id?: string | null }).line_account_id ?? null;
      if (requested) return accountId === requested;
      return accountId == null ? scope.canSeeUnassigned : scope.allowedAccountIds.includes(accountId);
    });
    return c.json({ success: true, data: visible.map(serialize) });
  } catch (err) {
    throw err;
  }
});

// GET /api/entry-routes/:id — single
entryRoutes.get('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await getEntryRouteById(c.env.DB, id);
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    if (!row || !canAccessEntryRoute(row, tenantId) || !await canAccessEntryRouteAccount(c.env.DB, c.get('staff'), row)) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    throw err;
  }
});

// POST /api/entry-routes — create
entryRoutes.post('/api/entry-routes', requireEntryRouteManagement(), inputJsonBoundary({"refCode":["string"],"genre":["null","string"],"name":["string"],"tagId":["null","string"],"scenarioId":["null","string"],"redirectUrl":["null","string"],"poolId":["null","string"],"introTemplateId":["null","string"],"runAccountFriendAddScenarios":["boolean"],"isActive":["boolean"],"lineAccountId":["null","string"],"line_account_id":["null","string"],"accountId":["null","string"],"account_id":["null","string"]}), async (c) => {
  try {
    const body = await c.req.json<{
      refCode: string;
      genre?: string | null;
      name: string;
      tagId?: string | null;
      scenarioId?: string | null;
      redirectUrl?: string | null;
      poolId?: string | null;
      introTemplateId?: string | null;
      couponEnabled?: boolean;
      couponAssetId?: string | null;
      couponAudience?: 'new_friends' | 'all_friends';
      runAccountFriendAddScenarios?: boolean;
      isActive?: boolean;
      /** 画面のヘッダーで選んだ所属。機能強制ミドルウェアが読む鍵と同名で受ける。 */
      lineAccountId?: string | null;
      line_account_id?: string | null;
      accountId?: string | null;
      account_id?: string | null;
    }>();
    const refCode = body.refCode?.trim();
    const name = body.name?.trim();
    const genre = body.genre?.trim() || null;
    if (!refCode || !name) {
      return inputError(c, { success: false, error: '名前と ref_code は必須です' }, 400, ["refCode","name"]);
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(refCode)) {
      return inputError(c, { success: false, error: 'ref_code は64文字以内の半角英数字・_・-で入力してください' }, 400, ["refCode"]);
    }
    if ((genre?.length ?? 0) > 80 || name.length > 120) {
      return inputError(c, { success: false, error: 'ジャンルは80文字、名前は120文字以内で入力してください' }, 400, ["genre","name"]);
    }
    const staff = c.get('staff');
    // 送りに所属が無いと機能強制で止まる。担当アカウント制の職員は
    // 自分の所属へ倒し、それでも無ければ作らせない。
    const lineAccountId = body.lineAccountId?.trim()
      || body.line_account_id?.trim()
      || body.accountId?.trim()
      || body.account_id?.trim()
      || staff.assignedLineAccountId
      || null;
    if (!lineAccountId) {
      return inputError(c, {
        success: false,
        error: 'LINEアカウントを指定してください',
        code: 'LINE_ACCOUNT_REQUIRED',
      }, 400, ["lineAccountId","line_account_id","accountId","account_id"]);
    }
    //  と同じ境界で照合する。範囲外の指定は「ない」ものとして404にする。
    const decision = await resolveRequestBoundary(c.env.DB, staff, lineAccountId);
    if (!decision.allowed) return c.json({ success: false, error: 'Not found' }, 404);
    const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
    const couponError = await couponSettingsError(c.env.DB, body, lineAccountId);
    if (couponError) return c.json({ success: false, error: couponError }, 400);
    const row = await createEntryRoute(c.env.DB, { ...body, refCode, name, genre, tenantId, lineAccountId });
    return c.json({ success: true, data: serialize(row) }, 201);
  } catch (err) {
    logger.error("entry_routes.create_failed");
    if (String(err).includes('UNIQUE constraint failed: entry_routes.ref_code')) {
      return c.json({ success: false, error: 'この ref_code は既に使われています' }, 409);
    }
    throw err;
  }
});


entryRoutes.patch('/api/entry-routes/:id', requireEntryRouteManagement(), inputJsonBoundary({"refCode":["string"],"genre":["null","string"],"name":["string"],"tagId":["null","string"],"scenarioId":["null","string"],"redirectUrl":["null","string"],"poolId":["null","string"],"introTemplateId":["null","string"],"runAccountFriendAddScenarios":["boolean"],"isActive":["boolean"],"stoppedReason":["null","string"]}), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    const existing = await getEntryRouteById(c.env.DB, id);
    if (!existing || !canAccessEntryRoute(existing, tenantId)) return c.json({ success: false, error: 'Not found' }, 404);
    if (!await canAccessEntryRouteAccount(c.env.DB, c.get('staff'), existing)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const body = await c.req.json<
      Partial<{
        refCode: string;
        genre: string | null;
        name: string;
        tagId: string | null;
        scenarioId: string | null;
        redirectUrl: string | null;
        poolId: string | null;
        introTemplateId: string | null;
        couponEnabled: boolean;
        couponAssetId: string | null;
        couponAudience: 'new_friends' | 'all_friends';
        runAccountFriendAddScenarios: boolean;
        isActive: boolean;
        stoppedReason?: string | null;
        expectedUpdatedAt: string;
      }>
    >();
    if (body.expectedUpdatedAt !== undefined && (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt)) {
      return inputError(c,{success:false,error:'読み込んだ更新日時を指定してください'},400,['expectedUpdatedAt']);
    }
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== existing.updated_at) {
      return c.json({success:false,code:'VERSION_CONFLICT',error:'先に保存された変更があります。最新を読み直してください',data:{current:serialize(existing)}},409);
    }
    if (body.refCode !== undefined && body.refCode.trim() !== existing.ref_code) {
      return inputError(c, { success: false, error: 'ref_code は作成後に変更できません' }, 400, ["refCode"]);
    }
    if (body.genre !== undefined && body.genre !== null && (!body.genre.trim() || body.genre.trim().length > 80)) {
      return inputError(c, { success: false, error: 'ジャンルは1〜80文字で入力してください' }, 400, ["genre"]);
    }
    if (body.name !== undefined && (!body.name.trim() || body.name.trim().length > 120)) {
      return inputError(c, { success: false, error: '名前は1〜120文字で入力してください' }, 400, ["name"]);
    }
    if (body.stoppedReason !== undefined && body.stoppedReason !== null
      && (typeof body.stoppedReason !== 'string' || body.stoppedReason.trim().length > 200)) {
      return inputError(c, { success: false, error: '停止理由は200文字以内で入力してください' }, 400, ["stoppedReason"]);
    }
    if (body.couponEnabled !== undefined || body.couponAssetId !== undefined || body.couponAudience !== undefined) {
      const couponError = await couponSettingsError(c.env.DB, body, existing.line_account_id ?? null, existing);
      if (couponError) return c.json({ success: false, error: couponError }, 400);
    }
    delete body.refCode;
    if (typeof body.genre === 'string') body.genre = body.genre.trim();
    if (body.name !== undefined) body.name = body.name.trim();
    const row = await updateEntryRoute(c.env.DB, id, body);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    if (err instanceof Error && err.message === 'ENTRY_ROUTE_VERSION_CONFLICT') {
      return c.json({success:false,code:'VERSION_CONFLICT',error:'先に保存された変更があります。最新を読み直してください'},409);
    }
    logger.error("entry_routes.by_id_update_failed");
    if (String(err).includes('UNIQUE constraint failed: entry_routes.ref_code')) {
      return c.json({ success: false, error: 'この ref_code は既に使われています' }, 409);
    }
    throw err;
  }
});


entryRoutes.delete('/api/entry-routes/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    const existing = await getEntryRouteById(c.env.DB, id);
    if (!existing || !canAccessEntryRoute(existing, tenantId)) return c.json({ success: false, error: 'Not found' }, 404);
    if (!await canAccessEntryRouteAccount(c.env.DB, c.get('staff'), existing)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const body: { confirmationName?: unknown } = await c.req
      .json<{ confirmationName?: unknown }>()
      .catch(() => ({}));
    if (typeof body.confirmationName !== 'string' || body.confirmationName !== existing.name) {
      return c.json({
        success: false,
        error: '完全削除する経路名を正確に入力してください。',
        code: 'ENTRY_ROUTE_NAME_CONFIRMATION_MISMATCH',
      }, 422);
    }
    const result = await deleteEntryRoute(c.env.DB, id, body.confirmationName);
    if (result === 'not_found') return c.json({ success: false, error: 'Not found' }, 404);
    if (result === 'name_mismatch') {
      return c.json({
        success: false,
        error: '経路名が変更されています。画面を読み直してから、もう一度確認してください。',
        code: 'ENTRY_ROUTE_NAME_CONFIRMATION_MISMATCH',
      }, 422);
    }
    if (result === 'in_use') {
      return c.json({
        success: false,
        error: '利用履歴がある経路は完全削除できません。受付停止を選んでください。',
        code: 'ENTRY_ROUTE_IN_USE',
      }, 409);
    }
    return c.json({ success: true });
  } catch (err) {
    throw err;
  }
});

// PNG/SVG。所属を確認してから、保存された経路のURLだけを書き出す。
entryRoutes.post('/api/entry-routes/:id/qr-image', requireEntryRouteManagement(), async (c) => {
  try {
    const staff = c.get('staff');
    const route = await getEntryRouteById(c.env.DB, c.req.param('id'));
    if (!route || !canAccessEntryRoute(route, staff.tenantId ?? DEFAULT_TENANT_ID)
      || !await canAccessEntryRouteAccount(c.env.DB, staff, route)) return c.json({ success: false, error: 'Not found' }, 404);
    if (route.is_active !== 1) return c.json({ success: false, error: 'この経路は停止しています' }, 409);
    const body = await c.req.json<{ format?: 'png' | 'svg'; size?: 'small' | 'medium' | 'large' }>();
    const format = body.format ?? 'png';
    const size = body.size ?? 'medium';
    if (!['png', 'svg'].includes(format) || !['small', 'medium', 'large'].includes(size)) return c.json({ success: false, error: '形式または大きさが正しくありません' }, 400);
    const pixels = { small: 256, medium: 512, large: 1024 }[size];
    const url = `${new URL(c.req.url).origin}/r/${route.ref_code}`;
    const output = await createQrImage(url, `${pixels}x${pixels}`, format);
    return new Response(output.bytes, { headers: {
      'Content-Type': output.contentType,
      'Content-Disposition': `attachment; filename="qr-${route.ref_code}-${size}.${format}"`,
      'Cache-Control': 'no-store',
    } });
  } catch (error) {
    if (error instanceof QrInputError) return c.json({ success: false, error: 'URLが長すぎるか、大きさが足りません' }, 400);
    throw error;
  }
});

// POST /api/entry-routes/:id/qr-pdf — printing sheet (A4, 1 page)
entryRoutes.post('/api/entry-routes/:id/qr-pdf', requireEntryRouteManagement(), inputJsonBoundary(), async (c) => {
  try {
    const id = c.req.param('id');
    const staff = c.get('staff');
    const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
    const existing = await getEntryRouteById(c.env.DB, id);
    if (!existing || !canAccessEntryRoute(existing, tenantId)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (!await canAccessEntryRouteAccount(c.env.DB, staff, existing)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    // 止めた経路は QR も印刷も出さない。画面も同じ文を見せる。
    if (existing.is_active !== 1) {
      return c.json({ success: false, error: 'この経路は停止しています' }, 409);
    }
    const body = await c.req.json<{ paper?: 'A4' | 'A5' }>().catch(() => ({} as { paper?: 'A4' | 'A5' }));
    const paper = body.paper ?? 'A4';
    if (!['A4', 'A5'].includes(paper)) return c.json({ success: false, error: '用紙はA4またはA5を選んでください' }, 400);
    const url = `${new URL(c.req.url).origin}/r/${existing.ref_code}`;
    let symbol;
    try {
      symbol = encodeQr(url);
    } catch (err) {
      if (err instanceof QrCapacityError) {
        return inputError(c, { success: false, error: 'URLが長すぎてQRにできません' }, 400, []);
      }
      throw err;
    }
    const account = existing.line_account_id
      ? await getLineAccountById(c.env.DB, existing.line_account_id)
      : null;
    const accountName = account?.name?.trim() || existing.name;
    const jst = japanCalendar().toISOString();
    const issuedAt = `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
    const coupon = existing.coupon_enabled === 1 && existing.coupon_asset_id && existing.line_account_id
      ? await availableEntryCoupon(c.env.DB, existing.coupon_asset_id, existing.line_account_id) : null;
    if (existing.coupon_enabled === 1 && !coupon) return c.json({ success: false, error: 'このクーポンは現在利用できません' }, 409);
    let pdf: Uint8Array;
    try {
      pdf = buildQrPrintPdf({ accountName, url, issuedAt, qr: symbol, paper, couponName: coupon?.name });
    } catch (err) {
      if (err instanceof QrPdfError) {
        return inputError(c, { success: false, error: '印刷用PDFを作れませんでした' }, 400, []);
      }
      throw err;
    }
    // ref_code は半角英数字だけなので、そのままファイル名に使える。
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="qr-${existing.ref_code}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    throw err;
  }
});

// GET /api/entry-routes/:id/funnel
entryRoutes.get('/api/entry-routes/:id/funnel', async (c) => {
  try {
    const id = c.req.param('id');
    const route = await getEntryRouteById(c.env.DB, id);
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    if (!route || !canAccessEntryRoute(route, tenantId) || !await canAccessEntryRouteAccount(c.env.DB, c.get('staff'), route)) return c.json({ success: false, error: 'Not found' }, 404);
    const funnel = await getEntryRouteFunnel(c.env.DB, id);
    return c.json({ success: true, data: funnel });
  } catch (err) {
    throw err;
  }
});

// GET /api/entry-routes/:id/sources
// そのリンクのクリックが「どこから来ているか」。utm_source > 参照元URLの
// ホスト名 > 「直接アクセス」の順で寄せる。
entryRoutes.get('/api/entry-routes/:id/sources', async (c) => {
  try {
    const id = c.req.param('id');
    const route = await getEntryRouteById(c.env.DB, id);
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    if (!route || !canAccessEntryRoute(route, tenantId) || !await canAccessEntryRouteAccount(c.env.DB, c.get('staff'), route)) return c.json({ success: false, error: 'Not found' }, 404);
    const sources = await getEntryRouteSources(c.env.DB, id);
    return c.json({ success: true, data: sources });
  } catch (err) {
    throw err;
  }
});

export { entryRoutes };
