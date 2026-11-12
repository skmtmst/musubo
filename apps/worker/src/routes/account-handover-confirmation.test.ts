import { describe, expect, it } from 'vitest';
import { cancelHandover, markExecuting, rollbackHandover, saveDecision } from '@line-crm/db';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { moveHandoverFriend } from '../services/account-handover-move.js';

describe('引き継ぎの実績からの切り戻し', () => {
  function setup() {
    const { raw, db } = createTestD1();
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES
      ('from','from','From','token','secret','00000000-0000-4000-8000-000000000001'),
      ('to','to','To','token','secret','00000000-0000-4000-8000-000000000001');
      INSERT INTO account_handovers(id,from_account_id,to_account_id,code,code_expires_at,status,created_at,completed_at)
      VALUES('ho','from','to','TEST','2099-01-01','completed','2026-01-01',datetime('now'));
      INSERT INTO friends(id,line_user_id,line_account_id) VALUES('moved','U-moved','to'),('already','U-already','to');
      INSERT INTO account_handover_decisions(id,handover_id,from_friend_id,decision,bucket,decided_at) VALUES
      ('d1','ho','moved','new','auto','now'),('d2','ho','already','new','auto','now')`);
    return {raw,db};
  }
  it('記録のない古い引き継ぎを戻さない', async () => {
    const {raw,db}=setup(); const result=await rollbackHandover(db,'ho',{});
    expect(result).toMatchObject({ok:false,error:expect.stringContaining('記録がない')});
    expect(raw.prepare("SELECT line_account_id FROM friends WHERE id='already'").get()).toEqual({line_account_id:'to'});
  });
  it('記録された人だけを戻し、元から移動先にいた人は戻さない', async () => {
    const {raw,db}=setup();
    raw.exec("INSERT INTO account_handover_moves VALUES('ho','moved','from','to','00000000-0000-4000-8000-000000000001','now')");
    const result=await rollbackHandover(db,'ho',{}); expect(result).toMatchObject({ok:true,restoredCount:1});
    expect(raw.prepare("SELECT id,line_account_id FROM friends ORDER BY id").all()).toEqual([{id:'already',line_account_id:'to'},{id:'moved',line_account_id:'from'}]);
  });
  it('同じ移動元と先の別の引き継ぎの人は戻さない', async () => {
    const {raw,db}=setup();
    raw.exec("INSERT INTO account_handovers(id,from_account_id,to_account_id,code,code_expires_at,status,created_at,completed_at) VALUES('ho2','from','to','TEST2','2099-01-01','completed','2026-01-01',datetime('now')); INSERT INTO account_handover_moves VALUES('ho','moved','from','to','00000000-0000-4000-8000-000000000001','now'),('ho2','already','from','to','00000000-0000-4000-8000-000000000001','now')");
    expect(await rollbackHandover(db,'ho',{})).toMatchObject({ok:true,restoredCount:1});
    expect(raw.prepare("SELECT id,line_account_id FROM friends ORDER BY id").all()).toEqual([{id:'already',line_account_id:'to'},{id:'moved',line_account_id:'from'}]);
  });
  it('同じ引き継ぎに他の統括の記録が混ざると全員戻さない', async () => {
    const {raw,db}=setup();
    raw.exec("INSERT INTO account_handover_moves VALUES('ho','moved','from','to','00000000-0000-4000-8000-000000000001','now'),('ho','already','from','to','other-tenant','now')");
    expect((await rollbackHandover(db,'ho',{})).ok).toBe(false);
    expect(raw.prepare("SELECT id,line_account_id FROM friends ORDER BY id").all()).toEqual([{id:'already',line_account_id:'to'},{id:'moved',line_account_id:'to'}]);
  });
  it('移動元と移動先の統括が異なれば移動も実績保存もしない', async () => {
    const {raw,db}=setup();
    raw.exec("UPDATE friends SET line_account_id='from' WHERE id='moved'; UPDATE account_handovers SET status='executing' WHERE id='ho'; UPDATE line_accounts SET tenant_id='other-tenant' WHERE id='to'");
    await expect(moveHandoverFriend(db,{handoverId:'ho',friendId:'moved',fromAccountId:'from',toAccountId:'to',targetFriendId:null})).rejects.toThrow();
    expect(raw.prepare("SELECT line_account_id FROM friends WHERE id='moved'").get()).toEqual({line_account_id:'from'});
    expect(raw.prepare('SELECT COUNT(*) n FROM account_handover_moves').get()).toEqual({n:0});
  });
  it('移動元の現在の統括と記録が違えば戻さない', async () => {
    const {raw,db}=setup();
    raw.exec("INSERT INTO account_handover_moves VALUES('ho','moved','from','to','different-tenant','now')");
    const result=await rollbackHandover(db,'ho',{}); expect(result.ok).toBe(false);
    expect(raw.prepare("SELECT line_account_id FROM friends WHERE id='moved'").get()).toEqual({line_account_id:'to'});
  });
  it('切り戻しの古い確認は拒み、正しい版だけ一度通す', async () => {
    const {raw,db}=setup(); raw.exec("INSERT INTO account_handover_moves VALUES('ho','moved','from','to','00000000-0000-4000-8000-000000000001','now')");
    expect(await rollbackHandover(db,'ho',{expectedRevision:2})).toMatchObject({ok:false,conflict:true});
    expect(await rollbackHandover(db,'ho',{expectedRevision:1})).toMatchObject({ok:true,restoredCount:1});
    expect((await rollbackHandover(db,'ho',{expectedRevision:1})).ok).toBe(false);
  });
  it('判断の更新は版を進め、本実行が始まった後の変更を拒む', async () => {
    const {raw,db}=setup(); raw.exec("UPDATE account_handovers SET status='previewed' WHERE id='ho'");
    await saveDecision(db,{handoverId:'ho',fromFriendId:'moved',decision:'skip',bucket:'auto'});
    expect(raw.prepare("SELECT confirmation_revision FROM account_handovers WHERE id='ho'").get()).toEqual({confirmation_revision:2});
    expect(await markExecuting(db,'ho',1)).toBe(false);
    expect(await markExecuting(db,'ho',2)).toBe(true);
    await expect(saveDecision(db,{handoverId:'ho',fromFriendId:'moved',decision:'new',bucket:'auto'})).rejects.toThrow('HANDOVER_STATE_CONFLICT');
  });
  it('取消は古い版を拒み、正しい版と版なしは通す', async () => {
    const {raw,db}=setup(); raw.exec("UPDATE account_handovers SET status='linked' WHERE id='ho'");
    expect(await cancelHandover(db,'ho',2)).toBe(false); expect(await cancelHandover(db,'ho',1)).toBe(true);
    raw.exec("UPDATE account_handovers SET status='linked' WHERE id='ho'");
    expect(await cancelHandover(db,'ho')).toBe(true);
  });
  it('移動と実績を同じまとまりで保存し、保存失敗なら移動も巻き戻す', async () => {
    const {raw,db}=setup(); raw.exec("UPDATE friends SET line_account_id='from' WHERE id='moved'; UPDATE account_handovers SET status='executing' WHERE id='ho'");
    const input={handoverId:'ho',friendId:'moved',fromAccountId:'from',toAccountId:'to',targetFriendId:null};
    raw.exec("CREATE TRIGGER fail_handover_move BEFORE INSERT ON account_handover_moves BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(moveHandoverFriend(db,input)).rejects.toThrow('fixture failure');
    expect(raw.prepare("SELECT line_account_id FROM friends WHERE id='moved'").get()).toEqual({line_account_id:'from'});
    raw.exec('DROP TRIGGER fail_handover_move');
    expect(await moveHandoverFriend(db,input)).toBe(true);
    expect(raw.prepare("SELECT friend_id,from_account_id,to_account_id,tenant_id FROM account_handover_moves").get()).toEqual({friend_id:'moved',from_account_id:'from',to_account_id:'to',tenant_id:'00000000-0000-4000-8000-000000000001'});
  });
});
