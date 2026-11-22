import Database from 'better-sqlite3';
import { readFileSync,readdirSync } from 'node:fs';
import { beforeAll,describe,expect,it } from 'vitest';
const root=new URL('../',import.meta.url),migrations=new URL('migrations/',root);
const names=['617_store_common_folders.sql','618_hq_banner_folders.sql','619_hq_folder_display_order.sql'];
const sql=(name:string)=>readFileSync(new URL(name,migrations),'utf8');
let snapshot:Buffer;
beforeAll(()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=OFF');db.exec(readFileSync(new URL('schema.sql',root),'utf8'));
 for(const name of readdirSync(migrations).filter(f=>f.endsWith('.sql')&&Number(f.split('_')[0])<617).sort()) {
  for(const statement of sql(name).split(/;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean)) {try{db.exec(statement);}catch(e){if(!/duplicate column name|already exists/i.test(String(e)))throw new Error(name+': '+String(e));}}
 }
 snapshot=db.serialize();db.close();
});
function old(){const db=new Database(snapshot);db.pragma('foreign_keys=ON');db.pragma('recursive_triggers=ON');return db;}
function migrate(db:Database.Database){db.transaction(()=>{for(const name of names)db.exec(sql(name));})();}
function account(db:Database.Database,id='a'){db.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES(?,?,?,'s','t')").run(id,id,id);}
function seed(db:Database.Database) {
 account(db);account(db,'b');
 db.exec(`INSERT INTO folders(id,kind,name,account_id) VALUES('parent','template','親','a');
 INSERT INTO folders(id,kind,name,account_id,parent_id) VALUES('child','template','子','a','parent');
 INSERT INTO templates(id,name,message_type,message_content,line_account_id,folder_id) VALUES('tpl','ひな形','text','本文','a','child');
 INSERT INTO folders(id,kind,name,account_id) VALUES('auto','automation','自動化','a');
 INSERT INTO automation_definitions(id,line_account_id,name,status,folder_id) VALUES('auto-item','a','自動化','draft','auto');
 INSERT INTO mileage_reward_folders(id,line_account_id,name,display_order,created_at,updated_at) VALUES('reward-folder','a','特典',7,'old','old');
 INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind,folder_id) VALUES('reward','a','残す特典','tag','reward-folder');
 INSERT INTO mileage_reward_versions(id,reward_id,version_number,required_miles,status) VALUES('version','reward',1,10,'published');
 UPDATE mileage_rewards SET current_published_version_id='version' WHERE id='reward';
 INSERT INTO friend_add_rule_folders(id,line_account_id,name,color,create_idempotency_key,created_by_staff_id,created_at,updated_at) VALUES('friend-folder','a','店頭','#3b82f6','key','owner','old','old');
 INSERT INTO friend_add_rules(id,line_account_id,friend_kind,name,folder_name,priority) VALUES('rule1','a','first_time','設定1','店頭',1),('rule2','a','returning','設定2','名前だけ',2),('rule3','b','first_time','他店','名前だけ',1);
 INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status) VALUES('rule-version','rule1',1,'{}','published');`);
}
describe('617〜619: 外部キーを有効にしたローカル移行',()=>{
 it('空の旧DBから3本が当たり、生成した空DBと同じ列を持つ',()=>{
  const db=old(),fresh=new Database(':memory:');try{migrate(db);fresh.exec(readFileSync(new URL('bootstrap.sql',root),'utf8'));
   // 782 は 617〜619 より後の変更。比較先を同じ時点に戻し、それ以外の全列を厳密に比べる。
   fresh.exec('DROP TRIGGER mileage_reward_hq_origin_update; ALTER TABLE mileage_rewards DROP COLUMN hq_template_version_id; ALTER TABLE mileage_rewards DROP COLUMN hq_template_id');
   for(const table of ['folders','mileage_rewards','affiliates','affiliate_offers','friend_add_rules','hq_banner_folders','hq_template_folders','hq_broadcast_folders'])expect(db.prepare(`PRAGMA table_info(${table})`).all()).toEqual(fresh.prepare(`PRAGMA table_info(${table})`).all());
   expect(db.pragma('foreign_key_check')).toEqual([]);
  }finally{db.close();fresh.close();}
 });
 it('所属・子フォルダ・既存のトリガー・特典の公開版を保持する',()=>{
  const db=old();try{seed(db);const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();migrate(db);
   expect(db.prepare("SELECT parent_id FROM folders WHERE id='child'").get()).toEqual({parent_id:'parent'});
   expect(db.prepare("SELECT folder_id FROM templates WHERE id='tpl'").get()).toEqual({folder_id:'child'});
   expect(db.prepare("SELECT folder_id FROM automation_definitions WHERE id='auto-item'").get()).toEqual({folder_id:'auto'});
   expect(db.prepare("SELECT folder_id,current_published_version_id FROM mileage_rewards WHERE id='reward'").get()).toEqual({folder_id:'reward-folder',current_published_version_id:'version'});
   const after=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();expect(after).toEqual(expect.arrayContaining(triggers));
   expect(db.prepare("SELECT status FROM mileage_reward_versions WHERE id='version'").get()).toEqual({status:'published'});
   expect(db.pragma('foreign_key_check')).toEqual([]);
  }finally{db.close();}
 });
 it('旧フォルダのID・色・順序と、名前しかなかった店ごとの分類を移す',()=>{
  const db=old();try{seed(db);migrate(db);
   expect(db.prepare("SELECT name,color,display_order,account_id FROM folders WHERE id='reward-folder'").get()).toEqual({name:'特典',color:null,display_order:7,account_id:'a'});
   expect(db.prepare("SELECT name,color FROM folders WHERE id='friend-folder'").get()).toEqual({name:'店頭',color:'#3b82f6'});
   expect(db.prepare("SELECT folder_id FROM friend_add_rules WHERE id='rule1'").get()).toEqual({folder_id:'friend-folder'});
   const rows=db.prepare("SELECT account_id FROM folders WHERE name='名前だけ' ORDER BY account_id").all();expect(rows).toEqual([{account_id:'a'},{account_id:'b'}]);
   expect(db.prepare("SELECT folder_id FROM friend_add_rules WHERE id='rule2'").get()).not.toEqual(db.prepare("SELECT folder_id FROM friend_add_rules WHERE id='rule3'").get());
  }finally{db.close();}
 });
 it('別の種類・店の所属をDBでも拒み、フォルダ削除で内容・公開版を消さない',()=>{
  const db=old();try{seed(db);migrate(db);
   expect(()=>db.exec("UPDATE mileage_rewards SET folder_id='friend-folder' WHERE id='reward'")).toThrow(/folder_assignment_invalid/);
   expect(()=>db.exec("UPDATE friend_add_rules SET folder_id='friend-folder' WHERE id='rule3'")).toThrow(/folder_assignment_invalid/);
   db.exec("DELETE FROM folders WHERE id='reward-folder';DELETE FROM folders WHERE id='friend-folder'");
   expect(db.prepare("SELECT folder_id FROM mileage_rewards WHERE id='reward'").get()).toEqual({folder_id:null});
   expect(db.prepare("SELECT folder_id,folder_name FROM friend_add_rules WHERE id='rule1'").get()).toEqual({folder_id:null,folder_name:null});
   expect(db.prepare("SELECT status FROM friend_add_rule_versions WHERE id='rule-version'").get()).toEqual({status:'published'});
  }finally{db.close();}
 });
 it('旧表からの追加・改名・色変更と共通表の変更が両方向で同期する',()=>{
  const db=old();try{seed(db);migrate(db);
   db.exec("UPDATE friend_add_rule_folders SET name='改名',color='#16a34a' WHERE id='friend-folder'");
   expect(db.prepare("SELECT name,color FROM folders WHERE id='friend-folder'").get()).toEqual({name:'改名',color:'#16a34a'});
   expect(db.prepare("SELECT folder_name FROM friend_add_rules WHERE id='rule1'").get()).toEqual({folder_name:'改名'});
   db.exec("UPDATE folders SET name='新名',color=NULL,revision=revision+1 WHERE id='friend-folder'");
   expect(db.prepare("SELECT name,color FROM friend_add_rule_folders WHERE id='friend-folder'").get()).toEqual({name:'新名',color:null});
   db.exec("INSERT INTO mileage_reward_folders VALUES('old-new','a','旧から追加',9,'old','old')");
   expect(db.prepare("SELECT kind FROM folders WHERE id='old-new'").get()).toEqual({kind:'mileage_reward'});
   db.exec("UPDATE friend_add_rules SET folder_name='追加名' WHERE id='rule2'");
   expect(db.prepare("SELECT name FROM folders WHERE id=(SELECT folder_id FROM friend_add_rules WHERE id='rule2')").get()).toEqual({name:'追加名'});
   db.exec("UPDATE folders SET name='名前を変更' WHERE kind='friend_add_rule' AND account_id='b' AND name='名前だけ';UPDATE friend_add_rules SET folder_name='名前だけ' WHERE id='rule3'");
   expect(db.prepare("SELECT name FROM folders WHERE id=(SELECT folder_id FROM friend_add_rules WHERE id='rule3')").get()).toEqual({name:'名前だけ'});
   expect(db.pragma('foreign_key_check')).toEqual([]);
  }finally{db.close();}
 });
 it('未知の参照があればデータを変更する前に移行を止める',()=>{
  const db=old();try{seed(db);db.exec("CREATE TABLE future_folder_child(id TEXT,folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);INSERT INTO future_folder_child VALUES('future','child')");
   expect(()=>migrate(db)).toThrow();
   expect(db.prepare("SELECT folder_id FROM future_folder_child").get()).toEqual({folder_id:'child'});
   expect(db.prepare("SELECT folder_id FROM templates WHERE id='tpl'").get()).toEqual({folder_id:'child'});
   expect(db.prepare("PRAGMA table_info(folders)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({name:'revision'})]));
  }finally{db.close();}
 });
 it('統括の順番はテナントごとのname,id順の連番になる',()=>{
  const db=old();try{
   db.exec("INSERT INTO tenants(id,name) VALUES('other','別統括')");
   for(const table of ['hq_template_folders','hq_broadcast_folders'])db.exec(`INSERT INTO ${table}(id,tenant_id,name) VALUES('b','other','B'),('a','other','A'),('c','00000000-0000-4000-8000-000000000001','C')`);
   migrate(db);for(const table of ['hq_template_folders','hq_broadcast_folders'])expect(db.prepare(`SELECT id,display_order FROM ${table} ORDER BY id`).all()).toEqual([{id:'a',display_order:0},{id:'b',display_order:1},{id:'c',display_order:0}]);
  }finally{db.close();}
 });
 it('既存の統括バナーを未分類にし、画像と配布履歴を保持する',()=>{
  const db=old();try{account(db);
   db.exec("INSERT INTO banner_projects(id,tenant_id,name) VALUES('project','00000000-0000-4000-8000-000000000001','案件');INSERT INTO media(id,kind,filename,mime_type,size_bytes,r2_key) VALUES('media','image','image.png','image/png',1,'r2');INSERT INTO banner_images(id,tenant_id,project_id,media_id) VALUES('image','00000000-0000-4000-8000-000000000001','project','media');INSERT INTO banner_image_deliveries(id,banner_image_id,line_account_id,media_id) VALUES('delivery','image','a','media')");
   const delivery=db.prepare("SELECT * FROM banner_image_deliveries").all(),media=db.prepare("SELECT * FROM media").all();
   migrate(db);
   expect(db.prepare("SELECT folder_id FROM banner_projects WHERE id='project'").get()).toEqual({folder_id:null});
   expect(db.prepare("SELECT folder_id FROM banner_images WHERE id='image'").get()).toEqual({folder_id:null});
   expect(db.prepare("SELECT * FROM banner_image_deliveries").all()).toEqual(delivery);
   expect(db.prepare("SELECT * FROM media").all()).toEqual(media);
   expect(db.pragma('foreign_key_check')).toEqual([]);
  }finally{db.close();}
 });
});
