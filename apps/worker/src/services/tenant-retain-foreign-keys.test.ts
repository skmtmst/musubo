import { describe, expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { monthlyContract, monthlyFixture } from '../test-utils/monthly-ledger.js';
import { processTenantDataPurge } from './tenant-data-purge.js';
import { RETENTION_TABLES } from '@line-crm/db';
import { discoverRetainedPurgeAncestors } from './tenant-retain-graph.js';
import policies from './tenant-retain-column-policies.json';

const now = '2027-05-01T00:00:00.000Z';
const due = "UPDATE tenants SET plan_status='canceled', retention_anchor_at='2026-01-01T00:00:00.000Z' WHERE id='t'";

describe('retained records survive tenant purge with real foreign keys', () => {
  test('monthly contract customer identifiers can be removed while retaining the contract', async () => {
    const f = monthlyFixture();
    await monthlyContract(f);
    if (!(f.raw.pragma('table_info(line_accounts)') as Array<{name:string}>).some(c => c.name === 'data_purged_at')) f.raw.exec('ALTER TABLE line_accounts ADD COLUMN data_purged_at TEXT');
    f.raw.exec("UPDATE booking_monthly_contracts SET customer_id='cus_private', version=version+1 WHERE id='contract'");
    const anonymize = "UPDATE booking_monthly_contracts SET customer_id=NULL, request_json=json_remove(request_json,'$.friendId'), version=version+1 WHERE id='contract'";
    expect(() => f.raw.exec(anonymize)).toThrow('monthly_contract_conflict');
    f.raw.exec("UPDATE line_accounts SET data_purged_at='2027-05-01T00:00:00Z' WHERE id='b'");
    expect(() => f.raw.exec(anonymize)).toThrow('monthly_contract_conflict');
    f.raw.exec("UPDATE line_accounts SET data_purged_at='2027-05-01T00:00:00Z' WHERE id='a'");
    expect(() => f.raw.exec("UPDATE booking_monthly_contracts SET customer_id='cus_other',version=version+1 WHERE id='contract'")).toThrow('monthly_contract_conflict');
    expect(() => f.raw.exec("UPDATE booking_monthly_contracts SET customer_id=NULL,request_json=json_remove(request_json,'$.friendId'),amount=amount+1,version=version+1 WHERE id='contract'")).toThrow('monthly_contract_conflict');
    expect(() => f.raw.exec("UPDATE booking_monthly_contracts SET customer_id=NULL,request_json='{}',version=version+1 WHERE id='contract'")).toThrow('monthly_contract_conflict');
    expect(() => f.raw.exec(anonymize)).toThrow('monthly_contract_conflict');
    f.raw.exec("UPDATE tenants SET purge_started_at='2027-05-01T00:00:00Z' WHERE id='t'");
    expect(() => f.raw.exec(anonymize)).not.toThrow();
    expect(() => f.raw.exec("UPDATE booking_monthly_contracts SET amount=amount+1,version=version+1 WHERE id='contract'")).toThrow('monthly_contract_conflict');
    expect(() => f.raw.exec("UPDATE booking_monthly_contracts SET friend_id='f2',version=version+1 WHERE id='contract'")).toThrow('monthly_contract_conflict');
  });
  test('restaurant approval history survives deletion of its store and organization', async () => {
    const f = gapFixture();
    f.raw.pragma('foreign_keys = ON');
    f.raw.exec(`${due};
      INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('ret-org','a','test','t');
      INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES ('ret-store','ret-org','test','test','a');
      INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title) VALUES ('ret-approval','ret-org','ret-store','menu_change','test');`);
    const outcome = await processTenantDataPurge({ DB: f.db }, { now });
    expect(outcome.completed).toBe(1);
    expect(f.raw.prepare("SELECT id FROM rt_approval_requests WHERE id='ret-approval'").get()).toBeTruthy();
  });
  test('broadcast approval history survives purge without keeping message content', async () => {
    const f = gapFixture();
    f.raw.pragma('foreign_keys = ON');
    f.raw.exec(`${due};
      INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id)
        VALUES ('ret-broadcast','private title','text','private message','a');
      INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action)
        VALUES ('ret-broadcast-approval','ret-broadcast','staff','requested');`);
    const outcome = await processTenantDataPurge({ DB: f.db }, { now });
    expect(outcome.completed).toBe(1);
    expect(f.raw.prepare("SELECT id FROM broadcast_approval_events WHERE id='ret-broadcast-approval'").get()).toBeTruthy();
    const broadcast = f.raw.prepare("SELECT title,message_content FROM broadcasts WHERE id='ret-broadcast'").get() as {title:string;message_content:string} | undefined;
    expect(broadcast?.title).not.toBe('private title');
    expect(broadcast?.message_content).not.toBe('private message');
  });
  test('every retained foreign-key parent has a tombstone policy', async () => {
    const f = gapFixture();
    const unsafe: string[] = [];
    for (const [table, entry] of Object.entries(RETENTION_TABLES)) {
      if (entry.category !== 'retain') continue;
      const refs = f.raw.pragma(`foreign_key_list("${table.replaceAll('"', '""')}")`) as Array<{table:string;from:string;on_delete:string}>;
      const columns = f.raw.pragma(`table_info("${table.replaceAll('"', '""')}")`) as Array<{name:string;notnull:number}>;
      for (const ref of refs) {
        const cannotDetach = ref.on_delete !== 'SET NULL' || columns.some(column => column.name === ref.from && column.notnull === 1);
        if (RETENTION_TABLES[ref.table]?.category === 'purge' && cannotDetach) {
          unsafe.push(`${table}.${ref.from} -> ${ref.table} (${ref.on_delete})`);
        }
      }
    }
    const parents = await discoverRetainedPurgeAncestors(f.db);
    expect(unsafe.length).toBeGreaterThan(0);
    for (const relation of unsafe) {
      const parent = relation.split(' -> ')[1].split(' ')[0];
      expect(parents).toContain(parent);
      expect(policies).toHaveProperty(parent);
    }
  });
  test('booking payment and audit are not cascade-deleted with the account', async () => {
    const f = gapFixture();
    f.raw.pragma('foreign_keys = ON');
    f.raw.exec(`${due};
      INSERT INTO booking_payments(id,line_account_id,amount,provider,idempotency_key,created_at,updated_at)
        VALUES('pay','a',2000,'test','payment-key','2026-01-01','2026-01-01');
      INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at)
        VALUES('audit','a','created','system','2026-01-01');`);
    const outcome = await processTenantDataPurge({ DB: f.db }, { now });
    expect(outcome.completed).toBe(1);
    const payment = f.raw.prepare("SELECT id FROM booking_payments WHERE id='pay'").get();
    const audit = f.raw.prepare("SELECT id FROM booking_audit_logs WHERE id='audit'").get();
    expect({ payment, audit }).toEqual({ payment: { id: 'pay' }, audit: { id: 'audit' } });
  });
  test('monthly contract does not block purge and remains retained', async () => {
    const f = monthlyFixture();
    await monthlyContract(f);
    f.raw.exec(due);
    const outcome = await processTenantDataPurge({ DB: f.db }, { now });
    expect(f.raw.prepare("SELECT id FROM booking_monthly_contracts WHERE id='contract'").get()).toBeTruthy();
    expect(() => f.raw.prepare("DELETE FROM friends WHERE id='f'").run()).toThrow(/FOREIGN KEY constraint failed/);
    expect(outcome.completed).toBe(1);
    expect(f.raw.prepare("SELECT id FROM booking_monthly_contracts WHERE id='contract'").get()).toBeTruthy();
  });
});

test('shared broadcast retains other tenant targets while the purged tenant is detached', async () => {
  const f=gapFixture(); f.raw.pragma('foreign_keys=ON');
  f.raw.exec(`${due};
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,target_type,account_ids,dedup_priority,failed_account_ids)
      VALUES('shared','shared title','text','shared message','a','multi-account-dedup','["a","b"]','["a","b"]','["a","b"]'),
            ('foreign','foreign title','text','foreign message','b','multi-account-dedup','["a","b"]',NULL,NULL);
    UPDATE broadcasts SET status='sending',batch_offset=0 WHERE id='shared';
    INSERT INTO friends(id,line_user_id,line_account_id) VALUES('other-friend','U-other','b');
    INSERT INTO broadcast_ab_recipients(broadcast_id,friend_id,variant_key,state,test_mode) VALUES('shared','f','A','pending',1),('shared','other-friend','A','pending',1);
    INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action) VALUES('shared-approval','shared','o','requested');`);
  const outcome=await processTenantDataPurge({DB:f.db},{now});
  expect(outcome.completed).toBe(1);
  expect(f.raw.prepare("SELECT title,line_account_id,account_ids,dedup_priority,failed_account_ids FROM broadcasts WHERE id='shared'").get())
    .toEqual({title:'shared title',line_account_id:null,account_ids:'["b"]',dedup_priority:'["b"]',failed_account_ids:'["b"]'});
  const {getBroadcasts,getBroadcastById,getQueuedBroadcasts}=await import('@line-crm/db');
  expect((await getBroadcasts(f.db,'b')).map(row=>row.id)).not.toContain('shared');
  expect(await getBroadcastById(f.db,'shared')).toBeNull();
  expect((await getQueuedBroadcasts(f.db)).map(row=>row.id)).not.toContain('shared');
  expect(f.raw.prepare("SELECT title,line_account_id,account_ids FROM broadcasts WHERE id='foreign'").get())
    .toEqual({title:'foreign title',line_account_id:'b',account_ids:'["b"]'});
  expect(f.raw.prepare("SELECT row_id FROM tenant_purge_tombstone_progress WHERE tenant_id='t' AND table_name='broadcasts' AND row_id='shared'").get()).toEqual({row_id:'shared'});
  expect(f.raw.prepare("SELECT id FROM broadcast_approval_events WHERE id='shared-approval'").get()).toEqual({id:'shared-approval'});
  expect(f.raw.prepare("SELECT friend_id FROM broadcast_ab_recipients WHERE broadcast_id='shared'").all()).toEqual([{friend_id:'other-friend'}]);
  expect(f.raw.pragma('foreign_key_check')).toEqual([]);
});
