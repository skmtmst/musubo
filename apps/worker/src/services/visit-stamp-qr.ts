import { jstCalendar as japanCalendar } from '@line-crm/shared';
import type { VisitStampSettings, VisitStampQr, VisitStampQrInput, VisitStampQrResult, VisitStampQrStatus } from '@line-crm/shared';
import { calculateVisitStamps, canonicalStampFriend, readStampCard, readStampWallet, stampCard, stampFriend, stampId, stampIntervalCondition, storefrontStampIntervalCondition, stampExpiryExpression, stampWallet, getStampVisit, StampError } from './visit-stamps.js';

type QrRow = {
  id:string; card_id:string; line_account_id:string; kind:'storefront'|'staff'; token:string;
  issued_by:string; issued_at:string; expires_at:string|null; card_version:number; base_count:number; amount:number|null;
  status:'active'|'used'|'revoked'; consumed_friend_id:string|null; consumed_at:string|null; consumed_entry_id:string|null;
  request_id:string; session_id:string; generation:number; rotation_key:string|null;
};
const now = () => new Date().toISOString();
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
async function qrRow(db:D1Database,id:string,accountId:string):Promise<QrRow> {
  const row=await db.prepare('SELECT * FROM visit_stamp_qr_codes WHERE id=? AND line_account_id=?').bind(stampId(id),accountId).first<QrRow>();
  if(!row)throw new StampError('QRが見つかりません',404);return row;
}
async function qrView(db:D1Database,row:QrRow):Promise<VisitStampQr> {
  const at=now();
  const shop=await db.prepare('SELECT liff_id FROM line_accounts WHERE id=?').bind(row.line_account_id).first<{liff_id:string|null}>();
  if(!shop?.liff_id || !/^[\w-]+$/.test(shop.liff_id))throw new StampError('店舗のLINEの画面を設定してください',409);
  const card=await stampCard(db,row.card_id);
  const status=row.status==='active'&&(!card.active||card.version!==row.card_version)?'revoked':row.status==='active'&&row.expires_at!==null&&row.expires_at<=at?'expired':row.status;
  const url=new URL(`https://liff.line.me/${shop.liff_id}/visit-stamps/qr`);
  url.searchParams.set('accountId',row.line_account_id); url.searchParams.set('liffId',shop.liff_id); url.searchParams.set('token',row.token);
  return {id:row.id,cardId:row.card_id,accountId:row.line_account_id,kind:row.kind,url:url.href,issuedAt:row.issued_at,expiresAt:row.expires_at,serverTime:at,status,generation:row.generation,count:row.base_count,amount:row.amount};
}
async function permittedCard(db:D1Database,cardId:string,accountId:string) {
  const card=await stampCard(db,cardId);
  if(!card.active)throw new StampError('カードは停止中です',409);
  if(!await db.prepare('SELECT 1 FROM visit_stamp_card_accounts WHERE card_id=? AND line_account_id=?').bind(cardId,accountId).first())throw new StampError('この店舗では使えないカードです',403);
  return card;
}
export async function storefrontQr(db:D1Database,cardId:string,accountId:string):Promise<VisitStampQr|null> {
  await permittedCard(db,cardId,accountId);
  const row=await db.prepare("SELECT * FROM visit_stamp_qr_codes WHERE card_id=? AND line_account_id=? AND kind='storefront' AND status='active'").bind(cardId,accountId).first<QrRow>();
  return row?qrView(db,row):null;
}
/** 交換のCASと発行を一つのbatchにする。再送は同じ世代を返し、別セッションには触れない。 */
export async function issueStampQr(db:D1Database,cardId:string,accountId:string,actorId:string,kind:'storefront'|'staff',input:VisitStampQrInput):Promise<VisitStampQr> {
  const card=await permittedCard(db,cardId,accountId),settings=JSON.parse(card.settings_json) as VisitStampSettings;
  const requestId=stampId(input.requestId),sessionId=kind==='storefront'?'storefront':stampId(input.sessionId);
  const previousId=kind==='storefront'?input.expectedQrId:input.previousQrId;
  if(previousId!=null)stampId(previousId);
  let count=kind==='storefront'?1:input.count,amount:number|null=null;
  if(kind==='staff'&&input.amount!==undefined) {
    if(!Number.isSafeInteger(input.amount)||input.amount!<0||input.amount!>100000000)throw new StampError('会計金額を確認してください');
    amount=input.amount!;count=Math.min(settings.maxPerVisit,Math.floor(amount/settings.amountUnit));
  }
  if(!Number.isSafeInteger(count)||count!<1||count!>settings.maxPerVisit)throw new StampError(`押印数は1〜${settings.maxPerVisit}個です`);
  const prior=await db.prepare('SELECT * FROM visit_stamp_qr_codes WHERE card_id=? AND line_account_id=? AND kind=? AND issued_by=? AND request_id=?')
    .bind(cardId,accountId,kind,actorId,requestId).first<QrRow>();
  if(prior) {
    if(prior.session_id!==sessionId||prior.base_count!==count||prior.amount!==amount)throw new StampError('同じ発行依頼の内容が変わっています',409);
    return qrView(db,prior);
  }
  const previous=previousId?await qrRow(db,previousId,accountId):null;
  if(previous&&(previous.card_id!==cardId||previous.kind!==kind||previous.session_id!==sessionId||(kind==='staff'&&previous.issued_by!==actorId)))throw new StampError('交換するQRを確認してください',403);
  // 読み取りが交換に勝った場合は使用結果を返す。続けて出す操作でだけ次を発行する。
  if(previous?.status==='used'&&!input.continueAfterUse)return qrView(db,previous);
  const shop=await db.prepare('SELECT liff_id FROM line_accounts WHERE id=?').bind(accountId).first<{liff_id:string|null}>();
  if(!shop?.liff_id||!/^[\w-]+$/.test(shop.liff_id))throw new StampError('店舗のLINEの画面を設定してください',409);
  const id=crypto.randomUUID(),at=now(),expires=kind==='staff'?new Date(Date.parse(at)+30000).toISOString():null;
  const op=crypto.randomUUID(),generation=(previous?.generation??0)+1;
  const statements:D1PreparedStatement[]=[];
  if(previous)statements.push(db.prepare(`UPDATE visit_stamp_qr_codes SET status='revoked',rotation_key=? WHERE id=? AND status='active'
    AND NOT EXISTS(SELECT 1 FROM visit_stamp_qr_codes q WHERE q.card_id=? AND q.line_account_id=? AND q.kind=? AND q.session_id=? AND q.generation>?)`)
    .bind(op,previous.id,cardId,accountId,kind,sessionId,previous.generation));
  const guard=previous?`EXISTS(SELECT 1 FROM visit_stamp_qr_codes WHERE id=? AND (rotation_key=? OR (status='used' AND ?=1)))
    AND NOT EXISTS(SELECT 1 FROM visit_stamp_qr_codes WHERE card_id=? AND line_account_id=? AND kind=? AND session_id=? AND generation>?)`
    :`NOT EXISTS(SELECT 1 FROM visit_stamp_qr_codes WHERE card_id=? AND line_account_id=? AND kind=? AND session_id=?)`;
  const args=previous?[previous.id,op,input.continueAfterUse?1:0,cardId,accountId,kind,sessionId,previous.generation]:[cardId,accountId,kind,sessionId];
  statements.push(db.prepare(`INSERT OR IGNORE INTO visit_stamp_qr_codes(id,card_id,line_account_id,kind,token,issued_by,issued_at,expires_at,card_version,base_count,amount,request_id,session_id,generation)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND active=1 AND version=?)`)
    .bind(id,cardId,accountId,kind,secret(),actorId,at,expires,card.version,count,amount,requestId,sessionId,generation,...args,cardId,card.version));
  await db.batch(statements);
  const saved=await db.prepare('SELECT * FROM visit_stamp_qr_codes WHERE card_id=? AND line_account_id=? AND kind=? AND issued_by=? AND request_id=?')
    .bind(cardId,accountId,kind,actorId,requestId).first<QrRow>();
  if(saved)return qrView(db,saved);
  if(previous){const current=await qrRow(db,previous.id,accountId);if(current.status==='used'&&!input.continueAfterUse)return qrView(db,current);}
  throw new StampError('QRが更新されました。読み直してください',409);
}
export async function stampQrStatus(db:D1Database,id:string,accountId:string,actorId:string):Promise<VisitStampQrStatus> {
  const row=await qrRow(db,id,accountId);
  if(row.kind!=='staff'||row.issued_by!==actorId)throw new StampError('このQRの権限がありません',403);
  const qr=await qrView(db,row);
  if(row.status!=='used')return {qr,result:null};
  const entry=await db.prepare('SELECT delta FROM visit_stamp_entries WHERE id=?').bind(row.consumed_entry_id).first<{delta:number}>();
  const friend=await db.prepare(`SELECT f.display_name FROM friends f JOIN friends canonical ON canonical.id=?
    WHERE f.line_account_id=? AND (f.id=canonical.id OR (canonical.user_id IS NOT NULL AND f.user_id=canonical.user_id)) LIMIT 1`).bind(row.consumed_friend_id,accountId).first<{display_name:string|null}>();
  return {qr,result:{...await successResult(db,row,row.consumed_friend_id!,entry!.delta,row.consumed_at!,row.consumed_entry_id!),friendName:friend?.display_name??'お客さま'}};
}
export async function revokeStampQr(db:D1Database,id:string,accountId:string,actorId:string) {
  const row=await qrRow(db,id,accountId);
  if(row.kind!=='staff'||row.issued_by!==actorId)throw new StampError('このQRの権限がありません',403);
  await db.prepare("UPDATE visit_stamp_qr_codes SET status='revoked' WHERE id=? AND status='active'").bind(id).run();
  return {id};
}
async function successResult(db:D1Database,row:QrRow,friendId:string,awarded:number,at:string,entryId:string):Promise<Extract<VisitStampQrResult,{status:'success'}>> {
  const card=await readStampCard(db,await stampCard(db,row.card_id)),wallet=await readStampWallet(db,row.card_id,friendId);
  const nextReward=[...card.settings.rewards].sort((a,b)=>a.stamps-b.stamps).find(r=>r.stamps>wallet.balance)??null;
  return {status:'success',card,wallet,awarded,at,entryId,nextReward};
}
async function limitedResult(db:D1Database,row:QrRow,friendId:string,at:string,settings:VisitStampSettings,boundVisit=false):Promise<VisitStampQrResult> {
  const entries=boundVisit?"e.kind IN ('visit','manual') AND e.idempotency_key<>'@receipt-bonus'":"e.kind='visit' AND e.visit_key LIKE 'storefront:%'";
  const last=await db.prepare(`SELECT MAX(e.occurred_at) AS at FROM visit_stamp_entries e WHERE e.card_id=? AND e.friend_id=? AND ${entries}
    AND e.delta>0 AND NOT EXISTS(SELECT 1 FROM visit_stamp_entries r WHERE r.original_id=e.id AND r.kind='reverse')`).bind(row.card_id,friendId).first<{at:string|null}>();
  const lastMs=Date.parse(last?.at??at),jst=japanCalendar(new Date(lastMs));
  const midnight=Date.UTC(jst.getUTCFullYear(),jst.getUTCMonth(),jst.getUTCDate()+1)-9*3600000;
  const hours=settings.stampInterval?.mode==='hours'?settings.stampInterval.hours!:0;
  const dailyLimit=!boundVisit||settings.stampInterval?.mode==='same_day';
  return {status:'limited',dailyLimit,retryAt:new Date(dailyLimit?Math.max(midnight,lastMs+hours*3600000):lastMs+hours*3600000).toISOString(),card:await readStampCard(db,await stampCard(db,row.card_id)),wallet:await readStampWallet(db,row.card_id,friendId)};
}
/** INSERTの条件で競合の勝者を決め、その押印IDを条件に使用済みを確定。同じD1トランザクション。 */
export async function redeemStampQr(db:D1Database,accountId:string,friendId:string,token:unknown,requestId:string,visitId?:string):Promise<VisitStampQrResult> {
  stampId(requestId);
  const submittedFriendId=friendId;
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return {status:'invalid',reason:'invalid'};
  const row=await db.prepare('SELECT * FROM visit_stamp_qr_codes WHERE token=? AND line_account_id=?').bind(token,accountId).first<QrRow>();
  if(!row)return {status:'invalid',reason:'invalid'};
  await stampFriend(db,row.card_id,friendId,accountId);
  friendId=await canonicalStampFriend(db,row.card_id,friendId);
  const key=`qr:${row.id}:${requestId}`;
  const receipt=await db.prepare('SELECT id,delta,occurred_at FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND idempotency_key=?')
    .bind(row.card_id,friendId,key).first<{id:string;delta:number;occurred_at:string}>();
  if(receipt)return successResult(db,row,friendId,receipt.delta,receipt.occurred_at,receipt.id);
  if(row.status==='used')return row.consumed_friend_id===friendId
    ?successResult(db,row,friendId,(await db.prepare('SELECT delta FROM visit_stamp_entries WHERE id=?').bind(row.consumed_entry_id).first<{delta:number}>())!.delta,row.consumed_at!,row.consumed_entry_id!)
    :{status:'invalid',reason:'used'};
  let at=now();const card=await stampCard(db,row.card_id);
  if(row.status==='revoked'||!card.active||card.version!==row.card_version)return {status:'invalid',reason:'revoked'};
  if(row.expires_at&&row.expires_at<=at)return {status:'invalid',reason:'expired'};
  const settings=JSON.parse(card.settings_json) as VisitStampSettings;
  const visit=visitId?await getStampVisit(db,'restaurant',visitId):null;
  if(visitId&&(!visit||visit.account_id!==accountId||visit.friend_id!==submittedFriendId||!visit.visited||!await db.prepare("SELECT 1 FROM rt_seat_visit_marks WHERE reservation_id=? AND kind='visited' AND undone_at IS NULL").bind(visitId).first()))throw new StampError('本人の来店済み予約を選んでください',409,['visitId']);
  if(!visitId){
   const visits=(await db.prepare(`SELECT r.id,s.name AS storeName,r.starts_at AS startsAt,(r.status IN('visited','seated') AND EXISTS(SELECT 1 FROM rt_seat_visit_marks m WHERE m.reservation_id=r.id AND m.kind='visited' AND m.undone_at IS NULL)) AS arrived
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
    WHERE f.id=? AND s.line_account_id=? AND r.status NOT IN('cancelled','no_show') AND r.hold_expires_at IS NULL
    AND (date(r.starts_at,'+9 hours')=date(?,'+9 hours') OR EXISTS(SELECT 1 FROM rt_seat_visit_marks m WHERE m.reservation_id=r.id AND m.kind='visited' AND m.undone_at IS NULL AND date(m.marked_at,'+9 hours')=date(?,'+9 hours')))
    ORDER BY r.starts_at,r.id`).bind(submittedFriendId,accountId,at,at).all<{id:string;storeName:string;startsAt:string;arrived:number}>()).results;
   if(visits.length)return {status:'visit_required',visits:visits.map(v=>({...v,arrived:!!v.arrived}))};
  }
  let visitAmount=row.amount??0;
  if(visit){at=visit.occurred_at;if(settings.mode==='amount'){
    const checkout=await db.prepare("SELECT amount FROM visit_stamp_checkouts WHERE kind='restaurant' AND visit_id=?").bind(visitId).first<{amount:number}>();
    if(!checkout)throw new StampError('この来店は会計の記録待ちです',409);visitAmount=checkout.amount;
  }}else if(settings.mode==='amount'&&row.amount===null&&row.kind==='storefront')throw new StampError('金額型は会計の金額を指定した店員QRで押してください',409);
  const visitKey=visit?'restaurant:'+visitId:`${row.kind==='storefront'?'storefront':'staff'}:${row.id}:${requestId}`;
  const wallet=await stampWallet(db,row.card_id,friendId,accountId);friendId=wallet.friendId;
  const tags=(await db.prepare('SELECT t.name FROM tags t JOIN friend_tags ft ON ft.tag_id=t.id WHERE ft.friend_id=?').bind(submittedFriendId).all<{name:string}>()).results.map(t=>t.name);
  const regular=calculateVisitStamps(settings,visitAmount,at,false,tags,visit?undefined:row.base_count),first=calculateVisitStamps(settings,visitAmount,at,true,tags,visit?undefined:row.base_count);
  const interval=visit?stampIntervalCondition(settings,at):storefrontStampIntervalCondition(settings,at,row.kind!=='storefront'),expiry=stampExpiryExpression(settings,at),entryId=crypto.randomUUID();
  const results=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,actor_id,reason,idempotency_key,visit_key,expires_at,occurred_at)
      SELECT ?,w.card_id,w.friend_id,q.line_account_id,'visit',CASE WHEN w.visit_count=0 THEN ? ELSE ? END,?, ?, ?, ?, ${expiry.sql},?
      FROM visit_stamp_wallets w JOIN visit_stamp_qr_codes q ON q.card_id=w.card_id JOIN visit_stamp_cards c ON c.id=q.card_id
      JOIN line_accounts a ON a.id=q.line_account_id JOIN visit_stamp_card_accounts ca ON ca.card_id=c.id AND ca.line_account_id=a.id
      WHERE q.id=? AND q.status='active' AND (q.expires_at IS NULL OR q.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND c.active=1 AND c.version=q.card_version
      AND a.is_active=1 AND a.archived_at IS NULL AND w.friend_id=? AND EXISTS(SELECT 1 FROM friends f WHERE f.id=? AND f.line_account_id=a.id AND f.is_following=1)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid WHERE r.id=? AND f.id=? AND s.line_account_id=q.line_account_id AND r.status IN ('visited','seated') AND EXISTS(SELECT 1 FROM rt_seat_visit_marks m WHERE m.reservation_id=r.id AND m.kind='visited' AND m.undone_at IS NULL))) AND ${interval.sql}`)
      .bind(entryId,first,regular,row.kind==='staff'?row.issued_by:null,row.kind==='storefront'?'店頭のQR':'店員のQR',key,visitKey,...expiry.args,at,row.id,friendId,submittedFriendId,visitId??null,visitId??null,submittedFriendId,...interval.args),
    db.prepare(`UPDATE visit_stamp_qr_codes SET status='used',consumed_friend_id=?,consumed_at=?,consumed_entry_id=?
      WHERE id=? AND kind='staff' AND status='active' AND EXISTS(SELECT 1 FROM visit_stamp_entries WHERE id=?)`)
      .bind(friendId,at,entryId,row.id,entryId),
    ...(visit?[db.prepare(`UPDATE visit_stamp_qr_codes SET status='used',consumed_friend_id=?,consumed_at=?,consumed_entry_id=(SELECT id FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND visit_key=? AND kind='visit')
      WHERE id=? AND kind='staff' AND status='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND active=1 AND version=?)
      AND EXISTS(SELECT 1 FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND visit_key=? AND kind='visit')
      AND EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid WHERE r.id=? AND f.id=? AND r.status IN('visited','seated') AND EXISTS(SELECT 1 FROM rt_seat_visit_marks m WHERE m.reservation_id=r.id AND m.kind='visited' AND m.undone_at IS NULL))`)
      .bind(friendId,now(),row.card_id,friendId,visitKey,row.id,row.card_id,row.card_version,row.card_id,friendId,visitKey,visitId,submittedFriendId)]:[]),
  ]);
  if(visit){const counted=await db.prepare("SELECT id,delta,occurred_at FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND visit_key=? AND kind='visit'").bind(row.card_id,friendId,visitKey).first<{id:string;delta:number;occurred_at:string}>();
   if(counted&&((await qrView(db,await qrRow(db,row.id,accountId))).status==='active'||(await qrRow(db,row.id,accountId)).consumed_friend_id===friendId))return {...await successResult(db,row,friendId,counted.delta,counted.occurred_at,counted.id),alreadyCounted:!results[0].meta.changes};}
  if(results[0].meta.changes)return successResult(db,row,friendId,(await db.prepare('SELECT delta FROM visit_stamp_entries WHERE id=?').bind(entryId).first<{delta:number}>())!.delta,at,entryId);
  const current=await qrRow(db,row.id,accountId);
  const retried=await db.prepare('SELECT id,delta,occurred_at FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND idempotency_key=?').bind(row.card_id,friendId,key).first<{id:string;delta:number;occurred_at:string}>();
  if(retried)return successResult(db,row,friendId,retried.delta,retried.occurred_at,retried.id);
  if(current.status==='used'&&current.consumed_friend_id===friendId)return successResult(db,current,friendId,(await db.prepare('SELECT delta FROM visit_stamp_entries WHERE id=?').bind(current.consumed_entry_id).first<{delta:number}>())!.delta,current.consumed_at!,current.consumed_entry_id!);
  if(current.status!=='active')return {status:'invalid',reason:current.status==='used'?'used':'revoked'};
  if(current.expires_at&&current.expires_at<=now())return {status:'invalid',reason:'expired'};
  const latestCard=await stampCard(db,row.card_id);
  if(!latestCard.active||latestCard.version!==row.card_version)return {status:'invalid',reason:'revoked'};
  if(!await db.prepare('SELECT 1 FROM friends WHERE id=? AND line_account_id=? AND is_following=1').bind(submittedFriendId,accountId).first())return {status:'friend_required'};
  if(!await db.prepare('SELECT 1 FROM line_accounts WHERE id=? AND is_active=1 AND archived_at IS NULL').bind(accountId).first())return {status:'invalid',reason:'revoked'};
  if(visit||row.kind==='storefront')return limitedResult(db,row,friendId,at,settings,!!visit);
  return {status:'invalid',reason:'invalid'};
}
