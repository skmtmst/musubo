import { afterEach, expect, it, vi } from 'vitest';
import { activateMonthly, monthlyContract, monthlyCycle, monthlyFixture, monthlyNow } from '../../test-utils/monthly-ledger.js';
import { stopExhaustedMonthlyCycle } from './monthly-exhausted.js';
import { processMonthlyFailureNotices, processStagingMonthlyFailureNotices } from './monthly-failure-notices.js';
import type { Env } from '../../worker-env.js';

const opened: ReturnType<typeof monthlyFixture>[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.raw.close(); });
it('最後の確定失敗だけで停止し、本人と店の通知予約を一度だけ残す', async () => {
  const d = monthlyFixture(); opened.push(d);
  await monthlyContract(d); monthlyCycle(d,{id:'initial',month:'2026-10',paid:true}); activateMonthly(d);
  monthlyCycle(d,{id:'renewal',kind:'renewal'});
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',new Date(monthlyNow))).toEqual({stopped:false});
  const dates = ['2026-11-10','2026-11-13','2026-11-15','2026-11-17'];
  for (let n=0;n<4;n++) {
    if (n===1) d.raw.prepare("UPDATE booking_monthly_cycles SET first_failed_at=?,state='retry_wait',version=version+1 WHERE id='renewal'").run(monthlyNow);
    d.raw.prepare(`INSERT INTO booking_monthly_attempts(cycle_id,tenant_id,account_id,attempt_no,scheduled_at,payment_method_id,payment_method_version,request_key,state)
      VALUES('renewal','t','a',?,?,'pm_original',1,?,'pending')`).run(n,`${dates[n]}T00:00:00.000Z`,`key-${n}`);
    d.raw.prepare("UPDATE booking_monthly_attempts SET state='failed',finished_at=?,version=version+1 WHERE cycle_id='renewal' AND attempt_no=?").run(`${dates[n]}T00:00:00.000Z`,n);
  }
  const now = new Date('2026-11-17T00:00:00Z');
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',now)).toEqual({stopped:true});
  expect(await stopExhaustedMonthlyCycle(d.db,'renewal',now)).toEqual({stopped:false});
  expect(d.raw.prepare("SELECT state,stop_reason FROM booking_monthly_contracts WHERE id='contract'").get()).toEqual({state:'stopped',stop_reason:'unpaid'});
  expect(d.raw.prepare("SELECT audience FROM booking_monthly_failure_notices ORDER BY audience").all()).toEqual([{audience:'friend'},{audience:'store'}]);
  const sendAt=new Date('2026-11-17T03:00:00Z');
  const send=vi.fn(async()=>{});
  expect(await processStagingMonthlyFailureNotices({DB:d.db,DEPLOY_ENV:'staging'} as Env['Bindings'],sendAt)).toEqual({processed:0});
  expect(await processMonthlyFailureNotices(d.db,sendAt,send,()=>sendAt)).toEqual({processed:0});
  d.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('a','test_recipients','["f","f2"]');
    UPDATE staff_members SET line_user_id='Uf2' WHERE id='o';`);
  expect(await processMonthlyFailureNotices(d.db,new Date('2026-11-17T13:00:00Z'),send,()=>new Date('2026-11-17T13:00:00Z'))).toEqual({processed:0});
  d.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','transaction','revoked','test','manual'); UPDATE friends SET is_hidden=1 WHERE id='f2'");
  expect(await processMonthlyFailureNotices(d.db,sendAt,send,()=>sendAt)).toEqual({processed:0});
  d.raw.exec("DELETE FROM friend_delivery_consents WHERE friend_id='f'; UPDATE friends SET is_hidden=0 WHERE id='f2'");
  const changed=()=>{d.raw.exec("UPDATE account_settings SET value='[]' WHERE line_account_id='a' AND key='test_recipients'");return sendAt;};
  expect(await processMonthlyFailureNotices(d.db,sendAt,send,changed)).toEqual({processed:0});
  expect(send).not.toHaveBeenCalled();
  d.raw.exec(`UPDATE account_settings SET value='["f","f2"]' WHERE line_account_id='a' AND key='test_recipients'`);
  expect(await processMonthlyFailureNotices(d.db,sendAt,send,()=>sendAt)).toEqual({processed:2});
  expect(send).toHaveBeenCalledTimes(2);
  expect(await processMonthlyFailureNotices(d.db,sendAt,send,()=>sendAt)).toEqual({processed:0});
});
