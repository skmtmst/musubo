import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('./feature-enforcement.js',()=>({featureJobCanRun:async()=>true}));
const dispatch = vi.hoisted(() => vi.fn(async (_db: D1Database, _event: unknown) => []));
vi.mock('../features/automations/automation-triggers/index.js', () => ({ dispatchAutomationEventWithLogging: dispatch }));
import {processPendingMileageEvents,toJstString} from '@line-crm/db';
import {createTestD1,insertFriend,type SqliteD1} from '../test-utils/d1-sqlite.js';
import {useSqliteClock} from '../test-utils/sqlite-clock.js';
import {recordTrackedClick,processTrackedClick,processDueTrackedClicks} from './tracked-click-steps.js';
import type { Env } from '../worker-env.js';
let item:SqliteD1;
beforeEach(()=>{
 item=createTestD1();
 item.raw.exec(`INSERT INTO users(id,display_name) VALUES('click-user','test');
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('click-account','test-channel','test','test','test');
 INSERT INTO tracked_links(id,name,original_url,line_account_id) VALUES('click-link','test','https://example.test','click-account');
 INSERT INTO tags(id,name,line_account_id) VALUES('click-tag','test','click-account');
 INSERT INTO mileage_rules(id,program_id,name,event_type,source,amount,initial_status,line_account_id,is_active,created_at,updated_at)
 VALUES('click-mileage-rule','default','test','link_clicked','tracked_link',1,'available',NULL,1,'2026-01-01','2026-01-01');`);
 insertFriend(item.raw,'click-friend',{line_account_id:'click-account',user_id:'click-user'});
});
afterEach(()=>item.raw.close());
it('PKG68 retries a real tag failure while preserving one real mileage event and grant',async()=>{
 const saved=await recordTrackedClick(item.db,{linkId:'click-link',friendId:'click-friend',identityVerified:true,accountId:'click-account',tagId:'click-tag',scenarioId:null,linkName:'test',conversionPointIds:[]});
 item.raw.exec("CREATE TRIGGER fail_tag BEFORE INSERT ON friend_tags BEGIN SELECT RAISE(ABORT,'temporary tag failure');END");
 const env={DB:item.db,LINE_CHANNEL_ACCESS_TOKEN:'test'} as Env['Bindings'];
 await expect(processTrackedClick(env,saved.id,saved.plan)).rejects.toThrow();
 expect(item.raw.prepare("SELECT COUNT(*) AS n FROM engagement_events WHERE event_type='link_clicked'").get()).toEqual({n:1});
 item.raw.exec('DROP TRIGGER fail_tag');
 await processDueTrackedClicks(env);await processDueTrackedClicks(env);
 expect(item.raw.prepare("SELECT COUNT(*) AS n FROM engagement_events WHERE event_type='link_clicked'").get()).toEqual({n:1});
 expect(item.raw.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({n:1});
 expect(item.raw.prepare("SELECT status FROM workflow_steps WHERE process_kind='tracked_click' AND step_key='__run'").get()).toEqual({status:'succeeded'});
 await processPendingMileageEvents(item.db,{now:toJstString(new Date(Date.now()+2*86400_000))});
 expect(item.raw.prepare('SELECT COUNT(*) AS n FROM mileage_ledger WHERE source_event_id=?').get(saved.id)).toEqual({n:1});
});

it('保存したクリックのIDを自動化の発生元として使う', async () => {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));useSqliteClock(item.raw,()=>new Date());
 try {
  dispatch.mockClear();
  const saved=await recordTrackedClick(item.db,{linkId:'click-link',friendId:'click-friend',identityVerified:true,accountId:'click-account',tagId:null,scenarioId:null,linkName:'test',conversionPointIds:[]});
  await processTrackedClick({DB:item.db,LINE_CHANNEL_ACCESS_TOKEN:'test'} as Env['Bindings'],saved.id,saved.plan);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][1]).toMatchObject({eventType:'link_clicked',sourceEventId:saved.id});
 } finally { vi.useRealTimers(); }
});
