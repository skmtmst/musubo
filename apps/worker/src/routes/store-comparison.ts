import type { StoreComparisonDetail } from '@line-crm/shared';
import { readAccountAttention } from '../services/hq-account-attention.js';
import {comparisonData,checkExportAccess} from '../services/store-comparison-export.js';
import {gapBody,gapKey} from '../services/gap-common.js';
import {Hono,type Context,type Handler} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError} from '../services/gap-common.js';
import {getVisibleLineAccountScope} from '../services/account-access.js';
import {comparisonAccounts,comparisonKeys,comparisonUnits,comparisonPeriod,comparisonTrend,storeNumbers,type ComparisonKey} from '../services/store-comparison.js';
export const storeComparison=new Hono<Env>();
storeComparison.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'comparison_unavailable'},e instanceof GapError?e.status:503));
async function stores(c:Context<Env>){const s=c.get('staff');if(!s?.tenantId||(!['owner','admin'].includes(s.role)&&!s.hqRole))throw new GapError('forbidden',403);const member=await c.env.DB.prepare("SELECT id FROM staff_members WHERE id=? AND tenant_id=? AND is_active=1 AND account_scope='all'").bind(s.id,s.tenantId).first();if(!member&&c.get('impersonation')?.tenantId!==s.tenantId)throw new GapError('forbidden',403);return comparisonAccounts((await getVisibleLineAccountScope(c.env.DB,s)).accounts);}
storeComparison.get('/api/hq/store-comparison',async c=>{const visible=await stores(c);const filters=c.req.query();return c.json({success:true,data:await comparisonData(c.env.DB,visible,c.get('staff').tenantId!,filters)});});
storeComparison.post('/api/hq/store-comparison/export',async c=>{
 const visible=await stores(c);if(c.get('impersonation'))throw new GapError('IMPERSONATION_WRITE_BLOCKED',403);
 const b=await gapBody(c),allowed=['from','to','compare','poolId','sort','order'];if(Object.keys(b).some(k=>!allowed.includes(k))||Object.values(b).some(v=>typeof v!=='string'))throw new GapError('invalid_filter');
 const filters=Object.fromEntries(allowed.filter(k=>b[k]!==undefined).map(k=>[k,String(b[k])])),request=JSON.stringify(filters),key=gapKey(c),staff=c.get('staff');
 const data=await comparisonData(c.env.DB,visible,staff.tenantId!,filters,true);
 const old=await c.env.DB.prepare('SELECT id,filters_json FROM hq_store_comparison_export_jobs WHERE tenant_id=? AND requested_by=? AND request_key=?').bind(staff.tenantId!,staff.id,key).first<{id:string;filters_json:string}>();
 if(old){if(old.filters_json!==request)throw new GapError('idempotency_conflict',409);return c.json({success:true,data:{id:old.id,replayed:true}},202);}
 const id=crypto.randomUUID(),now=new Date();
 await c.env.DB.prepare('INSERT INTO hq_store_comparison_export_jobs(id,tenant_id,requested_by,request_key,filters_json,account_ids_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,requested_by,request_key) DO NOTHING').bind(id,staff.tenantId!,staff.id,key,request,JSON.stringify(data.rows.map(r=>r.accountId)),now.toISOString(),new Date(now.getTime()+86400000).toISOString()).run();
 const saved=await c.env.DB.prepare('SELECT id,filters_json FROM hq_store_comparison_export_jobs WHERE tenant_id=? AND requested_by=? AND request_key=?').bind(staff.tenantId!,staff.id,key).first<{id:string;filters_json:string}>();if(saved?.filters_json!==request)throw new GapError('idempotency_conflict',409);
 return c.json({success:true,data:{id:saved.id,replayed:saved.id!==id}},202);
});
const exportView=(download:boolean):Handler<Env>=>async c=>{
 await stores(c);if(c.get('impersonation'))throw new GapError('IMPERSONATION_WRITE_BLOCKED',403);const staff=c.get('staff');
 const job=await c.env.DB.prepare('SELECT * FROM hq_store_comparison_export_jobs WHERE id=? AND tenant_id=? AND requested_by=?').bind(c.req.param('id'),staff.tenantId!,staff.id).first<Record<string,unknown>>();if(!job)throw new GapError('not_found',404);
 if(Date.parse(String(job.expires_at))<=Date.now())throw new GapError('export_expired',410);
 await checkExportAccess(c.env.DB,job);
 if(download){if(job.status!=='completed')throw new GapError('export_not_ready',409);c.set('outputAudit',{accountIds:JSON.parse(String(job.account_ids_json)),count:Number(job.row_count??0)});c.header('Content-Type','text/csv; charset=utf-8');c.header('Content-Disposition','attachment; filename="store-comparison.csv"');c.header('Cache-Control','no-store');return c.body(String(job.csv_text));}
 return c.json({success:true,data:{id:job.id,status:job.status,rowCount:job.row_count,expiresAt:job.expires_at,errorCode:job.error_code,downloadUrl:job.status==='completed'?`/api/hq/store-comparison/exports/${job.id}/download`:null}});
};
storeComparison.get('/api/hq/store-comparison/exports/:id',exportView(false));
storeComparison.get('/api/hq/store-comparison/exports/:id/download',exportView(true));
storeComparison.get('/api/hq/store-comparison/:accountId',async c=>{
 const id=c.req.param('accountId');if(!(await stores(c)).some(a=>a.id===id))throw new GapError('not_found',404);
 const period=comparisonPeriod(c.req.query('from'),c.req.query('to'));
 const numbers=await storeNumbers(c.env.DB,id,period);
 const recent=(await c.env.DB.prepare('SELECT id,title,status,sent_at FROM broadcasts WHERE line_account_id=? ORDER BY created_at DESC LIMIT 3').bind(id).all<StoreComparisonDetail['recentBroadcasts'][number]>()).results;
 let attention:StoreComparisonDetail['attention'];
 try { const result=await readAccountAttention(c.env.DB,id,false);attention={status:'ready',counts:result.counts,targets:result.targets}; }
 catch { attention={status:'unavailable',counts:null}; }
 const data:StoreComparisonDetail={accountId:id,...numbers,trend:comparisonTrend(numbers.trend,period),recentBroadcasts:recent,attention};
 return c.json({success:true,data});
});
