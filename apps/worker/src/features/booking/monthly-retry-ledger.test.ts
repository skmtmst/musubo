import { afterEach, expect, it, vi } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture, monthlyNow } from '../../test-utils/monthly-ledger.js';
import { scheduleMonthlyRetry } from './monthly-retry-ledger.js';
import { executeMonthlyAttempt } from './monthly-attempt-execution.js';
import { runMonthlyAttemptMockCron } from './monthly-attempt-cron.js';
import type { Env } from '../../worker-env.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
it('確定した失敗から同じ請求の次の試行を一度だけ記録する', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { id: 'initial', month: '2026-10', paid: true }); activateMonthly(d);
  monthlyCycle(d, { id: 'renewal', kind: 'renewal' });
  d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
    VALUES('renewal','t','a',0,?,'pm_original',1,'attempt-0','pending')`).run(monthlyNow);
  expect(await scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow))).toEqual({ status: 'unavailable' });
  d.raw.prepare("UPDATE booking_monthly_attempts SET state='failed',finished_at=?,version=version+1 WHERE cycle_id='renewal' AND attempt_no=0").run(monthlyNow);
  const results = await Promise.all([scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow)),scheduleMonthlyRetry(d.db,'renewal',0,new Date(monthlyNow))]);
  expect(results.filter(r => r.status === 'scheduled')).toHaveLength(1);
  expect(d.raw.prepare("SELECT attempt_no,scheduled_at,state FROM booking_monthly_attempts WHERE cycle_id='renewal' AND attempt_no=1").get())
    .toEqual({ attempt_no: 1, scheduled_at: '2026-11-13T00:00:00.000Z', state: 'pending' });
});
it('期限まで実行を待ち、同時実行と結果不明を再送しない', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { id: 'initial', month: '2026-10', paid: true }); activateMonthly(d);
  monthlyCycle(d, { id: 'renewal', kind: 'renewal' });
  d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
    VALUES('renewal','t','a',0,?,'pm_original',1,'attempt-0','pending')`).run(monthlyNow);
  const pay = vi.fn(async () => 'unknown' as const);
  expect((await executeMonthlyAttempt(d.db,'renewal',0,{pay},new Date('2026-11-09T23:59:00Z'))).status).toBe('unavailable');
  await Promise.all([executeMonthlyAttempt(d.db,'renewal',0,{pay},new Date(monthlyNow)),executeMonthlyAttempt(d.db,'renewal',0,{pay},new Date(monthlyNow))]);
  expect(pay).toHaveBeenCalledOnce();
  expect((await executeMonthlyAttempt(d.db,'renewal',0,{pay},new Date(monthlyNow))).status).toBe('unavailable');
});
it('未入金が確定した試行から次の再試行を作る', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { id: 'initial', month: '2026-10', paid: true }); activateMonthly(d);
  monthlyCycle(d, { id: 'renewal', kind: 'renewal' });
  d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
    VALUES('renewal','t','a',0,?,'pm_original',1,'attempt-0','pending')`).run(monthlyNow);
  expect((await executeMonthlyAttempt(d.db,'renewal',0,{pay:async()=> 'failed'},new Date(monthlyNow))).status).toBe('failed');
  expect(d.raw.prepare("SELECT scheduled_at FROM booking_monthly_attempts WHERE cycle_id='renewal' AND attempt_no=1").get())
    .toEqual({ scheduled_at: '2026-11-13T00:00:00.000Z' });
});
it('模擬の定期実行は両方の設定とテスト宛先がある検証環境だけで再試行を作る', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d, { id: 'initial', month: '2026-10', paid: true }); activateMonthly(d);
  monthlyCycle(d, { id: 'mock_mock', kind: 'renewal' });
  const env = { DB:d.db, DEPLOY_ENV:'staging', MONTHLY_INVOICE_MOCK_CRON_ENABLED:'true', MONTHLY_PAYMENT_MOCK_FAILURE_ENABLED:'true' } as Env['Bindings'];
  expect(await runMonthlyAttemptMockCron({...env, DEPLOY_ENV:'production'},new Date(monthlyNow))).toEqual({enabled:false});
  expect(await runMonthlyAttemptMockCron({...env, MONTHLY_PAYMENT_MOCK_FAILURE_ENABLED:undefined},new Date(monthlyNow))).toEqual({enabled:false});
  expect(await runMonthlyAttemptMockCron(env,new Date(monthlyNow))).toMatchObject({attempted:0});
  d.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('a','test_recipients','["f"]')`);
  expect(await runMonthlyAttemptMockCron(env,new Date(monthlyNow))).toMatchObject({attempted:1});
  expect(d.raw.prepare("SELECT state FROM booking_monthly_attempts WHERE cycle_id='mock_mock' AND attempt_no=0").get()).toEqual({state:'failed'});
  expect(d.raw.prepare("SELECT scheduled_at FROM booking_monthly_attempts WHERE cycle_id='mock_mock' AND attempt_no=1").get()).toEqual({scheduled_at:'2026-11-13T00:00:00.000Z'});
});
