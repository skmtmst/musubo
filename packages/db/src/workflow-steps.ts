/** Shared, account/tenant-scoped checkpoints. Times are UTC epoch milliseconds. */
export interface WorkflowStepRef {
  scopeId: string;
  processKind: string;
  subjectId: string;
  stepKey: string;
}
export interface WorkflowStepRow {
  scope_id: string; process_kind: string; subject_id: string; step_key: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'exhausted' | 'unknown' | 'canceled';
  lease_owner: string | null; lease_expires_at: number | null;
  attempt_count: number; max_attempts: number; next_attempt_at: number | null;
  retry_key: string; input_json: string | null; result_json: string | null;
  error_code: string | null; first_attempt_at: number | null; created_at: number; updated_at: number;
}
export function workflowBindings(ref: WorkflowStepRef): string[] {
  return [ref.scopeId, ref.processKind, ref.subjectId, ref.stepKey];
}
export const WORKFLOW_WHERE = 'scope_id=? AND process_kind=? AND subject_id=? AND step_key=?';
/** Only deliberate snapshots are accepted; credentials and reply tokens never enter this ledger. */
export function workflowJson(value: unknown): string {
  const json = JSON.stringify(value ?? null, (key, item) => {
    if (/^(authorization|.*access.?token|.*channel.?secret|reply.?token|.*api.?key|password|credential.?key)$/i.test(key)) {
      throw new Error('workflow_snapshot_contains_secret');
    }
    return item;
  });
  if (json.length > 128_000) throw new Error('workflow_snapshot_too_large');
  return json;
}
export async function ensureWorkflowStep(db: D1Database, ref: WorkflowStepRef,
  options: { now?: number; input?: unknown; retryKey?: string; maxAttempts?: number; initialAttempts?: number; status?: 'pending' | 'unknown' } = {},
): Promise<WorkflowStepRow> {
  await prepareWorkflowStep(db,ref,options).run();
  return (await getWorkflowStep(db, ref))!;
}
/** Allows callers to persist the domain input and its root checkpoint atomically. */
export function prepareWorkflowStep(db:D1Database,ref:WorkflowStepRef,
  options:{now?:number;input?:unknown;retryKey?:string;maxAttempts?:number;initialAttempts?:number;status?:'pending'|'unknown';afterChange?:boolean}={}):D1PreparedStatement {
  const now=options.now ?? Date.now();
  return db.prepare(`INSERT OR IGNORE INTO workflow_steps
    (scope_id,process_kind,subject_id,step_key,retry_key,input_json,max_attempts,status,created_at,updated_at,attempt_count)
    SELECT ?,?,?,?,?,?,?,?,?,?,? ${options.afterChange ? 'WHERE changes() = 1' : ''}`).bind(...workflowBindings(ref), options.retryKey ?? crypto.randomUUID(),
      options.input === undefined ? null : workflowJson(options.input), options.maxAttempts ?? 4,
      options.status ?? 'pending', now, now,options.initialAttempts ?? 0);
}
export async function getWorkflowStep(db: D1Database, ref: WorkflowStepRef): Promise<WorkflowStepRow | null> {
  return db.prepare(`SELECT * FROM workflow_steps WHERE ${WORKFLOW_WHERE}`).bind(...workflowBindings(ref)).first<WorkflowStepRow>();
}
export async function claimWorkflowStep(db: D1Database, ref: WorkflowStepRef,
  options: { now?: number; leaseMs?: number; owner?: string } = {},
): Promise<WorkflowStepRow | null> {
  const now = options.now ?? Date.now(), owner = options.owner ?? crypto.randomUUID();
  await db.prepare(`UPDATE workflow_steps SET status='exhausted',lease_owner=NULL,lease_expires_at=NULL,
    error_code='attempt_limit',updated_at=? WHERE ${WORKFLOW_WHERE} AND attempt_count>=max_attempts
    AND (status IN ('pending','failed') OR (status='running' AND lease_expires_at<=?))`)
    .bind(now,...workflowBindings(ref),now).run();
  const result = await db.prepare(`UPDATE workflow_steps SET status='running',lease_owner=?,lease_expires_at=?,
    attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=?,error_code=NULL
    WHERE ${WORKFLOW_WHERE} AND attempt_count<max_attempts
      AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND (status IN ('pending','failed') OR (status='running' AND lease_expires_at<=?))`)
    .bind(owner,now+(options.leaseMs ?? 300_000),now,now,...workflowBindings(ref),now,now).run();
  return result.meta.changes === 1 ? getWorkflowStep(db,ref) : null;
}
export function workflowFence(db: D1Database, ref: WorkflowStepRef, owner: string, now?:number): D1PreparedStatement {
  return db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workflow_steps WHERE ${WORKFLOW_WHERE}
    AND status='running' AND lease_owner=? AND lease_expires_at>COALESCE(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN 'true' ELSE 'workflow_lease_lost' END) AS workflow_fence`)
    .bind(...workflowBindings(ref),owner,now ?? null);
}
export async function renewWorkflowStep(db: D1Database, ref: WorkflowStepRef, owner: string, leaseMs = 300_000): Promise<void> {
  const now=Date.now();
  const result=await db.prepare(`UPDATE workflow_steps SET lease_expires_at=?,updated_at=? WHERE ${WORKFLOW_WHERE}
    AND status='running' AND lease_owner=? AND lease_expires_at>?`).bind(now+leaseMs,now,...workflowBindings(ref),owner,now).run();
  if(result.meta.changes!==1) throw new Error('workflow_lease_lost');
}
/** Domain changes and their completion checkpoint commit in one D1 transaction. */
export async function finishWorkflowStep(db: D1Database, ref: WorkflowStepRef, owner: string,
  options: { result?: unknown; statements?: D1PreparedStatement[]; now?: number } = {},
): Promise<void> {
  const now=options.now ?? Date.now();
  await db.batch([workflowFence(db,ref,owner,options.now),...(options.statements ?? []),db.prepare(`UPDATE workflow_steps
    SET status='succeeded',result_json=?,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
    WHERE ${WORKFLOW_WHERE} AND lease_owner=?`).bind(workflowJson(options.result),now,...workflowBindings(ref),owner)]);
}
export async function failWorkflowStep(db: D1Database, ref: WorkflowStepRef, owner: string,
  options: { now?: number; permanent?: boolean; unknown?: boolean; code?: string; delayMs?: number; providerRequestId?: string | null } = {},
): Promise<void> {
  const now=options.now ?? Date.now();
  // Callers supply constant classifications, never raw exception messages.
  const code=/^[a-z_]{1,80}$/.test(options.code ?? '') ? options.code! : 'processing_failed';
  await db.prepare(`UPDATE workflow_steps SET status=CASE WHEN ? THEN 'unknown'
    WHEN ? OR attempt_count>=max_attempts THEN 'exhausted' ELSE 'failed' END,
    error_code=?,next_attempt_at=?,result_json=COALESCE(?,result_json),lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE ${WORKFLOW_WHERE} AND status='running' AND lease_owner=? AND lease_expires_at>?`)
    .bind(options.unknown ? 1:0,options.permanent ? 1:0,code,now+(options.delayMs ?? 60_000),
      options.providerRequestId ? workflowJson({ requestId: options.providerRequestId }) : null,now,
      ...workflowBindings(ref),owner,now).run();
}
export async function releaseWorkflowStep(db: D1Database,ref: WorkflowStepRef,owner: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE workflow_steps SET status='pending',first_attempt_at=CASE WHEN attempt_count<=1 THEN NULL ELSE first_attempt_at END,attempt_count=MAX(0,attempt_count-1),
    lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
    WHERE ${WORKFLOW_WHERE} AND status='running' AND lease_owner=? AND lease_expires_at>?`)
    .bind(now,...workflowBindings(ref),owner,now).run();
}
