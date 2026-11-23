import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture} from '../test-utils/gap1.js';
import {processInboxOpeningAssignments} from '../services/inbox-assignment-opening.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:01:00Z'));d=gapFixture();d.raw.exec(`
 INSERT INTO inbox_assignment_settings(account_id,strategy,targets_json) VALUES('a','even','[{"staffId":"s","priority":1,"cap":10}]');
 INSERT INTO staff_presence(staff_id,away,last_seen_at) VALUES('s',0,'2026-10-16T00:00:00Z');
 INSERT INTO chats(id,friend_id,status,pending_since,last_customer_message_at,created_at,updated_at) VALUES('c','f','unread','2026-10-15T23:00:00Z','2026-10-15T23:00:00Z','now','now');`);});
afterEach(()=>{d.raw.close();vi.useRealTimers();});
it('営業時間の開始後に未割当を一度だけ再割当する',async()=>{
 await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:'s'});
 await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare('SELECT count(*) n FROM inbox_assignment_logs').get()).toEqual({n:1});
});
it('営業時間前は割り当てず開始時刻まで待つ',async()=>{
 vi.setSystemTime(new Date('2026-10-15T23:59:00Z'));await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
 vi.setSystemTime(new Date('2026-10-16T00:01:00Z'));await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:'s'});
});
it('開店時に全員不在でも、営業時間内に在席が戻れば再試行する',async()=>{
 d.raw.exec("UPDATE staff_presence SET away=1 WHERE staff_id='s'");
 await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:null});
 vi.advanceTimersByTime(300000);d.raw.prepare("UPDATE staff_presence SET away=0,last_seen_at=? WHERE staff_id='s'").run(new Date().toISOString());
 await processInboxOpeningAssignments(d.db,new Date());
 expect(d.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c'").get()).toEqual({assignee_staff_id:'s'});
});
