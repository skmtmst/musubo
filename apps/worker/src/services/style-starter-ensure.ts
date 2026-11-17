import { materializeInitialMenuAssets } from './style-initial-assets.js';
import type { SetupAnswer } from '@line-crm/shared';
import { hasPendingStyleSelection, profile, type StyleProfile } from './style-profile.js';
import { StyleError } from './style-setup-core.js';
import { insertStyleStarterItems } from './style-starter-insert.js';
import { starter } from './style-starter-set.js';
import { applyCatalogStarter, type StarterCatalogRuntime } from './style-starter-catalog-apply.js';

/**
 * 今のスタイルの初期セットのうち、まだ入っていない物を決める。
 * statements に積むだけで実行しない。読む口（はじめにやること）と入れ直しの口が同じ判定を使い、
 * 「足りない数」と「入れ直しで入る数」がずれないようにする。
 */
async function planMissingStarterItems(
  db: D1Database,
  account: string,
  tenant: string | null,
  actor: string,
  p: StyleProfile,
  now: string,
) {
  const statements: D1PreparedStatement[] = [];
  const selected = p.selection_mode === 'configured' || hasPendingStyleSelection(p);
  const answers = JSON.parse(p.answers_json ?? '{}') as Record<string, SetupAnswer>;
  // 店が編集した物を上書きしないよう、ある物は必ず飛ばす（skipExisting は既定の true のまま）。
  const result = await insertStyleStarterItems(
    db, account, tenant, actor, {}, selected, p.style, answers, statements, now, { sameStyleOnly: true },
  );
  return { ...result, statements };
}

/** はじめにやることの「初期セットが入っているか」。読むだけで書かない。 */
export async function starterApplication(db: D1Database, account: string, tenant: string | null) {
  const p = await profile(db, account);
  if (!p) return null;
  const set = await starter(db, tenant, p.style);
  if (set.definition.mode === 'catalog') {
    const selections = set.definition.selections ?? [];
    const rows = (await db.prepare("SELECT template_id,template_version_id,state FROM style_starter_catalog_items WHERE line_account_id=? AND tenant_id=?")
      .bind(account, tenant).all<{template_id:string;template_version_id:string;state:string}>()).results;
    const count = selections.filter(selection => rows.some(row => row.template_id === selection.templateId && row.template_version_id === selection.versionId && row.state === 'succeeded')).length;
    return { applied: count === selections.length, count, missing: set.autoInsert && p.selection_mode==='configured' ? selections.length - count : 0 };
  }
  const keys = set.definition.items.map(item => item.key);
  const count = (await db
    .prepare('SELECT COUNT(DISTINCT item_key) AS n FROM style_starter_items WHERE line_account_id=? AND style=? AND item_key IN (SELECT value FROM json_each(?))')
    .bind(account, p.style, JSON.stringify(keys))
    .first<{ n: number }>())?.n ?? 0;
  let missing: number | null;
  try {
    const plan = await planMissingStarterItems(db,account,tenant,'getting-started',p,new Date().toISOString());
    missing = plan.inserted.length + plan.updated.length;
  } catch (error) {
    // 統括の組が入れ直しで使えない形の時も、手順の一覧そのものは返す。数えられない物を 0 と言わない。
    if (!(error instanceof StyleError)) throw error;
    missing = null;
  }
  return { applied: count > 0, count, missing };
}

/**
 * 入れ直し。足りない物だけを入れ、スタイルの版は上げない。
 * 版は条件にだけ使い、読んだ後に変わっていたら batch ごと取り消す（古いスタイルの見本を入れない）。
 * 入れる物は止めた状態のまま。送信も利用開始もしない。
 */
export async function ensureStyleStarterItems(
  db: D1Database,
  account: string,
  tenant: string | null,
  actor: string,
  input: Record<string, unknown>,
  images?: R2Bucket,
  runtime: StarterCatalogRuntime = {},
) {
  const p = await profile(db, account);
  if (!p) throw new StyleError('select_style_first', 409);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== p.version)
    throw new StyleError('version_conflict', 409);
  const selectedSet = await starter(db, tenant, p.style);
  if (selectedSet.definition.mode === 'catalog' && tenant) {
    const before=(await db.prepare("SELECT template_id,template_version_id FROM style_starter_catalog_items WHERE line_account_id=? AND tenant_id=? AND state='succeeded'").bind(account,tenant).all<{template_id:string;template_version_id:string}>()).results;
    const catalogApplication=await applyCatalogStarter(db,tenant,account,actor,p.style,runtime);
    return {inserted:catalogApplication.items.filter(row=>row.state==='succeeded'&&!before.some(old=>old.template_id===row.templateId&&old.template_version_id===row.versionId)).map(row=>({key:row.templateId,kind:row.kind})),
      updated:[],skipped:[],existing:before.length,starterSet:{id:selectedSet.id,version:selectedSet.version},catalogApplication};
  }
  const now = new Date().toISOString();
  const answers = JSON.parse(p.answers_json) as Record<string,SetupAnswer>;
  if(answers.image?.mode==='configured' && answers.image.value==='simple')
    await materializeInitialMenuAssets(db,images,account,p.style,(await starter(db,tenant,p.style,true)).definition);
  const { set, inserted, updated, skipped, existing, statements } = await planMissingStarterItems(db,account,tenant,actor,p,now);
  const keys = new Set(set.definition.items.map((item) => item.key));
  const result = {
    inserted: (inserted as Array<{ key: string; kind: string }>).map(({ key, kind }) => ({ key, kind })),
    updated,
    skipped,
    existing: existing.filter((row) => row.style === p.style && keys.has(row.item_key)).length,
    starterSet: { id: set.id, version: set.version },
  };
  if (!inserted.length && !updated.length) return result;
  try {
    await db.batch([
      db.prepare(
        `SELECT json(CASE WHEN COALESCE((SELECT version FROM account_styles WHERE line_account_id=? AND style=?),-1)=? THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
      ).bind(account, p.style, p.version),
      ...statements,
      db.prepare(
        `INSERT INTO style_change_logs(id,line_account_id,actor_id,action,after_json,created_at) VALUES(?,?,?,'starter.ensure',?,?)`,
      ).bind(
        crypto.randomUUID(),
        account,
        actor,
        JSON.stringify({ setId: set.id, setVersion: set.version, version: p.version, keys: result.inserted.map((i) => i.key) }),
        now,
      ),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON') || String(error).includes('UNIQUE constraint failed: style_starter_items.'))
      throw new StyleError('version_conflict', 409);
    throw error;
  }
  return result;
}
