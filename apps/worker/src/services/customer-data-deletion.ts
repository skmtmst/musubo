import { auditEventStatement, encryptCredential, RETENTION_R2_KEY_COLUMNS } from '@line-crm/db';
import { planExternalCleanup } from '../features/booking/booking-external-cleanup-plan/index.js';
import { cleanupIndex, cleanupRecipientProof } from '../features/booking/booking-external-cleanup-proof/index.js';
import relations from './customer-data-relations.json';
import protectedRelations from './customer-data-protected-relations.json';

export type DeletionKind = 'form_response' | 'friend_data';
export type DeletionTarget = {
  kind: DeletionKind; id: string; accountId: string | null; friendId: string | null;
  formId?: string; lineUserId?: string;
};
type Journal = { id: string; action: string; detail_json: string; actor_id: string };
type Detail = { accountId: string | null; formId?: string; token: string; leaseUntil: number; completedAt?: string; rows?: number };
type Relation = { friendColumns: string[]; lineUserColumn: boolean; references: Array<{ parent: string; columns: Array<{ column: string; parentColumn: string }> }> };
const graph: Record<string, Relation> = relations;
type ProtectedReference = {parent:string;mode?:'restrict';columns:Array<{column:string;parentColumn:string}>};
const protectedGraph = protectedRelations as Record<string,ProtectedReference[]>;
export const deletionJournalId = (kind: DeletionKind, id: string) => `customer-delete:${kind}:${id}`;
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
export class DeletionFailure extends Error {
  constructor(public status: 409 | 503, public code: string) { super(code); }
}
export async function deletionJournal(db: D1Database, kind: DeletionKind, id: string): Promise<(Journal & { detail: Detail }) | null> {
  const row = await db.prepare('SELECT id, action, detail_json, actor_id FROM operation_audit WHERE id = ?')
    .bind(deletionJournalId(kind, id)).first<Journal>();
  return row ? { ...row, detail: JSON.parse(row.detail_json) as Detail } : null;
}
/** R2 失敗・DB の巻戻し・HTTP 応答喪失でも、削除の意図を永続的に保持する。 */
export async function customerDeletionPending(db: D1Database, friendId: string | null, submissionId?: string | null): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 FROM operation_audit WHERE target_kind = 'customer_deletion'
    AND action <> 'deleted' AND ((target_id = ? AND id = ?) OR (friend_id = ? AND id = ?)) LIMIT 1`)
    .bind(submissionId ?? '', deletionJournalId('form_response', submissionId ?? ''), friendId ?? '', deletionJournalId('friend_data', friendId ?? '')).first();
}

/** 値はバインドし、SQL の識別子は確認済みスキーマの関係一覧だけから取る。 */
export function friendDeletionCondition(table: string, seen = new Set<string>()): string {
  if (table === 'friends') return '"friends".id = ?1';
  if (seen.has(table) || !graph[table]) return '0';
  const next = new Set(seen).add(table);
  const rel = graph[table];
  const conditions = rel.friendColumns.map(col => `${q(table)}.${q(col)} = ?1`);
  if (rel.lineUserColumn) conditions.push(`(${q(table)}.line_user_id = ?2 AND ${q(table)}.line_account_id IS ?3)`);
  for (const ref of rel.references) {
    // 顧客自身の成果・帰属は紹介者のデータと区別し、参照だけを最後の原子的 batch で外す。
    if (ref.parent === 'affiliates' && ['conversion_events', 'affiliate_attribution_decisions'].includes(table)) continue;
    const inner = friendDeletionCondition(ref.parent, next);
    if (inner !== '0') conditions.push(`EXISTS (SELECT 1 FROM ${q(ref.parent)} WHERE ${inner} AND ${ref.columns.map(col => `${q(ref.parent)}.${q(col.parentColumn)} = ${q(table)}.${q(col.column)}`).join(' AND ')})`);
  }
  return conditions.length ? `(${conditions.join(' OR ')})` : '0';
}
const responseConditions: Record<string, string> = {
  form_submissions: 'id = ?1',
  form_submission_files: 'submission_id = ?1',
  media_file_scans: 'id IN (SELECT scan_id FROM form_submission_files WHERE submission_id = ?1)',
  form_submit_claims: 'submission_id = ?1',
  form_submit_outbox: `EXISTS (SELECT 1 FROM form_submit_claims c WHERE c.submission_id = ?1
    AND c.tenant_id = form_submit_outbox.tenant_id AND c.line_account_id = form_submit_outbox.line_account_id
    AND c.form_id = form_submit_outbox.form_id AND c.friend_id = form_submit_outbox.friend_id
    AND c.idempotency_key = form_submit_outbox.idempotency_key)`,
  form_capacity_claims: 'submission_id = ?1',
};
function conditionsFor(target: DeletionTarget): Record<string, string> {
  if (target.kind === 'form_response') return responseConditions;
  const result = Object.fromEntries(Object.keys(graph).map(table => [table, friendDeletionCondition(table)]));
  result.event_booking_transition_runs = `line_account_id IS ?3 AND (json_extract(input_snapshot,'$.friendId')=?1 OR json_extract(input_snapshot,'$.recipient')=?2)`;
  result.style_analytics_results = `line_account_id IS ?3 AND EXISTS(SELECT 1 FROM json_each(style_analytics_results.selection_json,'$.ids') p WHERE json_extract(p.value,'$.friendId')=?1)`;
  result.media_file_scans = 'id IN (SELECT scan_id FROM form_submission_files WHERE friend_id = ?1)';
  result.workflow_steps = `scope_id = 'line:' || ?3 AND process_kind IN ('booking_outlook_sync','booking_meeting_retry','booking_calendar_create','booking_calendar_delete')
    AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = workflow_steps.subject_id AND b.line_account_id = ?3 AND b.friend_id = ?1)`;
  return result;
}
function childFirst(tables: string[]): string[] {
  const result: string[] = [], visited = new Set<string>();
  const visit = (table: string) => {
    if (visited.has(table)) return;
    visited.add(table);
    for (const child of tables) if (graph[child]?.references.some(ref => ref.parent === table)) visit(child);
    // 外部キーでない親子関係も、子を消すまで親を保持する。
    if (table === 'form_submissions') for (const child of ['form_submission_files', 'form_submit_outbox', 'form_submit_claims', 'form_capacity_claims', 'media_file_scans']) if (tables.includes(child)) visit(child);
    if (table === 'form_submission_files' && tables.includes('media_file_scans')) visit('media_file_scans');
    if (table === 'form_submit_claims' && tables.includes('form_submit_outbox')) visit('form_submit_outbox');
    if (table === 'bookings' && tables.includes('workflow_steps')) visit('workflow_steps');
    result.push(table);
  };
  for (const table of tables) visit(table);
  return result;
}
type Snapshot = { table: string; condition: string; rows: Array<Record<string, unknown> & { _delete_rowid: number }>; keys: string[] };

export async function deleteCustomerData(env: { DB: D1Database; IMAGES?: Pick<R2Bucket, 'delete'>; LINE_CREDENTIAL_ENCRYPTION_KEY?: string; DEPLOY_ENV?:string; BOOKING_MEETING_REAL_ENABLED?:string }, target: DeletionTarget, actorId: string): Promise<{ deleted: true; replayed: boolean }> {
  const db = env.DB, id = deletionJournalId(target.kind, target.id);
  const prior = await deletionJournal(db, target.kind, target.id);
  if (prior?.action === 'deleted') return { deleted: true, replayed: true };
  const conditions = conditionsFor(target);
  const params = target.kind === 'friend_data' ? [target.id, target.lineUserId ?? '', target.accountId] : [target.id];
  // 未適用・途中の移行では削除意図や R2 を変更する前に止める。SQL 識別子は承認済みの保持参照だけを使う。
  if (target.kind === 'friend_data') {
    for (const [table, refs] of Object.entries(protectedGraph)) {
      const columns = (await db.prepare(`PRAGMA table_info(${q(table)})`).all<{ name: string; notnull: number }>()).results;
      const foreignKeys = (await db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all<{ from: string; table: string; on_delete: string }>()).results;
      for (const ref of refs) for (const col of ref.columns) {
        // 月謝の固定契約は切り離さず、該当本人の削除だけを下の保持検査で止める。
        if(ref.mode==='restrict') {
          if(!foreignKeys.some(f=>f.from===col.column && f.table===ref.parent && f.on_delete==='RESTRICT')) throw new DeletionFailure(409,'deletion_schema_approval_required');
          continue;
        }
        if (!columns.some(c => c.name === `${col.column}_history`)
          || !columns.some(c => c.name === col.column && c.notnull === 0)
          || !foreignKeys.some(f => f.from === col.column && f.table === ref.parent && f.on_delete === 'SET NULL')) {
          throw new DeletionFailure(409, 'deletion_schema_approval_required');
        }
      }
    }
  }
  const protectedChecks = Object.entries(protectedGraph).flatMap(([table, refs]) => refs.flatMap(ref => {
    if (target.kind === 'friend_data' && ref.mode !== 'restrict') return [];
    const condition = target.kind === 'friend_data' ? friendDeletionCondition(ref.parent) : conditions[ref.parent];
    if (!condition) return [];
    return [{ table, condition: `EXISTS (SELECT 1 FROM ${q(ref.parent)} WHERE ${condition} AND ${ref.columns.map(col => `${q(ref.parent)}.${q(col.parentColumn)} = ${q(table)}.${q(col.column)}`).join(' AND ')})` }];
  }));
  // 他の顧客の成果から参照される参加者を消す場合も、関係をたどって別顧客の記録まで消さない。
  if (target.kind === 'friend_data') {
    for (const [table, relation] of Object.entries(graph)) {
      if (relation.friendColumns.includes('friend_id')) protectedChecks.push({ table,
        condition: `(${conditions[table]}) AND ${q(table)}.friend_id IS NOT NULL AND ${q(table)}.friend_id <> ?1` });
    }
  }
  const preserved = protectedChecks.length ? await db.batch(protectedChecks.map(check => db.prepare(`SELECT 1 AS present FROM ${q(check.table)} WHERE ${check.condition} LIMIT 1`).bind(...(check.condition.includes('?3') ? params : [params[0]])))) : [];
  if (preserved.some(result => result.results.length)) throw new DeletionFailure(409, 'deletion_schema_approval_required');
  const token = crypto.randomUUID();
  const detail: Detail = { accountId: target.accountId, ...(target.formId ? { formId: target.formId } : {}), token, leaseUntil: Date.now() + 300_000 };
  // 同じ友だちに対する別の対象指定や二重押下を直列化する。
  await db.prepare(`INSERT OR IGNORE INTO operation_audit (id,target_kind,target_id,action,actor_id,friend_id,detail_json,created_at)
    SELECT ?, 'customer_deletion', ?, 'deleting', ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM operation_audit WHERE target_kind = 'customer_deletion' AND action = 'deleting'
      AND friend_id = ? AND json_extract(detail_json,'$.leaseUntil') > ?)`)
    .bind(id, target.id, actorId, target.friendId, JSON.stringify(detail), new Date().toISOString(), target.friendId, Date.now()).run();
  const owned = await db.prepare(`UPDATE operation_audit SET action = 'deleting', actor_id = ?, detail_json = ?
    WHERE id = ? AND action <> 'deleted'
      AND (json_extract(detail_json,'$.token') = ? OR action = 'retryable' OR json_extract(detail_json,'$.leaseUntil') <= ?)
      AND NOT EXISTS (SELECT 1 FROM operation_audit other WHERE other.id <> ? AND other.target_kind = 'customer_deletion'
        AND other.friend_id = ? AND other.action = 'deleting' AND json_extract(other.detail_json,'$.leaseUntil') > ?)`)
    .bind(actorId, JSON.stringify(detail), id, token, Date.now(), id, target.friendId, Date.now()).run();
  if (owned.meta.changes !== 1) {
    if ((await deletionJournal(db, target.kind, target.id))?.action === 'deleted') return { deleted: true, replayed: true };
    throw new DeletionFailure(409, 'deletion_in_progress');
  }
  try {
    const snapshots: Snapshot[] = [];
    // DB 往復数が増え過ぎないよう、読取をまとめる。
    const entries = Object.entries(conditions);
    const results = await db.batch(entries.map(([table, condition]) => db.prepare(`SELECT rowid AS _delete_rowid, * FROM ${q(table)} WHERE ${condition}`).bind(...(condition.includes('?3') ? params : [params[0]]))));
    for (let i = 0; i < entries.length; i++) {
      const [table, condition] = entries[i];
      const rows = results[i].results as Snapshot['rows'];
      const columns = RETENTION_R2_KEY_COLUMNS.filter(entry => entry.table === table).map(entry => entry.column);
      snapshots.push({ table, condition, rows, keys: rows.flatMap(row => columns.flatMap(col => typeof row[col] === 'string' && row[col] ? [row[col] as string] : [])) });
    }
    const byTable = new Map(snapshots.map(snapshot => [snapshot.table, snapshot]));
    const cleanup: Array<{id:string;payload:string;index:string;retainUntil:number}> = [];
    let testRecipients:string|null=null;
    let testRecipientProof:string|undefined;
    if (target.kind === 'friend_data') {
      const links=byTable.get('booking_meeting_links')?.rows ?? [], steps=byTable.get('workflow_steps')?.rows ?? [];
      // 外部呼出中の処理が完了していない場合、先に結果を確定してから削除する。
      const now=Date.now();
      if (steps.some(row=>row.status==='running' && Number(row.lease_expires_at)>now && ['booking_calendar_create','booking_calendar_delete','booking_outlook_sync'].includes(String(row.process_kind))) ||
          links.some(row=>((row.status==='pending' && Number(row.attempt_count)>0 && !row.last_error_code) || (row.status==='cancel_pending' && row.last_error_code==='delete_started')) && (!Number.isFinite(Date.parse(String(row.updated_at))) || Date.parse(String(row.updated_at))>now-120000))) throw new DeletionFailure(503,'deletion_retry_required');
      if(target.accountId && env.DEPLOY_ENV==='staging' && env.BOOKING_MEETING_REAL_ENABLED==='true' && env.LINE_CREDENTIAL_ENCRYPTION_KEY) {
        const setting=await db.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'").bind(target.accountId).first<{value:string}>();
        testRecipients=setting?.value??null;
        let eligible=false;try{const ids:unknown=JSON.parse(testRecipients??'null');eligible=Array.isArray(ids)&&ids.includes(target.id);}catch{/* 対象外 */}
        if(eligible&&testRecipients!==null){
          testRecipientProof=await cleanupRecipientProof(env.LINE_CREDENTIAL_ENCRYPTION_KEY,target.accountId,testRecipients);
        }
      }
      for (const booking of byTable.get('bookings')?.rows ?? []) {
        const id=String(booking.id);
        const planned=planExternalCleanup({booking,meetings:links.filter(row=>row.booking_id===id),workflows:steps.filter(row=>row.subject_id===id),now:Date.now()});
        if(planned.length&&!target.accountId)throw new DeletionFailure(503,'deletion_retry_required');
        // 後片づけに必要な外部参照を平文保存しない。鍵が無いときは削除を延期する。
        if(planned.length&&!env.LINE_CREDENTIAL_ENCRYPTION_KEY)throw new DeletionFailure(503,'deletion_cleanup_key_missing');
        for(const item of planned) {
          const scoped=item.provider==='google_calendar'?item:testRecipientProof?{...item,testRecipientProof}:{...item,action:'review' as const};
          const index=await cleanupIndex(env.LINE_CREDENTIAL_ENCRYPTION_KEY!,target.accountId!,item.provider,item.staffId);
          const created=Date.now(),start=Date.parse(item.startsAt??''),minimum=created+(Number.isFinite(start)?90:730)*86400000;
          // 将来の予定は日時を過ぎるまで、空き枠から除くための参照が要る。期限は週単位に丸める。
          const retainUntil=Math.ceil(Math.max(minimum,Number.isFinite(start)?start+86400000:minimum)/(7*86400000))*(7*86400000);
          cleanup.push({id:crypto.randomUUID(),index:index.index,retainUntil,payload:JSON.stringify(await encryptCredential(JSON.stringify(scoped),env.LINE_CREDENTIAL_ENCRYPTION_KEY))});
        }
      }
    }
    const keys = [...new Set(snapshots.flatMap(snapshot => snapshot.keys))];
    if (keys.length && !env.IMAGES) throw new DeletionFailure(503, 'deletion_retry_required');
    // R2 の削除は冪等なので、全削除が成功するまで DB のキーを残して再試行可能にする。
    for (let offset = 0; offset < keys.length; offset += 100) await env.IMAGES!.delete(keys.slice(offset, offset + 100));
    const guard = (condition: string, values: unknown[]) => {
      let cursor = 0;
      const bindings: unknown[] = [];
      const normalized = condition.replace(/\?(\d+)?/g, (_, n: string | undefined) => {
        bindings.push(values[n ? Number(n) - 1 : cursor++]); return '?';
      });
      return db.prepare(`UPDATE operation_audit SET target_kind = CASE WHEN (${normalized}) THEN 'customer_deletion' ELSE NULL END WHERE id = ?`).bind(...bindings, id);
    };
    const statements = [db.prepare('PRAGMA defer_foreign_keys = ON'), guard("action = 'deleting' AND json_extract(detail_json, '$.token') = ?", [token])];
    if(testRecipientProof) statements.push(guard("(SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients') IS ?",[target.accountId,testRecipients]));
    // R2 待機中に追加された保持対象を、連動削除で失わないようにする。
    for (const check of protectedChecks) statements.push(guard(`NOT EXISTS (SELECT 1 FROM ${q(check.table)} WHERE ${check.condition})`, check.condition.includes('?3') ? params : [params[0]]));
    // R2 待機中に増えたファイルや子行も、再試行で到達できる形を保つ。
    for (const snapshot of snapshots) {
      const rowids = JSON.stringify(snapshot.rows.map(row => row._delete_rowid));
      const bound = snapshot.condition.includes('?3') ? params : [params[0]];
      const condition = snapshot.condition.replace(/\?([123])/g, (_, n: string) => `?${Number(n)}`);
      const slot = bound.length + 1;
      statements.push(guard(`(SELECT COUNT(*) FROM ${q(snapshot.table)} WHERE ${condition}) = json_array_length(?${slot})
        AND NOT EXISTS (SELECT 1 FROM ${q(snapshot.table)} WHERE ${condition} AND rowid NOT IN (SELECT value FROM json_each(?${slot})))`, [...bound, rowids]));
      // キー交換に加え回答・友だちの付替も検出する。照合のスナップショット値は一時バインドだけとし、台帳へ保存しない。
      const first = snapshot.rows[0];
      const guardedFields:Record<string,string[]>={bookings:['lock_version','status','starts_at','external_event_id','external_calendar_id','staff_id'],booking_meeting_links:['status','last_error_code','attempt_count','idempotency_key','external_meeting_id','staff_id','starts_at'],workflow_steps:['status','input_json','result_json','lease_expires_at','updated_at']};
      const candidates = ['id', 'line_user_id', 'line_account_id', 'form_id', 'submission_id',...(guardedFields[snapshot.table]??[]),
        ...(graph[snapshot.table]?.friendColumns ?? []),
        ...(graph[snapshot.table]?.references.flatMap(ref => ref.columns.map(col => col.column)) ?? []),
        ...RETENTION_R2_KEY_COLUMNS.filter(entry => entry.table === snapshot.table).map(entry => entry.column)];
      const columns = [...new Set(candidates)].filter(col => first && Object.hasOwn(first, col));
      if (columns.length) statements.push(guard(`NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN ${q(snapshot.table)} actual
        ON actual.rowid = json_extract(expected.value,'$.rowid') WHERE ${columns.map(col => `actual.${q(col)} IS NOT json_extract(expected.value,'$.values.${col}')`).join(' OR ')})`,
        [JSON.stringify(snapshot.rows.map(row => ({ rowid: row._delete_rowid, values: Object.fromEntries(columns.map(col => [col, row[col] ?? null])) })))]));
    }
    for(const item of cleanup) statements.push(db.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,result_json,created_at,updated_at)
      VALUES(?,'booking_external_cleanup',?,'current','pending',?,?,?,?,?)`).bind(`line:${target.accountId}`,item.id,item.index,item.payload,JSON.stringify({retainUntil:item.retainUntil}),Date.now(),Date.now()));
    if (target.kind === 'friend_data') {
      const affiliateCondition = conditions.affiliates;
      // 承認済み保持表以外へスキーマを増やさず、既に NULL を許す参照を解除する。紹介者の名前とコードも除く。
      statements.push(db.prepare(`UPDATE conversion_events SET affiliate_id = NULL, affiliate_code = NULL
        WHERE affiliate_id IN (SELECT id FROM affiliates WHERE ${affiliateCondition})`).bind(...(affiliateCondition.includes('?3') ? params : [params[0]])));
      const removed = `SELECT id FROM affiliates WHERE ${affiliateCondition}`;
      statements.push(db.prepare(`UPDATE affiliate_attribution_decisions
        SET affiliate_id = CASE WHEN affiliate_id IN (${removed}) THEN NULL ELSE affiliate_id END,
            ref_code = CASE WHEN affiliate_id IN (${removed}) THEN NULL ELSE ref_code END,
            candidates_json = (SELECT json_group_array(json(CASE
              WHEN json_extract(candidate.value, '$.affiliateId') IN (${removed})
              THEN json_set(candidate.value, '$.affiliateName', '削除済みのお客さま', '$.refCode', '')
              ELSE candidate.value END)) FROM json_each(candidates_json) candidate)
        WHERE affiliate_id IN (${removed}) OR EXISTS (SELECT 1 FROM json_each(candidates_json) candidate
          WHERE json_extract(candidate.value, '$.affiliateId') IN (${removed}))`)
        .bind(...(affiliateCondition.includes('?3') ? params : [params[0]])));
    }
    for (const table of childFirst(Object.keys(conditions))) {
      const snapshot = byTable.get(table)!;
      if (snapshot.rows.length) statements.push(db.prepare(`DELETE FROM ${q(table)} WHERE rowid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(snapshot.rows.map(row => row._delete_rowid))));
    }
    const formIds = [...new Set(byTable.get('form_submissions')!.rows.map(row => row.form_id as string))];
    for (const formId of formIds) statements.push(db.prepare(`UPDATE forms SET submit_count = (SELECT COUNT(*) FROM form_submissions WHERE form_id = ? AND is_test = 0) WHERE id = ?`).bind(formId, formId));
    const completed: Detail = { ...detail, completedAt: new Date().toISOString(), rows: snapshots.reduce((sum, s) => sum + s.rows.length, 0) };
    statements.push(db.prepare("UPDATE operation_audit SET action = 'deleted', detail_json = ? WHERE id = ? AND json_extract(detail_json,'$.token') = ?").bind(JSON.stringify(completed), id, token));
    const account = target.accountId ? await db.prepare('SELECT tenant_id FROM line_accounts WHERE id = ?').bind(target.accountId).first<{ tenant_id: string | null }>() : null;
    statements.push(auditEventStatement(db, { id, sourceKind: 'operation_audit', sourceId: id,
      tenantId: account?.tenant_id, lineAccountId: target.accountId, category: 'business', actorPrincipalId: actorId,
      action: `customer.${target.kind}.deleted`, targetKind: target.kind, targetId: target.id, result: 'success',
      after: { deletedRows: completed.rows }, createdAt: completed.completedAt, retentionClass: 'general' }));
    await db.batch(statements);
    return { deleted: true, replayed: false };
  } catch (error) {
    // 記録は固定コードに限り、顧客本文・ファイル名・キー・外部エラーをログへ出さない。
    await db.prepare("UPDATE operation_audit SET action = 'retryable' WHERE id = ? AND action = 'deleting' AND json_extract(detail_json,'$.token') = ?").bind(id, token).run().catch(() => {});
    if(error instanceof DeletionFailure && error.code==='deletion_cleanup_key_missing')throw error;
    throw new DeletionFailure(503, 'deletion_retry_required');
  }
}
