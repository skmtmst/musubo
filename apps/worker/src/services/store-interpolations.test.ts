import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import {resolveSendCommonVars} from './interpolation-context.js';
import {renderMessageContent,renderBroadcastMessageContent,assertNoUnresolvedBroadcastVariables} from './render-message.js';
import {prepareBroadcastCommonVarSnapshot} from './common-var-snapshot.js';
let f:SqliteD1;
beforeEach(()=>{f=createTestD1();f.raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('shop','店','ch','unused','unused');INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id) VALUES('send','案内','text','{予約ページ}','shop')");});
afterEach(()=>f.raw.close());
describe('店の共通情報の差し込み',()=>{
 it('未設定や空欄はプレビューで差し込まず、実送信と予約送信の固定処理では止める',async()=>{
  const content='{店の電話番号}・{{var.reservation_url}}';expect(renderMessageContent(content,{vars:{}})).toBe('{{var.store_phone}}・{{var.reservation_url}}');
  await expect(resolveSendCommonVars(f.db,'shop',content,{kind:'broadcast',id:'send'})).rejects.toThrow('common_var_unresolved');
  f.raw.exec("INSERT INTO common_vars(id,var_key,name,value,line_account_id) VALUES('phone','store_phone','電話','03-0000-2222','shop'),('url','reservation_url','予約',' ','shop')");
  await expect(prepareBroadcastCommonVarSnapshot(f.db,{id:'send',line_account_id:'shop'},'{予約ページ}')).rejects.toThrow();
  expect(f.raw.prepare('SELECT common_var_snapshot FROM broadcasts').get()).toEqual({common_var_snapshot:null});
 });
 it('正規キーから電話・予約URLを差し込み、JSONや差し込み値中の波括弧を壊さない',async()=>{
  f.raw.exec("INSERT INTO common_vars(id,var_key,name,value,line_account_id) VALUES('phone','store_phone','電話','03-0000-2222','shop'),('url','reservation_url','予約','https://example.test/book','shop')");
  const content='{店の電話番号} / {予約ページ}',vars=await resolveSendCommonVars(f.db,'shop',content,{kind:'broadcast',id:'send'});
  expect(renderMessageContent(content,{vars})).toBe('03-0000-2222 / https://example.test/book');
  const rendered=renderBroadcastMessageContent('flex',JSON.stringify({type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:'{店の電話番号}'}]}}),{vars:{store_phone:'03-"quoted" {{name}}'}});
  expect(JSON.parse(rendered).body.contents[0].text).toBe('03-"quoted" {{name}}');
  expect(()=>assertNoUnresolvedBroadcastVariables('{予約ページ}')).toThrow('Unresolved');
 });
});
