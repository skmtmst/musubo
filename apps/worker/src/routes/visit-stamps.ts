import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { tracedFetch as fetch } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { issueStampQr, storefrontQr, stampQrStatus, revokeStampQr, redeemStampQr } from '../services/visit-stamp-qr.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { bodyLimit } from 'hono/body-limit';
import { featureJobCanRun } from '../services/feature-enforcement.js';
import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import type { VisitStampCardInput, VisitStampPaperInput, VisitStampQrInput } from '@line-crm/shared';
import { dbFor } from '../services/db-router.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { getStaffById } from '@line-crm/db';
import { StampError, stampId, stampCard, readStampCard, saveStampCard, stampWallet, stampEntries, grantStamps, reverseStampEntry,
  setStampPin, offerStampReward, useStampReward, requestPaperStamps, applyPaperStamps, getStampVisit, reconcileStampVisit, stampCardLocked } from '../services/visit-stamps.js';

export const visitStamps=new Hono<Env>();
visitStamps.use('/api/visit-stamps/*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
visitStamps.onError((e, c) => {
  if (!(e instanceof StampError)) throw new UnexpectedRouteError(c, { success: false, error: 'スタンプの処理を確認できません' });
  return inputError(c, { success: false, ...((e.status === 400 || e.status === 422) ? { fields: e.fields } : {}), error: e.message }, e.status);
});
const tenant=(c:Context<Env>)=>{const t=c.get('staff')?.tenantId;if(!t)throw new StampError('ログインが必要です',401);return t;};
async function account(c:Context<Env>,id:unknown) {
  const a=stampId(id);const db=dbFor(c.env),row=await db.prepare('SELECT tenant_id FROM line_accounts WHERE id=?').bind(a).first<{tenant_id:string}>();
  if(!row||row.tenant_id!==tenant(c)||!(await getVisibleLineAccountScope(db,c.get('staff'))).ids.includes(a))throw new StampError('この店舗の権限がありません',403);
  if(!await featureJobCanRun(db,{accountId:a,featureId:'visit_stamps',job:'visit stamps'}))throw new StampError('来店スタンプは停止中です',403);return a;
}
async function body(c:Context<Env>):Promise<Record<string,unknown>> {
  const input=await c.req.json().catch(()=>null);if(!input||typeof input!=='object'||Array.isArray(input))throw new StampError('入力を確認してください');return input;
}
async function backgroundImage(c:Context<Env>,input:VisitStampCardInput) {
  const value=input.settings?.backgroundImageUrl;if(!value)return;
  let url:URL;try{url=new URL(value);}catch{throw new StampError('アップロードした背景画像を選んでください');}
  const origin=new URL(c.env.WORKER_URL||c.req.url).origin;
  if(url.origin!==origin||url.search||url.hash||!/^\/images\/[\w-]+\.(jpg|png)$/.test(url.pathname))throw new StampError('アップロードしたJPG・PNGの背景画像を選んでください');
  const object=await c.env.IMAGES.head(url.pathname.slice('/images/'.length));
  if(!object||object.size>3*1024*1024||!['image/jpeg','image/png'].includes(object.httpMetadata?.contentType??''))throw new StampError('背景画像はJPG・PNG、3MBまでです');
}
visitStamps.use('/api/visit-stamps/*',requireRole('owner','admin','staff'));
visitStamps.use('/api/visit-stamps/*',async(c,next)=>{tenant(c);if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){if(c.get('staff')?.readOnly)throw new StampError('閲覧のみの権限です',403);}await next();});
visitStamps.get('/api/visit-stamps/cards',async c=>{
  const scope=await getVisibleLineAccountScope(dbFor(c.env),c.get('staff'));
  if(!scope.ids.length)return c.json({success:true,data:[]});
  const rows=(await dbFor(c.env).prepare(`SELECT DISTINCT c.id FROM visit_stamp_cards c JOIN visit_stamp_card_accounts a ON a.card_id=c.id
    WHERE c.tenant_id=? AND a.line_account_id IN (${sqlIdSet(scope.ids).sql})`).bind(tenant(c),...sqlIdSet(scope.ids).binds).all<{id:string}>()).results;
  const data=[];for(const r of rows)data.push(await readStampCard(dbFor(c.env),await stampCard(dbFor(c.env),r.id,tenant(c))));
  return c.json({success:true,data});
});
visitStamps.post('/api/visit-stamps/cards',requireRole('owner','admin'),inputJsonBoundary(), async c=>{
  const input=await body(c) as unknown as VisitStampCardInput;
  await backgroundImage(c,input);
  if(!Array.isArray(input.accountIds))throw new StampError('押せる店舗を選んでください');for(const a of input.accountIds)await account(c,a);
  return c.json({success:true,data:await saveStampCard(dbFor(c.env),tenant(c),input)},201);
});
visitStamps.put('/api/visit-stamps/cards/:id',requireRole('owner','admin'),inputJsonBoundary(), async c=>{
  const db=dbFor(c.env),old=await readStampCard(db,await stampCard(db,c.req.param('id'),tenant(c))),input=await body(c) as unknown as VisitStampCardInput;
  await backgroundImage(c,input);
  if(!Array.isArray(input.accountIds))throw new StampError('押せる店舗を選んでください');for(const a of [...old.accountIds,...input.accountIds])await account(c,a);
  return c.json({success:true,data:await saveStampCard(db,tenant(c),input,c.req.param('id'))});
});
visitStamps.get('/api/visit-stamps/cards/:id/wallet',async c=>{
  const a=await account(c,c.req.query('accountId')),db=dbFor(c.env);await stampCard(db,c.req.param('id'),tenant(c));const friend=stampId(c.req.query('friendId'));
  const wallet=await stampWallet(db,c.req.param('id'),friend,a);return c.json({success:true,data:{wallet,entries:await stampEntries(db,c.req.param('id'),wallet.friendId)}});
});
visitStamps.post('/api/visit-stamps/cards/:id/grants',requireRole('owner','admin','staff'),inputJsonBoundary(), async c=>{
  const b=await body(c),a=await account(c,b.accountId),db=dbFor(c.env);await stampCard(db,c.req.param('id'),tenant(c));
  return c.json({success:true,data:await grantStamps(db,{cardId:c.req.param('id'),friendId:stampId(b.friendId),accountId:a,count:b.count as number,reason:b.reason as string,actorId:c.get('staff')!.id,requestId:stampId(b.requestId),kind:b.source==='paper'?'paper':'manual'})});
});
visitStamps.post('/api/visit-stamps/entries/:id/reverse',requireRole('owner','admin'),inputJsonBoundary(), async c=>{
  const b=await body(c),db=dbFor(c.env),entry=await db.prepare('SELECT line_account_id FROM visit_stamp_entries WHERE id=?').bind(c.req.param('id')).first<{line_account_id:string}>();
  if(!entry)throw new StampError('記録が見つかりません',404);await account(c,entry.line_account_id);
  return c.json({success:true,data:await reverseStampEntry(db,c.req.param('id'),tenant(c),c.get('staff')!.id,b.reason as string)});
});
visitStamps.put('/api/visit-stamps/pins/:staffId',requireRole('owner','admin'),inputJsonBoundary(), async c=>{
  const b=await body(c),a=await account(c,b.accountId),db=dbFor(c.env),member=await getStaffById(db,stampId(c.req.param('staffId')));
  if(!member||!member.is_active||member.tenant_id!==tenant(c)||member.access_level==='read_only'||!(await getVisibleLineAccountScope(db,{
    id:member.id,name:member.name,role:member.role,tenantId:member.tenant_id,readOnly:false,accountScope:member.account_scope??'all',
  } as Env['Variables']['staff'])).ids.includes(a))throw new StampError('店員の所属店舗を確認してください',403);
  await setStampPin(db,a,member.id,b.pin as string);return c.json({success:true,data:{staffId:member.id,accountId:a,configured:true}});
});
visitStamps.get('/api/visit-stamps/paper-requests',async c=>{
  const a=await account(c,c.req.query('accountId'));
  return c.json({success:true,data:(await dbFor(c.env).prepare('SELECT * FROM visit_stamp_paper_requests WHERE line_account_id=? ORDER BY created_at DESC LIMIT 200').bind(a).all()).results});
});
visitStamps.post('/api/visit-stamps/paper-requests/:id/review',requireRole('owner','admin','staff'),inputJsonBoundary(), async c=>{
  const b=await body(c),db=dbFor(c.env),r=await db.prepare('SELECT line_account_id FROM visit_stamp_paper_requests WHERE id=?').bind(c.req.param('id')).first<{line_account_id:string}>();
  if(!r)throw new StampError('申請が見つかりません',404);await account(c,r.line_account_id);
  if(!['approve','reject'].includes(b.action as string))throw new StampError('承認か却下を選んでください');
  return c.json({success:true,data:await applyPaperStamps(db,c.req.param('id'),tenant(c),c.get('staff')!.id,b.action==='approve',b.reason as string)});
});
visitStamps.post('/api/visit-stamps/visits/:kind/:id/checkout',requireRole('owner','admin','staff'),inputJsonBoundary(), async c=>{
  const b=await body(c),kind=c.req.param('kind') as 'restaurant'|'booking',db=dbFor(c.env),visit=await getStampVisit(db,kind,c.req.param('id'));
  if(!visit)throw new StampError('来店が見つかりません',404);await account(c,visit.account_id);if(!visit.visited)throw new StampError('来店済みの記録だけ会計できます',409);
  if(!Number.isSafeInteger(b.amount)||(b.amount as number)<0||(b.amount as number)>100000000)throw new StampError('会計金額を確認してください');
  const saved=await db.prepare('INSERT OR IGNORE INTO visit_stamp_checkouts(kind,visit_id,line_account_id,amount,recorded_by) VALUES(?,?,?,?,?)').bind(kind,visit.id,visit.account_id,b.amount,c.get('staff')!.id).run();
  const prior=await db.prepare('SELECT amount FROM visit_stamp_checkouts WHERE kind=? AND visit_id=?').bind(kind,visit.id).first<{amount:number}>();
  if(prior!.amount!==b.amount)throw new StampError('会計済みです。押印の取消後に手動で訂正してください',409);
  await reconcileStampVisit(db,kind,visit.id);return c.json({success:true,data:{visitId:visit.id,amount:b.amount,recorded:true}});
});
visitStamps.get('/api/visit-stamps/cards/:id/storefront-qr',async c=>{
  const a=await account(c,c.req.query('accountId')),db=dbFor(c.env);await stampCard(db,c.req.param('id'),tenant(c));
  return c.json({success:true,data:await storefrontQr(db,c.req.param('id'),a)});
});
visitStamps.post('/api/visit-stamps/cards/:id/storefront-qr',requireRole('owner','admin'),inputJsonBoundary(),async c=>{
  const b=await body(c),a=await account(c,b.accountId),db=dbFor(c.env);await stampCard(db,c.req.param('id'),tenant(c));
  return c.json({success:true,data:await issueStampQr(db,c.req.param('id'),a,c.get('staff')!.id,'storefront',b as unknown as VisitStampQrInput)});
});
visitStamps.post('/api/visit-stamps/cards/:id/staff-qr',requireRole('owner','admin','staff'),inputJsonBoundary(),async c=>{
  const b=await body(c),a=await account(c,b.accountId),db=dbFor(c.env);await stampCard(db,c.req.param('id'),tenant(c));
  return c.json({success:true,data:await issueStampQr(db,c.req.param('id'),a,c.get('staff')!.id,'staff',b as unknown as VisitStampQrInput)});
});
visitStamps.get('/api/visit-stamps/staff-qr/:id',requireRole('owner','admin','staff'),async c=>{
  const a=await account(c,c.req.query('accountId'));
  return c.json({success:true,data:await stampQrStatus(dbFor(c.env),c.req.param('id'),a,c.get('staff')!.id)});
});
visitStamps.delete('/api/visit-stamps/staff-qr/:id',requireRole('owner','admin','staff'),async c=>{
  const a=await account(c,c.req.query('accountId'));
  return c.json({success:true,data:await revokeStampQr(dbFor(c.env),c.req.param('id'),a,c.get('staff')!.id)});
});
// LIFFはIDトークンの対象チャンネルを指定店舗のlogin_channel_idに固定する。
async function customer(c:Context<Env>,qr=false) {
  const a=stampId(c.req.query('accountId')),db=dbFor(c.env);
  const shop=await db.prepare('SELECT id,tenant_id,login_channel_id FROM line_accounts WHERE id=? AND is_active=1 AND archived_at IS NULL').bind(a).first<{tenant_id:string;login_channel_id:string|null}>();
  const token=c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token||!shop?.login_channel_id)throw new StampError('LINEの本人確認が必要です',401);
  const response=await fetch('https://api.line.me/oauth2/v2.1/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({id_token:token,client_id:shop.login_channel_id}),signal:AbortSignal.timeout(10000)});
  const identity=response.ok?await response.json() as {sub?:string}:null;
  if(!identity?.sub)throw new StampError('LINEの本人確認が必要です',401);
  const friend=await db.prepare('SELECT id FROM friends WHERE line_account_id=? AND line_platform_user_id=? AND is_following=1').bind(a,identity.sub).first<{id:string}>();
  if(!friend)throw new StampError(qr?'友だち追加が必要です':'友だちの確認が必要です',403);
  if(!await featureJobCanRun(db,{accountId:a,featureId:'visit_stamps',job:'visit stamps'}))throw new StampError('来店スタンプは停止中です',403);return {db,a,friendId:friend.id,tenantId:shop.tenant_id};
}
visitStamps.post('/api/liff/visit-stamps/qr/redeem',inputJsonBoundary(),async c=>{
  c.header('Cache-Control','private, no-store');
  try {
    const x=await customer(c,true),b=await body(c);
    return c.json({success:true,data:await redeemStampQr(x.db,x.a,x.friendId,b.token,stampId(b.requestId),typeof b.visitId==='string'?b.visitId:undefined)});
  } catch(e) {
    if(e instanceof StampError&&e.message==='友だち追加が必要です')return c.json({success:true,data:{status:'friend_required'}});
    throw e;
  }
});
visitStamps.get('/api/liff/visit-stamps/cards',async c=>{
  const x=await customer(c),rows=(await x.db.prepare('SELECT card_id FROM visit_stamp_card_accounts WHERE line_account_id=?').bind(x.a).all<{card_id:string}>()).results;
  const data=[];for(const r of rows){const card=await stampCard(x.db,r.card_id,x.tenantId);if(card.active&&!await stampCardLocked(x.db,card.id,x.friendId,x.a))data.push({card:await readStampCard(x.db,card),wallet:await stampWallet(x.db,r.card_id,x.friendId,x.a)});}
  return c.json({success:true,data});
});
visitStamps.get('/api/liff/visit-stamps/cards/:id',async c=>{
  const x=await customer(c),card=await stampCard(x.db,c.req.param('id'),x.tenantId),wallet=await stampWallet(x.db,card.id,x.friendId,x.a);
  return c.json({success:true,data:{card:await readStampCard(x.db,card),wallet,entries:await stampEntries(x.db,card.id,wallet.friendId)}});
});
visitStamps.post('/api/liff/visit-stamps/cards/:id/rewards',inputJsonBoundary(), async c=>{
  const x=await customer(c),b=await body(c);await stampCard(x.db,c.req.param('id'),x.tenantId);
  return c.json({success:true,data:await offerStampReward(x.db,c.req.param('id'),x.friendId,x.a,stampId(b.rewardId),stampId(b.requestId))},201);
});
visitStamps.post('/api/liff/visit-stamps/redemptions/:id/use',inputJsonBoundary(), async c=>{
  const x=await customer(c),b=await body(c);
  return c.json({success:true,data:await useStampReward(x.db,c.req.param('id'),x.friendId,x.a,null,b.pin as string)});
});
visitStamps.post('/api/liff/visit-stamps/cards/:id/paper-requests',inputJsonBoundary(), async c=>{
  const x=await customer(c),b=await body(c) as unknown as VisitStampPaperInput;await stampCard(x.db,c.req.param('id'),x.tenantId);
  if(typeof b.photoUrl!=='string'||!b.photoUrl.startsWith(new URL('/api/liff/visit-stamps/paper-photos/',c.req.url).href)||!await x.db.prepare('SELECT id FROM visit_stamp_paper_photos WHERE friend_id=? AND line_account_id=? AND card_id=? AND id=?').bind(x.friendId,x.a,c.req.param('id'),b.photoUrl.split('/').at(-1)?.split('?')[0]??'').first())throw new StampError('本人が預けた写真を指定してください',403);
  return c.json({success:true,data:await requestPaperStamps(x.db,c.req.param('id'),x.friendId,x.a,b.photoUrl,b.stamps)},201);
});

visitStamps.get('/api/visit-stamps/entries',async c=>{
 const a=await account(c,c.req.query('accountId')),db=dbFor(c.env),from=c.req.query('from'),to=c.req.query('to'),friend=c.req.query('friendId'),kind=c.req.query('kind');
 const { page, limit: pageSize } = parseOffsetPaging({ limit: c.req.query('pageSize'), page: c.req.query('page') }, { defaultLimit: 50, limitPolicy: {}, pagePolicy: {} });
 if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200||!Number.isSafeInteger((page-1)*pageSize)||(from&&!Number.isFinite(Date.parse(from)))||(to&&!Number.isFinite(Date.parse(to)))||(from&&to&&Date.parse(from)>=Date.parse(to))
 ||(kind&&!['visit','manual','paper','redeem','reverse','expire','restore'].includes(kind)))throw new StampError('期間・種類・ページを確認してください');
 if(friend)stampId(friend);
 // 共有カードでも実際に押した店舗だけの記録。友だちの検索は共通会員の代表IDも含む。
 const where=`e.line_account_id=? AND (? IS NULL OR julianday(e.created_at)>=julianday(?)) AND (? IS NULL OR julianday(e.created_at)<julianday(?))
 AND (? IS NULL OR e.friend_id=? OR EXISTS(SELECT 1 FROM friends x JOIN friends y ON x.user_id=y.user_id WHERE x.id=e.friend_id AND y.id=? AND y.line_account_id=?)) AND (? IS NULL OR e.kind=?)`;
 const args=[a,from??null,from??null,to??null,to??null,friend??null,friend??null,friend??null,a,kind??null,kind??null];
 const total=await db.prepare(`SELECT COUNT(*) AS n FROM visit_stamp_entries e WHERE ${where}`).bind(...args).first<{n:number}>();
 const items=(await db.prepare(`SELECT e.id,e.card_id AS cardId,e.friend_id AS friendId,e.line_account_id AS accountId,e.kind,e.delta,e.actor_id AS actorId,e.reason,e.created_at AS createdAt,e.original_id AS originalId FROM visit_stamp_entries e WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?`).bind(...args,pageSize,(page-1)*pageSize).all()).results;
 return c.json({success:true,data:buildOffsetListResponse({ items,total:total!.n,page,pageSize, paging: { limit: pageSize, offset: (page - 1) * pageSize }, sort: [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'desc' }] })});
});
visitStamps.get('/api/liff/visit-stamps/cards/:id/paper-requests',async c=>{
 const x=await customer(c),card=c.req.param('id');await stampCard(x.db,card,x.tenantId);await stampWallet(x.db,card,x.friendId,x.a);
 // 同じ統合会員でも写真と申請はアップロードした店舗・本人のものだけ公開する。
 const rows=(await x.db.prepare(`SELECT p.id,p.card_id AS cardId,p.photo_url AS photoUrl,p.stamps,p.status,p.reason,p.created_at AS createdAt,p.reviewed_at AS reviewedAt FROM visit_stamp_paper_requests p
 WHERE p.card_id=? AND p.line_account_id=? AND (p.submitted_friend_id=? OR (p.submitted_friend_id IS NULL AND p.friend_id=?)) ORDER BY p.created_at DESC,p.id LIMIT 200`).bind(card,x.a,x.friendId,x.friendId).all()).results;
 return c.json({success:true,data:rows});
});
const PHOTO_LIMIT=5*1024*1024;
visitStamps.post('/api/liff/visit-stamps/cards/:id/paper-photos',bodyLimit({maxSize:PHOTO_LIMIT+65536,onError:c=>c.json({success:false,error:'写真は5MBまでです'},413)}),inputJsonBoundary(), async c=>{
 const x=await customer(c),card=c.req.param('id');await stampCard(x.db,card,x.tenantId);await stampWallet(x.db,card,x.friendId,x.a);
 const form=await c.req.formData().catch(()=>null);if(!form)throw new StampError('写真を選んでください');const file:unknown=form.get('file');
 if(file instanceof File&&file.size>PHOTO_LIMIT)return c.json({success:false,error:'写真は5MBまでです'},413);
 if(!(file instanceof File)||file.size<1||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new StampError('JPEG・PNG・WebPの写真を5MBまでで選んでください');
 const bytes=new Uint8Array(await file.arrayBuffer()),signature=file.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:file.type==='image/png'?[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v):new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
 if(!signature)throw new StampError('写真の形式が正しくありません');
 const id=crypto.randomUUID(),key=`private/visit-stamps/${x.a}/${x.friendId}/${id}`;
 await c.env.IMAGES.put(key,bytes,{httpMetadata:{contentType:file.type}});
 try{await x.db.prepare('INSERT INTO visit_stamp_paper_photos(id,card_id,friend_id,line_account_id,object_key,content_type,size) VALUES(?,?,?,?,?,?,?)').bind(id,card,x.friendId,x.a,key,file.type,file.size).run();}
 catch(e){await c.env.IMAGES.delete(key);throw e;}
 return c.json({success:true,data:{id,photoUrl:new URL(`/api/liff/visit-stamps/paper-photos/${id}`,c.req.url).href,contentType:file.type,size:file.size}},201);
});
visitStamps.get('/api/liff/visit-stamps/paper-photos/:id',async c=>{
 const x=await customer(c),r=await x.db.prepare('SELECT object_key,content_type FROM visit_stamp_paper_photos WHERE id=? AND friend_id=? AND line_account_id=?').bind(c.req.param('id'),x.friendId,x.a).first<{object_key:string;content_type:string}>();
 if(!r)throw new StampError('写真が見つかりません',404);const object=await c.env.IMAGES.get(r.object_key);if(!object)throw new StampError('写真が見つかりません',404);
 return new Response(object.body,{headers:{'Content-Type':r.content_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
});
visitStamps.get('/api/visit-stamps/paper-photos/:id',async c=>{
 const db=dbFor(c.env),r=await db.prepare('SELECT line_account_id,object_key,content_type FROM visit_stamp_paper_photos WHERE id=?').bind(c.req.param('id')).first<{line_account_id:string;object_key:string;content_type:string}>();
 if(!r)throw new StampError('写真が見つかりません',404);await account(c,r.line_account_id);const object=await c.env.IMAGES.get(r.object_key);if(!object)throw new StampError('写真が見つかりません',404);
 return new Response(object.body,{headers:{'Content-Type':r.content_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
});
