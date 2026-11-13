import manifest from './data-retention-tables.json';

/**
 * 退会後の顧客データ削除（★36-2）で、bootstrap.sql の表を1つずつ分類した表。
 *
 * 分類は3つだけにする。
 *   purge  … その統括の顧客データ。保存期限が切れたら消す。
 *   retain … 監査・支払・審査の記録。統括に紐づいていても消さない。
 *   global … 統括に紐づかない基盤・マスタ・運営の表。そもそも消す対象にならない。
 *
 * 新しい表を足したのに分類を書き忘れると、顧客データが消えずに残る。
 * それを見落とさないため data-retention-tables.test.ts が bootstrap.sql と
 * この表を突き合わせ、分類漏れがあればテストを落とす。
 */
export type RetentionCategory = 'purge' | 'retain' | 'global';

/**
 * その表の行が、どの統括のものかを決める道すじ。
 *
 * tenant      … 列に統括IDがそのまま入っている。
 * lineAccount … 列にLINEアカウントIDが入っている。アカウントは統括に属する。
 * parent      … 親表の行に属する。親をたどると最後は tenant か lineAccount に着く。
 * publicIngress … 受信の種類ごとに成果地点または計測サイトから統括をたどる。
 */
export type RetentionScope =
  | { by: 'publicIngress'; column: string }
  | { by: 'workflow'; column: string }
  | { by: 'tenant'; column: string }
  | { by: 'lineAccount'; column: string }
  | { by: 'parent'; column: string; parent: string; parentColumn: string };

export interface RetentionTable {
  category: RetentionCategory;
  /** global の表には紐づけがないので入らない。 */
  scope?: RetentionScope;
}

export const RETENTION_TABLES: Record<string, RetentionTable> = manifest as Record<
  string,
  RetentionTable
>;

/** 分類表に載っている表の名前。 */
export function retentionTableNames(): string[] {
  return Object.keys(RETENTION_TABLES);
}

/**
 * 削除対象の表を「子が先、親が後」の順に並べる。
 *
 * 親を先に消すと、子の行が親をたどれなくなって消し残る。
 * たどる先を数えて、深い表から順に返す。
 *
 * parent の親だけでなく、lineAccount で紐づく表も line_accounts より
 * 先に消す。line_accounts 自身も削除対象なので、先に消してしまうと
 * 「そのアカウントの行」を選ぶ条件が何も選べなくなって消し残る。
 */
export function purgeTablesChildFirst(): string[] {
  const depth = new Map<string, number>();
  /** その表の行を選ぶために、まだ残っていないといけない表。 */
  const dependsOn = (name: string): string[] => {
    // 第2弾の参照を残したまま親の組・申込を先に消さない。
    if (name === 'bookings') return ['booking_series','booking_groups'];
    if (name === 'hq_store_comparison_export_jobs') return ['staff_members'];
    if (name === 'line_account_hq_admin_memberships') return ['line_accounts', 'staff_members'];
    if (name === 'member_rank_notices') return ['member_rank_tiers','friends'];
    if (name === 'ec_auto_line_attribution_events') return ['ec_auto_line_sends','friends'];
    if (name === 'booking_entitlement_notices') return ['booking_pass_plans','booking_entitlements','friends'];
    if (name === 'booking_pass_purchases') return ['booking_pass_plans','booking_entitlements','friends'];
    if (name === 'broadcast_execution_contexts') return ['broadcasts','mcp_connections'];
    if (name === 'member_ranks') return ['member_rank_tiers'];
    if (name === 'hq_store_response_samples') return ['chats'];
    if (name === 'ec_auto_line_sends') return ['ec_behavior_events'];
    if (name === 'booking_makeup_credits') return ['event_bookings'];
    // Files also reference answers and friends; remove them before either parent.
    if (name === 'form_submission_files') return ['form_submissions'];
    if (name === 'scenario_source_jobs') return ['scenario_versions'];
    if (name === 'hq_form_test_tokens') return ['hq_template_versions'];
    if (name === 'hq_broadcast_saved_views' || name === 'hq_template_saved_views') return ['staff_members'];
    const scope = RETENTION_TABLES[name]?.scope;
    if (!scope) return [];
    if (scope.by === 'publicIngress') return ['conversion_points', 'measurement_sites'];
    if (scope.by === 'parent') return [scope.parent];
    if (scope.by === 'workflow' || (scope.by === 'lineAccount' && name !== 'line_accounts')) return ['line_accounts'];
    return [];
  };
  const measure = (name: string, seen: Set<string>): number => {
    const cached = depth.get(name);
    if (cached !== undefined) return cached;
    // 親子の輪があっても止まるようにする。実際の schema には無いが、将来の追加で壊さない。
    if (seen.has(name)) return 0;
    const parents = dependsOn(name);
    if (!parents.length) {
      depth.set(name, 0);
      return 0;
    }
    seen.add(name);
    const value = Math.max(...parents.map(parent => measure(parent, new Set(seen)))) + 1;
    seen.delete(name);
    depth.set(name, value);
    return value;
  };
  return Object.keys(RETENTION_TABLES)
    .filter((name) => RETENTION_TABLES[name].category === 'purge')
    .map((name) => ({ name, depth: measure(name, new Set()) }))
    .sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}

/**
 * 1つの表から、指定した統括の行だけを選ぶ WHERE 句を作る。
 * 値の埋め込みはせず、統括IDを入れる `?` を1つだけ返す。
 */
export function tenantScopeCondition(table: string): string {
  const entry = RETENTION_TABLES[table];
  if (!entry?.scope) throw new Error(`統括に紐づかない表です: ${table}`);
  return buildCondition(table, entry.scope, new Set([table]));
}

function buildCondition(table: string, scope: RetentionScope, seen: Set<string>): string {
  if (scope.by === 'publicIngress') return `(${table}.kind, ${table}.${scope.column}) IN (
    WITH target(tenant_id) AS (SELECT ?)
    SELECT 'conversion_nonce', id FROM conversion_points WHERE tenant_id=(SELECT tenant_id FROM target)
    UNION ALL SELECT 'site_event', id FROM measurement_sites WHERE line_account_id IN
      (SELECT id FROM line_accounts WHERE tenant_id=(SELECT tenant_id FROM target)))`;
  if (scope.by === 'workflow' && table !== 'workflow_steps') throw new Error(`共有工程の削除条件は未定義です: ${table}`);
  if (scope.by === 'workflow') return `${table}.rowid IN (
    WITH target(id) AS (SELECT ?)
    SELECT w.rowid FROM workflow_steps w WHERE w.scope_id IN (
      SELECT 'tenant:' || id FROM target UNION ALL SELECT 'line:' || id FROM line_accounts WHERE tenant_id=(SELECT id FROM target))
    UNION ALL
    SELECT w.rowid FROM workflow_steps w
    WHERE w.scope_id>='stripe-test:' AND w.scope_id<'stripe-test;' AND w.process_kind IN ('booking_stripe_webhook','booking_stripe_object')
      AND (COALESCE(json_extract(w.input_json,'$.retentionTenantId'),json_extract(w.input_json,'$.tenantId'))=(SELECT id FROM target)
       OR COALESCE(json_extract(w.input_json,'$.retentionAccountId'),json_extract(w.input_json,'$.accountId')) IN
         (SELECT id FROM line_accounts WHERE tenant_id=(SELECT id FROM target))))`;
  if (scope.by === 'tenant') return `${table}.${scope.column} = ?`;
  if (scope.by === 'lineAccount') {
    return `${table}.${scope.column} IN (SELECT id FROM line_accounts WHERE tenant_id = ?)`;
  }
  const parent = RETENTION_TABLES[scope.parent];
  if (!parent?.scope) throw new Error(`親が統括に紐づきません: ${table} -> ${scope.parent}`);
  if (seen.has(scope.parent)) throw new Error(`親子の輪があります: ${table} -> ${scope.parent}`);
  seen.add(scope.parent);
  const inner = buildCondition(scope.parent, parent.scope, seen);
  return `${table}.${scope.column} IN (SELECT ${scope.parent}.${scope.parentColumn} FROM ${scope.parent} WHERE ${inner})`;
}

/**
 * 画像の実体（R2）の鍵を持つ列。行を消す前にここを読んで R2 側も消す。
 * 列を増やしたときは data-retention-tables.test.ts が bootstrap.sql と突き合わせる。
 */
export const RETENTION_R2_KEY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'affiliate_payout_batches', column: 'export_object_key' },
  { table: 'affiliate_statements', column: 'pdf_object_key' },
  { table: 'visit_stamp_paper_photos', column: 'object_key' },
  { table: 'hq_template_owned_r2_keys', column: 'object_key' },
  { table: 'media', column: 'r2_key' },
  { table: 'form_submission_files', column: 'r2_key' },
  { table: 'imagemap_images', column: 'r2_key' },
  { table: 'broadcast_media_upload_sessions', column: 'r2_key' },
  { table: 'broadcast_media_upload_sessions', column: 'public_key' },
  { table: 'media_upload_sessions', column: 'r2_key' },
  { table: 'media_versions', column: 'r2_key' },
  { table: 'nen_pet_profiles', column: 'image_r2_key' },
  { table: 'nen_photo_derivatives', column: 'r2_key' },
  { table: 'nen_photo_submissions', column: 'r2_key' },
  { table: 'nen_photo_submissions', column: 'review_r2_key' },
  { table: 'nen_photo_submissions', column: 'public_r2_key' },
  { table: 'rich_menu_pages', column: 'image_r2_key' },
  { table: 'rt_inbound_emails', column: 'r2_key' },
];
