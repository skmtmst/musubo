import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const sql=(name:string)=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
it('771は既存の上限予約を保ち、本送信用の予定と枠を追加する',()=>{
 const db=new Database(':memory:');
 try{
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE line_accounts(id TEXT PRIMARY KEY);
  CREATE TABLE friends(id TEXT PRIMARY KEY,line_account_id TEXT); CREATE TABLE ec_auto_line_sends(id TEXT PRIMARY KEY);
  CREATE TABLE ec_behavior_events(id TEXT PRIMARY KEY,account_id TEXT,friend_id TEXT,type TEXT,product_id TEXT,product_snapshot_json TEXT,occurred_at TEXT,received_at TEXT);
  CREATE TABLE ec_auto_line_rules(account_id TEXT,kind TEXT,enabled INTEGER,wait_minutes INTEGER,messages_json TEXT);
  INSERT INTO tenants VALUES('t');INSERT INTO users VALUES('u');INSERT INTO line_accounts VALUES('a');INSERT INTO friends VALUES('f','a');INSERT INTO ec_auto_line_sends VALUES('s');`);
  db.exec(sql('765_ec_auto_line_cap.sql'));
  db.exec("INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES('old','t','u','a','f','s','simulation','p','p','2026-10-16','2026-10-16T00:00:00Z','accepted')");
  db.exec(sql('771_ec_auto_line_live_send.sql'));
  expect(db.prepare('SELECT id,candidate_id,live_intent_id,state FROM ec_auto_line_cap_reservations').get()).toEqual({id:'old',candidate_id:'s',live_intent_id:null,state:'accepted'});
  db.exec("INSERT INTO ec_auto_line_live_intents(id,account_id,kind,occurrence_key,friend_id,product_id,due_at,payload_json,created_at,updated_at) VALUES('intent','a','cart','event','f','p','2026-10-16','[]','now','now'); INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,live_intent_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES('new','t','u','a','f','intent','live','p','p','2026-10-16','2026-10-16T00:00:00Z','reserved')");
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(()=>db.exec("INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,live_intent_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES('dup','t','u','a','f','intent','live','p','p','2026-10-16','2026-10-16','reserved')")).toThrow();
 } finally{db.close();}
});
