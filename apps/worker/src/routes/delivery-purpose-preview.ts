import {purposeAliases,type BroadcastPurpose} from '../features/broadcasts/broadcast-simulation/index.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {requirePermission} from '../middleware/role-guard.js';
import {gapAccount,gapBody,GapError} from '../services/gap-common.js';
export const deliveryPurposePreview=new Hono<Env>();
deliveryPurposePreview.use('/api/delivery-purposes*',requirePermission('/broadcasts'));
deliveryPurposePreview.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'purpose_preview_unavailable'},e instanceof GapError?e.status:503));
const purposes=[{id:'transaction',label:'予約・支払いなどの取引の連絡',sendAvailable:false,simulationAvailable:true},{id:'notice',label:'お知らせ',sendAvailable:false,simulationAvailable:true},{id:'marketing',label:'宣伝',sendAvailable:true}]as const;
deliveryPurposePreview.get('/api/delivery-purposes',async c=>{await gapAccount(c);return c.json({success:true,data:purposes});});
/** 保存や送信は行わない。既存の一斉配信はマーケティング用途の判定を維持する。 */
deliveryPurposePreview.post('/api/delivery-purposes/preview',async c=>{
 const a=await gapAccount(c),b=await gapBody(c);if(!purposes.some(p=>p.id===b.purpose))throw new GapError('invalid_purpose');
 const aliases=purposeAliases[b.purpose as BroadcastPurpose];
 if(b.friendIds!==undefined&&(!Array.isArray(b.friendIds)||b.friendIds.length>10000||b.friendIds.some(id=>typeof id!=='string')))throw new GapError('invalid_friends');
 const ids=b.friendIds===undefined?null:JSON.stringify([...new Set(b.friendIds as string[])]);
 const row=await c.env.DB.prepare(`SELECT count(*) matched,count(CASE WHEN f.is_following=0 THEN 1 END) blocked,count(CASE WHEN f.is_following=1 AND EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.line_account_id=f.line_account_id AND c.friend_id=f.id AND c.purpose IN(SELECT value FROM json_each(?)) AND c.state='revoked') THEN 1 END) optedOut FROM friends f WHERE f.line_account_id=? AND COALESCE(f.is_hidden,0)=0 AND COALESCE(f.line_platform_user_id,'')<>'' AND (? IS NULL OR f.id IN(SELECT value FROM json_each(?)))`).bind(JSON.stringify(aliases),a,ids,ids).first<{matched:number;blocked:number;optedOut:number}>();
 return c.json({success:true,data:{purpose:b.purpose,recipients:row!.matched-row!.blocked-row!.optedOut,excluded:{blocked:row!.blocked,optedOut:row!.optedOut},sent:false,previewOnly:true}});
});
