import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { processTenantDataPurge } from './tenant-data-purge.js';

test('payment, refund, replay and cancellation records survive purge with foreign keys enabled', async () => {
  const f=gapFixture(); f.raw.pragma('foreign_keys=ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',purge_requested_at='2026-01-01' WHERE id='t';
    INSERT INTO booking_payments(id,line_account_id,amount,provider,idempotency_key,created_at,updated_at)
      VALUES('p','a',2000,'test','pay','2026-01-01','2026-01-01'),('other-p','b',4000,'test','other','2026-01-01','2026-01-01');
    INSERT INTO booking_payment_events(id,line_account_id,provider,provider_event_id,payment_id,provider_payment_id,kind,outcome,received_at,result)
      VALUES('ev','a','test','evt-1','p','provider-1','paid','paid','2026-01-01','applied');
    INSERT INTO booking_payment_event_replays(id,event_id,actor_id,occurred_at,source_version,result)
      VALUES('replay','ev','operator','2026-01-01',1,'applied');
    INSERT INTO booking_payment_refunds(id,payment_id,line_account_id,idempotency_key,amount,reason,actor_id,actor_label,notification_status,created_at)
      VALUES('refund','p','a','refund-key',100,'reason','operator','operator','not_requested','2026-01-01');
    INSERT INTO booking_payment_booking_links(id,payment_id,line_account_id,reason,actor_id,actor_label,created_at)
      VALUES('link','p','a','reason','operator','operator','2026-01-01');
    INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at)
      VALUES('charge','history','a','no_show_fee',500,'{}','succeeded','2026-01-01','2026-01-01');
    INSERT INTO booking_cancellation_events(id,charge_id,action,created_at) VALUES('cancel','charge','created','2026-01-01');`);
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(1);
  for (const [table,id] of [['booking_payments','p'],['booking_payment_events','ev'],['booking_payment_event_replays','replay'],['booking_payment_refunds','refund'],['booking_payment_booking_links','link'],['booking_charges','charge'],['booking_cancellation_events','cancel']] as const) {
    expect(f.raw.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id),table).toEqual({id});
  }
  expect(f.raw.prepare("SELECT amount FROM booking_payments WHERE id='other-p'").get()).toEqual({amount:4000});
  expect(f.raw.pragma('foreign_key_check')).toEqual([]);
});

test('consent and audit rows remain after tenant purge and another tenant is untouched', async () => {
  const f=gapFixture(); f.raw.pragma('foreign_keys=ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',purge_requested_at='2026-01-01' WHERE id='t';
    INSERT INTO audit_events(id,tenant_id,line_account_id,category,action,result) VALUES('audit','t','a','business','fixture','success');
    INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at) VALUES('booking-audit','a','create','system','2026-01-01');
    INSERT INTO login_audit(id,action) VALUES('login','login');
    INSERT INTO operation_audit(id,target_kind,action,friend_id) VALUES('operation','friend','create','f');
    INSERT INTO platform_audit_logs(id,staff_id,tenant_id,action) VALUES('platform','o','t','fixture');
    INSERT INTO site_consent_days(line_account_id,day,granted) VALUES('a','2026-01-01',1),('b','2026-01-01',2);
    INSERT INTO stripe_events(id,stripe_event_id,event_type,tenant_id) VALUES('stripe','evt_fixture','other','t');
    INSERT INTO style_change_logs(id,line_account_id,action,created_at) VALUES('style','a','fixture','2026-01-01');
    INSERT INTO booking_calendar_switch_audit(id,line_account_id,scope_id,actor_id,before_json,after_json,created_at)
      VALUES('calendar','a','scope','operator','{}','{}','2026-01-01');`);
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(1);
  for (const [table,id] of [['audit_events','audit'],['booking_audit_logs','booking-audit'],['login_audit','login'],['operation_audit','operation'],['platform_audit_logs','platform'],['stripe_events','stripe'],['style_change_logs','style'],['booking_calendar_switch_audit','calendar']] as const) {
    expect(f.raw.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id),table).toEqual({id});
  }
  expect(f.raw.prepare("SELECT granted FROM site_consent_days WHERE line_account_id='a'").get()).toEqual({granted:1});
  expect(f.raw.prepare("SELECT granted FROM site_consent_days WHERE line_account_id='b'").get()).toEqual({granted:2});
  expect(f.raw.pragma('foreign_key_check')).toEqual([]);
});
