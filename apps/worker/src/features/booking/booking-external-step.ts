import { ensureWorkflowStep, workflowBindings, workflowJson, WORKFLOW_WHERE, type WorkflowStepRef } from '@line-crm/db';

import { createCallState, createExternalCall, validateState } from '../../lib/external-call/index.js';
import { type CallIdentity, type CallPolicy, type CallResult, type CallState, type Outcome } from '../../lib/external-call/types.js';
import { BookingExternalCircuits } from './booking-external-circuits.js';
import { customerDestinationBlocked, customerDestinationDigest, noCustomerDeletionForDigest } from '../../services/customer-deletion-destination.js';

interface Snapshot<S> { identity: CallIdentity; policy: CallPolicy; snapshot: S }
interface Result<T> { callState: CallState; value?: T }
export interface BookingExternalStep<S, T> {
  ref: WorkflowStepRef;
  identity: CallIdentity;
  policy: CallPolicy;
  snapshot: S;
  now?: () => number;
  initialAttempts?: number;
  /** legacyの実行開始印がある操作を新しい予算で再送しない。 */
  legacyUnknown?: boolean;
  authorize(snapshot: Readonly<S>): Promise<boolean>;
  execute(signal: AbortSignal, snapshot: Readonly<S>, identity: Readonly<CallIdentity>): Promise<Outcome<T>>;
  /** 外部の参照IDと業務結果を成功checkpointと同じ取引で保存する。 */
  statements?(next: Readonly<CallState>, value: T | undefined): D1PreparedStatement[];
}

/** 既存workflow_stepsを使う予約系の記録→単発実行→結果。startedはleaseで取り直さない。 */
export async function runBookingExternalStep<S, T>(db: D1Database, options: BookingExternalStep<S, T>): Promise<CallResult<T>> {
  if (options.ref.scopeId !== `line:${options.identity.scope.accountId}`) throw new Error('booking_external_scope_conflict');
  const destination = (options.snapshot && typeof options.snapshot==='object') ? (options.snapshot as {to?:unknown}).to : undefined;
  const incomingDigest=typeof destination==='string' && destination ? await customerDestinationDigest(options.identity.scope.accountId,destination) : null;
  if(incomingDigest && await customerDestinationBlocked(db,incomingDigest,options.identity.scope.accountId,destination as string)) throw new Error('customer_deleted');
  const now = options.now ?? Date.now;
  const input: Snapshot<S> = { identity: options.identity, policy: options.policy, snapshot: options.snapshot };
  const created = await ensureWorkflowStep(db, options.ref, {
    now: now(), input, retryKey: options.identity.idempotencyKey, maxAttempts: options.policy.maxAttempts,
    initialAttempts: options.initialAttempts ?? 0, status: options.legacyUnknown ? 'unknown' : 'pending',
  });
  const saved = JSON.parse(created.input_json ?? 'null') as Snapshot<S> | null;
  // 別の作りの旧checkpointを新規送信へ読み替えない。既存の履歴は保持する。
  if (!saved?.identity || !saved.policy || !('snapshot' in saved)) throw new Error('booking_external_legacy_checkpoint');
  const savedDestination=(saved.snapshot && typeof saved.snapshot==='object') ? (saved.snapshot as {to?:unknown}).to : undefined;
  const savedDigest=typeof savedDestination==='string' && savedDestination ? await customerDestinationDigest(options.identity.scope.accountId,savedDestination) : null;
  if (workflowJson(saved.identity) !== workflowJson(options.identity)) throw new Error('booking_external_identity_conflict');
  let result: Result<T> | null = created.result_json ? JSON.parse(created.result_json) : null;
  let state = result?.callState ?? createCallState(saved.identity, saved.policy, created.created_at);
  if (!result) {
    state.attempts = created.attempt_count;
    if (created.status === 'succeeded') state.phase = 'succeeded';
    else if (created.status === 'unknown' || created.status === 'running') state.phase = 'unknown';
    else if (created.status === 'exhausted' || created.status === 'canceled') state.phase = 'stopped';
  }
  validateState(state);
  if (workflowJson(state.identity) !== workflowJson(saved.identity) || workflowJson(state.policy) !== workflowJson(saved.policy)
    || created.max_attempts !== state.policy.maxAttempts || created.attempt_count !== state.attempts) {
    throw new Error('booking_external_checkpoint_invalid');
  }
  let previousJson = created.result_json;
  let value = result?.value;
  const call = createExternalCall({ circuits: new BookingExternalCircuits(db), now });
  const outcome = await call<T>({
    state,
    authorize: () => options.authorize(structuredClone(saved.snapshot)),
    execute: async (signal, identity) => {
      const outcome = await options.execute(signal, structuredClone(saved.snapshot), identity);
      if (outcome.kind === 'success') value = outcome.value;
      return outcome;
    },
    journal: {
      async compareAndSwap(previous, next) {
        // 共通実行器へ渡す前にも、保存側で不変項目と単調な版/回数を検査する。
        if (workflowJson(previous) !== workflowJson(state)
          || workflowJson(next.identity) !== workflowJson(saved.identity)
          || workflowJson(next.policy) !== workflowJson(saved.policy)
          || next.revision !== previous.revision + 1
          || next.attempts !== previous.attempts + (next.phase === 'started' ? 1 : 0)
          || (previous.phase !== 'ready' && previous.phase !== 'started')) return false;
        validateState(next);
        const where = `${WORKFLOW_WHERE} AND input_json=? AND result_json IS ? AND attempt_count=?
          AND status NOT IN ('succeeded','exhausted','canceled')${next.phase==='started' && savedDigest ? ` AND ${noCustomerDeletionForDigest}` : ''}`;
        const args = [...workflowBindings(options.ref), created.input_json, previousJson, previous.attempts,
          ...(next.phase==='started' && savedDigest ? [savedDigest,options.identity.scope.accountId,savedDestination] : [])];
        const nextJson = workflowJson({ callState: next, ...(next.phase === 'succeeded' ? { value } : {}) });
        const status = next.phase === 'succeeded' ? 'succeeded' : next.phase === 'ready' ? 'pending'
          : next.phase === 'stopped' ? 'exhausted' : 'unknown';
        // fenceが負けた取引では業務側の文もrollbackする。状態だけ先に成功にしない。
        try {
          await db.batch([
            db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workflow_steps WHERE ${where})
              THEN 'true' ELSE 'booking_external_cas_conflict' END) AS booking_external_fence`).bind(...args),
            ...(options.statements?.(next, value) ?? []),
            db.prepare(`UPDATE workflow_steps SET status=?,result_json=?,attempt_count=?,next_attempt_at=?,
              error_code=?,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=?
              WHERE ${where}`).bind(status, nextJson, next.attempts, next.phase === 'ready' ? next.nextAt : null,
                next.phase === 'started' || next.phase === 'unknown' ? 'delivery_unknown' : next.reason ?? null,
                next.attempts ? now() : null, now(), ...args),
          ]);
        } catch (error) {
          // SQLのfenceだけは競合として返す。DB障害は共通実行器がstorage/unknownにする。
          if (String(error).includes('malformed JSON')) return false;
          throw error;
        }
        state = structuredClone(next);
        previousJson = nextJson;
        result = { callState: state, value };
        return true;
      },
    },
  });
  return outcome;
}

/** 不明の操作は読取りの証拠だけで回収する。ここから元の書込みは呼ばない。 */
export async function reconcileBookingExternalStep<S, T>(db: D1Database, ref: WorkflowStepRef,
  verify: (snapshot: Readonly<S>) => Promise<{ verified: true; value: T } | { verified: false }>,
  statements: (value: T) => D1PreparedStatement[] = () => [],
): Promise<T | null> {
  const { getWorkflowStep } = await import('@line-crm/db');
  const row = await getWorkflowStep(db, ref);
  if (!row?.input_json) return null;
  const input = JSON.parse(row.input_json) as Snapshot<S>;
  const result:Result<T>|null = row.result_json ? JSON.parse(row.result_json) : null;
  const previous = result?.callState ?? (row.status==='unknown' ? { ...createCallState(input.identity,input.policy,row.created_at),attempts:row.attempt_count,phase:'unknown' as const } : null);
  if (!previous || !['started', 'unknown'].includes(previous.phase)) return null;
  validateState(previous);
  const evidence = await verify(structuredClone(input.snapshot));
  if (!evidence.verified) return null;
  const next: CallState = { ...previous, phase: 'succeeded', revision: previous.revision + 1 };
  delete next.reason;
  delete next.status;
  const where = `${WORKFLOW_WHERE} AND input_json=? AND result_json IS ? AND status='unknown'`;
  const args = [...workflowBindings(ref), row.input_json, row.result_json];
  await db.batch([
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workflow_steps WHERE ${where})
      THEN 'true' ELSE 'booking_external_reconcile_conflict' END)`).bind(...args),
    ...statements(evidence.value),
    db.prepare(`UPDATE workflow_steps SET status='succeeded',result_json=?,error_code=NULL,updated_at=?
      WHERE ${where}`).bind(workflowJson({ callState: next, value: evidence.value }), Date.now(), ...args),
  ]);
  return evidence.value;
}
