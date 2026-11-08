import { checkMediaGate } from './file-scan.js';
import { getPinnedMediaObject } from './media-upload-storage.js';
import {requireAccountAi} from './account-ai-features.js';
import {
  bannerReferencesFromRow,claimWorkflowStep,ensureWorkflowStep,failWorkflowStep,finishWorkflowStep,
  getBannerGeneration,getBannerImageWithDetail,getBannerUsageThisMonth,getBannerUsageToday,getTenantBilling,
  countRecentFailedBannerGenerations,toJstString,releaseWorkflowStep,workflowFence,getWorkflowStep,
  type BannerGeneration,type WorkflowStepRef,
} from '@line-crm/db';


import type { Env } from '../worker-env.js';
import { resolveTenantEntitlements } from './billing-plans.js';
import { findBannerPreset } from './banner-prompt.js';
import { resizeBannerToPreset,type BannerCropPosition } from './banner-resize.js';
import { generateOpenAIImage,OpenAIImageError,DEFAULT_OPENAI_IMAGE_MODEL,type OpenAIReferenceImage } from './openai-images.js';
import { stableWebhookStepId } from './incoming-webhook-receipts.js';

export class BannerJobFailure extends Error { constructor(message:string,public status:number){super(message)} }

/** 1回に画像1枚を永続的に処理し、定期処理が未完了の続きへ進む。 */
export async function processBannerGeneration(env:Env['Bindings'],generationId:string,tenantId:string):Promise<string|null>{
  const db=env.DB;
  const ref:WorkflowStepRef={scopeId:`tenant:${tenantId}`,processKind:'banner_generation',subjectId:generationId,stepKey:'__run'};
  await ensureWorkflowStep(db,ref,{maxAttempts:50});
  const root=await claimWorkflowStep(db,ref,{leaseMs:300_000});
  if(!root){
    const current=await getWorkflowStep(db,ref);
    if(current && ['exhausted','unknown'].includes(current.status))await db.prepare(`UPDATE banner_generations SET status='failed',
      error_message='作成を再開できませんでした。管理者に確認してください',finished_at=?
      WHERE id=? AND tenant_id=? AND status IN ('queued','running')`).bind(toJstString(new Date()),generationId,tenantId).run();
    return null;
  }
  const owner=root.lease_owner!;
  const quotaRef={scopeId:ref.scopeId,processKind:'banner_quota',subjectId:tenantId,stepKey:'__run'};
  await ensureWorkflowStep(db,quotaRef,{maxAttempts:50});
  const quota=await claimWorkflowStep(db,quotaRef,{leaseMs:300_000});
  if(!quota){await releaseWorkflowStep(db,ref,owner);return null;}
  try {
    const generation=await getBannerGeneration(db,generationId,tenantId);
    if(!generation || generation.stop_requested_at || !['queued','running'].includes(generation.status)){
      await finishWorkflowStep(db,ref,owner);return null;
    }
    await requireAccountAi(db,generation.ai_account_id,'banner',tenantId);
    const imageId=await processNextImage(env,generation,ref,owner);
    await reconcileBannerProgress(db,generation);
    const latest=await getBannerGeneration(db,generationId,tenantId);
    if(latest && ['queued','running'].includes(latest.status))await releaseWorkflowStep(db,ref,owner);
    else await finishWorkflowStep(db,ref,owner);
    return imageId;
  }catch(error){
    const latest=await getBannerGeneration(db,generationId,tenantId);
    if(latest && !['queued','running'].includes(latest.status))await finishWorkflowStep(db,ref,owner);
    else await failWorkflowStep(db,ref,owner,{delayMs:60_000});
    throw error;
  }
  finally{await releaseWorkflowStep(db,quotaRef,quota.lease_owner!);}
}
async function processNextImage(env:Env['Bindings'],g:BannerGeneration,root:WorkflowStepRef,owner:string):Promise<string|null>{
  const db=env.DB;
  // 保存済み画像があれば、その順番は完了として扱い再生成しない。
  for(let sequence=1;sequence<=g.requested_count;sequence++){
    const slot={...root,stepKey:`image:${sequence}`};
    const saved=await db.prepare('SELECT id FROM banner_images WHERE generation_id=? AND sequence=? ORDER BY created_at LIMIT 1')
      .bind(g.id,sequence).first<{id:string}>();
    const previous=await ensureWorkflowStep(db,slot,{maxAttempts:50,input:{sequence,gravity:g.crop_gravity ?? 'center'}});
    if(saved){
      if(previous.status!=='succeeded'){
        const claim=await claimWorkflowStep(db,slot);
        if(claim)await finishWorkflowStep(db,slot,claim.lease_owner!,{result:{imageId:saved.id}});
      }continue;
    }
    if(previous.status==='succeeded')continue;
    const claim=await claimWorkflowStep(db,slot);
    if(!claim)return null;
    const slotOwner=claim.lease_owner!;
    try{
      const rawKey=`banner/${g.id}/${sequence}/source`;
      let source=await env.IMAGES.get(rawKey);
      if(!source){
        const render={...root,stepKey:`render:${sequence}`};
        const prior=await ensureWorkflowStep(db,render,{maxAttempts:1});
        // 実行中断や応答喪失で外部生成を再実行しない。保存済み R2 オブジェクトだけを回復の根拠にする。
        if(prior.first_attempt_at!==null){
          const message='画像を作れませんでした。生成結果が不明な画像は作り直していません';
          await finishWorkflowStep(db,slot,slotOwner,{result:{failed:true,unknown:true},statements:[workflowFence(db,root,owner),
            db.prepare(`UPDATE banner_generations SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'canceled'
              WHEN done_count>0 THEN 'done' ELSE 'failed' END,failed_count=failed_count+1,error_message=?,finished_at=? WHERE id=? AND tenant_id=?`)
              .bind(message,toJstString(new Date()),g.id,g.tenant_id),
          ]});
          throw new BannerJobFailure(message,502);
        }
        const renderClaim=await claimWorkflowStep(db,render,{leaseMs:300_000});
        if(!renderClaim)return null;
        let providerStarted=false;
        try{
          const exempt=Number(env.BANNER_MONTHLY_IMAGES) || 150;
          const entitlements=await resolveTenantEntitlements(db,await getTenantBilling(db,g.tenant_id),{exemptMonthlyImages:exempt});
          const [month,today,failures]=await Promise.all([getBannerUsageThisMonth(db,g.tenant_id),getBannerUsageToday(db,g.tenant_id),
            countRecentFailedBannerGenerations(db,g.tenant_id,toJstString(new Date(Date.now()-15*60_000)))]);
          if(!entitlements.canGenerate || month>=entitlements.monthlyImages || today>=Math.max(1,Math.ceil(entitlements.monthlyImages/5)) || failures>=3)
            throw new Error('banner_limit_or_pause');
          if(!env.OPENAI_API_KEY)throw new Error('banner_configuration_missing');
          const references:OpenAIReferenceImage[]=[];
          for(const entry of bannerReferencesFromRow(g)){
            const image=await getBannerImageWithDetail(db,entry.imageId,g.tenant_id);
            if(!image || image.deleted_at)throw new Error('banner_reference_missing');
            const gate=await checkMediaGate(db,env.IMAGES,{
              id:image.media.id,lineAccountId:image.media.line_account_id,r2Key:image.media.r2_key,
              filename:image.media.filename,mimeType:image.media.mime_type,sizeBytes:image.media.size_bytes,
              width:image.media.width,height:image.media.height,
            });
            if(!gate.allowed)throw new Error('banner_reference_missing');
            const object=await getPinnedMediaObject(env.IMAGES,image.media.r2_key,gate.etag);
            if(!object)throw new Error('banner_reference_missing');
            references.push({bytes:new Uint8Array(await object.arrayBuffer()),mimeType:image.media.mime_type,filename:image.media.filename});
          }
          const latest=await getBannerGeneration(db,g.id,g.tenant_id);
          if(latest?.stop_requested_at){await releaseWorkflowStep(db,render,renderClaim.lease_owner!);await releaseWorkflowStep(db,slot,slotOwner);return null;}
          await db.batch([workflowFence(db,root,owner),workflowFence(db,render,renderClaim.lease_owner!)]);
          providerStarted=true;
          await requireAccountAi(db,g.ai_account_id,'banner',g.tenant_id);
          const result=await generateOpenAIImage({apiKey:env.OPENAI_API_KEY,model:g.model_name || env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL,
            prompt:g.final_prompt,size:g.api_size as '1024x1024'|'1536x1024'|'1024x1536',quality:g.quality,referenceImages:references});
          await env.IMAGES.put(rawKey,result.bytes,{httpMetadata:{contentType:result.mimeType},customMetadata:{generationId:g.id}});
          await finishWorkflowStep(db,render,renderClaim.lease_owner!,{result:{r2Key:rawKey,mimeType:result.mimeType}});
          source=await env.IMAGES.get(rawKey);
        }catch(error){
          await failWorkflowStep(db,render,renderClaim.lease_owner!,{unknown:true,code:'render_failed'});
          // 外部呼出をした可能性があれば、同じ画像をもう一度生成しない。
          if(await env.IMAGES.get(rawKey))throw error;
          const message=error instanceof OpenAIImageError?error.userMessage
            :error instanceof Error && error.message==='banner_reference_missing'?'参照画像が見つかりません。ライブラリから選び直してください'
              :'画像を作れませんでした。生成結果が不明な画像は作り直していません';
          const status=error instanceof OpenAIImageError && error.kind==='safety'?422
            :error instanceof Error && error.message==='banner_reference_missing'?400:502;
          await finishWorkflowStep(db,slot,slotOwner,{result:{failed:true,unknown:providerStarted,status},statements:[
            workflowFence(db,root,owner),db.prepare(`UPDATE banner_generations SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'canceled'
              WHEN done_count>0 THEN 'done' ELSE 'failed' END,failed_count=failed_count+1,error_message=?,finished_at=? WHERE id=? AND tenant_id=?`)
              .bind(message,toJstString(new Date()),g.id,g.tenant_id),
          ]});
          throw new BannerJobFailure(message,status);
        }
      }
      if(!source)throw new Error('banner_source_missing');
      const render={...root,stepKey:`render:${sequence}`};
      // チェックポイント保存が失敗しても、保存済み R2 が生成成功の根拠になる。
      await db.batch([workflowFence(db,root,owner),db.prepare(`UPDATE workflow_steps SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
        result_json=?,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?`)
        .bind(JSON.stringify({r2Key:rawKey,mimeType:source.httpMetadata?.contentType ?? JSON.parse((await getWorkflowStep(db,render))?.result_json ?? '{}').mimeType ?? 'image/png'}),Date.now(),render.scopeId,render.processKind,render.subjectId,render.stepKey)]);
      const bytes=new Uint8Array(await source.arrayBuffer()),preset=findBannerPreset(g.preset_key);
      const originalDims=g.api_size.split('x').map(Number);
      const gravity=JSON.parse(claim.input_json!).gravity as BannerCropPosition;
      const shaped=preset?await resizeBannerToPreset(bytes,preset,gravity,env.CF_IMAGES ?? null)
        :{bytes,width:originalDims[0],height:originalDims[1],resized:false};
      const rendered=await getWorkflowStep(db,render);
      const originalMime=source.httpMetadata?.contentType ?? JSON.parse(rendered?.result_json ?? '{}').mimeType ?? 'image/png';
      const mimeType=shaped.resized?'image/jpeg':originalMime;
      const key=`banner/${g.id}/${sequence}/final.jpg`;
      await env.IMAGES.put(key,shaped.bytes,{httpMetadata:{contentType:mimeType}});
      const mediaId=await stableWebhookStepId(g.id,`media:${sequence}`),imageId=await stableWebhookStepId(g.id,`image:${sequence}`);
      const versionId=await stableWebhookStepId(g.id,`media-version:${sequence}`),usageId=await stableWebhookStepId(g.id,`usage:${sequence}`);
      const references=bannerReferencesFromRow(g),edited=references.find(entry=>entry.mode==='edit'),now=toJstString(new Date());
      await finishWorkflowStep(db,slot,slotOwner,{result:{imageId,resized:shaped.resized},statements:[workflowFence(db,root,owner),
        db.prepare(`INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,width,height,r2_key,uploaded_by,created_at)
          VALUES(?,NULL,'image',?,?,?,?,?,?,?,?)`).bind(mediaId,`banner-${sequence}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,mimeType,shaped.bytes.byteLength,shaped.width ?? null,shaped.height ?? null,key,g.created_by,now),
        db.prepare(`INSERT INTO media_versions(id,media_id,version_no,r2_key,mime_type,size_bytes,width,height,scan_status,scanned_at,uploaded_by,created_at,published_at)
          VALUES(?,?,1,?,?,?,?,?,'verified',?,?,?,?)`).bind(versionId,mediaId,key,mimeType,shaped.bytes.byteLength,shaped.width ?? null,shaped.height ?? null,now,g.created_by,now,now),
        db.prepare(`INSERT INTO banner_images(id,tenant_id,project_id,generation_id,media_id,sequence,source,parent_image_id,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(imageId,g.tenant_id,g.project_id,g.id,mediaId,sequence,edited?'edited':'generated',edited?.imageId ?? references[0]?.imageId ?? null,g.created_by,now),
        db.prepare(`INSERT INTO banner_usage_ledger(id,tenant_id,generation_id,units,reason,created_at)VALUES(?,?,?,1,?,?)`)
          .bind(usageId,g.tenant_id,g.id,edited?'edit':'generate',now),
      ]});
      await env.IMAGES.delete(rawKey).catch(()=>undefined);
      return imageId;
    }catch(error){await failWorkflowStep(db,slot,slotOwner,{delayMs:60_000});throw error;}
  }
  return null;
}
async function reconcileBannerProgress(db:D1Database,g:BannerGeneration):Promise<void>{
  const counts=await db.prepare(`SELECT (SELECT COUNT(*) FROM banner_images WHERE generation_id=?) AS done,
    (SELECT COUNT(*) FROM workflow_steps WHERE scope_id=? AND process_kind='banner_generation' AND subject_id=?
      AND step_key LIKE 'image:%' AND status='succeeded' AND json_extract(result_json,'$.failed')=1) AS failed`)
    .bind(g.id,`tenant:${g.tenant_id}`,g.id).first<{done:number;failed:number}>();
  const finished=counts!.done+counts!.failed>=g.requested_count;
  await db.prepare(`UPDATE banner_generations SET done_count=?,failed_count=?,status=CASE WHEN stop_requested_at IS NOT NULL THEN 'canceled'
    WHEN status IN ('done','failed','canceled') THEN status ELSE ? END,started_at=COALESCE(started_at,?),finished_at=CASE WHEN ? OR stop_requested_at IS NOT NULL THEN ? ELSE finished_at END,
    error_message=CASE WHEN ?>0 THEN '一部の画像を作れませんでした。生成結果が不明な画像は作り直していません' ELSE error_message END
    WHERE id=? AND tenant_id=?`).bind(counts!.done,counts!.failed,finished?(counts!.done>0?'done':'failed'):'running',
      toJstString(new Date()),finished?1:0,toJstString(new Date()),counts!.failed,g.id,g.tenant_id).run();
}
export async function processDueBannerGenerations(env:Env['Bindings']):Promise<number>{
  const due=await env.DB.prepare(`SELECT g.id,g.tenant_id FROM banner_generations g WHERE g.status IN ('queued','running') AND g.stop_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM workflow_steps w WHERE w.scope_id='tenant:' || g.tenant_id
      AND w.process_kind='banner_generation' AND w.subject_id=g.id AND w.step_key='__run'
      AND ((w.status='running' AND w.lease_expires_at>?) OR w.next_attempt_at>?))
    ORDER BY g.created_at LIMIT 20`).bind(Date.now(),Date.now()).all<{id:string;tenant_id:string}>();
  for(const row of due.results)await processBannerGeneration(env,row.id,row.tenant_id).catch(()=>undefined);
  return due.results.length;
}
