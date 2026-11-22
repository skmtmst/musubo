import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { runBookingExternalStep, reconcileBookingExternalStep } from './booking-external-step.js';
import { BookingExternalCircuits } from './booking-external-circuits.js';
import { API_RETRY_WAIT } from '../../lib/external-call/index.js';
import { type CallIdentity, type Outcome } from '../../lib/external-call/types.js';
import {customerDestinationDigest} from '../../services/customer-deletion-destination.js';

let sql: SqliteD1;
const now = 1_800_000_000_000;
const identity: CallIdentity = { scope: { accountId: 'a', storeId: 'a', destination: 'line', connectionId: 'c' },
  operationId: 'operation', idempotencyKey: 'stable', snapshotId: 'snapshot', effect: 'write' };
const ref = { scopeId: 'line:a', processKind: 'booking_fixture', subjectId: 'operation', stepKey: 'send' };
const input = () => ({ ref, identity, snapshot: { to: 'U_fixture', body: 'saved' },
  now: () => now, policy: { category: 'api' as const, maxAttempts: 3, timeoutMs: 1000, deadlineAt: now + 86_400_000, wait: API_RETRY_WAIT },
  authorize: async () => true,
  execute: vi.fn(async (): Promise<Outcome<{ id: string }>> => ({ kind: 'success', value: { id: 'provider-reference' } })),
});
beforeEach(() => { sql = createTestD1(); });
afterEach(() => { sql.raw.close(); });

describe('予約系の永続checkpoint', () => {
  it('予約通知の送信直前に顧客削除を受け付けると外部へ送らない',async()=>{
    const options=input(),digest=await customerDestinationDigest('a','U_fixture');
    const outcome=await runBookingExternalStep(sql.db,{...options,authorize:async()=>{
      sql.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
        VALUES ('customer-delete:friend_data:f','customer_deletion','f','deleting','owner','f',?)`)
        .run(JSON.stringify({accountId:'a',recipientDigest:digest}));
      return true;
    }});
    expect(outcome.kind).not.toBe('success');
    expect(options.execute).not.toHaveBeenCalled();
  });
  it('並行CASは1要求。成功後は再起動しても要求0、入力の写しと参照IDを保持', async () => {
    const options = input();
    const outcomes = await Promise.all([runBookingExternalStep(sql.db, options), runBookingExternalStep(sql.db, options)]);
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(outcomes.map(o => o.kind)).toContain('success');
    expect((await runBookingExternalStep(sql.db, { ...options, snapshot: { to: 'changed', body: 'changed' } })).kind).toBe('succeeded');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(sql.raw.prepare('SELECT input_json,result_json FROM workflow_steps WHERE process_kind=?').get(ref.processKind))
      .toMatchObject({ input_json: expect.stringContaining('saved'), result_json: expect.stringContaining('provider-reference') });
  });
  it('送信開始後の切断はunknown。24時間後も別実行器から再送しない', async () => {
    const options = input(); options.execute.mockRejectedValue(new Error('secret upstream payload'));
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('unknown');
    expect((await runBookingExternalStep(sql.db, { ...options, now: () => now + 2 * 86_400_000 })).kind).toBe('unknown');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sql.raw.prepare('SELECT * FROM workflow_steps').all())).not.toContain('secret upstream');
  });
  it('外部成功後の業務保存が失敗してもstartedを残し、再送なしで読取り照合する', async () => {
    sql.raw.exec(`CREATE TABLE domain_fixture(id TEXT PRIMARY KEY); CREATE TRIGGER crash_domain BEFORE INSERT ON domain_fixture
      BEGIN SELECT RAISE(ABORT,'storage_down'); END`);
    const options = { ...input(), statements: (next: { phase: string }) => next.phase === 'succeeded'
      ? [sql.db.prepare("INSERT INTO domain_fixture VALUES('provider-reference')")] : [] };
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('unknown');
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('unknown');
    expect(options.execute).toHaveBeenCalledTimes(1);
    sql.raw.exec('DROP TRIGGER crash_domain');
    const verify = vi.fn(async (snapshot: { to: string; body: string }) => ({ verified: true as const, value: { id: snapshot.body } }));
    expect(await reconcileBookingExternalStep(sql.db, ref, verify, () => [sql.db.prepare("INSERT INTO domain_fixture VALUES('provider-reference')")]))
      .toEqual({ id: 'saved' });
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('succeeded');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(sql.raw.prepare('SELECT COUNT(*) n FROM domain_fixture').get()).toEqual({ n: 1 });
  });
  it('送信前のDB障害・別店・停止・認証エラーは送信/再送0', async () => {
    const options = input();
    await expect(runBookingExternalStep(sql.db, { ...options, ref: { ...ref, scopeId: 'line:other' } })).rejects.toThrow('scope_conflict');
    expect((await runBookingExternalStep(sql.db, { ...options, authorize: async () => false })).kind).toBe('stopped');
    expect(options.execute).not.toHaveBeenCalled();
    sql.raw.exec(`CREATE TRIGGER crash_checkpoint BEFORE UPDATE ON workflow_steps WHEN NEW.process_kind='booking_fixture'
      BEGIN SELECT RAISE(ABORT,'storage_down'); END`);
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('storage_error');
    expect(options.execute).not.toHaveBeenCalled();
    sql.raw.exec('DROP TRIGGER crash_checkpoint');
    options.execute.mockResolvedValue({ kind: 'permanent', reason: 'http', status: 401 });
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('stopped');
    expect((await runBookingExternalStep(sql.db, options)).kind).toBe('stopped');
    expect(options.execute).toHaveBeenCalledTimes(1);
  });
  it('既存の厳しい3回予算とRetry-Afterを保持し、別の呼出しでも早く再送しない', async () => {
    const options = input(); identity.effect = 'read';
    try {
      options.execute.mockResolvedValue({ kind: 'transient', reason: 'http', status: 429, retryAt: now + 300_000 });
      expect(await runBookingExternalStep(sql.db, options)).toMatchObject({ kind: 'deferred', nextAt: now + 300_000 });
      expect((await runBookingExternalStep(sql.db, { ...options, now: () => now + 60_000 })).kind).toBe('deferred');
      expect(options.execute).toHaveBeenCalledTimes(1);
      await runBookingExternalStep(sql.db, { ...options, now: () => now + 300_000 });
      await runBookingExternalStep(sql.db, { ...options, now: () => now + 600_000 });
      expect((await runBookingExternalStep(sql.db, { ...options, now: () => now + 86_000_000 })).kind).toBe('stopped');
      expect(options.execute).toHaveBeenCalledTimes(3);
    } finally { identity.effect = 'write'; }
  });
});

it('D1の別storeでも遮断中0要求・半開同時1回、期限切れprobeの旧結果を捨てる', async () => {
  const a = new BookingExternalCircuits(sql.db), b = new BookingExternalCircuits(sql.db), scope = identity.scope;
  for (let i = 0; i < 5; i++) {
    const admission = await a.acquire(scope, now);
    expect(admission.allowed).toBe(true);
    if (admission.allowed) await a.settle(admission.lease, 'failure', now);
  }
  expect((await b.acquire(scope, now + 1)).allowed).toBe(false);
  const admissions = await Promise.all([a.acquire(scope, now + 30_000), b.acquire(scope, now + 30_000)]);
  expect(admissions.filter(a => a.allowed)).toHaveLength(1);
  const probe = admissions.find(a => a.allowed)!;
  const later = await b.acquire(scope, now + 90_001);
  expect(later.allowed).toBe(true);
  if (probe.allowed) await a.settle(probe.lease, 'success', now + 90_002);
  expect((await a.acquire(scope, now + 90_003)).allowed).toBe(false);
  if (later.allowed) await b.settle(later.lease, 'failure', now + 90_004);
  expect((await a.acquire(scope, now + 90_005)).allowed).toBe(false);
  expect((await a.acquire({ ...scope, accountId: 'other', storeId: 'other' }, now)).allowed).toBe(true);
});
