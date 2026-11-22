import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCustomerData } from './customer-data-deletion.js';
import { cleanupDeliveryOrphans } from './delivery-orphan-cleanup.js';

let mf: Miniflare;
let native: Awaited<ReturnType<Miniflare['getD1Database']>>;
let sequence = 0;
let friendId: string, submissionId: string, scanId: string, fileId: string;
let remove: ReturnType<typeof vi.fn<(keys: string | string[]) => Promise<void>>>;
const db = () => native as unknown as D1Database;
const target = (kind: 'friend_data' | 'form_response') => ({ kind, id: kind === 'friend_data' ? friendId : submissionId,
  friendId, accountId: 'account', formId: 'form', lineUserId: `LINE-${friendId}` });
const env = () => ({ DB: db(), IMAGES: { delete: remove } });

describe('local workerd D1 binding', () => {
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
    native = await mf.getD1Database('DB');
    const sql = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
    // 実 D1 相当の既存試験と同じ正規化済み bootstrap 分割を使う。
    const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).reduce<string[]>((result, line) => {
      result[result.length - 1] += `\n${line}`;
      if (line.trimEnd().endsWith(';')) result.push('');
      return result;
    }, ['']).map(statement => statement.trim()).filter(Boolean);
    for (let offset = 0; offset < statements.length; offset += 50) await native.batch(statements.slice(offset, offset + 50).map(statement => native.prepare(statement)));
    await native.batch([
      native.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES ('account','A','channel','token','secret')"),
      native.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES ('other','LINE-other','account')"),
      native.prepare("INSERT INTO forms(id,name,fields) VALUES ('form','F','[]')"),
    ]);
  }, 120_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    sequence++; friendId = `friend-${sequence}`; submissionId = `submission-${sequence}`; scanId = `scan-${sequence}`; fileId = `file-${sequence}`;
    remove = vi.fn(async () => {});
    await native.batch([
      native.prepare('INSERT INTO friends(id,line_user_id,line_account_id) VALUES (?,?,?)').bind(friendId, `LINE-${friendId}`, 'account'),
      native.prepare('INSERT INTO form_submissions(id,form_id,friend_id,data) VALUES (?,?,?,?)').bind(submissionId, 'form', friendId, '{"private":"customer body"}'),
      native.prepare('INSERT INTO media_file_scans(id,line_account_id,subject_kind,subject_id,filename,mime_type,size_bytes,status) VALUES (?,?,?,?,?,?,?,?)').bind(scanId, 'account', 'form_file', `private/${fileId}`, 'private-name.pdf', 'application/pdf', 10, 'clean'),
      native.prepare('INSERT INTO form_submission_files(id,line_account_id,form_id,block_id,friend_id,submission_id,file_kind,side,r2_key,filename,mime_type,size_bytes,scan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(fileId, 'account', 'form', 'block', friendId, submissionId, 'identity', 'single', `private/${fileId}`, 'private-name.pdf', 'application/pdf', 10, scanId, 'now'),
    ]);
  });
  it('deletes answer, object, scan and audit atomically and replays once', async () => {
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ deleted: true, replayed: false });
    expect(await native.prepare('SELECT id FROM form_submissions WHERE id=?').bind(submissionId).first()).toBeNull();
    expect(await native.prepare('SELECT id FROM media_file_scans WHERE id=?').bind(scanId).first()).toBeNull();
    expect(await native.prepare('SELECT id FROM friends WHERE id=?').bind(friendId).first()).toBeTruthy();
    const audit = await native.prepare('SELECT * FROM audit_events WHERE source_id=?').bind(`customer-delete:form_response:${submissionId}`).first();
    expect(audit).toMatchObject({ actor_principal_id: 'owner', action: 'customer.form_response.deleted', result: 'success' });
    expect(JSON.stringify(audit)).not.toMatch(/customer body|private-name|LINE-/);
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ replayed: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith([`private/${fileId}`]);
  }, 30_000);
  it('executes the full friend relation graph with D1 numbered bindings', async () => {
    expect(await deleteCustomerData(env(), target('friend_data'), 'owner')).toMatchObject({ deleted: true });
    expect(await native.prepare('SELECT id FROM friends WHERE id=?').bind(friendId).first()).toBeNull();
    expect(await native.prepare("SELECT id FROM friends WHERE id='other'").first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM form_submission_files WHERE id=?').bind(fileId).first()).toBeNull();
    expect(remove).toHaveBeenCalledExactlyOnceWith([`private/${fileId}`]);
  }, 30_000);
  it('deletes delivery order items together with the matching friend order', async () => {
    await native.batch([
      native.prepare("INSERT INTO rt_delivery_orders(id,account_id,store_id,service,external_order_id,order_number,received_at,friend_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind('order-'+friendId,'account','store','line','external-'+friendId,'1',1,friendId,1,1),
      native.prepare("INSERT INTO rt_delivery_order_items(id,order_id,name,note,created_at) VALUES (?,?,?,?,?)").bind('item-'+friendId,'order-'+friendId,'private name','private note',1),
      native.prepare("INSERT INTO rt_delivery_orders(id,account_id,store_id,service,external_order_id,order_number,received_at,friend_id,created_at,updated_at) VALUES ('other-order','account','store','line','other-order','2',1,'other',1,1)"),
      native.prepare("INSERT INTO rt_delivery_order_items(id,order_id,name,created_at) VALUES ('other-item','other-order','other',1)"),
    ]);
    await deleteCustomerData(env(), target('friend_data'), 'owner');
    expect(await native.prepare('SELECT id FROM rt_delivery_order_items WHERE id=?').bind('item-'+friendId).first()).toBeNull();
    expect(await native.prepare("SELECT id FROM rt_delivery_order_items WHERE id='other-item'").first()).toBeTruthy();
  }, 30_000);
  it('audits only the count of orphans atomically on a native D1 binding', async () => {
    await native.prepare("INSERT INTO rt_delivery_order_items(id,order_id,name,note,created_at) VALUES ('orphan-native','absent','private','private note',1)").run();
    expect(await cleanupDeliveryOrphans(db())).toBe(1);
    expect(await cleanupDeliveryOrphans(db())).toBe(0);
    const audits = await native.prepare("SELECT after_json FROM audit_events WHERE action='privacy.delivery_orphans.cleaned'").all();
    expect(audits.results).toEqual([{after_json:'{\"deletedRows\":1}'}]);
  }, 30_000);
  it('rolls D1 batch back on an error after attachment deletion, then retries', async () => {
    await native.prepare("CREATE TRIGGER fail_customer_delete BEFORE DELETE ON form_submissions BEGIN SELECT RAISE(ABORT,'fail'); END").run();
    await expect(deleteCustomerData(env(), target('form_response'), 'owner')).rejects.toMatchObject({ status: 503 });
    expect(await native.prepare('SELECT id FROM form_submissions WHERE id=?').bind(submissionId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM form_submission_files WHERE id=?').bind(fileId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM media_file_scans WHERE id=?').bind(scanId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM audit_events WHERE source_id=?').bind(`customer-delete:form_response:${submissionId}`).first()).toBeNull();
    await native.prepare('DROP TRIGGER fail_customer_delete').run();
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ deleted: true });
  }, 30_000);
});
