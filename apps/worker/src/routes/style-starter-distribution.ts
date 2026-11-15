import { profile } from '../services/style-profile.js';
import type { SetupAnswer } from '@line-crm/shared';
import { materializeInitialMenuAssets } from '../services/style-initial-assets.js';
import { starterCatalogRuntime } from './style-starter-runtime.js';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { base, hq, json, account, edit, version } from './styles-common.js';
import { checkStyle, readDefinition, StyleError } from '../services/style-setup.js';
import { musuboStarter } from '../services/style-starter-set.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  starterDistributionPlan,
  distributeStarter,
} from '../services/style-starter-distribution.js';
import {
  overwriteResource,
  resourceSnapshot,
  snapshotGuard,
  recordSnapshot,
} from '../services/style-starter-resource.js';
import type { StarterItem } from '../services/style-starter-definition.js';
export const styleStarterDistribution = new Hono<Env>();
const path = '/api/hq/style-starter-sets/:style';
styleStarterDistribution.post(path + '/preflight', async (c) => {
  const tenant = await hq(c),
    style = checkStyle(c.req.param('style')),
    b = await json(c);
  const plan = await starterDistributionPlan(c.env.DB, tenant, style, b);
  return c.json({
    success: true,
    data: {
      token: plan.token,
      accountCount: plan.accountCount,
      editedCount: plan.editedCount,
      accounts: plan.accounts.map((a) => ({
        accountId: a.accountId,
        editedCount: a.editedCount,
        items: a.items.map(({ binding, snapshot, ...i }) => i),
      })),
    },
  });
});
/** musubo の標準の中身。統括が自分の組を作る・戻す前に見る。 */
styleStarterDistribution.get(path + '/default', async (c) => {
  await hq(c);
  const style = checkStyle(c.req.param('style'));
  const standard = await musuboStarter(c.env.DB, style);
  return c.json({
    success: true,
    data: { style, id: standard.id, version: standard.version, definition: standard.definition },
  });
});
/**
 * 統括の組を musubo の標準に戻す。戻す前の版は止めた写しで残し、自動で入れるかの設定と組の ID は変えない。
 * 店にはまだ配らない（配るのは今までどおり確認と配るの口から）。
 */
styleStarterDistribution.post(path + '/reset', requireRole('owner', 'admin'), async (c) => {
  const tenant = await hq(c),
    style = checkStyle(c.req.param('style')),
    b = await json(c);
  if (b.confirmed !== true) throw new StyleError('confirmation_required');
  const current = await c.env.DB.prepare(
    'SELECT id,version,auto_insert FROM style_starter_sets WHERE tenant_id=? AND style=? AND archived_at IS NULL',
  )
    .bind(tenant, style)
    .first<{ id: string; version: number; auto_insert: number }>();
  version(b.expectedVersion, current?.version ?? 0);
  // 自分の組が無い統括は、もう標準を使っている。戻す物が無い。
  if (!current) return c.json({ success: true, data: { id: null, version: 0, reset: false, previousId: null } });
  const definition = readDefinition((await musuboStarter(c.env.DB, style)).definition, style);
  const now = new Date().toISOString(),
    previousId = crypto.randomUUID();
  const [, updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO style_starter_sets(id,tenant_id,style,name,definition_json,version,archived_at,updated_at,updated_by,auto_insert)
       SELECT ?,tenant_id,style,name,definition_json,version,?,updated_at,updated_by,auto_insert FROM style_starter_sets
        WHERE id=? AND tenant_id=? AND version=? AND archived_at IS NULL`,
    ).bind(previousId, now, current.id, tenant, current.version),
    c.env.DB.prepare(
      'UPDATE style_starter_sets SET definition_json=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND tenant_id=? AND version=? AND archived_at IS NULL',
    ).bind(JSON.stringify(definition), now, c.get('staff').id, current.id, tenant, current.version),
  ]);
  // 読んだ後にほかの人が保存していたら、写しも作られていない。上書きせずに知らせる。
  if (!updated?.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({
    success: true,
    data: { id: current.id, version: current.version + 1, reset: true, previousId, autoInsert: !!current.auto_insert },
  });
});
styleStarterDistribution.post(path + '/distribute', async (c) =>
  c.json({
    success: true,
    data: await distributeStarter(
      c.env.DB,
      await hq(c),
      c.get('staff').id,
      checkStyle(c.req.param('style')),
      await json(c),
      c.env.IMAGES,
      starterCatalogRuntime(c),
    ),
  }),
);
styleStarterDistribution.post(
  base + '/starter-items/:key/accept-update',
  async (c) => {
    edit(c);
    const a = await account(c),
      b = await json(c),
      key = c.req.param('key') ?? '';
    if (b.confirmed !== true) throw new StyleError('confirmation_required');
    const binding = await c.env.DB.prepare(
      'SELECT * FROM style_starter_items WHERE line_account_id=? AND item_key=? AND pending_update IS NOT NULL ORDER BY style=(SELECT style FROM account_styles WHERE line_account_id=?) DESC LIMIT 1',
    )
      .bind(a, key, a)
      .first<{
        style: string;
        kind: string;
        target_id: string;
        pending_update: string;
      }>();
    if (!binding) throw new StyleError('not_found', 404);
    const pending = JSON.parse(binding.pending_update) as {
      setId: string;
      setVersion: number;
      item: StarterItem;
    };
    if (b.expectedSetVersion !== pending.setVersion)
      throw new StyleError('version_conflict', 409);
    const snapshot = await resourceSnapshot(
      c.env.DB,
      a,
      binding.kind,
      binding.target_id,
    );
    if (b.expectedSnapshot !== snapshot)
      throw new StyleError('version_conflict', 409);
    const p=await profile(c.env.DB,a);
    const answers=JSON.parse(p?.answers_json??'{}') as Record<string,SetupAnswer>;
    const style=checkStyle(binding.style);
    if(pending.item.initialMenu)await materializeInitialMenuAssets(c.env.DB,c.env.IMAGES,a,style,{items:[pending.item]});
    const plannedForms=new Map<string,string>();
    const variant=pending.item.initialMenu?'simple':'existing';
    const profileChanges=p&&pending.item.kind==='rich_menu'?[
      c.env.DB.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM account_styles WHERE line_account_id=? AND version=?) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`).bind(a,p.version),
      c.env.DB.prepare("UPDATE account_styles SET answers_json=json_set(answers_json,'$.image',json(?)),version=version+1 WHERE line_account_id=? AND version=?").bind(JSON.stringify({mode:'configured',value:variant,...(!pending.item.initialMenu?{resourceId:binding.target_id}:{})}),a,p.version),
    ]:[];
    await c.env.DB.batch([
      ...profileChanges,
      snapshotGuard(c.env.DB, a, binding.kind, binding.target_id, snapshot),
      c.env.DB.prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM style_starter_items WHERE line_account_id=? AND style=? AND item_key=? AND pending_update=?) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
      ).bind(a, binding.style, key, binding.pending_update),
      ...(await overwriteResource(
        c.env.DB,
        a,
        binding.target_id,
        pending.item,
        new Date().toISOString(),
        style,
        {...answers,image:{mode:'configured',value:variant}},
        plannedForms,
      )),
      c.env.DB.prepare(
        'UPDATE style_starter_items SET set_id=?,set_version=?,pending_update=NULL WHERE line_account_id=? AND style=? AND item_key=?',
      ).bind(pending.setId, pending.setVersion, a, binding.style, key),
      recordSnapshot(
        c.env.DB,
        a,
        binding.style,
        key,
        binding.kind,
        binding.target_id,
      ),
      c.env.DB.prepare(
        `INSERT INTO style_change_logs(id,line_account_id,actor_id,action,after_json,created_at) VALUES(?,?,?,'starter.accept_update',?,?)`,
      ).bind(
        crypto.randomUUID(),
        a,
        c.get('staff').id,
        JSON.stringify({
          key,
          setId: pending.setId,
          setVersion: pending.setVersion,
        }),
        new Date().toISOString(),
      ),
    ]);
    return c.json({ success: true });
  },
);
