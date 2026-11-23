import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { requireRole } from '../middleware/role-guard.js';
import { adoptCatalogVersion, CatalogAdoptionError, catalogHqStatus, dismissCatalogVersion } from '../services/hq-templates/catalog-adoption.js';
import { canUseMileageAccount } from './scoring-definition.js';

/** 本部から配られた景品の、新しい版の知らせ・取り込み・今のまま。店のスタッフと閲覧のみは見るだけ。 */
export const mileageHqAdoption = new Hono<Env>();

const messages: Record<string, string> = {
  not_found: '使い道が見つかりません',
  hq_version_required: '取り込む版を指定してください',
  hq_binding_not_found: '本部から配られた使い道ではありません',
  hq_version_conflict: '本部の版かこの使い道が先に変わりました。読み直してください',
  hq_template_unavailable: '本部のひな形が使えなくなりました',
  hq_origin_conflict: '本部の版と使い道の記録が食い違っています。本部に確認してください',
  hq_target_changed: 'ほかの人が先に変更しました。読み直してください',
  hq_version_invalid: '本部の版を読み込めませんでした。本部に確認してください',
  handgift_protected: '手渡しの景品には本部の版を取り込めません',
  reference_unavailable: '本部の版が使うタグや処理がこの店にありません。確認してください',
  reward_kind_changed: '渡し方が変わる版は取り込めません。新しい使い道として作ってください',
};

function fail(c: Context<Env>, error: unknown) {
  if (error instanceof CatalogAdoptionError) return inputError(c, { success: false, error: messages[error.code] ?? '入力内容を確認してください', code: error.code }, error.status, []);
  throw error;
}

mileageHqAdoption.get('/api/mileage/rewards/:id/hq-status', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = c.req.query('accountId')?.trim() ?? '';
  if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
  try { return c.json({ success: true, data: await catalogHqStatus(c.env.DB, 'mileage_reward', accountId, c.req.param('id')) }); }
  catch (error) { return fail(c, error); }
});

for (const [suffix, run] of [['hq-adopt', adoptCatalogVersion], ['hq-dismiss', dismissCatalogVersion]] as const) {
  mileageHqAdoption.post(`/api/mileage/rewards/:id/${suffix}`, requireRole('owner', 'admin'), inputJsonBoundary({ accountId: ['string'], versionId: ['string'] }), async (c) => {
    const body = await c.req.json<{ accountId?: unknown; versionId?: unknown }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    const staff = c.get('staff');
    // 閲覧のみは全体の認証でも止まるが、この口だけ単独で使われても書かせない。
    if (!staff || staff.readOnly) return c.json({ success: false, error: '閲覧のみの担当者は変更できません' }, 403);
    try {
      const data = await run(c.env.DB, { kind: 'mileage_reward', accountId, targetId: c.req.param('id'), versionId: body.versionId, actor: { id: staff.id, role: staff.role } });
      c.set('auditRecorded', true);
      return c.json({ success: true, data });
    } catch (error) { return fail(c, error); }
  });
}
