import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
const line = vi.hoisted(() => ({ batches: [] as string[][], broadcastCalls: 0 }));
vi.mock('@line-crm/line-sdk', () => ({ LineClient: class {
  async broadcast() { line.broadcastCalls++; return { requestId: 'all' }; }
  async multicast(to: string[]) { line.batches.push(to); return { requestId: 'limited' }; }
  async pushMessageWithRequestId(to: string) { line.batches.push([to]); return { data: {}, requestId: 'limited' }; }
} }));
vi.mock('../../services/stealth.js', async original => ({ ...await original<Record<string,unknown>>(), sleep: async () => {}, calculateStaggerDelay: () => 0 }));
const { processBroadcastSend, processQueuedBroadcasts, processScheduledBroadcasts, guardScheduledBroadcastQuota } = await import('./broadcast.js');
const { renewLimitedReservation, freezeLimitedAudience, holdLimitedBroadcast } = await import('./broadcast-delivery-limit.js');
const { getBroadcastById, requestBroadcastStop, resumeBroadcastSending, beginBroadcastRetryAttempt, reopenFailedClaims, recoverStalledBroadcasts } = await import('@line-crm/db');
const { tryReserveQuotaSlot } = await import('./broadcast-quota-guard.js');
const { LineClient } = await import('@line-crm/line-sdk');
function seed(store: SqliteD1, deliveryLimit: unknown) {
  for (const id of ['own', 'other']) store.raw.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES(?,?,?,?,?,1)`).run(id,id,id,`token-${id}`,'test');
  for (const [id, account] of [['a','own'],['b','own'],['c','own'],['foreign','other']]) store.raw.prepare(`INSERT INTO friends(id,line_user_id,display_name,line_account_id,is_following) VALUES(?,?,?,?,1)`).run(id,`U-${id}`,id,account);
  store.raw.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,message_options_json,track_links,measure_opens) VALUES('limited','notice','text','hello','all','draft','own',?,0,0)`).run(JSON.stringify({deliveryLimit,deliveryLimitConfirmation:{broadcastId:'limited',recipientCount:2,version:1}}));
}
beforeEach(() => { line.batches=[];line.broadcastCalls=0;vi.stubGlobal('fetch',vi.fn(async input => new Response(JSON.stringify(String(input).endsWith('/consumption')?{totalUsage:8}:{type:'limited',value:10}),{status:200}))); });
afterEach(() => { vi.unstubAllGlobals();vi.restoreAllMocks(); });
describe('配信先の上限と残り通数', () => {
  it('送信済みを含む場合も古い処理は新世代を停止しない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.exec("UPDATE broadcasts SET status='sending',batch_offset=-1 WHERE id='limited'");
      store.raw.exec("INSERT INTO broadcast_send_claims (broadcast_id,friend_id,line_account_id,attempt_no,state,dispatched_at) VALUES ('limited','a','own',1,'claimed','2026-01-01')");
      const old=(await getBroadcastById(store.db,'limited'))!;
      store.raw.exec("UPDATE broadcasts SET lock_version=lock_version+1 WHERE id='limited'");
      await holdLimitedBroadcast(store.db,old,'古い処理');
      expect((await getBroadcastById(store.db,'limited'))!.stopped_at).toBeNull();
    }finally{store.raw.close();}
  });
  it('復旧前の処理は新しい世代の送信枠を更新しない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.exec("UPDATE broadcasts SET status='sending',batch_offset=-1 WHERE id='limited'");
      const old=(await getBroadcastById(store.db,'limited'))!;
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,0,10)).toBe(true);
      store.raw.exec("UPDATE broadcasts SET lock_version=lock_version+1 WHERE id='limited'");
      await expect(renewLimitedReservation(store.db,old,1)).rejects.toThrow();
      const row=store.raw.prepare("SELECT value FROM account_settings WHERE line_account_id='own' AND key='broadcast_quota_reservations'").get() as {value:string};
      expect(JSON.parse(row.value)).toEqual(expect.arrayContaining([expect.objectContaining({broadcastId:'limited',planned:2})]));
    }finally{store.raw.close();}
  });
  it('停止を記録した直後に新しい世代が確保した送信枠は解除しない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.exec("UPDATE broadcasts SET status='sending',batch_offset=-1 WHERE id='limited'");
      const old=(await getBroadcastById(store.db,'limited'))!;
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,0,10)).toBe(true);
      const original=store.db.prepare.bind(store.db);let advanced=false;
      const spy=vi.spyOn(store.db,'prepare').mockImplementation(sql=>{
        if(!advanced && sql.includes('SELECT value FROM account_settings')){advanced=true;store.raw.exec("UPDATE broadcasts SET status='sending',lock_version=lock_version+1 WHERE id='limited'");}
        return original(sql);
      });
      try{await holdLimitedBroadcast(store.db,old,'古い処理');}finally{spy.mockRestore();}
      expect(advanced).toBe(true);
      const row=store.raw.prepare("SELECT value FROM account_settings WHERE line_account_id='own' AND key='broadcast_quota_reservations'").get() as {value:string};
      expect(JSON.parse(row.value)).toEqual(expect.arrayContaining([expect.objectContaining({broadcastId:'limited'})]));
    }finally{store.raw.close();}
  });
  it.each([false,true])('上限を確認した配信が自動復旧しても確認印を保ち送り切る（差し込み=%s）',async personalized=>{
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      if(personalized)store.raw.exec("UPDATE broadcasts SET message_content='{{name}} さん' WHERE id='limited'");
      const client=new LineClient('unused');await processBroadcastSend(store.db,client,'limited');
      store.raw.prepare("UPDATE broadcasts SET batch_offset=-1,batch_lock_at=datetime('now','-1 hour'),success_count=? WHERE id='limited'").run(personalized?1:0);
      await recoverStalledBroadcasts(store.db);
      const row=(await getBroadcastById(store.db,'limited'))!;
      expect(row.lock_version).toBe(2);
      expect(JSON.parse(row.message_options_json!).deliveryLimitConfirmation.version).toBe(2);
      await processQueuedBroadcasts(store.db,client);
      expect(line.batches.flat()).toHaveLength(2);
      expect((await getBroadcastById(store.db,'limited'))!.status).toBe('sent');
    }finally{store.raw.close();}
  });
  it('復旧前の処理は新しい世代の送信枠を解除しない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.exec("UPDATE broadcasts SET status='sending',batch_offset=-1 WHERE id='limited'");
      const old=(await getBroadcastById(store.db,'limited'))!;
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,0,10)).toBe(true);
      store.raw.exec("UPDATE broadcasts SET lock_version=lock_version+1 WHERE id='limited'");
      await holdLimitedBroadcast(store.db,old,'古い処理');
      expect((await getBroadcastById(store.db,'limited'))!.status).toBe('sending');
      const reservation=store.raw.prepare("SELECT value FROM account_settings WHERE line_account_id='own' AND key='broadcast_quota_reservations'").get() as {value:string};
      expect(JSON.parse(reservation.value)).toEqual(expect.arrayContaining([expect.objectContaining({broadcastId:'limited'})]));
    }finally{store.raw.close();}
  });
  it('サーバーの確認の印が無ければ、直接呼ばれても送らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:false,maxRecipients:2});
      store.raw.prepare("UPDATE broadcasts SET message_options_json=? WHERE id='limited'").run(JSON.stringify({deliveryLimit:{upToRemainingQuota:false,maxRecipients:2}}));
      await expect(processBroadcastSend(store.db,new LineClient('unused'),'limited')).rejects.toThrow('確認');
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });
  it('確認した版が違えば、上限を使い回さず止める', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});store.raw.prepare("UPDATE broadcasts SET lock_version=2 WHERE id='limited'").run();
      await expect(processBroadcastSend(store.db,new LineClient('unused'),'limited')).rejects.toThrow('確認');
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });
  it('枠と候補が増えても、予約で了承した2人を超えて送らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at='2020-01-01T00:00:00Z' WHERE id='limited'").run();
      vi.stubGlobal('fetch',vi.fn(async input=>new Response(JSON.stringify(String(input).endsWith('/consumption')?{totalUsage:0}:{type:'limited',value:1000}))));
      const client=new LineClient('unused');await processScheduledBroadcasts(store.db,client);await processQueuedBroadcasts(store.db,client);
      expect(line.broadcastCalls).toBe(0);expect(line.batches.flat()).toHaveLength(2);
    }finally{store.raw.close();}
  });
  it('同意が無い人と、非表示の人は抽選の候補にも入らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:false,maxRecipients:2});
      store.raw.prepare("UPDATE friends SET is_hidden=1 WHERE id='b'").run();
      store.raw.prepare("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('own','c','marketing','revoked','test','test')").run();
      const client=new LineClient('unused');await processBroadcastSend(store.db,client,'limited');await processQueuedBroadcasts(store.db,client);
      expect(store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited'").all()).toEqual([{friend_id:'a'}]);
      expect(line.batches.flat()).toEqual(['U-a']);expect(line.broadcastCalls).toBe(0);
    }finally{store.raw.close();}
  });
  it('予約で枠を確認できなければ、送らず内容を残した下書きと通知にする', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});store.raw.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at='2020-01-01T00:00:00Z' WHERE id='limited'").run();
      vi.stubGlobal('fetch',vi.fn(async()=>new Response('private',{status:401})));
      await processScheduledBroadcasts(store.db,new LineClient('unused'));
      expect(store.raw.prepare("SELECT status,message_content,scheduled_at FROM broadcasts WHERE id='limited'").get()).toEqual({status:'draft',message_content:'hello',scheduled_at:null});
      expect(store.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='broadcast.quota_short'").get()).toEqual({n:1});
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });
  it('枠の予約は自己更新で二重加算せず、ほかの配信には同じ枠を渡さない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      const broadcast=store.raw.prepare("SELECT * FROM broadcasts WHERE id='limited'").get() as Parameters<typeof renewLimitedReservation>[1];
      await renewLimitedReservation(store.db,broadcast,2);await renewLimitedReservation(store.db,broadcast,2);
      store.raw.prepare("INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,message_options_json,track_links,measure_opens) VALUES('second','notice','text','hello','all','draft','own',?,0,0)").run(JSON.stringify({...JSON.parse(broadcast.message_options_json!),deliveryLimitConfirmation:{broadcastId:'second',recipientCount:2,version:1}}));
      const second=store.raw.prepare("SELECT * FROM broadcasts WHERE id='second'").get() as typeof broadcast;
      expect(await guardScheduledBroadcastQuota(store.db,second,'own')).toMatchObject({blocked:true});
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });

  it('上限2人を選んだ配信は全員向けの送信をせず、同じ店の2人だけに届く', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:false,maxRecipients:2});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');await processQueuedBroadcasts(store.db,client);
      expect(line.broadcastCalls).toBe(0);
      const sent=line.batches.flat();expect(sent).toHaveLength(2);expect(new Set(sent).size).toBe(2);expect(sent.every(id=>['U-a','U-b','U-c'].includes(id))).toBe(true);
      expect(store.raw.prepare(`SELECT total_count FROM broadcasts WHERE id='limited'`).get()).toEqual({total_count:2});
    }finally{store.raw.close();}
  });
  it('残り通数まで送る選択は残り2人に固定され、実行を繰り返しても残りの人を補充しない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');await processQueuedBroadcasts(store.db,client);
      const fixed=store.raw.prepare(`SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id`).all();
      expect(fixed).toHaveLength(2);expect(line.batches.flat()).toHaveLength(2);
      await processQueuedBroadcasts(store.db,client);
      expect(store.raw.prepare(`SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id`).all()).toEqual(fixed);
      expect(line.batches.flat()).toHaveLength(2);expect(line.broadcastCalls).toBe(0);
    }finally{store.raw.close();}
  });
  it('宛先の固定と同時に版が変わったら、古い版の宛先は1人も作らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const old=(await getBroadcastById(store.db,'limited'))!;
      store.raw.exec("UPDATE broadcasts SET status='sending',lock_version=2 WHERE id='limited'");
      await expect(freezeLimitedAudience(store.db,old,2)).rejects.toThrow('固定できません');
      expect(store.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id='limited'").get()).toEqual({n:0});
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });
  it('固定した台帳が消えても、現在の条件で全員を作り直さない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');
      store.raw.exec("DELETE FROM broadcast_send_claims WHERE broadcast_id='limited'; UPDATE broadcasts SET total_count=0 WHERE id='limited'");
      await processQueuedBroadcasts(store.db,client);
      expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
      expect(store.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id='limited'").get()).toEqual({n:0});
      expect((await getBroadcastById(store.db,'limited'))!.status).toBe('draft');
    }finally{store.raw.close();}
  });
  it('停止と再開は人数の上限と元の宛先を保ち、版だけを同じ更新で進める', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');
      const fixed=store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id").all();
      expect(await requestBroadcastStop(store.db,{id:'limited',expectedVersion:1})).toBe(1);
      expect(await resumeBroadcastSending(store.db,{id:'limited',expectedVersion:2})).toBe(1);
      const row=(await getBroadcastById(store.db,'limited'))!;
      expect(JSON.parse(row.message_options_json!)).toMatchObject({deliveryLimitConfirmation:{broadcastId:'limited',recipientCount:2,version:3}});
      await processQueuedBroadcasts(store.db,client);
      expect(line.batches.flat()).toHaveLength(2);expect(line.broadcastCalls).toBe(0);
      expect(store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id").all()).toEqual(fixed);
    }finally{store.raw.close();}
  });
  it('失敗分の再送も確認人数を引き継ぎ、成功済みと抽選に外れた人へは送らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');await processQueuedBroadcasts(store.db,client);
      const fixed=store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id").all() as {friend_id:string}[];
      const failed=fixed[0].friend_id;
      store.raw.prepare("UPDATE broadcast_send_claims SET state='failed',error_code='line_http_429' WHERE broadcast_id='limited' AND friend_id=?").run(failed);
      store.raw.prepare("DELETE FROM messages_log WHERE broadcast_id='limited' AND friend_id=?").run(failed);
      const row=(await getBroadcastById(store.db,'limited'))!;
      const attempt=await beginBroadcastRetryAttempt(store.db,{id:'limited',expectedVersion:row.lock_version??1});
      expect(attempt.changes).toBe(1);await reopenFailedClaims(store.db,'limited',attempt.attemptNo!);
      line.batches=[];await processQueuedBroadcasts(store.db,client);
      expect(line.batches.flat()).toEqual(['U-'+failed]);expect(line.broadcastCalls).toBe(0);
    }finally{store.raw.close();}
  });
  it('予約の期限を越えた再開で、外から使われた枠を取り直せなければ送らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});const client=new LineClient('unused');
      await processBroadcastSend(store.db,client,'limited');
      const row=(await getBroadcastById(store.db,'limited'))!;await renewLimitedReservation(store.db,row,2);
      store.raw.prepare("UPDATE account_settings SET value=? WHERE key='broadcast_quota_reservations'").run(JSON.stringify([{broadcastId:'limited',planned:2,reservedAt:Date.now()-31*60*1000}]));
      vi.stubGlobal('fetch',vi.fn(async input=>new Response(JSON.stringify(String(input).endsWith('/consumption')?{totalUsage:10}:{type:'limited',value:10}))));
      await processQueuedBroadcasts(store.db,client);
      expect(line.batches).toEqual([]);expect(line.broadcastCalls).toBe(0);
      expect((await getBroadcastById(store.db,'limited'))!.status).toBe('draft');
      expect(store.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='broadcast.quota_short'").get()).toEqual({n:1});
    }finally{store.raw.close();}
  });

  it('一部を送り終えた後に枠が減ったら残りだけ止め、復旧しても抽選をやり直さない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      for(let i=0;i<157;i++)store.raw.prepare("INSERT INTO friends(id,line_user_id,display_name,line_account_id,is_following) VALUES(?,?,?,'own',1)").run('p'+i,'U-p'+i,'人'+i);
      store.raw.prepare("UPDATE broadcasts SET message_content='{{name}} さん',message_options_json=? WHERE id='limited'").run(JSON.stringify({deliveryLimit:{upToRemainingQuota:true},deliveryLimitConfirmation:{broadcastId:'limited',recipientCount:160,version:1}}));
      let usage=0;vi.stubGlobal('fetch',vi.fn(async input=>new Response(JSON.stringify(String(input).endsWith('/consumption')?{totalUsage:usage}:{type:'limited',value:1000}))));
      const client=new LineClient('unused');await processBroadcastSend(store.db,client,'limited');await processQueuedBroadcasts(store.db,client);
      expect(line.batches.flat()).toHaveLength(150);
      const fixed=store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id").all();expect(fixed).toHaveLength(160);
      // LINEの使用数が遅れている最初の回も予約を持ち、期限を越えたら残りで取り直す。
      store.raw.prepare("UPDATE account_settings SET value=? WHERE key='broadcast_quota_reservations'").run(JSON.stringify([{broadcastId:'limited',planned:160,reservedAt:Date.now()-31*60*1000}]));
      store.raw.exec("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('new','U-new','後から増えた人','own')");
      usage=999;await processQueuedBroadcasts(store.db,client);
      expect(line.batches.flat()).toHaveLength(150);
      expect(store.raw.prepare("SELECT status,stopped_at FROM broadcasts WHERE id='limited'").get()).toMatchObject({status:'sending',stopped_at:expect.any(String)});
      usage=0;expect(await resumeBroadcastSending(store.db,{id:'limited',expectedVersion:1})).toBe(1);await processQueuedBroadcasts(store.db,client);
      expect(new Set(line.batches.flat()).size).toBe(160);expect(line.batches.flat()).not.toContain('U-new');
      expect(store.raw.prepare("SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id='limited' ORDER BY friend_id").all()).toEqual(fixed);
      expect(line.broadcastCalls).toBe(0);
    }finally{store.raw.close();}
  });

  it('ほかの配信から写した確認印では送らない', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      store.raw.prepare("UPDATE broadcasts SET message_options_json=? WHERE id='limited'").run(JSON.stringify({deliveryLimit:{upToRemainingQuota:true},deliveryLimitConfirmation:{broadcastId:'different',recipientCount:2,version:1}}));
      await expect(processBroadcastSend(store.db,new LineClient('unused'),'limited')).rejects.toThrow('確認');expect(line.broadcastCalls).toBe(0);expect(line.batches).toEqual([]);
    }finally{store.raw.close();}
  });

  it('自己予約の置き換えは明示した限定配信だけで使い、通常の予約判定を保つ', async () => {
    const store=createTestD1();try {
      seed(store,{upToRemainingQuota:true});
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,8,10)).toBe(true);
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,8,10)).toBe(false);
      expect(await tryReserveQuotaSlot(store.db,'own','limited',2,8,10,{replaceOwn:true})).toBe(true);
      expect(await tryReserveQuotaSlot(store.db,'own','another',2,8,10)).toBe(false);
    }finally{store.raw.close();}
  });

});
