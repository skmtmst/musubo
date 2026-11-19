import { afterEach, beforeEach, expect, it } from 'vitest';
import { gapFixture } from '../../test-utils/gap1.js';
import {prepareLiveEventPlan} from './ec-auto-line-live-plan.js';
let fixture: ReturnType<typeof gapFixture>;
beforeEach(()=>{fixture=gapFixture();});
afterEach(()=>{fixture.raw.close();});
it('カゴ・閲覧の予定は起点ごとに一度だけ、当時の本文を記録する',async()=>{
 fixture.raw.exec(`INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json) VALUES
 ('a','cart',1,60,'[{"type":"text","text":"カゴ"}]'),('a','browse',1,60,'[{"type":"text","text":"閲覧"}]');
 INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES
 ('cart','a','f','cart_add','p','{}','2026-11-19T01:00:00Z','2026-11-19T01:00:00Z','cart'),
 ('view1','a','f','product_view','p','{}','2026-11-19T01:00:00Z','2026-11-19T01:00:00Z','view1'),
 ('view2','a','f','product_view','p','{}','2026-11-19T01:01:00Z','2026-11-19T01:01:00Z','view2')`);
 await fixture.db.batch(prepareLiveEventPlan(fixture.db,'cart'));await fixture.db.batch(prepareLiveEventPlan(fixture.db,'view2'));
 await fixture.db.batch(prepareLiveEventPlan(fixture.db,'cart'));
 fixture.raw.exec("UPDATE ec_auto_line_rules SET messages_json='[]' WHERE account_id='a'");
 expect(fixture.raw.prepare('SELECT kind,occurrence_key,payload_json FROM ec_auto_line_live_intents ORDER BY kind').all()).toEqual([
 {kind:'browse',occurrence_key:'view2',payload_json:'[{"type":"text","text":"閲覧"}]'},{kind:'cart',occurrence_key:'cart',payload_json:'[{"type":"text","text":"カゴ"}]'}]);
});
it('再入荷の回と入荷前の購読を区別し、重複購読はまとめる',async()=>{
 fixture.raw.exec(`INSERT INTO friends(id,line_user_id,line_account_id) VALUES('late-f','Ulate','a');
 INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json) VALUES('a','restock',1,0,'[{"type":"text","text":"入荷"}]');
 INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES
 ('sub1','a','f','restock_subscribe','p','{}','2026-11-19T00:00:00Z','2026-11-19T00:00:00Z','sub1'),
 ('sub2','a','f','restock_subscribe','p','{}','2026-11-19T00:30:00Z','2026-11-19T00:30:00Z','sub2'),
 ('first','a',NULL,'restock','p','{"stock":1}','2026-11-19T01:00:00Z','2026-11-19T01:00:00Z','first'),
 ('late','a','late-f','restock_subscribe','p','{}','2026-11-19T01:30:00Z','2026-11-19T01:30:00Z','late'),
 ('second','a',NULL,'restock','p','{"stock":2}','2026-11-19T02:00:00Z','2026-11-19T02:00:00Z','second')`);
 await fixture.db.batch(prepareLiveEventPlan(fixture.db,'first'));await fixture.db.batch(prepareLiveEventPlan(fixture.db,'second'));
 expect(fixture.raw.prepare('SELECT occurrence_key,friend_id FROM ec_auto_line_live_intents ORDER BY occurrence_key,friend_id').all()).toEqual([
 {occurrence_key:'first',friend_id:'f'}, {occurrence_key:'second',friend_id:'f'}, {occurrence_key:'second',friend_id:'late-f'}]);
 expect(fixture.raw.prepare('SELECT count(*) n FROM ec_restock_occurrences').get()).toEqual({n:2});
});
it('SQLite で読めない日時は行動記録を残して予定を作らない',async()=>{
 fixture.raw.exec(`INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json) VALUES('a','cart',1,60,'[]');
 INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key)
 VALUES('noniso','a','f','cart_add','p','{}','2026-11-19T01:00:00+0900','2026-11-19T01:00:00Z','noniso')`);
 await fixture.db.batch(prepareLiveEventPlan(fixture.db,'noniso'));
 expect(fixture.raw.prepare("SELECT id FROM ec_behavior_events WHERE id='noniso'").get()).toEqual({id:'noniso'});
 expect(fixture.raw.prepare('SELECT count(*) n FROM ec_auto_line_live_intents').get()).toEqual({n:0});
});
