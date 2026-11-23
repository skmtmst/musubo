vi.mock('./feature-enforcement.js',()=>({featureJobCanRun:async()=>true}));
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestD1,insertFriend,type SqliteD1} from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
const fault=vi.hoisted(()=>({tag:true}));
vi.mock('./activity-mileage.js',()=>({awardActivityMileage:async(db:D1Database)=>db.prepare("UPDATE effects SET n=n+1 WHERE id='mileage'").run()}));
vi.mock('./action-score-events.js',()=>({applyActionScoreEvent:async(db:D1Database)=>db.prepare("UPDATE effects SET n=n+1 WHERE id='score'").run()}));
vi.mock('../features/automations/automation-triggers.js',()=>({dispatchAutomationEventWithLogging:async(db:D1Database)=>{await db.prepare("UPDATE effects SET n=n+1 WHERE id='automation'").run();return []}}));
vi.mock('../features/friends/friend-tag-attach.js',()=>({attachTagAndFireSideEffects:async(db:D1Database)=>{
 await db.prepare("UPDATE effects SET n=n+1 WHERE id='tag'").run();if(fault.tag)throw new Error('tag after write failed');
}}));
import {recordTrackedClick,processTrackedClick,processDueTrackedClicks} from './tracked-click-steps.js';
let item:SqliteD1;
beforeEach(()=>{item=createTestD1();fault.tag=true;item.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','channel-a','A','test','test')");insertFriend(item.raw,'f',{line_account_id:'a'});
 item.raw.exec(`INSERT INTO tracked_links(id,name,original_url,line_account_id)VALUES('l','link','https://example.test','a');
 CREATE TABLE effects(id TEXT PRIMARY KEY,n INTEGER);INSERT INTO effects VALUES('mileage',0),('score',0),('automation',0),('tag',0)`)});
afterEach(()=>item.raw.close());
describe('PKG68 durable click stages',()=>{
 it('persists the queue before redirect work and resumes only the unfinished effects',async()=>{
  const saved=await recordTrackedClick(item.db,{linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:'tag',scenarioId:null,linkName:'link',conversionPointIds:[]});
  const env={DB:item.db} as Env['Bindings'];
  await expect(processTrackedClick(env,saved.id,saved.plan)).rejects.toThrow();
  expect(item.raw.prepare("SELECT status FROM workflow_steps WHERE step_key='__run'").get()).toEqual({status:'failed'});
  fault.tag=false;await processDueTrackedClicks(env);await processDueTrackedClicks(env);
  expect(item.raw.prepare('SELECT n FROM effects ORDER BY id').all()).toEqual([{n:1},{n:1},{n:1},{n:1}]);
  expect(item.raw.prepare('SELECT click_count FROM tracked_links').get()).toEqual({click_count:1});
  expect(item.raw.prepare("SELECT status FROM workflow_steps WHERE step_key='__run'").get()).toEqual({status:'succeeded'});
 });
 it('does not keep a click without its resume plan if checkpoint storage fails',async()=>{
  item.raw.exec("CREATE TRIGGER no_checkpoint BEFORE INSERT ON workflow_steps BEGIN SELECT RAISE(ABORT,'storage failed'); END");
  await expect(recordTrackedClick(item.db,{linkId:'l',friendId:null,accountId:'a',tagId:null,scenarioId:null,linkName:'link',conversionPointIds:[]})).rejects.toThrow();
  expect(item.raw.prepare('SELECT count(*) AS n FROM link_clicks').get()).toEqual({n:0});
  expect(item.raw.prepare('SELECT click_count FROM tracked_links').get()).toEqual({click_count:0});
 });
});


it.each(['b', null])('rejects a foreign or null account before persisting an identified click: %s', async accountId => {
  await expect(recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId,tagId:null,scenarioId:null,linkName:'link',conversionPointIds:[]}))
    .rejects.toThrow('tracked_click_account_changed');
  expect(item.raw.prepare('SELECT COUNT(*) AS n FROM link_clicks').get()).toEqual({n:0});
  expect(item.raw.prepare('SELECT COUNT(*) AS n FROM workflow_steps').get()).toEqual({n:0});
});
it('refuses a queued friend moved to NULL before any effects run', async () => {
  item.raw.exec("UPDATE line_accounts SET tenant_id='other-tenant' WHERE id='a'");
  const saved = await recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:'tag',scenarioId:null,linkName:'link',conversionPointIds:[]});
  item.raw.exec("UPDATE friends SET line_account_id=NULL WHERE id='f'");
  await expect(processTrackedClick({DB:item.db} as Env['Bindings'],saved.id,saved.plan)).rejects.toThrow('tracked_click_account_changed');
  expect(item.raw.prepare('SELECT n FROM effects ORDER BY id').all()).toEqual([{n:0},{n:0},{n:0},{n:0}]);
});

it('refuses old persisted identified plans without verified identity provenance', async () => {
  const saved = await recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:'tag',scenarioId:null,linkName:'link',conversionPointIds:[]});
  const legacy = {...saved.plan};
  delete legacy.identityVerified;
  item.raw.prepare("UPDATE workflow_steps SET input_json=? WHERE step_key='__run'").run(JSON.stringify(legacy));
  await expect(processTrackedClick({DB:item.db} as Env['Bindings'],saved.id,legacy)).rejects.toThrow('tracked_click_identity_unverified');
  expect(item.raw.prepare('SELECT n FROM effects ORDER BY id').all()).toEqual([{n:0},{n:0},{n:0},{n:0}]);
  await expect(recordTrackedClick(item.db, {linkId:'l',friendId:'f',accountId:'a',tagId:null,scenarioId:null,linkName:'link',conversionPointIds:[]}))
    .rejects.toThrow('tracked_click_identity_unverified');
});


it('records and continues a verified default-tenant NULL friend', async () => {
  item.raw.exec("UPDATE friends SET line_account_id=NULL WHERE id='f'");
  fault.tag = false;
  const saved = await recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:'tag',scenarioId:null,linkName:'link',conversionPointIds:[]});
  expect(item.raw.prepare('SELECT friend_id FROM link_clicks').get()).toEqual({friend_id:'f'});
  await processTrackedClick({DB:item.db} as Env['Bindings'],saved.id,saved.plan);
  expect(item.raw.prepare('SELECT n FROM effects ORDER BY id').all()).toEqual([{n:1},{n:1},{n:1},{n:1}]);
});
it('refuses a queued NULL friend reassigned to another account', async () => {
  item.raw.exec("UPDATE friends SET line_account_id=NULL WHERE id='f'");
  const saved = await recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:'tag',scenarioId:null,linkName:'link',conversionPointIds:[]});
  item.raw.exec("UPDATE friends SET line_account_id='b' WHERE id='f'");
  await expect(processTrackedClick({DB:item.db} as Env['Bindings'],saved.id,saved.plan)).rejects.toThrow('tracked_click_account_changed');
  await expect(recordTrackedClick(item.db, {linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:null,scenarioId:null,linkName:'link',conversionPointIds:[]})).rejects.toThrow('tracked_click_account_changed');
  expect(item.raw.prepare('SELECT n FROM effects ORDER BY id').all()).toEqual([{n:0},{n:0},{n:0},{n:0}]);
});

it('rejects tracking for a friend whose account has been purged', async () => {
  item.raw.exec("UPDATE line_accounts SET data_purged_at='2027-01-01' WHERE id='a'");
  await expect(recordTrackedClick(item.db,{linkId:'l',friendId:'f',identityVerified:true,accountId:'a',tagId:null,scenarioId:null,linkName:'link',conversionPointIds:[]})).rejects.toThrow('tracked_click_account_changed');
  expect(item.raw.prepare('SELECT COUNT(*) AS n FROM link_clicks').get()).toEqual({n:0});
});
