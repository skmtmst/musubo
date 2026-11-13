import { seedExistingRestaurantFollowup } from '../test-utils/restaurant-followup-fixture.js';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { forms } from './forms.js';
import { friends } from './friends.js';
import { formDocuments } from './form-documents.js';
import { deleteCustomerData, deletionJournalId, friendDeletionCondition } from '../services/customer-data-deletion.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import protectedRelations from '../services/customer-data-protected-relations.json';
import relations from '../services/customer-data-relations.json';
import { RETENTION_TABLES } from '@line-crm/db';
let sqlite: SqliteD1;
let staff: AuthenticatedStaff | undefined;
let objects: Set<string>;
let remove: ReturnType<typeof vi.fn>;
const answerUrl = '/api/forms/form/submissions/answer?account_id=a';
const friendUrl = '/api/friends/u/data';
const headers = (token = 'delete-form-response') => ({ 'X-Confirm-Irreversible': token });
const target = { kind: 'form_response' as const, id: 'answer', formId: 'form', friendId: 'u', accountId: 'a' };
function app() {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { if (staff) c.set('staff', staff); await next(); });
  app.route('/', forms); app.route('/', friends); app.route('/', formDocuments);
  return app;
}
function env(): Env['Bindings'] { return { DB: sqlite.db, IMAGES: { delete: remove } } as unknown as Env['Bindings']; }
function count(table: string) { return (sqlite.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
function document(id: string, submission: string | null, friend = 'u') {
  sqlite.raw.prepare(`INSERT INTO media_file_scans (id,line_account_id,subject_kind,subject_id,filename,mime_type,size_bytes,status)
    VALUES (?, 'a','form_file',?,'secret-id.pdf','application/pdf',12,'clean')`).run(`scan-${id}`, `private/${id}`);
  sqlite.raw.prepare(`INSERT INTO form_submission_files (id,line_account_id,form_id,block_id,friend_id,submission_id,file_kind,side,r2_key,filename,mime_type,size_bytes,scan_id,created_at)
    VALUES (?,'a','form','block',?,?,'identity','single',?,'secret-id.pdf','application/pdf',12,?,'2026-10-10')`).run(id, friend, submission, `private/${id}`, `scan-${id}`);
  objects.add(`private/${id}`);
}
beforeEach(() => {
  sqlite = createTestD1({ foreignKeys: true });
  staff = { id: 'env-owner', role: 'owner', tenantId: 't', readOnly: false } as AuthenticatedStaff;
  objects = new Set();
  remove = vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); });
  sqlite.raw.exec(`INSERT INTO tenants (id,name) VALUES ('t','Tenant'),('other','Other');
    INSERT INTO line_accounts (id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES ('a','A','ca','token','secret','t'),('b','B','cb','token','secret','other');
    INSERT INTO friends (id,line_user_id,line_account_id,display_name,metadata) VALUES ('u','LINE-private','a','customer-private','{"note":"private"}'),('v','LINE-other','a','Other','{}'),('x','LINE-foreign','b','Foreign','{}');
    INSERT INTO forms (id,name,fields,submit_count) VALUES ('form','F','[]',2);
    INSERT INTO form_accounts (form_id,line_account_id) VALUES ('form','a');
    INSERT INTO form_submissions (id,form_id,friend_id,data) VALUES ('answer','form','u','{"secret":"customer-private"}'),('other-answer','form','v','{}');`);
  document('doc', 'answer'); document('other-doc', 'other-answer', 'v');
});
afterEach(() => { sqlite.raw.close(); vi.restoreAllMocks(); });

describe('private data deletion', () => {
  it.each(['staff', 'viewer', 'anonymous', 'readOnlyOwner', 'readOnlyAdmin'])('rejects %s through both direct APIs', async role => {
    staff = role === 'anonymous' ? undefined : { ...staff!, role: role === 'readOnlyOwner' ? 'owner' : role === 'readOnlyAdmin' ? 'admin' : role, readOnly: role.startsWith('readOnly') } as AuthenticatedStaff;
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(403);
    expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(403);
    expect(count('form_submissions')).toBe(2); expect(remove).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin'])('allows %s, removes attachments, scans, capacity and claims; recounts answers', async role => {
    staff = { ...staff!, role } as AuthenticatedStaff;
    sqlite.raw.exec(`INSERT INTO form_capacity_claims (form_id,slot_key,submission_id,created_at) VALUES ('form','slot','answer','now');
      INSERT INTO form_submit_claims (tenant_id,line_account_id,form_id,friend_id,idempotency_key,request_hash,status,submission_id,owner,created_at,updated_at,expires_at) VALUES ('t','a','form','u','k','hash','completed','answer','owner','now','now','later');
      INSERT INTO form_submit_outbox (tenant_id,line_account_id,form_id,friend_id,idempotency_key,kind,event_id,payload,created_at,updated_at) VALUES ('t','a','form','u','k','webhook','evt','private-body','now','now');`);
    const response = await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env());
    expect(response.status).toBe(200);
    expect(objects.has('private/doc')).toBe(false); expect(objects.has('private/other-doc')).toBe(true);
    expect(count('form_submissions')).toBe(1); expect(count('form_submission_files')).toBe(1); expect(count('media_file_scans')).toBe(1);
    expect(count('form_capacity_claims')).toBe(0); expect(count('form_submit_claims')).toBe(0); expect(count('form_submit_outbox')).toBe(0);
    expect((sqlite.raw.prepare("SELECT submit_count FROM forms WHERE id='form'").get() as any).submit_count).toBe(1);
    const audit = sqlite.raw.prepare('SELECT * FROM operation_audit').all() as any[];
    expect(audit).toHaveLength(1); expect(audit[0].actor_id).toBe('env-owner'); expect(audit[0].action).toBe('deleted');
    expect(JSON.parse(audit[0].detail_json).completedAt).toBeTruthy();
    expect(JSON.stringify(audit)).not.toMatch(/customer-private|LINE-private|secret-id|private\/doc|private-body/);
    const replay = await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env());
    expect(replay.status).toBe(200); expect((await replay.json() as any).data.replayed).toBe(true); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit confirmation and refuses another tenant, including a completed replay', async () => {
    expect((await app().request(answerUrl, { method: 'DELETE' }, env())).status).toBe(428);
    expect((await app().request('/api/friends/x/data', { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(404);
    await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env());
    staff = { ...staff!, tenantId: 'other' };
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(404);
  });
  it('removes a friend, all answers and unattached documents, direct and indirect children while preserving another friend and retained records', async () => {
    document('abandoned', null);
    sqlite.raw.exec(`INSERT INTO chats (id,friend_id,notes,created_at,updated_at) VALUES ('chat','u','private-memo','now','now');
      INSERT INTO messages_log (id,friend_id,direction,message_type,content) VALUES ('msg','u','incoming','text','private-message');
      INSERT INTO tags (id,name) VALUES ('tag','Shared');
      INSERT INTO friend_tags (friend_id,tag_id) VALUES ('u','tag'),('v','tag');
      INSERT INTO operation_audit (id,target_kind,target_id,action,friend_id) VALUES ('retained','tag','tag','changed','u');`);
    const response = await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env());
    expect(response.status).toBe(200);
    expect(count('friends')).toBe(2); expect(count('chats')).toBe(0); expect(count('messages_log')).toBe(0);
    expect(count('form_submissions')).toBe(1); expect(count('form_submission_files')).toBe(1); expect(count('media_file_scans')).toBe(1);
    expect(count('tags')).toBe(1); expect(count('friend_tags')).toBe(1); expect(count('operation_audit')).toBe(2);
    expect(objects).toEqual(new Set(['private/other-doc']));
    expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(200);
    expect(sqlite.raw.pragma('foreign_key_check')).toEqual([]);
  });
  it('顧客データ削除で引き継ぎの移動記録も対象者だけ消す', async () => {
    sqlite.raw.exec(`INSERT INTO account_handovers(id,from_account_id,to_account_id,code,code_expires_at,status,created_at) VALUES('move','a','b','move-code','2030-01-01','completed','now');
      INSERT INTO account_handover_moves(handover_id,friend_id,from_account_id,to_account_id,tenant_id,moved_at) VALUES('move','u','a','b','t','now'),('move','v','a','b','t','now')`);
    const res = await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env());
    expect(res.status).toBe(200);
    expect(sqlite.raw.prepare('SELECT friend_id FROM account_handover_moves ORDER BY friend_id').all()).toEqual([{ friend_id: 'v' }]);
  });
  it('purges merged restaurant events and consumed QR data while retaining other friends and stamp history', async () => {
    sqlite.raw.exec(`INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('org','a','Restaurant','t');
      INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES ('store','org','Store','S','a');
      INSERT INTO visit_stamp_cards(id,tenant_id,name,settings_json) VALUES ('card','t','Card','{}');`);
    for (const friend of ['u', 'v']) {
      sqlite.raw.prepare(`INSERT INTO rt_reservation_events(id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json)
        VALUES (?,'store','restaurant.waitlist.invited',0,'now',?,'a',?,'{}')`).run(`event-${friend}`, `request-${friend}`, friend);
      sqlite.raw.prepare(`INSERT INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,occurred_at)
        VALUES (?,'card',?,'a','visit',1,'visit',?,'now')`).run(`stamp-${friend}`, friend, `stamp-${friend}`);
      sqlite.raw.prepare(`INSERT INTO visit_stamp_qr_codes(id,card_id,line_account_id,kind,token,issued_by,issued_at,expires_at,card_version,base_count,status,
        consumed_friend_id,consumed_at,consumed_entry_id,request_id,session_id,generation)
        VALUES (?,'card','a','staff',?,'owner','now','later',1,1,'used',?,'now',?,?,?,1)`)
        .run(`qr-${friend}`, `token-${friend}`, friend, `stamp-${friend}`, `qr-${friend}`, `session-${friend}`);
    }
    sqlite.raw.exec(`INSERT INTO visit_stamp_qr_codes(id,card_id,line_account_id,kind,token,issued_by,issued_at,card_version,base_count,request_id,session_id,generation)
      VALUES ('storefront','card','a','storefront','public-token','owner','now',1,1,'public','public',1);`);
    const response = await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env());
    expect(response.status).toBe(200);
    expect(sqlite.raw.prepare('SELECT friend_id FROM rt_reservation_events').all()).toEqual([{ friend_id: 'v' }]);
    expect(sqlite.raw.prepare('SELECT event_id FROM rt_reservation_event_receipts').all()).toEqual([
      { event_id: 'event-v' }, { event_id: 'event-v' }, { event_id: 'event-v' },
    ]);
    expect(sqlite.raw.prepare('SELECT id FROM visit_stamp_qr_codes ORDER BY id').all()).toEqual([{ id: 'qr-v' }, { id: 'storefront' }]);
    expect(count('visit_stamp_entries')).toBe(2);
    expect(sqlite.raw.pragma('foreign_key_check')).toEqual([]);
  });
  it('deletes restaurant confirmations and source jobs only for the target friend',async()=>{
    sqlite.raw.exec(`INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES('org','a','Restaurant','t');
      INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','Store','S','a');
      `);
    seedExistingRestaurantFollowup(sqlite,'store');
    sqlite.raw.exec("INSERT INTO scenario_versions(id,scenario_id,version_number,published_at,created_at,updated_at) VALUES('version','restaurant-followup:store',1,'now','now','now');");
    for(const friend of ['u','v']){
      sqlite.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES(?,'store','phone','人',2,'2027-01-01T00:00:00Z','2027-01-01T01:00:00Z','pending')").run('r-'+friend);
      sqlite.raw.prepare("INSERT INTO rt_reservation_confirmations(request_id,reservation_id,reservation_version,friend_id,requested_at,expires_at) VALUES(?,?,1,?,'now','later')").run('c-'+friend,'r-'+friend,friend);
      sqlite.raw.prepare("INSERT INTO scenario_source_jobs(id,line_account_id,friend_id,scenario_version_id,step_id,source_kind,source_id,source_event_id,source_version,scheduled_at,idempotency_key) VALUES(?,'a',?,'version','step','restaurant_reservation',?,'event',1,'now',?)").run('j-'+friend,friend,'r-'+friend,'key-'+friend);
    }
    expect((await app().request(friendUrl,{method:'DELETE',headers:headers('delete-friend-data')},env())).status).toBe(200);
    expect(sqlite.raw.prepare('SELECT friend_id FROM rt_reservation_confirmations').all()).toEqual([{friend_id:'v'}]);
    expect(sqlite.raw.prepare('SELECT friend_id FROM scenario_source_jobs').all()).toEqual([{friend_id:'v'}]);
    expect(count('rt_store_followup_templates')).toBe(1);expect(count('scenario_versions')).toBe(1);
    expect(sqlite.raw.pragma('foreign_key_check')).toEqual([]);
  });
  it('keeps database parents and keys after partial R2 failure, denies content and retries', async () => {
    document('doc2', 'answer');
    remove.mockImplementationOnce(async (keys: string[]) => { objects.delete(keys[0]); throw new Error('private-storage-error'); });
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(503);
    expect(count('form_submissions')).toBe(2); expect(count('form_submission_files')).toBe(3);
    expect((await app().request('/api/form-files/doc/content', {}, env())).status).toBe(409);
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(200);
    expect(objects).toEqual(new Set(['private/other-doc']));
  });
  it('rolls back every database deletion and completion audit on failure, then retries', async () => {
    sqlite.raw.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON form_submissions BEGIN SELECT RAISE(ABORT,'fail'); END;");
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(503);
    expect(count('form_submission_files')).toBe(2); expect(count('media_file_scans')).toBe(2);
    expect((sqlite.raw.prepare('SELECT action FROM operation_audit').get() as any).action).toBe('retryable');
    sqlite.raw.exec('DROP TRIGGER fail_delete');
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(200);
  });
  it('serializes a double click and a friend purge racing with an answer purge', async () => {
    let unblock!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    remove.mockImplementationOnce(async (keys: string[]) => { started(); await new Promise<void>(resolve => { unblock = resolve; }); keys.forEach(key => objects.delete(key)); });
    const first = app().request(answerUrl, { method: 'DELETE', headers: headers() }, env()); await entered;
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(409);
    expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(409);
    unblock(); expect((await first).status).toBe(200); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('recovers a dead worker lease and fences a stale worker', async () => {
    const token = 'old';
    sqlite.raw.prepare(`INSERT INTO operation_audit (id,target_kind,target_id,action,friend_id,detail_json) VALUES (?,'customer_deletion','answer','deleting','u',?)`)
      .run(deletionJournalId('form_response','answer'), JSON.stringify({ accountId: 'a', formId: 'form', token, leaseUntil: 0 }));
    expect(await deleteCustomerData(env(), target, 'new-actor')).toMatchObject({ deleted: true });
    expect((sqlite.raw.prepare('SELECT actor_id FROM operation_audit').get() as any).actor_id).toBe('new-actor');
  });
  it('does not lose a document that arrives during R2 deletion', async () => {
    remove.mockImplementationOnce(async (keys: string[]) => { keys.forEach(key => objects.delete(key)); document('late', 'answer'); });
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(503);
    expect(count('form_submission_files')).toBe(3); expect(count('form_submissions')).toBe(2);
    expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(200);
    expect(objects).toEqual(new Set(['private/other-doc']));
  });
  it('covers every schema friend reference and excludes retained or staff records', () => {
    for (const { name } of sqlite.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>) {
      if (RETENTION_TABLES[name]?.category !== 'purge' || name === 'staff_members') continue;
      const refs = sqlite.raw.pragma(`foreign_key_list(${name})`) as Array<{ table:string }>;
      const columns = sqlite.raw.pragma(`table_info(${name})`) as Array<{ name:string }>;
      if (refs.some(ref => ref.table === 'friends' || ref.table in relations) || columns.some(col => col.name === 'friend_id' || col.name.endsWith('_friend_id'))) expect(relations).toHaveProperty(name);
    }
    for (const table of Object.keys(relations)) expect(RETENTION_TABLES[table].category).toBe('purge');
    for (const [table, relation] of Object.entries(relations)) {
      const grouped = new Map<number, { parent: string; columns: Array<{ column: string; parentColumn: string }> }>();
      for (const ref of sqlite.raw.pragma(`foreign_key_list(${table})`) as Array<{ id:number; table:string; from:string; to:string }>) {
        if (!(ref.table in relations)) continue;
        const group = grouped.get(ref.id) ?? { parent: ref.table, columns: [] };
        group.columns.push({ column: ref.from, parentColumn: ref.to }); grouped.set(ref.id, group);
      }
      if (table !== 'form_capacity_claims') expect(relation.references).toEqual([...grouped.values()]);
    }
    // 生成した条件式が、実スキーマに対して実行可能なことを確かめる。
    for (const table of Object.keys(relations)) sqlite.raw.prepare(`SELECT * FROM "${table}" WHERE ${friendDeletionCondition(table)}`);
  });
});

function photo() {
  sqlite.raw.exec(`INSERT INTO nen_pet_profiles(id,friend_id,name,created_at,updated_at) VALUES ('pet','u','private-pet','now','now');
    INSERT INTO nen_photo_submissions(id,friend_id,pet_id,r2_key,image_url,content_type,created_at,updated_at,line_account_id) VALUES ('photo','u','pet','private/photo','https://example.test/private-photo','image/png','now','now','a');
    INSERT INTO nen_photo_derivatives(id,photo_id,line_account_id,kind,source_version,r2_key,content_type,created_at) VALUES ('derivative','photo','a','review',1,'private/derivative','image/png','now');`);
  objects.add('private/photo'); objects.add('private/derivative');
}
function photoAudit() {
  sqlite.raw.exec(`INSERT INTO nen_photo_original_download_audit(id,photo_id,line_account_id,requested_by,event,created_at) VALUES ('download-audit','photo','a','env-owner','downloaded','now');`);
}
it('deletes indirect photo derivatives while retaining detached audit history', async () => {
  photo(); photoAudit();
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(200);
  expect(count('nen_photo_original_download_audit')).toBe(1);
  expect(sqlite.raw.prepare('SELECT photo_id,photo_id_history FROM nen_photo_original_download_audit').get()).toEqual({photo_id:null,photo_id_history:'photo'});
  expect(count('nen_photo_submissions')).toBe(0); expect(count('nen_photo_derivatives')).toBe(0);
  expect(objects).toEqual(new Set(['private/other-doc']));
});
it('retains and detaches an audit inserted during R2 deletion in the same atomic batch', async () => {
  photo();
  remove.mockImplementationOnce(async (keys: string[]) => { keys.forEach(key => objects.delete(key)); photoAudit(); });
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(200);
  expect(count('nen_photo_original_download_audit')).toBe(1); expect(count('nen_photo_submissions')).toBe(0); expect(count('friends')).toBe(2);
  expect(sqlite.raw.prepare('SELECT photo_id,photo_id_history FROM nen_photo_original_download_audit').get()).toEqual({photo_id:null,photo_id_history:'photo'});
});
it('records completion in the visible audit feed atomically, with no customer text', async () => {
  await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env());
  const audit = sqlite.raw.prepare('SELECT * FROM audit_events').all() as any[];
  expect(audit).toHaveLength(1); expect(audit[0].actor_principal_id).toBe('env-owner'); expect(audit[0].tenant_id).toBe('t');
  expect(audit[0].action).toBe('customer.form_response.deleted'); expect(audit[0].created_at).toBeTruthy();
  expect(JSON.stringify(audit)).not.toMatch(/customer-private|LINE-private|secret-id|private\/doc/);
});
it('fences an expired execution after a second worker takes ownership', async () => {
  let unblock!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve });
  remove.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { unblock = resolve }) });
  const old = deleteCustomerData(env(), target, 'old-actor');
  const outcome = old.catch(error => error);
  await entered;
  sqlite.raw.exec("UPDATE operation_audit SET detail_json=json_set(detail_json,'$.leaseUntil',0)");
  expect(await deleteCustomerData(env(), target, 'new-actor')).toMatchObject({ deleted: true });
  unblock(); expect((await outcome).status).toBe(503);
  expect((sqlite.raw.prepare('SELECT actor_id,action FROM operation_audit').get() as any)).toMatchObject({ actor_id: 'new-actor', action: 'deleted' });
  expect(count('audit_events')).toBe(1);
});
it('protects every retained foreign key in the real schema', () => {
  for (const { name } of sqlite.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>) {
    if (RETENTION_TABLES[name]?.category !== 'retain') continue;
    const refs = sqlite.raw.pragma(`foreign_key_list(${name})`) as Array<{ table: string; on_delete: string }>;
    if (refs.some(ref => ref.table in relations && ref.on_delete !== 'SET NULL')) expect(protectedRelations).toHaveProperty(name);
  }
});
it('requires access to all linked accounts before deleting an orphan answer of a shared form', async () => {
  sqlite.raw.exec(`INSERT INTO form_accounts(form_id,line_account_id) VALUES ('form','b');
    INSERT INTO form_submissions(id,form_id,friend_id,data) VALUES ('orphan','form',NULL,'private-orphan');`);
  expect((await app().request('/api/forms/form/submissions/orphan?account_id=a', { method: 'DELETE', headers: headers() }, env())).status).toBe(404);
  expect(count('form_submissions')).toBe(3); expect(remove).not.toHaveBeenCalled();
});
it('keeps account and tenant boundaries on a friend deletion replay', async () => {
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(200);
  staff = { ...staff!, tenantId: 'other' };
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(404);
});
it('rolls back database deletion when the required completion audit cannot be saved', async () => {
  sqlite.raw.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fail'); END;");
  expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(503);
  expect(count('form_submissions')).toBe(2); expect(count('form_submission_files')).toBe(2); expect(count('media_file_scans')).toBe(2); expect(count('audit_events')).toBe(0);
  sqlite.raw.exec('DROP TRIGGER fail_audit');
  expect((await app().request(answerUrl, { method: 'DELETE', headers: headers() }, env())).status).toBe(200);
  expect(count('audit_events')).toBe(1);
});

it('preserves another customer conversion and attribution while detaching a deleted referrer', async () => {
  sqlite.raw.exec(`INSERT INTO affiliates(id,name,code,friend_id) VALUES ('affiliate','Private referrer','ref','u');
    INSERT INTO conversion_points(id,name,event_type) VALUES ('point','P','purchase');
    INSERT INTO conversion_events(id,conversion_point_id,friend_id,affiliate_id,affiliate_code) VALUES ('other-conversion','point','v','affiliate','ref');
    INSERT INTO affiliate_attribution_decisions(id,conversion_event_id,friend_id,conversion_point_id,affiliate_id,ref_code,reason,window_days,candidates_json) VALUES ('decision','other-conversion','v','point','affiliate','ref','matched_last_touch',30,'[{"affiliateId":"affiliate","affiliateName":"Private referrer","refCode":"ref"},{"affiliateId":"unrelated","affiliateName":"Keep this candidate","refCode":"other"}]');`);
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(200);
  expect(count('conversion_events')).toBe(1); expect(count('friends')).toBe(2); expect(count('affiliates')).toBe(0);
  expect(sqlite.raw.prepare('SELECT friend_id,affiliate_id,affiliate_code FROM conversion_events').get()).toEqual({friend_id:'v',affiliate_id:null,affiliate_code:null});
  expect(sqlite.raw.prepare('SELECT friend_id,affiliate_id,ref_code,candidates_json FROM affiliate_attribution_decisions').get()).toEqual({friend_id:'v',affiliate_id:null,ref_code:null,candidates_json:JSON.stringify([{affiliateId:'affiliate',affiliateName:'削除済みのお客さま',refCode:''},{affiliateId:'unrelated',affiliateName:'Keep this candidate',refCode:'other'}])});
});

it('denies post-action replay while the friend deletion is incomplete', async () => {
  remove.mockRejectedValueOnce(new Error('storage-failed'));
  expect((await app().request(friendUrl, { method: 'DELETE', headers: headers('delete-friend-data') }, env())).status).toBe(503);
  const retry = await app().request('/api/forms/form/submissions/answer/retry-effects?account_id=a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env());
  expect(retry.status).toBe(409); expect((await retry.json() as any).error).toBe('この回答は削除中です');
});

it.each(['answer', 'friend'])('fences %s ownership reassignment during R2 deletion', async kind => {
  remove.mockImplementationOnce(async (keys: string[]) => {
    keys.forEach(key => objects.delete(key));
    if (kind === 'answer') sqlite.raw.exec("UPDATE form_submissions SET friend_id='x' WHERE id='answer'");
    else sqlite.raw.exec("UPDATE friends SET line_account_id='b' WHERE id='u'");
  });
  const response = await app().request(kind === 'answer' ? answerUrl : friendUrl,
    { method: 'DELETE', headers: headers(kind === 'answer' ? 'delete-form-response' : 'delete-friend-data') }, env());
  expect(response.status).toBe(503); expect(count('friends')).toBe(3); expect(count('form_submissions')).toBe(2); expect(count('form_submission_files')).toBe(2);
  expect(count('audit_events')).toBe(0);
});

it('retains all 13 tables, all amounts and other customers through failure, retry and replay; readers/CSV stay complete', async () => {
  const { seedDeletionRecords } = await import('../../../../packages/db/test/fixtures/customer-deletion.mjs');
  const { getClosedAccountSettlement, prepareAffiliateStatement, createAffiliateStatement, getAffiliatePayoutBatchExport, getAffiliateStatementReplay, listAffiliateStatementsForSelf, createAffiliatePayoutBatch, consumePhotoOriginalDownload, claimPhotoNotificationDelivery, getBookingSalesSummary, requestPhotoAssessment } = await import('@line-crm/db');
  seedDeletionRecords(sqlite.raw, 'deleted', 'fixture-friend');
  seedDeletionRecords(sqlite.raw, 'kept', 'kept-friend');
  sqlite.raw.exec("UPDATE affiliate_settlements SET period_from='2025-10-01T00:00:00Z',period_to='2025-11-01T00:00:00Z' WHERE id='kept-0-settlement'");
  const tables=Object.keys(protectedRelations);
  const retained = () => Object.fromEntries(tables.map(t=>[t,sqlite.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string,unknown>[]]));
  const before=retained();
  const ownTarget={kind:'friend_data' as const,id:'fixture-friend',friendId:'fixture-friend',accountId:'fixture-account',lineUserId:'LINE-fixture-friend'};
  sqlite.raw.exec("CREATE TRIGGER fail_del36b BEFORE DELETE ON friends WHEN OLD.id='fixture-friend' BEGIN SELECT RAISE(ABORT,'test'); END");
  await expect(deleteCustomerData(env(),ownTarget,'owner')).rejects.toMatchObject({status:503});
  expect(retained()).toEqual(before);
  expect(sqlite.raw.prepare("SELECT id FROM friends WHERE id='fixture-friend'").get()).toBeTruthy();
  sqlite.raw.exec('DROP TRIGGER fail_del36b');
  expect(await deleteCustomerData(env(),ownTarget,'owner')).toMatchObject({deleted:true,replayed:false});
  expect(await deleteCustomerData(env(),ownTarget,'owner')).toMatchObject({deleted:true,replayed:true});
  const after=retained();
  for(const [table,refs] of Object.entries(protectedRelations)) {
    expect(after[table]).toHaveLength(before[table].length);
    const columns=refs.flatMap(r=>r.columns.map(c=>c.column));
    for(let i=0;i<before[table].length;i++) {
      const old=before[table][i], now=after[table][i];
      const deleted=(old.id ?? old.token_hash as string).toString().startsWith('deleted-');
      for(const [column,value] of Object.entries(old)) {
        if(deleted && columns.includes(column)) expect(now[column]).toBeNull();
        else expect(now[column]).toEqual(value);
      }
    }
    for(const amount of ['amount','amount_minor','total_amount_minor','paid_amount_minor']) {
      expect(after[table].reduce((n,r)=>n+Number(r[amount]??0),0)).toBe(before[table].reduce((n,r)=>n+Number(r[amount]??0),0));
    }
  }
  expect(sqlite.raw.prepare("SELECT id FROM friends WHERE id='kept-friend'").get()).toBeTruthy();
  expect(sqlite.raw.prepare("SELECT id FROM conversion_events WHERE id='kept-0-conversion'").get()).toBeTruthy();
  expect(sqlite.raw.pragma('foreign_key_check')).toEqual([]);
  const scope={tenantId:'fixture-tenant',lineAccountId:'fixture-account'};
  const resume=await getClosedAccountSettlement(sqlite.db,{...scope,periodFrom:'2026-10-01T00:00:00Z',periodTo:'2026-11-01T00:00:00Z'});
  expect(resume?.totalAmount).toBe(900);
  expect(resume?.affiliates).toEqual([expect.objectContaining({affiliateId:'deleted-0-affiliate',affiliateName:'削除済みのお客さま',amount:900,statementIssued:true})]);
  const snapshot=await prepareAffiliateStatement(sqlite.db,{...scope,settlementId:'deleted-0-settlement',affiliateId:'deleted-0-affiliate'});
  expect(snapshot).toMatchObject({affiliateName:'削除済みのお客さま',totalAmount:900,grossAmount:1000,deductionAmount:100,lineCount:2});
  expect(await createAffiliateStatement(sqlite.db,{...scope,snapshot:snapshot!,objectKey:'synthetic.pdf',checksum:'fake',idempotencyKey:'deleted-statement',requestFingerprint:'fake',actorId:'owner',expiresAt:'2999-01-01'})).toMatchObject({affiliateId:'deleted-0-affiliate',totalAmount:900});
  expect(await getAffiliateStatementReplay(sqlite.db,{...scope,idempotencyKey:'deleted-statement'})).toMatchObject({statement:{affiliateId:'deleted-0-affiliate'}});
  expect(await listAffiliateStatementsForSelf(sqlite.db,{...scope,affiliateId:'deleted-0-affiliate'})).toEqual([]);
  expect(await getAffiliatePayoutBatchExport(sqlite.db,{...scope,batchId:'deleted-0-batch'})).toMatchObject({lines:[{affiliateId:'deleted-0-affiliate',amount:900}]});
  expect(await createAffiliatePayoutBatch(sqlite.db,{...scope,settlementId:'deleted-0-settlement',expectedVersion:1,idempotencyKey:'new-batch',requestFingerprint:'fake',actorId:'owner',bankFormat:'zengin_csv'})).toMatchObject({kind:'bank_missing',missingAffiliateIds:['deleted-0-affiliate']});
  const sales=await getBookingSalesSummary(sqlite.db,'fixture-account','2026-10-01','2026-11-01');
  expect(sales.total.paidRevenue).toBe(2000);
  expect(sales.menus).toContainEqual(expect.objectContaining({menu_name:'削除済みのお客さま',paidRevenue:1000}));
  expect(await requestPhotoAssessment(sqlite.db,{id:'replay-run',photoId:'deleted-0-photo',lineAccountId:'fixture-account',expectedVersion:1,actorId:'fixture-staff',idempotencyKey:'deleted-0',requestFingerprint:'deleted-0'})).toMatchObject({kind:'duplicate',run:{photoId:null,customerName:'削除済みのお客さま'}});
  expect(await consumePhotoOriginalDownload(sqlite.db,{tokenHash:'deleted-0-grant',lineAccountId:'fixture-account',actorId:'fixture-staff'})).toBeNull();
  expect(await claimPhotoNotificationDelivery(sqlite.db,{decisionId:'deleted-0-review',lineAccountId:'fixture-account',leaseId:'lease',leaseExpiresAt:'2999-01-01'})).toBeNull();
});

it('refuses a partial schema before intent, R2 or customer data changes', async () => {
  sqlite.raw.exec(`DROP TRIGGER booking_payments_history_insert;
    DROP TRIGGER booking_payments_history_detach;
    ALTER TABLE booking_payments DROP COLUMN booking_id_history;`);
  const response=await app().request(friendUrl,{method:'DELETE',headers:headers('delete-friend-data')},env());
  expect(response.status).toBe(409);
  expect((await response.json() as any).code).toBe('deletion_schema_approval_required');
  expect(count('operation_audit')).toBe(0); expect(count('friends')).toBe(3); expect(remove).not.toHaveBeenCalled();
});

it('keeps two deleted customers separate in an existing CSV batch instead of merging NULL references', async () => {
  const { seedDeletionRecords } = await import('../../../../packages/db/test/fixtures/customer-deletion.mjs');
  const { getAffiliatePayoutBatchExport } = await import('@line-crm/db');
  seedDeletionRecords(sqlite.raw,'first','first-person');
  seedDeletionRecords(sqlite.raw,'second','second-person');
  sqlite.raw.exec("UPDATE affiliate_payout_batch_lines SET batch_id='first-0-batch' WHERE id='second-0-payout'; UPDATE affiliate_payout_batches SET total_amount_minor=1800,line_count=2 WHERE id='first-0-batch'");
  for(const id of ['first-person','second-person']) {
    await deleteCustomerData(env(),{kind:'friend_data',id,friendId:id,accountId:'fixture-account',lineUserId:`LINE-${id}`},'owner');
  }
  const exported=await getAffiliatePayoutBatchExport(sqlite.db,{tenantId:'fixture-tenant',lineAccountId:'fixture-account',batchId:'first-0-batch'});
  expect(exported?.lines).toHaveLength(2);
  expect(exported?.lines.map(l=>l.affiliateId).sort()).toEqual(['first-0-affiliate','second-0-affiliate']);
  expect(exported?.lines.reduce((n,l)=>n+l.amount,0)).toBe(1800);
});

it('accepts a late payment result without recreating a deleted booking or adding another audit', async () => {
  const { seedDeletionRecords } = await import('../../../../packages/db/test/fixtures/customer-deletion.mjs');
  const { applyPaidBookingPayment } = await import('./booking-payments.js');
  seedDeletionRecords(sqlite.raw,'late','late-person');
  sqlite.raw.exec("UPDATE booking_payments SET status='pending',provider_payment_id='synthetic-provider' WHERE id='late-0-payment'");
  await deleteCustomerData(env(),{kind:'friend_data',id:'late-person',friendId:'late-person',accountId:'fixture-account',lineUserId:'LINE-late-person'},'owner');
  expect(await applyPaidBookingPayment(sqlite.db,'synthetic-provider')).toEqual({duplicate:false});
  expect(await applyPaidBookingPayment(sqlite.db,'synthetic-provider')).toEqual({duplicate:true});
  expect(sqlite.raw.prepare("SELECT booking_id,status,amount FROM booking_payments WHERE id='late-0-payment'").get()).toEqual({booking_id:null,status:'paid',amount:1000});
  expect(count('bookings')).toBe(0); expect(count('booking_audit_logs')).toBe(1);
});
