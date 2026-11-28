import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {accountAiFeatures} from './account-ai-features.js';
import {aiDrafts} from './ai-drafts.js';
import {AI_DISCLOSURE_VERSION,accountAiSetting,g2OpenAiAvailable} from '../services/account-ai-features.js';
import {createLineAccount} from '@line-crm/db';
import {initializeAccountStyle} from '../services/style-setup.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();d.raw.close();vi.unstubAllGlobals();});
const path='/api/ai-features/banner?account_id=a';
const body={enabled:true,expectedVersion:0,consent:true,disclosureVersion:AI_DISCLOSURE_VERSION};
async function put(b:unknown=body,staff=gapOwner,im=false){return gapApp(d,[accountAiFeatures],staff,im).request(path,{method:'PUT',headers:{Authorization:'Bearer lh_session:session','Content-Type':'application/json'},body:JSON.stringify(b)});}
test('G2の設定は既定オフ、店ごとのAIは常時オン',async()=>{
 const fresh=await createLineAccount(d.db,{channelId:'fresh',name:'新店',channelAccessToken:'fake',channelSecret:'fake',tenantId:'t'},'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
 for(const a of ['a',fresh.id]){
  const result=await gapCall(gapApp(d,[aiDrafts]),'/api/ai-settings?account_id='+a);expect((await result.json() as {data:{mode:string}}).data.mode).toBe('off');
  await initializeAccountStyle(d.db,a,'t','o');
  expect((await (await gapCall(gapApp(d,[aiDrafts]),'/api/ai-settings?account_id='+a)).json() as {data:{mode:string}}).data.mode).toBe('off');
  for(const f of ['banner','google_review'] as const)expect(await accountAiSetting(d.db,a,f)).toMatchObject({enabled:true,alwaysOn:true,version:0,consentBy:null});
 }
});
test('常時オンの利用設定は変更できず、権限と監査を守る',async()=>{
 for(const [staff,im] of [[{...gapOwner,readOnly:true},false],[{...gapOwner,role:'staff' as const},false],[gapOwner,true]] as const)expect((await put(body,staff,im)).status).toBe(403);
 for(const enabled of [true,false]){const r=await put({enabled,expectedVersion:0});expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:'ai_always_on'});}
 expect(d.raw.prepare('SELECT count(*) n FROM account_ai_features').get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT count(*) n FROM operation_audit WHERE target_kind='account_ai_feature'").get()).toEqual({n:0});
});
test('G2は既定も本番もOpenAIを呼ばず、設定がonでも拒否する',async()=>{
 d.raw.exec("INSERT INTO chats(id,friend_id,created_at,updated_at) VALUES('chat','f','now','now');INSERT INTO ai_settings(account_id,mode,updated_by) VALUES('a','draft_only','o')");
 for(const bindings of [{},{G2_OPENAI_ENABLED:'true'},{G2_OPENAI_ENABLED:'true',DEPLOY_ENV:'production'},{G2_OPENAI_ENABLED:'true',DEPLOY_ENV:'unknown'}])for(const kind of ['summary','draft']){
  const r=await gapCall(gapApp(d,[aiDrafts],gapOwner,false,{OPENAI_API_KEY:'fake',...bindings}),`/api/chats/chat/ai/${kind}`,'POST',{});expect(r.status).toBe(409);expect((await r.json() as {error:string}).error).toBe('g2_ai_unavailable');
 }
 expect(g2OpenAiAvailable({G2_OPENAI_ENABLED:'true',DEPLOY_ENV:'staging'})).toBe(true);
 expect(d.raw.prepare('SELECT count(*) n FROM ai_usage_counters').get()).toEqual({n:0});
});
