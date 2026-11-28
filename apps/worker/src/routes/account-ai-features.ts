import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite} from '../services/gap-common.js';
import {AI_DISCLOSURE,AI_DISCLOSURE_VERSION,accountAiAlwaysOn,accountAiSetting,type AccountAiFeature} from '../services/account-ai-features.js';
import {sensitiveStepUpSatisfied,stepUpRequiredResponse} from '../lib/step-up.js';
import {requireRole} from '../middleware/role-guard.js';
export const accountAiFeatures=new Hono<Env>();
accountAiFeatures.use('/api/ai-features*',requireRole('owner','admin'));
accountAiFeatures.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'ai_settings_unavailable'},e instanceof GapError?e.status:503));
accountAiFeatures.get('/api/ai-features',async c=>{
 const a=await gapAccount(c);
 return c.json({success:true,data:{items:await Promise.all((['banner','google_review'] as const).map(f=>accountAiSetting(c.env.DB,a,f,c.env))),disclosure:AI_DISCLOSURE,disclosureVersion:AI_DISCLOSURE_VERSION}});
});
accountAiFeatures.put('/api/ai-features/:feature',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),feature=c.req.param('feature') as AccountAiFeature;
 if(!['banner','google_review'].includes(feature))throw new GapError('invalid_ai_feature');
 if(accountAiAlwaysOn(c.env))throw new GapError('ai_always_on',409);
 const b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(typeof b.enabled!=='boolean')throw new GapError('invalid_ai_feature');
 if(b.enabled){
  if(b.consent!==true||b.disclosureVersion!==AI_DISCLOSURE_VERSION)throw new GapError('ai_consent_required');
  if(!await sensitiveStepUpSatisfied(c,'ai.settings'))return stepUpRequiredResponse(c,'AIの利用を始めるには本人確認が必要です');
 }
 const actor=c.get('staff').id,now=new Date().toISOString(),db=c.env.DB;
 const result=await db.batch([
  db.prepare(`INSERT INTO account_ai_features(account_id,feature,enabled,consent_by,consent_at,disclosure_version) SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM account_ai_features WHERE account_id=? AND feature=? AND version=?)
   ON CONFLICT(account_id,feature) DO UPDATE SET enabled=excluded.enabled,version=version+1,
   consent_by=CASE WHEN excluded.enabled=1 THEN excluded.consent_by ELSE consent_by END,
   consent_at=CASE WHEN excluded.enabled=1 THEN excluded.consent_at ELSE consent_at END,
   disclosure_version=CASE WHEN excluded.enabled=1 THEN excluded.disclosure_version ELSE disclosure_version END WHERE version=?`)
   .bind(a,feature,b.enabled?1:0,b.enabled?actor:null,b.enabled?now:null,b.enabled?AI_DISCLOSURE_VERSION:null,v,a,feature,v,v),
  db.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,detail_json) SELECT ?,'account_ai_feature',?,'changed',?,? WHERE changes()=1`)
   .bind(crypto.randomUUID(),a,actor,JSON.stringify({feature,enabled:b.enabled,consent:b.enabled?{by:actor,at:now,disclosureVersion:AI_DISCLOSURE_VERSION,text:AI_DISCLOSURE}:null})),
 ]);
 if(!result[0].meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await accountAiSetting(db,a,feature,c.env)});
});
