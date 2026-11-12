import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach,afterEach,describe,expect,it } from 'vitest';
import { asD1 } from './d1-test-helper.js';
import { createFolder,getFolderById,updateFolder,deleteFolder,swapFolderOrder,getFolderItemCounts } from '../src/folders.js';
import { listMileageRewardFolders,createMileageRewardFolder,reorderMileageRewardFolders,moveMileageRewardToFolder } from '../src/mileage/reward-folders.js';
import { createAffiliate,createAffiliateWithRandomCode,updateAffiliate } from '../src/affiliates.js';
import { createAffiliateOffer,updateAffiliateOffer } from '../src/affiliate-offers.js';
let raw:Database.Database,db:D1Database;
beforeEach(()=>{raw=new Database(':memory:');raw.exec(readFileSync(new URL('../bootstrap.sql',import.meta.url),'utf8'));raw.pragma('foreign_keys=ON');db=asD1(raw);
 raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('a','A','a','s','t'),('b','B','b','s','t');INSERT INTO mileage_programs(id,code,name,created_at,updated_at) VALUES('default','default','マイル','now','now')");
});
afterEach(()=>raw.close());
const tenant='00000000-0000-4000-8000-000000000001';
describe('共通フォルダと既存の特典の互換口',()=>{
 it('旧作成・並べ替え・移動は共通表に読み書きし、色と改名は旧一覧にも出る',async()=>{
  const a=await createMileageRewardFolder(db,'a','A'),b=await createMileageRewardFolder(db,'a','B');
  await updateFolder(db,a.id,{name:'改名',color:'#3b82f6',expectedRevision:1});
  await reorderMileageRewardFolders(db,'a',[b.id,a.id]);expect((await listMileageRewardFolders(db,'a')).map(f=>f.id)).toEqual([b.id,a.id]);
  raw.prepare("INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind) VALUES('reward','a','特典','tag')").run();
  await moveMileageRewardToFolder(db,'a','reward',a.id);
  expect((await listMileageRewardFolders(db,'a')).find(f=>f.id===a.id)).toMatchObject({name:'改名',count:1});
  await expect(moveMileageRewardToFolder(db,'b','reward',a.id)).rejects.toMatchObject({status:404});
  await deleteFolder(db,a.id);expect(raw.prepare("SELECT folder_id FROM mileage_rewards WHERE id='reward'").get()).toEqual({folder_id:null});
  expect(raw.pragma('foreign_key_check')).toEqual([]);
 });
 it('特典の旧並べ替えで店越え・重複・一部だけを拒否する',async()=>{
  const a=await createMileageRewardFolder(db,'a','A'),b=await createMileageRewardFolder(db,'b','B');
  for(const ids of [[],[a.id,a.id],[b.id]])await expect(reorderMileageRewardFolders(db,'a',ids)).rejects.toMatchObject({status:422});
 });
 it('フォルダの版が読み取り後に変われば交換全体を巻き戻す',async()=>{
  const a=await createFolder(db,{kind:'affiliate',accountId:'a',name:'A',displayOrder:0});
  const b=await createFolder(db,{kind:'affiliate',accountId:'a',name:'B',displayOrder:1});
  await updateFolder(db,b.id,{color:'#16a34a',expectedRevision:1});
  await expect(swapFolderOrder(db,a,b)).rejects.toThrow('FOLDER_CONFLICT');
  expect((await getFolderById(db,a.id))?.display_order).toBe(0);expect((await getFolderById(db,b.id))?.display_order).toBe(1);
 });
});
describe('紹介者・案件の所属と件数',()=>{
 it('2つの紹介者作成口と案件作成口が所属を保存し、省略で維持・nullで外す',async()=>{
  const f=await createFolder(db,{kind:'affiliate',accountId:'a',name:'紹介者'}),o=await createFolder(db,{kind:'affiliate_offer',accountId:'a',name:'案件'});
  const a=await createAffiliate(db,{tenantId:tenant,lineAccountId:'a',name:'A',code:'code-a',folderId:f.id});
  const b=await createAffiliateWithRandomCode(db,{tenantId:tenant,lineAccountId:'a',name:'B',folderId:f.id});
  const offer=await createAffiliateOffer(db,{lineAccountId:'a',name:'案件',folderId:o.id});
  expect(a.folder_id).toBe(f.id);expect(b.folder_id).toBe(f.id);expect(offer.folder_id).toBe(o.id);
  expect((await updateAffiliate(db,b.id,{folder_id:` ${f.id} `}))?.folder_id).toBe(f.id);
  expect((await updateAffiliateOffer(db,offer.id,{folder_id:` ${o.id} `}))?.folder_id).toBe(o.id);
  expect((await updateAffiliate(db,a.id,{name:'変更'}))?.folder_id).toBe(f.id);
  expect((await updateAffiliateOffer(db,offer.id,{description:'変更'}))?.folder_id).toBe(o.id);
  expect(await getFolderItemCounts(db,'affiliate',{allowedAccountIds:['a'],canSeeUnassigned:false})).toEqual({byFolderId:{[f.id]:2},unfiled:0});
  await updateAffiliate(db,a.id,{folder_id:null});await updateAffiliateOffer(db,offer.id,{folder_id:null});
  expect(await getFolderItemCounts(db,'affiliate',{allowedAccountIds:['a'],canSeeUnassigned:false})).toEqual({byFolderId:{[f.id]:1},unfiled:1});
  await deleteFolder(db,f.id);expect(raw.prepare('SELECT folder_id FROM affiliates').all()).toEqual([{folder_id:null},{folder_id:null}]);
 });
 it('別の種類・店の所属を拒否し、案件の店だけを変えても分類先を引き継がない',async()=>{
  const f=await createFolder(db,{kind:'affiliate_offer',accountId:'a',name:'案件'});
  await expect(createAffiliate(db,{tenantId:tenant,lineAccountId:'a',name:'A',code:'code',folderId:f.id})).rejects.toMatchObject({code:'folder_invalid'});
  await expect(createAffiliateOffer(db,{lineAccountId:'b',name:'B',folderId:f.id})).rejects.toMatchObject({code:'folder_invalid'});
  const offer=await createAffiliateOffer(db,{lineAccountId:'a',name:'A',folderId:f.id});
  await expect(updateAffiliateOffer(db,offer.id,{line_account_id:'b'})).rejects.toMatchObject({code:'folder_invalid'});
  await expect(updateAffiliateOffer(db,offer.id,{line_account_id:null})).rejects.toMatchObject({code:'folder_invalid'});
  expect(raw.prepare('SELECT line_account_id,folder_id FROM affiliate_offers').get()).toEqual({line_account_id:'a',folder_id:f.id});
 });
});
it('Webhook の親フォルダ削除は子まで両方の確認版を進める',async()=>{
 const parent=await createFolder(db,{kind:'webhook',accountId:'a',name:'親'});
 const child=await createFolder(db,{kind:'webhook',accountId:'a',name:'子',parentId:parent.id});
 raw.prepare("INSERT INTO outgoing_webhooks(id,line_account_id,name,url,event_types,folder_id) VALUES('out','a','送信','https://example.test','[]',?)").run(parent.id);
 raw.prepare("INSERT INTO incoming_webhooks(id,line_account_id,name,source_type,folder_id) VALUES('in','a','受信','custom',?)").run(child.id);
 expect(await deleteFolder(db,parent.id)).toBe(true);
 expect(raw.prepare("SELECT confirmation_revision,folder_id FROM outgoing_webhooks WHERE id='out'").get()).toEqual({confirmation_revision:2,folder_id:null});
 expect(raw.prepare("SELECT confirmation_revision,folder_id FROM incoming_webhooks WHERE id='in'").get()).toEqual({confirmation_revision:2,folder_id:null});
});
