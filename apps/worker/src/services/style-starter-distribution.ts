import { materializeInitialMenuAssets } from './style-initial-assets.js';
import type { PlannedInitialForms } from './style-initial-buttons.js';
import { catalogDistributionPlan, distributeCatalog } from './style-starter-catalog-distribution.js';
import type { StarterCatalogRuntime } from './style-starter-catalog-apply.js';
import { sameStarterSnapshot } from './style-starter-snapshot.js';
import type { AccountStyle, SetupAnswer } from '@line-crm/shared';
import { checkStyle, StyleError, profile, starter } from './style-setup.js';
import { insertStyleStarterItems } from './style-starter-insert.js';
import {
  resourceSnapshot,
  snapshotGuard,
  recordSnapshot,
  overwriteResource,
} from './style-starter-resource.js';

type Binding = {
  line_account_id: string;
  style: AccountStyle;
  item_key: string;
  kind: string;
  target_id: string;
  is_sample: number;
  source_snapshot: string | null;
  pending_update: string | null;
  set_version: number;
};
async function legacyStarterDistributionPlan(
  db: D1Database,
  tenant: string,
  style: AccountStyle,
  input: Record<string, unknown>,
) {
  const set = await starter(db, tenant, style);
  if (set.id.startsWith('musubo:'))
    throw new StyleError('starter_set_not_found', 404);
  if (input.expectedVersion !== set.version)
    throw new StyleError('version_conflict', 409);
  const target = input.target as
    | { style?: unknown; accountIds?: unknown }
    | undefined;
  if (
    !target ||
    (target.style === undefined) === (target.accountIds === undefined)
  )
    throw new StyleError('invalid_targets');
  let ids: string[];
  if (target.style !== undefined) {
    const selected = checkStyle(target.style);
    ids = (
      await db
        .prepare(
          `SELECT a.id FROM line_accounts a JOIN account_styles s ON s.line_account_id=a.id WHERE a.tenant_id=? AND a.archived_at IS NULL AND a.is_active=1 AND s.style=? ORDER BY a.id`,
        )
        .bind(tenant, selected)
        .all<{ id: string }>()
    ).results.map((a) => a.id);
  } else {
    if (
      !Array.isArray(target.accountIds) ||
      !target.accountIds.length ||
      target.accountIds.length > 100 ||
      target.accountIds.some((x) => typeof x !== 'string') ||
      new Set(target.accountIds).size !== target.accountIds.length
    )
      throw new StyleError('invalid_targets');
    ids = [...target.accountIds].sort();
    for (const id of ids)
      if (
        !(await db
          .prepare(
            `SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND archived_at IS NULL AND is_active=1`,
          )
          .bind(id, tenant)
          .first())
      )
        throw new StyleError('not_found', 404);
  }
  if (ids.length > 100) throw new StyleError('too_many_accounts', 422);
  const accounts = [];
  for (const accountId of ids) {
    const p = await profile(db, accountId);
    const bindings = (
      await db
        .prepare(
          'SELECT * FROM style_starter_items WHERE line_account_id=? ORDER BY applied_at,style,item_key',
        )
        .bind(accountId)
        .all<Binding>()
    ).results;
    const items = [];
    for (const item of set.definition.items) {
      const binding = bindings.find((b) => b.item_key === item.key && b.style === style) ?? bindings.find((b) => b.item_key === item.key);
      const snapshot = binding
        ? await resourceSnapshot(db, accountId, binding.kind, binding.target_id)
        : null;
      const edited =
        !!binding &&
        ((item.kind==='rich_menu' && !item.initialMenu && JSON.parse(p?.answers_json??'{}').image?.value==='simple') || !binding.is_sample ||
          binding.source_snapshot === null ||
          !sameStarterSnapshot(binding.kind, snapshot, binding.source_snapshot));
      items.push({
        key: item.key,
        name: item.name,
        kind: item.kind,
        edited,
        action: !binding ? 'create' : edited ? 'notify' : 'overwrite',
        binding: binding ?? null,
        snapshot,
      });
    }
    accounts.push({
      accountId,
      profileVersion: p?.version ?? 0,
      items,
      editedCount: items.filter((i) => i.edited).length,
    });
  }
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ set, accounts })),
  );
  return {
    set,
    accounts,
    token: Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    accountCount: accounts.length,
    editedCount: accounts.reduce((n, a) => n + a.editedCount, 0),
  };
}
export async function starterDistributionPlan(db:D1Database,tenant:string,style:AccountStyle,input:Record<string,unknown>) {
  const plan=await legacyStarterDistributionPlan(db,tenant,style,input);
  return plan.set.definition.mode==='catalog' ? catalogDistributionPlan(db,tenant,style,plan.accounts) : plan;
}
export async function distributeStarter(
  db: D1Database,
  tenant: string,
  actor: string,
  style: AccountStyle,
  input: Record<string, unknown>,
  images?: R2Bucket,
  runtime: StarterCatalogRuntime = {},
) {
  const plan = await legacyStarterDistributionPlan(db, tenant, style, input);
  if (plan.set.definition.mode === 'catalog') return distributeCatalog(db,tenant,actor,style,input,await catalogDistributionPlan(db,tenant,style,plan.accounts),runtime);
  if (input.confirmed !== true || input.token !== plan.token)
    throw new StyleError('distribution_confirmation_required', 409);
  if (
    input.editedAction !== undefined &&
    !['notify', 'new_copy'].includes(String(input.editedAction))
  )
    throw new StyleError('invalid_edited_action');
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM style_starter_sets WHERE id=? AND tenant_id=? AND version=? AND archived_at IS NULL) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
      )
      .bind(plan.set.id, tenant, plan.set.version),
  ];
  const now = new Date().toISOString(),
    results = [];
  for (const a of plan.accounts) {
    statements.push(db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND archived_at IS NULL AND is_active=1) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`).bind(a.accountId,tenant));
    const p = await profile(db, a.accountId);
    const answers=JSON.parse(p?.answers_json??'{}') as Record<string,SetupAnswer>;
    const canonical=plan.set.definition.items.some(item=>item.initialMenu===style);
    const operationAnswers=canonical?{...answers,image:{mode:'configured' as const,value:'simple'}}:answers;
    const plannedForms:PlannedInitialForms=new Map(a.items.filter(row=>row.kind==='form'&&row.binding).map(row=>[row.key,row.binding!.target_id]));
    if(canonical){await materializeInitialMenuAssets(db,images,a.accountId,style,plan.set.definition);}
    let menuApplied=false,menuTarget:string|undefined;

    statements.push(
      db
        .prepare(
          `SELECT json(CASE WHEN COALESCE((SELECT version FROM account_styles WHERE line_account_id=?),0)=? THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
        )
        .bind(a.accountId, a.profileVersion),
    );
    for (const row of [...a.items.filter(row=>row.kind==='form'),...a.items.filter(row=>row.kind!=='form')]) {
      const item = plan.set.definition.items.find((i) => i.key === row.key)!;
      const b = row.binding;
      if (b)
        statements.push(
          snapshotGuard(db, a.accountId, b.kind, b.target_id, row.snapshot),
        );
      if (b && row.edited && input.editedAction !== 'new_copy') {
        statements.push(
          db
            .prepare(
              'UPDATE style_starter_items SET pending_update=? WHERE line_account_id=? AND style=? AND item_key=?',
            )
            .bind(
              JSON.stringify({
                setId: plan.set.id,
                setVersion: plan.set.version,
                item,
              }),
              a.accountId,
              b.style,
              b.item_key,
            ),
        );
        results.push({
          accountId: a.accountId,
          key: item.key,
          action: 'pending',
          message: '本部の新しい版があります',
        });
        continue;
      }
      if (b && !row.edited && b.kind === item.kind) {
        statements.push(
          ...(await overwriteResource(
            db,
            a.accountId,
            b.target_id,
            item,
            now,
            style,
            operationAnswers,
            plannedForms,
          )),
        );
        statements.push(
          db
            .prepare(
              'UPDATE style_starter_items SET set_id=?,set_version=?,pending_update=NULL,applied_at=? WHERE line_account_id=? AND style=? AND item_key=?',
            )
            .bind(
              plan.set.id,
              plan.set.version,
              now,
              a.accountId,
              b.style,
              b.item_key,
            ),
        );
        statements.push(
          recordSnapshot(
            db,
            a.accountId,
            b.style,
            b.item_key,
            b.kind,
            b.target_id,
          ),
        );
        if(item.kind==='rich_menu'){menuApplied=true;menuTarget=b.target_id;}
        results.push({
          accountId: a.accountId,
          key: item.key,
          action: 'overwritten',
        });
        continue;
      }
      if (b)
        statements.push(
          db
            .prepare(
              "UPDATE style_starter_items SET item_key=item_key||':previous:'||target_id,pending_update=NULL WHERE line_account_id=? AND style=? AND item_key=?",
            )
            .bind(a.accountId, b.style, item.key),
        );
      const { inserted } = await insertStyleStarterItems(
        db,
        a.accountId,
        tenant,
        actor,
        { choices: { [item.key]: { mode: 'sample' } } },
        true,
        style,
        operationAnswers,
        statements,
        now,
        {
          set: { ...plan.set, definition: { items: [item] } },
          skipExisting: false,
          plannedForms,
        },
      );
      if(inserted.length&&item.kind==='rich_menu'){menuApplied=true;menuTarget=(inserted[0] as {id:string}).id;}
      results.push({
        accountId: a.accountId,
        key: item.key,
        action: inserted.length ? 'created' : 'unconfigured',
      });
    }
    // 先頭の版照合と同じbatch内。カード更新による版の増加も含めて保存する。
    if(menuApplied&&p) {
      const value=canonical?'simple':'existing';
      statements.push(db.prepare("UPDATE account_styles SET answers_json=json_set(answers_json,'$.image',json(?)),version=version+1,updated_at=? WHERE line_account_id=?").bind(JSON.stringify({mode:'configured',value,...(!canonical&&menuTarget?{resourceId:menuTarget}:{})}),now,a.accountId));
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO style_change_logs(id,line_account_id,actor_id,action,after_json,created_at) VALUES(?,?,?,'starter.distribute',?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          a.accountId,
          actor,
          JSON.stringify({ setId: plan.set.id, version: plan.set.version }),
          now,
        ),
    );
  }
  await db.batch(statements);
  return { accountCount: plan.accountCount, items: results };
}
