import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { inspectFormTemplate, inspectFormTemplateReferences } from './form.js';
import { buildFormRuntimePlan, createFormReferenceResolver, executeFormStore, executeHqAtomicStore } from './runtime.js';
import { parseScenarioDefinition, planScenario, scenarioSnapshot } from './scenario.js';
import type { HqTemplateAdapterContext, HqTemplateAuthority } from './contract.js';
let fixture: SqliteD1;
const authority: HqTemplateAuthority = { tenantId: 'tenant', actorId: 'owner', role: 'owner', readOnly: false, accountScoped: false };
const definition = { schemaVersion: 1, form: { name: 'Survey', description: null, fields: [{ name: 'answer', label: 'Answer', type: 'text' }], on_submit_tag_id: 'source-tag', on_submit_scenario_id: null } };
const input = { templateVersionId: 'version', definitionJson: JSON.stringify(definition) };
const options = (context: HqTemplateAdapterContext, db = fixture.db) => ({ db, authority, templateId: 'template', runId: 'run', context });
const count = (table: string) => (fixture.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
async function preflight(account: string): Promise<HqTemplateAdapterContext> {
  const version = fixture.raw.prepare("SELECT definition_json FROM hq_template_versions WHERE id='version'").get() as { definition_json: string };
  const currentInput = { ...input, definitionJson: version.definition_json };
  const info = await inspectFormTemplate(fixture.db, authority, account, currentInput), references = await inspectFormTemplateReferences(fixture.db, authority, account, currentInput, info.snapshot), id = `preflight-${account}`;
  fixture.raw.prepare(`INSERT INTO hq_template_preflights(id,tenant_id,template_id,template_version_id,target_account_id,distribution_mode,idempotency_fingerprint,snapshot_token,status,created_by,expires_at) VALUES (?,'tenant','template','version',?,'create','run',?,'ready','owner','2099-01-01T00:00:00.000Z')`).run(id,account,info.snapshotToken);
  fixture.raw.prepare(`INSERT INTO hq_template_preflight_resolutions(preflight_id,tenant_id,template_id,template_version_id,target_account_id,idempotency_fingerprint,snapshot_token,source_id,item_kind,resolution_mode,target_id,expected_revision) VALUES (?,'tenant','template','version',?,'run',?,'form','form','create',?,?)`).run(id,account,info.snapshotToken,info.targetId,info.expectedRevision);
  for (const reference of references) fixture.raw.prepare(`INSERT INTO hq_template_preflight_resolutions(preflight_id,tenant_id,template_id,template_version_id,target_account_id,idempotency_fingerprint,snapshot_token,source_id,item_kind,resolution_mode,target_id,expected_revision) VALUES (?,'tenant','template','version',?,'run',?,?,?,?,?,?)`).run(id,account,info.snapshotToken,reference.sourceId,reference.itemKind,reference.duplicate?'overwrite':'create',reference.targetId,reference.expectedRevision);
  return { tenantId:'tenant',targetAccountId:account,preflightId:id,idempotencyFingerprint:'run',snapshotToken:info.snapshotToken,mode:'create',resolutions:[{sourceId:'form',itemKind:'form',mode:'create'},...references.map(reference=>({sourceId:reference.sourceId,itemKind:reference.itemKind,mode:reference.duplicate?'overwrite' as const:'create' as const,targetId:reference.targetId??undefined,expectedRevision:reference.expectedRevision??undefined}))] };
}
beforeEach(() => {
  fixture = createTestD1({foreignKeys:true});
  fixture.raw.exec("INSERT INTO tenants(id,name) VALUES ('tenant','Tenant'),('other','Other')");
  for (const id of ['source','a','b','c','foreign']) fixture.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id,liff_id) VALUES (?,?,?,'fixture','fixture',?,?)").run(id,id,id,id==='foreign'?'other':'tenant',`liff-${id}`);
  fixture.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES ('source-tag','ＶＩＰ','source'); INSERT INTO hq_templates(id,tenant_id,template_type,name) VALUES ('template','tenant','form','Survey')");
  fixture.raw.prepare("INSERT INTO hq_template_versions(id,tenant_id,template_id,version,definition_json,content_hash) VALUES ('version','tenant','template',1,?,'fixture')").run(input.definitionJson);
  fixture.raw.exec("UPDATE hq_templates SET current_version_id='version' WHERE id='template'");
});
afterEach(() => fixture.raw.close());
test('統括配布は既存の長いシナリオ名をそのまま各店に作る', async () => {
  const name = '長いシナリオ'.repeat(12);
  const definition = parseScenarioDefinition({ schemaVersion: 1, scenario: { name, description: null }, steps: [{ id: 'step', delayMinutes: 0, messageType: 'text', messageContent: '見本' }] });
  const snapshot = await scenarioSnapshot(fixture.db, 'a');
  const plan = planScenario('a', definition, snapshot, [{ sourceId: 'scenario', itemKind: 'scenario', mode: 'create' }]);
  await fixture.db.batch(plan.statements.map(statement => fixture.db.prepare(statement.sql).bind(...statement.bindings)));
  expect(fixture.raw.prepare("SELECT name FROM scenarios WHERE line_account_id='a'").get()).toEqual({ name });
});
describe('form runtime and atomic store execution', () => {
  test('three stores receive private forms and local tags with one audit per store', async () => {
    for(const a of ['a','b','c']) expect(await executeFormStore(options(await preflight(a)))).toEqual({status:'succeeded',reused:false});
    expect(count('forms')).toBe(3); expect(count('tags')).toBe(4);
    const rows=fixture.raw.prepare('SELECT f.is_active,t.line_account_id,fa.line_account_id target FROM forms f JOIN tags t ON t.id=f.on_submit_tag_id JOIN form_accounts fa ON fa.form_id=f.id').all() as Array<{is_active:number;line_account_id:string;target:string}>;
    expect(rows.every(r=>r.is_active===0&&r.line_account_id===r.target)).toBe(true);
    expect(fixture.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.distributed'").get()).toEqual({n:3}); expect(fixture.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test('same-name active tag is overwritten only after its preflight choice is bound',async()=>{
    fixture.raw.exec("INSERT INTO tags(id,name,line_account_id,description) VALUES ('existing','vip','a','keep'),('foreign-tag','vip','foreign','other')");
    await executeFormStore(options(await preflight('a')));
    expect(fixture.raw.prepare('SELECT on_submit_tag_id FROM forms').get()).toEqual({on_submit_tag_id:'existing'});
    expect(fixture.raw.prepare("SELECT description FROM tags WHERE id='existing'").get()).toEqual({description:null}); expect(count('tags')).toBe(3);
  });
  test.each(['foreign','missing','archived'])('%s source tag is rejected without destination writes',async kind=>{
    const c=await preflight('a');
    if(kind==='foreign')fixture.raw.exec("UPDATE tags SET line_account_id='foreign' WHERE id='source-tag'");
    if(kind==='missing')fixture.raw.exec("DELETE FROM tags WHERE id='source-tag'");
    if(kind==='archived')fixture.raw.exec("UPDATE tags SET status='archived' WHERE id='source-tag'");
    expect((await executeFormStore(options(c))).status).toBe('failed');expect(count('forms')).toBe(0);
    expect(fixture.raw.prepare("SELECT id FROM tags WHERE line_account_id='a'").all()).toEqual([]);
  });
  test('a simple referenced scenario is copied as an inactive draft with its steps',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','ありがとうございます')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    expect((await executeFormStore(options(await preflight('a')))).status).toBe('succeeded');
    const form=fixture.raw.prepare('SELECT on_submit_scenario_id FROM forms').get() as {on_submit_scenario_id:string};
    expect(fixture.raw.prepare('SELECT line_account_id,is_active,current_published_version_id FROM scenarios WHERE id=?').get(form.on_submit_scenario_id)).toEqual({line_account_id:'a',is_active:0,current_published_version_id:null});
    expect(fixture.raw.prepare('SELECT scenario_id,message_content,is_draft FROM scenario_steps WHERE scenario_id=?').get(form.on_submit_scenario_id)).toEqual({scenario_id:form.on_submit_scenario_id,message_content:'ありがとうございます',is_draft:1});
  });
  test('invalid scenario actions fail during preflight and leave no destination writes',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('source-scenario','複雑な案内','manual','source'); INSERT INTO scenario_actions(id,scenario_id,hook,action_type,config_json) VALUES ('source-action','source-scenario','scenario_completed','scenario','{}')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    await expect(preflight('a')).rejects.toMatchObject({code:'UNSUPPORTED_REFERENCE'});expect(count('forms')).toBe(0);expect(count('scenarios')).toBe(1);expect(count('tags')).toBe(1);
  });
  test('same-name destination scenario is explicitly overwritten from its bound preflight row',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1),('target-scenario','ご案内','manual','a',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','元の内容'),('target-step','target-scenario',1,'text','別の内容')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    expect((await executeFormStore(options(await preflight('a')))).status).toBe('succeeded');expect(count('forms')).toBe(1);expect(count('scenarios')).toBe(2);
    expect(fixture.raw.prepare("SELECT message_content FROM scenario_steps WHERE scenario_id='target-scenario'").get()).toEqual({message_content:'元の内容'});
  });
  test.each([false, true])('scenario overwrite removes old actions/triggers atomically (rollback=%s)',async rollback=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1),('target-scenario','ご案内','manual','a',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','元の内容'),('target-step','target-scenario',1,'text','別の内容'); INSERT INTO scenario_actions(id,scenario_id,hook,action_type,config_json) VALUES ('old-action','target-scenario','scenario_completed','send_message','{}'); INSERT INTO scenario_triggers(id,scenario_id,kind) VALUES ('old-trigger','target-scenario','friend_add')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    if(rollback)fixture.raw.exec("CREATE TRIGGER reject_form BEFORE INSERT ON forms BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect((await executeFormStore(options(await preflight('a')))).status).toBe(rollback?'failed':'succeeded');
    expect(fixture.raw.prepare("SELECT count(*) n FROM scenario_actions WHERE scenario_id='target-scenario'").get()).toEqual({n:rollback?1:0});
    expect(fixture.raw.prepare("SELECT count(*) n FROM scenario_triggers WHERE scenario_id='target-scenario'").get()).toEqual({n:rollback?1:0});
    expect(fixture.raw.prepare("SELECT message_content FROM scenario_steps WHERE scenario_id='target-scenario'").get()).toEqual({message_content:rollback?'別の内容':'元の内容'});
    expect(fixture.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test('scenario alias choice creates a separately named reference and preserves the selected duplicate',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1),('target-scenario','ご案内','manual','a',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','元の内容'),('target-step','target-scenario',1,'text','既存の内容')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const context=await preflight('a');
    context.resolutions=context.resolutions.map(row=>row.itemKind==='scenario'?{...row,mode:'alias'}:row);
    expect((await executeFormStore(options(context))).status).toBe('succeeded');
    const form=fixture.raw.prepare('SELECT on_submit_scenario_id FROM forms').get() as {on_submit_scenario_id:string};
    expect(fixture.raw.prepare('SELECT name FROM scenarios WHERE id=?').get(form.on_submit_scenario_id)).toEqual({name:'ご案内 (2)'});
    expect(fixture.raw.prepare("SELECT message_content FROM scenario_steps WHERE scenario_id='target-scenario'").get()).toEqual({message_content:'既存の内容'});
  });
  test.each(['encoded-reference','underscore-reference'])('non-portable scenario %s is rejected before destination writes',async kind=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,on_complete_mode,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','pause','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','ありがとうございます')");
    if(kind==='encoded-reference')fixture.raw.exec("UPDATE scenario_steps SET message_content='https%253A%252F%252Fliff.line.me%252Ffixture' WHERE id='source-step'");
    if(kind==='underscore-reference')fixture.raw.exec("UPDATE scenario_steps SET message_content='https://example.invalid/path?line_account_id=source&scenario_id=source-scenario' WHERE id='source-step'");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    await expect(preflight('a')).rejects.toMatchObject({code:'UNSUPPORTED_REFERENCE'});expect(count('forms')).toBe(0);expect(count('scenarios')).toBe(1);
  });
  test('scenario graph copies tags, templates, triggers, actions, and next scenario in one inactive draft batch',async()=>{
    fixture.raw.exec(`
      INSERT INTO tags(id,name,line_account_id) VALUES ('source-trigger-tag','開始タグ','source'),('source-action-tag','完了タグ','source');
      INSERT INTO templates(id,name,message_type,message_content,line_account_id,published_version) VALUES ('source-template','案内テンプレート','text','テンプレート本文','source',1);
      INSERT INTO scenarios(id,name,trigger_type,trigger_tag_id,on_complete_mode,on_complete_scenario_id,line_account_id,is_active) VALUES
        ('source-child','次の案内','manual',NULL,'pause',NULL,'source',1),
        ('source-scenario','複雑な案内','tag_added','source-trigger-tag','move','source-child','source',1);
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content,template_id,on_reach_tag_id) VALUES
        ('source-child-step','source-child',1,'text','次です',NULL,NULL),
        ('source-step','source-scenario',1,'text','控え','source-template','source-action-tag');
      INSERT INTO scenario_actions(id,scenario_id,hook,step_id,sort_order,action_type,config_json) VALUES
        ('source-action-tag-row','source-scenario','step_sent','source-step',0,'tag','{"op":"add","tagIds":["source-action-tag"]}'),
        ('source-action-next','source-scenario','scenario_completed',NULL,1,'scenario','{"op":"start","scenarioId":"source-child"}'),
        ('source-action-template','source-scenario','scenario_completed',NULL,2,'send_template','{"templateId":"source-template"}');
      INSERT INTO scenario_triggers(id,scenario_id,kind,tag_id) VALUES
        ('source-trigger-friend','source-scenario','friend_add',NULL),
        ('source-trigger-tag-row','source-scenario','tag_added','source-trigger-tag');
    `);
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const context=await preflight('a');
    expect(context.resolutions.map(row=>row.sourceId).sort()).toEqual(['form','scenario:source-child','scenario:source-scenario','tag:source-action-tag','tag:source-tag','tag:source-trigger-tag','template:source-template']);
    expect((await executeFormStore(options(context))).status).toBe('succeeded');
    const copied=(fixture.raw.prepare("SELECT id,name,is_active,current_published_version_id,on_complete_scenario_id,trigger_tag_id FROM scenarios WHERE line_account_id='a' ORDER BY name").all()) as Array<Record<string,unknown>>;
    expect(copied).toHaveLength(2); expect(copied.every(row=>row.is_active===0&&row.current_published_version_id===null)).toBe(true);
    const root=copied.find(row=>row.name==='複雑な案内')!, child=copied.find(row=>row.name==='次の案内')!;
    expect(root.on_complete_scenario_id).toBe(child.id);
    expect(fixture.raw.prepare("SELECT published_version,line_account_id FROM templates WHERE line_account_id='a'").get()).toEqual({published_version:0,line_account_id:'a'});
    const step=fixture.raw.prepare('SELECT id,template_id,on_reach_tag_id,is_draft FROM scenario_steps WHERE scenario_id=?').get(root.id) as Record<string,unknown>;
    expect(step.is_draft).toBe(1); expect(step.template_id).not.toBe('source-template'); expect(step.on_reach_tag_id).not.toBe('source-action-tag');
    const actionConfigs=(fixture.raw.prepare('SELECT config_json FROM scenario_actions WHERE scenario_id=? ORDER BY sort_order').all(root.id) as Array<{config_json:string}>).map(row=>JSON.parse(row.config_json));
    expect(JSON.stringify(actionConfigs)).not.toContain('source-');
    expect(fixture.raw.prepare('SELECT count(*) n FROM scenario_triggers WHERE scenario_id=?').get(root.id)).toEqual({n:2});
    expect(fixture.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test('cyclic next-scenario graph fails closed during preflight',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,on_complete_mode,on_complete_scenario_id,line_account_id) VALUES ('source-a','A','manual','move','source-b','source'),('source-b','B','manual','move','source-a','source')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-a'}}));
    await expect(preflight('a')).rejects.toMatchObject({code:'UNSUPPORTED_REFERENCE'}); expect(count('forms')).toBe(0);
  });
  test('ambiguous dependent template is rejected before a preflight decision is stored',async()=>{
    fixture.raw.exec("INSERT INTO templates(id,name,message_type,message_content,line_account_id) VALUES ('source-template','案内','text','本文','source'),('target-template-a','案内','text','A','a'),('target-template-b','案内','text','B','a'); INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('source-scenario','案内シナリオ','manual','source'); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content,template_id) VALUES ('source-step','source-scenario',1,'text','控え','source-template')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    await expect(preflight('a')).rejects.toMatchObject({code:'SELECTION_REQUIRED'}); expect(count('forms')).toBe(0);
  });
  test('a direct tag already planned before its scenario graph is not inserted twice',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,trigger_tag_id,line_account_id) VALUES ('source-scenario','タグ開始','tag_added','source-tag','source'); INSERT INTO scenario_triggers(id,scenario_id,kind,tag_id) VALUES ('source-trigger','source-scenario','tag_added','source-tag')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const context=await preflight('a'), resolve=createFormReferenceResolver({db:fixture.db,authority});
    const tag=await resolve({kind:'tag',sourceId:'source-tag'},context);
    const scenario=await resolve({kind:'scenario',sourceId:'source-scenario'},context);
    expect(tag.dbCommit?.filter(statement=>statement.sql.startsWith('INSERT INTO tags'))).toHaveLength(1);
    expect(scenario.dbCommit?.filter(statement=>statement.sql.startsWith('INSERT INTO tags'))).toHaveLength(0);
  });
  test('a scenario reachable only through template JSON is included in the atomic clone',async()=>{
    fixture.raw.exec(`
      INSERT INTO templates(id,name,message_type,message_content,carousel_actions_json,line_account_id) VALUES ('source-template','分岐テンプレート','carousel','{}','{"0":{"0":[{"scenarioId":"source-child"}]}}','source');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('source-root','入口','manual','source'),('source-child','分岐先','manual','source');
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content,template_id) VALUES ('source-root-step','source-root',1,'text','控え','source-template'),('source-child-step','source-child',1,'text','到着',NULL);
    `);
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-root'}}));
    const context=await preflight('a');
    expect(context.resolutions.map(row=>row.sourceId)).toContain('scenario:source-child');
    expect((await executeFormStore(options(context))).status).toBe('succeeded');
    expect(fixture.raw.prepare("SELECT count(*) n FROM scenarios WHERE line_account_id='a'").get()).toEqual({n:2});
    const template=fixture.raw.prepare("SELECT carousel_actions_json FROM templates WHERE line_account_id='a'").get() as {carousel_actions_json:string};
    expect(template.carousel_actions_json).not.toContain('source-child');
    expect(fixture.raw.pragma('foreign_key_check')).toEqual([]);
  });
  test('source account reuses its exact scenario graph without mutating it before later stores',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','元の内容')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const before=fixture.raw.prepare("SELECT * FROM scenarios WHERE id='source-scenario'").get(), stepBefore=fixture.raw.prepare("SELECT * FROM scenario_steps WHERE id='source-step'").get();
    expect((await executeFormStore(options(await preflight('source')))).status).toBe('succeeded');
    expect(fixture.raw.prepare("SELECT * FROM scenarios WHERE id='source-scenario'").get()).toEqual(before);
    expect(fixture.raw.prepare("SELECT * FROM scenario_steps WHERE id='source-step'").get()).toEqual(stepBefore);
    expect((await executeFormStore(options(await preflight('a')))).status).toBe('succeeded');
  });
  test.each([['a-root','b-child'],['z-root','a-child']])('overlapping direct parent %s and child %s roots share one planned target without duplicate inserts',async(parentId,childId)=>{
    fixture.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,on_complete_mode,on_complete_scenario_id,line_account_id) VALUES (?,'親','manual','move',?,'source'),(?,'子','manual','stop',NULL,'source')").run(parentId,childId,childId);
    fixture.raw.prepare("INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('parent-step',?,1,'text','親本文'),('child-step',?,1,'text','子本文')").run(parentId,childId);
    const layout={version:2,header:[],sections:[{id:'page',name:'質問',blocks:[{id:'field',kind:'input',name:'answer',label:'質問',type:'text'}]}],options:{afterActions:[{kind:'scenario',op:'start',scenarioId:childId}]}};
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,layout,on_submit_scenario_id:parentId}}));
    const context=await preflight('a');
    expect(context.resolutions.filter(row=>row.itemKind==='scenario').every(row=>row.expectedRevision?.includes('hqsg1.'))).toBe(true);
    expect((await executeFormStore(options(context))).status).toBe('succeeded');
    expect(fixture.raw.prepare("SELECT COUNT(*) n FROM scenarios WHERE line_account_id='a'").get()).toEqual({n:2});
  });
  test.each(['step-image','template-flex-image'])('non-portable media in scenario graph (%s) fails closed during preflight',async kind=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES ('source-scenario','画像案内','manual','source')");
    if(kind==='step-image') fixture.raw.exec("INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'image','https://cdn.example.invalid/source-only.jpg')");
    else fixture.raw.exec("INSERT INTO templates(id,name,message_type,message_content,line_account_id) VALUES ('source-template','画像カード','flex','{\"type\":\"bubble\",\"hero\":{\"type\":\"image\",\"url\":\"https://cdn.example.invalid/source-only.jpg\"}}','source'); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content,template_id) VALUES ('source-step','source-scenario',1,'text','控え','source-template')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    await expect(preflight('a')).rejects.toMatchObject({code:'UNSUPPORTED_REFERENCE'}); expect(count('forms')).toBe(0);
  });
  test('concurrent replay observes staged and never starts another business plan',async()=>{
    const c=await preflight('a');let release!:()=>void,entered!:()=>void,builds=0;
    const gate=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r});
    const first=executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>{builds++;entered();await gate;return buildFormRuntimePlan({db:fixture.db,authority,context,input})}});
    await ready;expect(await executeFormStore(options(c))).toEqual({status:'staged',reused:true});release();expect((await first).status).toBe('succeeded');expect(builds).toBe(1);
    expect(await executeFormStore(options(c))).toEqual({status:'succeeded',reused:true});expect(count('forms')).toBe(1);expect(fixture.raw.prepare('SELECT attempt_count FROM hq_template_distribution_results').get()).toEqual({attempt_count:2});
  });
  test('lost successful batch response recovers success, not another creation',async()=>{
    const c=await preflight('a');const db={prepare:fixture.db.prepare.bind(fixture.db),batch:async(s:D1PreparedStatement[])=>{await fixture.db.batch(s);throw new Error('response lost')}}as unknown as D1Database;
    expect((await executeFormStore(options(c,db))).status).toBe('succeeded');await executeFormStore(options(c));expect(count('forms')).toBe(1);
    expect(fixture.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.distributed'").get()).toEqual({n:1});
  });
  test('business failure retries safely, rolls back partial writes, then becomes terminal',async()=>{
    const c=await preflight('a');fixture.raw.exec("CREATE TRIGGER fail_form BEFORE INSERT ON forms BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect((await executeFormStore(options(c))).status).toBe('failed');expect(count('forms')).toBe(0);expect(count('tags')).toBe(1);
    expect(fixture.raw.prepare('SELECT target_id FROM hq_template_preflight_resolutions').get()).toEqual({target_id:null});expect(fixture.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.distributed'").get()).toEqual({n:0});
    fixture.raw.exec('DROP TRIGGER fail_form');expect(await executeFormStore(options(c))).toEqual({status:'failed',reused:true});expect(count('forms')).toBe(0);
  });
  test('one destination edit conflicts without blocking another store',async()=>{
    const a=await preflight('a'),b=await preflight('b');fixture.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES ('changed','edited','a')");
    expect((await executeFormStore(options(a))).status).toBe('version_conflict');expect((await executeFormStore(options(b))).status).toBe('succeeded');expect(count('forms')).toBe(1);
  });
  test('source edit between plan and batch rolls back all destination writes',async()=>{
    const c=await preflight('a');expect((await executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>{const p=await buildFormRuntimePlan({db:fixture.db,authority,context,input});fixture.raw.exec("UPDATE tags SET name='changed' WHERE id='source-tag'");return p}})).status).toBe('failed');expect(count('forms')).toBe(0);expect(count('tags')).toBe(1);
  });
  test('source scenario graph edited after preflight is rejected as a version conflict',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','最初の内容')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const context=await preflight('a'), revision=context.resolutions.find(row=>row.sourceId==='scenario:source-scenario')?.expectedRevision;
    expect(revision).toContain('hqsg1.');
    fixture.raw.exec("UPDATE scenario_steps SET message_content='事前確認後の変更' WHERE id='source-step'");
    expect((await executeFormStore(options(context))).status).toBe('version_conflict');
    expect(count('forms')).toBe(0);expect(fixture.raw.prepare("SELECT COUNT(*) n FROM scenarios WHERE line_account_id='a'").get()).toEqual({n:0});
  });
  test('scenario step insertion between plan and batch is detected atomically',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','最初の内容')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const c=await preflight('a');
    const result=await executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>{const plan=await buildFormRuntimePlan({db:fixture.db,authority,context,input});fixture.raw.exec("INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('late-step','source-scenario',2,'text','後から追加')");return plan}});
    expect(result.status).toBe('failed');expect(count('forms')).toBe(0);expect(fixture.raw.prepare("SELECT COUNT(*) n FROM scenarios WHERE line_account_id='a'").get()).toEqual({n:0});
  });
  test('scenario action edit between plan and batch is detected and rolls back the graph',async()=>{
    fixture.raw.exec("INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES ('source-scenario','ご案内','manual','source',1); INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES ('source-step','source-scenario',1,'text','最初の内容'); INSERT INTO scenario_actions(id,scenario_id,hook,action_type,config_json) VALUES ('source-action','source-scenario','scenario_completed','send_message','{\"content\":\"完了\"}')");
    fixture.raw.prepare("UPDATE hq_template_versions SET definition_json=? WHERE id='version'").run(JSON.stringify({...definition,form:{...definition.form,on_submit_scenario_id:'source-scenario'}}));
    const c=await preflight('a');
    const result=await executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>{const plan=await buildFormRuntimePlan({db:fixture.db,authority,context,input});fixture.raw.exec("UPDATE scenario_actions SET config_json='{\"content\":\"変更\"}' WHERE id='source-action'");return plan}});
    expect(result.status).toBe('failed');expect(count('forms')).toBe(0);expect(fixture.raw.prepare("SELECT COUNT(*) n FROM scenarios WHERE line_account_id='a'").get()).toEqual({n:0});
  });
  test('changed replay choices and foreign authority cannot reuse the result',async()=>{
    const c=await preflight('a');await executeFormStore(options(c));
    await expect(executeFormStore(options({...c,mode:'alias',resolutions:c.resolutions.map(r=>r.sourceId==='form'?{...r,mode:'alias'}:r)}))).rejects.toMatchObject({code:'SELECTION_CHANGED'});
    await expect(executeFormStore({...options(c),authority:{...authority,tenantId:'other'}})).rejects.toMatchObject({code:'FORBIDDEN'});expect(count('forms')).toBe(1);
  });
  test('simultaneous first submissions execute the plan once',async()=>{
    const c=await preflight('a');let builds=0;
    const run=()=>executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>{builds++;return buildFormRuntimePlan({db:fixture.db,authority,context,input})}});
    const results=await Promise.all([run(),run()]);expect(builds).toBe(1);expect(results.some(r=>r.status==='succeeded')).toBe(true);expect(count('forms')).toBe(1);
  });
  test('pending claim interruption can resume without changing the immutable decision',async()=>{
    const c=await preflight('a');let blocked=true;
    const db={prepare:(sql:string)=>{if(blocked&&sql.startsWith("UPDATE hq_template_distribution_results SET status='staged'")){blocked=false;throw new Error('interrupted before claim')}return fixture.db.prepare(sql)},batch:fixture.db.batch.bind(fixture.db)}as unknown as D1Database;
    await expect(executeFormStore(options(c,db))).rejects.toThrow('interrupted');
    expect(fixture.raw.prepare('SELECT status FROM hq_template_distribution_results').get()).toEqual({status:'pending'});
    expect((await executeFormStore(options(c))).status).toBe('succeeded');expect(count('forms')).toBe(1);
  });
  test('ambiguous or archived destination name fails during preflight without creating another tag',async()=>{
    fixture.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES ('duplicate1','vip','a'),('duplicate2','ＶＩＰ','a')");
    await expect(preflight('a')).rejects.toMatchObject({code:'SELECTION_REQUIRED'});expect(count('forms')).toBe(0);
  });
  test('expired preflight cannot be claimed',async()=>{
    const c=await preflight('a');fixture.raw.exec("UPDATE hq_template_preflights SET expires_at='2000-01-01T00:00:00Z'");
    await expect(executeFormStore(options(c))).rejects.toMatchObject({code:'VERSION_CONFLICT'});expect(count('hq_template_distribution_results')).toBe(0);
  });
  test('R2 plan is rejected before business writes',async()=>{
    const c=await preflight('a');const r=await executeHqAtomicStore({...options(c),buildPlan:async(context,input)=>({...await buildFormRuntimePlan({db:fixture.db,authority,context,input}),stage:[{key:'fixture',ownerToken:'fixture',bytes:new Uint8Array()}]})});expect(r.status).toBe('unsupported');expect(count('forms')).toBe(0);expect(count('tags')).toBe(1);
  });
});
