import { logger } from '@line-crm/shared/server';
import type { VisitStampSettings, VisitStampCardInput, VisitStampCard, VisitStampWallet, VisitStampEntry, VisitStampRedemption } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { getStaffById } from '@line-crm/db';
import { getVisibleLineAccountScope } from './account-access.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { dbFor } from './db-router.js';
import { safeRestaurantHttpsUrl } from './restaurant-media-links.js';

export class StampError extends Error {
  readonly fields: Record<string, string>;
  constructor(message: string, public status: 400|401|403|404|409|422|429 = 400, keys: readonly string[] = []) {
    super(message);
    this.fields = Object.fromEntries(keys.map(key => [key, message]));
  }
}
export function stampId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w:-]{1,160}$/.test(value)) throw new StampError('識別番号を確認してください');
  return value;
}
export function validateStampSettings(s: VisitStampSettings): void {
  if (!s || !['visit','amount'].includes(s.mode) || !Number.isSafeInteger(s.amountUnit) || s.amountUnit<1 || s.amountUnit>100000000
    || !Number.isSafeInteger(s.maxPerVisit) || s.maxPerVisit<1 || s.maxPerVisit>10000
    || !Number.isSafeInteger(s.firstVisitBonus) || s.firstVisitBonus<0 || s.firstVisitBonus>10000
    || (s.expiryMonths!==null && (!Number.isSafeInteger(s.expiryMonths)||s.expiryMonths<1||s.expiryMonths>120))
    || typeof s.timezone!=='string'||!s.timezone||s.timezone.length>100
    || !Array.isArray(s.multipliers)||s.multipliers.length>20 || !Array.isArray(s.rankMultipliers)||s.rankMultipliers.length>20
    || !Array.isArray(s.rewards)||!s.rewards.length||s.rewards.length>20) throw new StampError('スタンプの設定を確認してください', 400, ["settings"]);
  if((s.slotCount!==undefined&&(!Number.isSafeInteger(s.slotCount)||s.slotCount<1||s.slotCount>10000))||(s.maxStackedStamps!==undefined&&(!Number.isSafeInteger(s.maxStackedStamps)||s.maxStackedStamps<1||s.maxStackedStamps>10000))||(s.stackingOrder!==undefined&&!['bonus_then_multipliers','multipliers_then_bonus'].includes(s.stackingOrder)))throw new StampError('マスの数・重ねた上限・順序を確認してください', 400, ["settings"]);
  if (s.backgroundColor !== undefined && !/^#[0-9a-f]{6}$/i.test(s.backgroundColor)) throw new StampError('カードの色を確認してください', 400, ["settings"]);
  if (s.backgroundImageUrl != null && (!safeRestaurantHttpsUrl(s.backgroundImageUrl) || s.backgroundImageUrl.length > 2000)) throw new StampError('背景画像を確認してください', 400, ["settings"]);
  if (s.expiryBasis !== undefined && !['last_visit','first_visit','none'].includes(s.expiryBasis)) throw new StampError('期限の起点を確認してください', 400, ["settings"]);
  if (s.expiryBasis && s.expiryBasis !== 'none' && s.expiryMonths === null) throw new StampError('期限の長さを選んでください', 400, ["settings"]);
  if (s.expiryReminder !== undefined && !['none','day_before','three_days_before','week_before','two_weeks_before','month_before'].includes(s.expiryReminder)) throw new StampError('期限のお知らせを確認してください', 400, ["settings"]);
  if (s.completion !== undefined && !['repeat','next_card'].includes(s.completion)) throw new StampError('ゴール後のカードを確認してください', 400, ["settings"]);
  if (s.completion === 'next_card') stampId(s.nextCardId);
  if (s.instructions !== undefined && (typeof s.instructions !== 'string' || [...s.instructions].length > 500)) throw new StampError('使い方の説明は500字までです', 400, ["settings"]);
  if (s.receiptBonus !== undefined && (!Number.isSafeInteger(s.receiptBonus) || s.receiptBonus < 0 || s.receiptBonus > 50)) throw new StampError('受け取りボーナスは0〜50個です', 400, ["settings"]);
  if (s.stampInterval !== undefined && (!s.stampInterval || !['none','same_day','hours'].includes(s.stampInterval.mode)
    || (s.stampInterval.mode === 'hours' && (!Number.isInteger(s.stampInterval.hours) || s.stampInterval.hours! < 1 || s.stampInterval.hours! > 23)))) throw new StampError('押印の間隔は1〜23時間です', 400, ["settings"]);
  try { new Intl.DateTimeFormat('en',{timeZone:s.timezone}).format(); } catch { throw new StampError('時間帯を確認してください'); }
  const ids=new Set<string>();
  for(const r of s.rewards) {
    stampId(r.id);if(ids.has(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>100||!Number.isSafeInteger(r.stamps)||r.stamps<1||r.stamps>10000)throw new StampError('特典を確認してください');ids.add(r.id);
  }
  for(const m of [...s.multipliers,...s.rankMultipliers]) {
    if(!m||(m.name!==undefined&&(typeof m.name!=='string'||!m.name.trim()||m.name.length>100))||(m.active!==undefined&&typeof m.active!=='boolean')||!Number.isFinite(m.multiplier)||m.multiplier<1||m.multiplier>100)throw new StampError('倍率を確認してください');
  }
  for(const m of s.multipliers) {
    if((m.from!==undefined&&!Number.isFinite(Date.parse(m.from)))||(m.to!==undefined&&!Number.isFinite(Date.parse(m.to)))||(m.from&&m.to&&Date.parse(m.from)>=Date.parse(m.to))
      ||(m.weekdays!==undefined&&(!Array.isArray(m.weekdays)||m.weekdays.some(x=>!Number.isInteger(x)||x<0||x>6)))
      ||(m.startMinute!==undefined&&(!Number.isInteger(m.startMinute)||m.startMinute<0||m.startMinute>1439))
      ||(m.endMinute!==undefined&&(!Number.isInteger(m.endMinute)||m.endMinute<1||m.endMinute>1440))
      ||((m.startMinute===undefined)!==(m.endMinute===undefined))||(m.startMinute!==undefined&&m.startMinute>=m.endMinute!)) throw new StampError('倍率の期間・曜日・時間を確認してください');
  }
  for(const r of s.rankMultipliers)if(typeof r.tagName!=='string'||!r.tagName.trim()||r.tagName.length>100)throw new StampError('ランクのタグ名を確認してください');
}
/** 基本→初回→時間の倍率（配列順）→最高ランク→切捨て→上限。店の暦で判定。 */
export function calculateVisitStamps(s:VisitStampSettings,amount:number,at:string,first:boolean,tagNames:string[],baseCount?:number):number {
  const date=new Date(at),parts=new Intl.DateTimeFormat('en-US',{timeZone:s.timezone,weekday:'short',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(date);
  const part=(key:string)=>parts.find(p=>p.type===key)!.value;
  const weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday')),minute=Number(part('hour'))*60+Number(part('minute'));
  const bonus=first?s.firstVisitBonus:0,after=s.stackingOrder==='multipliers_then_bonus';
  let count=(baseCount??(s.mode==='visit'?1:Math.floor(amount/s.amountUnit)))+(after?0:bonus);
  if(s.maxStackedStamps!==undefined)count=Math.min(s.maxPerVisit,count);
  for(const m of s.multipliers) if(m.active!==false&&(!m.from||date.getTime()>=Date.parse(m.from))&&(!m.to||date.getTime()<Date.parse(m.to))&&(!m.weekdays||m.weekdays.includes(weekday))
    &&(m.startMinute===undefined||(minute>=m.startMinute&&minute<m.endMinute!)))count*=m.multiplier;
  count*=Math.max(1,...s.rankMultipliers.filter(m=>m.active!==false&&tagNames.includes(m.tagName)).map(m=>m.multiplier));
  return Math.min(s.maxStackedStamps??s.maxPerVisit,Math.floor(count+(after?bonus:0)));
}
export function stampExpiry(at:string,months:number|null,jst=false):string|null {
  if(months===null)return null;const offset=jst?9*3600000:0,d=new Date(Date.parse(at)+offset),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return new Date(d.getTime()-offset).toISOString();
}
/** 最初の押印をSQL内で選び、同時の初回押印でも起点を一つにする。受け取りは来店に数えない。 */
export function stampExpiryExpression(s:VisitStampSettings,at:string):{sql:string;args:unknown[]} {
  if(s.expiryBasis==='none'||s.expiryMonths===null)return {sql:'NULL',args:[]};
  if(s.expiryBasis!=='first_visit')return {sql:'?',args:[stampExpiry(at,s.expiryMonths,s.expiryBasis==='last_visit')]};
  return {sql:`(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',strftime('%Y-%m-%d',date(anchor,'start of month',?,
    '+'||(MIN(CAST(strftime('%d',anchor) AS INTEGER),CAST(strftime('%d',date(anchor,'start of month',?,'-1 day')) AS INTEGER))-1)||' days'))
    ||strftime('T%H:%M:%f',anchor),'-9 hours') FROM (SELECT strftime('%Y-%m-%dT%H:%M:%f',COALESCE((SELECT e.occurred_at FROM visit_stamp_entries e
    WHERE e.card_id=w.card_id AND e.friend_id=w.friend_id AND e.kind IN ('visit','manual','paper') AND e.delta>0
    AND e.idempotency_key<>'@receipt-bonus' ORDER BY julianday(e.occurred_at),e.rowid LIMIT 1),?),'+9 hours') AS anchor))`,
    args:[`+${s.expiryMonths} months`,`+${s.expiryMonths+1} months`,at]};
}
/** 間隔は店頭QRだけ。制限なしでも日本時間で同日1回。 */
export function storefrontStampIntervalCondition(s:VisitStampSettings,at:string,exempt=true):{sql:string;args:unknown[]} {
 if(exempt)return {sql:'1=1',args:[]};
 const hours=s.stampInterval?.mode==='hours'?s.stampInterval.hours:undefined;
 return {sql:`NOT EXISTS(SELECT 1 FROM visit_stamp_entries e WHERE e.card_id=w.card_id AND e.friend_id=w.friend_id
 AND e.kind='visit' AND e.visit_key LIKE 'storefront:%' AND e.delta>0
 AND NOT EXISTS(SELECT 1 FROM visit_stamp_entries r WHERE r.original_id=e.id AND r.kind='reverse')
 AND (date(e.occurred_at,'+9 hours')>=date(?,'+9 hours')${hours?' OR julianday(e.occurred_at)>julianday(?)-?/24.0':''}))`,args:hours?[at,at,hours]:[at]};
}

export function stampIntervalCondition(s:VisitStampSettings,at:string,exempt=false):{sql:string;args:unknown[]} {
  const interval=s.stampInterval;
  if(exempt||!interval||interval.mode==='none')return {sql:'1=1',args:[]};
  const condition=interval.mode==='same_day'?`date(e.occurred_at,'+9 hours')>=date(?,'+9 hours')`:`julianday(e.occurred_at)>julianday(?)-?/24.0`;
  return {sql:`NOT EXISTS(SELECT 1 FROM visit_stamp_entries e WHERE e.card_id=w.card_id AND e.friend_id=w.friend_id
    AND e.kind IN ('visit','manual') AND e.delta>0 AND e.idempotency_key<>'@receipt-bonus'
    AND NOT EXISTS(SELECT 1 FROM visit_stamp_entries r WHERE r.original_id=e.id AND r.kind='reverse') AND ${condition})`,
    args:interval.mode==='same_day'?[at]:[at,interval.hours!]};
}
function storedStampExpiry(s:VisitStampSettings):{sql:string;args:unknown[]} {
  if(s.expiryBasis==='none'||s.expiryMonths===null)return {sql:'NULL',args:[]};
  const expression=stampExpiryExpression({...s,expiryBasis:'first_visit'},'1970-01-01T00:00:00Z');
  // 最後からの期限だけは台帳のいちばん新しい押印を使う。押印が無い財布には期限を付けない。
  if(s.expiryBasis==='last_visit')expression.sql=expression.sql.replace('ORDER BY julianday(e.occurred_at),e.rowid','ORDER BY julianday(e.occurred_at) DESC,e.rowid DESC');
  expression.args[2]=null;return expression;
}
type CardRow={id:string;tenant_id:string;name:string;settings_json:string;active:number;version:number};
export async function stampCard(db:D1Database,id:string,tenantId?:string):Promise<CardRow> {
  const r=await db.prepare('SELECT * FROM visit_stamp_cards WHERE id=? AND (? IS NULL OR tenant_id=?)').bind(stampId(id),tenantId??null,tenantId??null).first<CardRow>();
  if(!r)throw new StampError('カードが見つかりません',404);return r;
}
export async function readStampCard(db:D1Database,r:CardRow):Promise<VisitStampCard> {
  const accounts=await db.prepare('SELECT line_account_id FROM visit_stamp_card_accounts WHERE card_id=? ORDER BY line_account_id').bind(r.id).all<{line_account_id:string}>();
  const settings=JSON.parse(r.settings_json) as VisitStampSettings;
  return {id:r.id,name:r.name,settings:{slotCount:Math.max(...settings.rewards.map(r=>r.stamps)),stackingOrder:'bonus_then_multipliers',...settings},active:!!r.active,version:r.version,expectedVersion:r.version,accountIds:accounts.results.map(x=>x.line_account_id)};
}
export async function saveStampCard(db:D1Database,tenantId:string,input:VisitStampCardInput,id?:string):Promise<VisitStampCard> {
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.active!=='boolean'||!Number.isSafeInteger(input.expectedVersion)
    ||!Array.isArray(input.accountIds)||!input.accountIds.length||input.accountIds.length>100||new Set(input.accountIds).size!==input.accountIds.length)throw new StampError('カードと店舗の設定を確認してください', 400, ["name","active","expectedVersion","accountIds"]);
  validateStampSettings(input.settings);
  for(const a of input.accountIds){stampId(a);if(!await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND archived_at IS NULL').bind(a,tenantId).first())throw new StampError('指定した店舗は使えません',403);}
  const cardId=id?stampId(id):crypto.randomUUID();if(id)await stampCard(db,id,tenantId);else if(input.expectedVersion!==0)throw new StampError('新しいカードの版は0です', 400, ["expectedVersion"]);
  if (input.settings.completion === 'next_card') {
    const next = await stampCard(db, input.settings.nextCardId!, tenantId);
    if (next.id === cardId || !next.active) throw new StampError('次のカードには別の有効なカードを選んでください');
    const allowed = (await readStampCard(db, next)).accountIds;
    if (input.accountIds.some(a => !allowed.includes(a))) throw new StampError('次のカードは同じ店舗で使えるカードを選んでください', 400, ["accountIds"]);
    const seen=new Set([cardId]);let cursor:CardRow|undefined=next;
    while(cursor){if(seen.has(cursor.id))throw new StampError('次のカードが循環しています');seen.add(cursor.id);
      const s=JSON.parse(cursor.settings_json) as VisitStampSettings;cursor=s.completion==='next_card'&&s.nextCardId?await stampCard(db,s.nextCardId,tenantId):undefined;}
  }
  const token=crypto.randomUUID();
  const statements=[db.prepare(`INSERT INTO visit_stamp_cards(id,tenant_id,name,settings_json,active,write_token) SELECT ?,?,?,?,?,? WHERE ?=0
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,settings_json=excluded.settings_json,active=excluded.active,write_token=excluded.write_token,version=version+1,updated_at=datetime('now') WHERE tenant_id=? AND version=?`)
    .bind(cardId,tenantId,input.name.trim(),JSON.stringify(input.settings),input.active?1:0,token,id?0:input.expectedVersion,tenantId,input.expectedVersion)];
  // 更新の勝者だけが許可店を書き換える。UPDATEの版条件と同じトランザクション。
  statements.push(db.prepare('DELETE FROM visit_stamp_card_accounts WHERE card_id=? AND changes()=1').bind(cardId));
  for(const a of input.accountIds)statements.push(db.prepare(`INSERT OR IGNORE INTO visit_stamp_card_accounts(card_id,line_account_id)
    SELECT ?,? WHERE EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND write_token=?)`).bind(cardId,a,cardId,token));
  if(input.settings.expiryBasis!==undefined){const expiry=storedStampExpiry(input.settings);
    statements.push(db.prepare(`UPDATE visit_stamp_wallets AS w SET expires_at=${expiry.sql} WHERE w.card_id=?
      AND EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND write_token=?)`).bind(...expiry.args,cardId,cardId,token));}
  const result=await db.batch(statements);if(!result[0].meta.changes)throw new StampError('カードが更新されました。読み直してください',409);
  return readStampCard(db,await stampCard(db,cardId,tenantId));
}
export async function stampFriend(db:D1Database,cardId:string,friendId:string,accountId:string) {
  const row=await db.prepare(`SELECT f.id FROM friends f JOIN line_accounts a ON a.id=f.line_account_id JOIN visit_stamp_cards c ON c.tenant_id=a.tenant_id
    JOIN visit_stamp_card_accounts ca ON ca.card_id=c.id AND ca.line_account_id=a.id WHERE c.id=? AND f.id=? AND a.id=?`).bind(cardId,friendId,accountId).first();
  if(!row)throw new StampError('カードとお客さまの店舗が一致しません',403);
}
export async function canonicalStampFriend(db:D1Database,cardId:string,friendId:string):Promise<string> {
  const f=await db.prepare('SELECT user_id FROM friends WHERE id=?').bind(friendId).first<{user_id:string|null}>();
  if(!f?.user_id)return friendId;
  const existing=await db.prepare(`SELECT w.friend_id FROM visit_stamp_wallets w JOIN friends f ON f.id=w.friend_id
    WHERE w.card_id=? AND f.user_id=? ORDER BY w.friend_id LIMIT 1`).bind(cardId,f.user_id).first<{friend_id:string}>();
  if(existing)return existing.friend_id;
  const first=await db.prepare(`SELECT f.id FROM friends f JOIN visit_stamp_card_accounts a ON a.line_account_id=f.line_account_id
    WHERE a.card_id=? AND f.user_id=? ORDER BY f.id LIMIT 1`).bind(cardId,f.user_id).first<{id:string}>();
  return first?.id??friendId;
}
/** 財布を初めて作る操作と受け取りボーナスを一つのトランザクションにする。 */
export function createStampWalletStatements(db:D1Database,cardId:string,friendId:string,accountId:string,bonus:number,guard='1=1',guardArgs:unknown[]=[]) {
  return [
    db.prepare(`INSERT OR IGNORE INTO visit_stamp_wallets(card_id,friend_id) SELECT ?,? WHERE ${guard}`).bind(cardId,friendId,...guardArgs),
    db.prepare(`INSERT INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,occurred_at)
      SELECT ?,?,?,?,'manual',?,'受け取りボーナス','@receipt-bonus',datetime('now') WHERE changes()=1 AND ?>0`)
      .bind(crypto.randomUUID(),cardId,friendId,accountId,bonus,bonus),
  ];
}
export async function stampCardLocked(db:D1Database,cardId:string,friendId:string,accountId:string):Promise<boolean> {
  const canonical=await canonicalStampFriend(db,cardId,friendId);
  if(await db.prepare('SELECT 1 FROM visit_stamp_wallets WHERE card_id=? AND friend_id=?').bind(cardId,canonical).first())return false;
  return !!await db.prepare(`SELECT 1 FROM visit_stamp_cards c JOIN visit_stamp_card_accounts a ON a.card_id=c.id
    WHERE a.line_account_id=? AND c.active=1 AND json_extract(c.settings_json,'$.completion')='next_card'
    AND json_extract(c.settings_json,'$.nextCardId')=? LIMIT 1`).bind(accountId,cardId).first();
}
export async function stampWallet(db:D1Database,cardId:string,friendId:string,accountId:string,writeGuard?:{sql:string;args:unknown[]}):Promise<VisitStampWallet> {
  await stampFriend(db,cardId,friendId,accountId);
  if(await stampCardLocked(db,cardId,friendId,accountId))throw new StampError('前のカードのゴール特典を使うと受け取れます',409);
  friendId=await canonicalStampFriend(db,cardId,friendId);
  const settings=JSON.parse((await stampCard(db,cardId)).settings_json) as VisitStampSettings;
  await db.batch(createStampWalletStatements(db,cardId,friendId,accountId,settings.receiptBonus??0,writeGuard?.sql??'1=1',writeGuard?.args??[]));
  // 期限切れは再読込でも一度だけ。残高はSQLの現在値を使う。
  await db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,occurred_at)
    SELECT ?,card_id,friend_id,?,'expire',-MAX(balance,0),'有効期限切れ','expire:'||expires_at||':'||version,datetime('now')
    FROM visit_stamp_wallets WHERE card_id=? AND friend_id=? AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday('now') AND balance>0 AND ${writeGuard?.sql??'1=1'}`)
    .bind(crypto.randomUUID(),accountId,cardId,friendId,...writeGuard?.args??[]).run();
  const r=await db.prepare('SELECT balance,earned_total,expires_at FROM visit_stamp_wallets WHERE card_id=? AND friend_id=?').bind(cardId,friendId).first<{balance:number;earned_total:number;expires_at:string|null}>();
  if(!r)throw new StampError('来店の記録が更新されました',409);
  return {cardId,friendId,balance:r.balance,earnedTotal:r.earned_total,expiresAt:r.expires_at};
}
export async function readStampWallet(db:D1Database,cardId:string,friendId:string):Promise<VisitStampWallet> {
 const r=await db.prepare('SELECT balance,earned_total,expires_at FROM visit_stamp_wallets WHERE card_id=? AND friend_id=?').bind(cardId,friendId).first<{balance:number;earned_total:number;expires_at:string|null}>();
 if(!r)throw new StampError('カードが見つかりません',404);return {cardId,friendId,balance:r.balance,earnedTotal:r.earned_total,expiresAt:r.expires_at};
}
export async function grantStamps(db:D1Database,input:{cardId:string;friendId:string;accountId:string;count:number;reason:string;actorId:string|null;requestId:string;kind:'manual'|'paper'|'visit';at?:string;visitKey?:string}):Promise<VisitStampWallet> {
  const c=await stampCard(db,input.cardId);if(!c.active)throw new StampError('カードは停止中です',409);
  if(!Number.isSafeInteger(input.count)||input.count<1||input.count>10000||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)throw new StampError('押印数と理由を確認してください', 400, ["count","reason"]);
  stampId(input.requestId);input.friendId=(await stampWallet(db,input.cardId,input.friendId,input.accountId)).friendId;
  const at=input.at??new Date().toISOString(),settings=JSON.parse(c.settings_json) as VisitStampSettings;
  if(!Number.isFinite(Date.parse(at)))throw new StampError('押印日時を確認してください');
  const expiry=stampExpiryExpression(settings,at),interval=stampIntervalCondition(settings,at,input.kind==='paper');
  await db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,actor_id,reason,idempotency_key,visit_key,expires_at,occurred_at)
    SELECT ?,w.card_id,w.friend_id,?,?,?,?,?,?,?,${expiry.sql},? FROM visit_stamp_wallets w WHERE w.card_id=? AND w.friend_id=? AND ${interval.sql}`)
    .bind(crypto.randomUUID(),input.accountId,input.kind,input.count,input.actorId,input.reason.trim(),input.requestId,input.visitKey??null,...expiry.args,at,input.cardId,input.friendId,...interval.args).run();
  const receipt=await db.prepare('SELECT delta,reason,kind,line_account_id FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND idempotency_key=?').bind(input.cardId,input.friendId,input.requestId).first<{delta:number;reason:string;kind:string;line_account_id:string}>();
  if(!receipt)throw new StampError(settings.stampInterval?.mode==='same_day'?'同じ日は1回までです。日本時間の0時以降に押せます':`前の押印から${settings.stampInterval?.hours??0}時間あけてください`,409);
  if(receipt.delta!==input.count||receipt.reason!==input.reason.trim()||receipt.kind!==input.kind||receipt.line_account_id!==input.accountId)throw new StampError('同じ押印の依頼で内容が変わっています', 409, ["count","reason","kind","accountId"]);
  return readStampWallet(db,input.cardId,input.friendId);
}
export async function stampEntries(db:D1Database,cardId:string,friendId:string):Promise<VisitStampEntry[]> {
  return (await db.prepare(`SELECT id,card_id AS cardId,friend_id AS friendId,line_account_id AS accountId,kind,delta,actor_id AS actorId,reason,created_at AS createdAt,original_id AS originalId
    FROM visit_stamp_entries WHERE card_id=? AND friend_id=? ORDER BY created_at DESC,id LIMIT 200`).bind(cardId,friendId).all<VisitStampEntry>()).results;
}
export async function reverseStampEntry(db:D1Database,id:string,tenantId:string,actorId:string,reason:string) {
  if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw new StampError('取消理由を入力してください');
  const entry=await db.prepare(`SELECT e.* FROM visit_stamp_entries e JOIN visit_stamp_cards c ON c.id=e.card_id WHERE e.id=? AND c.tenant_id=?`).bind(stampId(id),tenantId).first<{card_id:string;friend_id:string;line_account_id:string;delta:number;kind:string}>();
  if(!entry)throw new StampError('記録が見つかりません',404);if(!['visit','manual','paper','redeem'].includes(entry.kind))throw new StampError('この記録は取り消せません',409);
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,actor_id,reason,idempotency_key,original_id,occurred_at)
      VALUES(?,?,?,?,'reverse',?,?,?,?,?,datetime('now'))`).bind(crypto.randomUUID(),entry.card_id,entry.friend_id,entry.line_account_id,-entry.delta,actorId,reason.trim(),'reverse:'+id,id),
    db.prepare(`UPDATE visit_stamp_redemptions SET status='cancelled',cancelled_at=datetime('now') WHERE id=(SELECT substr(idempotency_key,8) FROM visit_stamp_entries WHERE id=?) AND status='used'`).bind(id),
  ]);
  if(!result[0].meta.changes)throw new StampError('すでに取り消しています',409);
  return readStampWallet(db,entry.card_id,entry.friend_id);
}
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
export async function stampPinHash(pin:string,salt:string):Promise<string> {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},key,256));
}
export async function setStampPin(db:D1Database,accountId:string,staffId:string,pin:string) {
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw new StampError('暗証番号は4桁です');
  const others=(await db.prepare('SELECT staff_id,salt,hash FROM visit_stamp_staff_pins WHERE line_account_id=? AND staff_id<>?').bind(accountId,staffId).all<{staff_id:string;salt:string;hash:string}>()).results;
  for(const r of others)if(await stampPinHash(pin,r.salt)===r.hash)throw new StampError('この店では別の店員が同じ暗証番号を使っています',409);
  const salt=crypto.randomUUID(),hash=await stampPinHash(pin,salt);
  await db.prepare(`INSERT INTO visit_stamp_staff_pins(line_account_id,staff_id,salt,hash) VALUES(?,?,?,?)
    ON CONFLICT(line_account_id,staff_id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,attempts=0,locked_until=NULL,updated_at=datetime('now')`).bind(accountId,staffId,salt,hash).run();
}
export async function verifyStampPin(db:D1Database,accountId:string,staffId:string,pin:string):Promise<void> {
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw new StampError('暗証番号は4桁です');
  const result=await db.prepare(`UPDATE visit_stamp_staff_pins SET attempts=CASE WHEN julianday(locked_until)<=julianday('now') THEN 1 ELSE attempts+1 END,
    locked_until=CASE WHEN julianday(locked_until)<=julianday('now') THEN NULL ELSE locked_until END
    WHERE line_account_id=? AND staff_id=? AND (locked_until IS NULL OR julianday(locked_until)<=julianday('now'))
    RETURNING salt,hash,attempts`).bind(accountId,staffId).first<{salt:string;hash:string;attempts:number}>();
  if(!result)throw new StampError('暗証番号を確認できません。店員へお知らせください',429);
  if(result.attempts>5){await db.prepare("UPDATE visit_stamp_staff_pins SET locked_until=datetime('now','+15 minutes') WHERE line_account_id=? AND staff_id=? AND salt=?").bind(accountId,staffId,result.salt).run();throw new StampError('試行回数の上限です。15分後に確認してください',429);}
  const hash=await stampPinHash(pin,result.salt);let differs=0;for(let i=0;i<hash.length;i++)differs|=hash.charCodeAt(i)^result.hash.charCodeAt(i);
  if(differs){if(result.attempts>=5)await db.prepare("UPDATE visit_stamp_staff_pins SET locked_until=datetime('now','+15 minutes') WHERE line_account_id=? AND staff_id=? AND salt=?").bind(accountId,staffId,result.salt).run();throw new StampError('暗証番号が違います',403);}
  await db.prepare('UPDATE visit_stamp_staff_pins SET attempts=0,locked_until=NULL WHERE line_account_id=? AND staff_id=? AND salt=? AND attempts=?').bind(accountId,staffId,result.salt,result.attempts).run();
}
export async function offerStampReward(db:D1Database,cardId:string,friendId:string,accountId:string,rewardId:string,requestId:string):Promise<VisitStampRedemption> {
  stampId(requestId);const c=await stampCard(db,cardId);if(!c.active)throw new StampError('カードは停止中です',409);
  const reward=(JSON.parse(c.settings_json) as VisitStampSettings).rewards.find(x=>x.id===rewardId);if(!reward)throw new StampError('特典が見つかりません',404);
  const wallet=await stampWallet(db,cardId,friendId,accountId);friendId=wallet.friendId;if(wallet.balance<reward.stamps)throw new StampError('スタンプが足りません',409);
  await db.prepare(`INSERT OR IGNORE INTO visit_stamp_redemptions(id,card_id,friend_id,line_account_id,reward_id,reward_name,stamps,request_id) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(),cardId,friendId,accountId,rewardId,reward.name,reward.stamps,requestId).run();
  const r=await db.prepare('SELECT id,card_id AS cardId,reward_id AS rewardId,reward_name AS rewardName,stamps,status FROM visit_stamp_redemptions WHERE card_id=? AND friend_id=? AND request_id=?').bind(cardId,friendId,requestId).first<VisitStampRedemption>();
  if(r!.rewardId!==rewardId)throw new StampError('同じ使用依頼の内容が変わっています',409);return r!;
}
export async function useStampReward(db:D1Database,id:string,friendId:string,accountId:string,staffId:string|null,pin:string) {
  const submittedFriendId=friendId;
  const selected=await db.prepare('SELECT card_id FROM visit_stamp_redemptions WHERE id=?').bind(stampId(id)).first<{card_id:string}>();
  if(!selected)throw new StampError('特典が見つかりません',404);
  friendId=(await stampWallet(db,selected.card_id,friendId,accountId)).friendId;
  const r=await db.prepare('SELECT * FROM visit_stamp_redemptions WHERE id=? AND friend_id=? AND line_account_id=?').bind(stampId(id),friendId,accountId).first<{card_id:string;status:string;stamps:number;reward_name:string}>();
  if(!r)throw new StampError('特典が見つかりません',404);if(r.status!=='offered')throw new StampError('この特典はすでに処理済みです',409);
  await readStampWallet(db,r.card_id,friendId);
  const card=await stampCard(db,r.card_id),settings=JSON.parse(card.settings_json) as VisitStampSettings;
  const goal=Math.max(...settings.rewards.map(reward=>reward.stamps));
  const next=settings.completion==='next_card'&&r.stamps>=goal?await stampCard(db,settings.nextCardId!,card.tenant_id):null;
  let nextFriend:string|null=null;
  if(next){if(!next.active)throw new StampError('次のカードは停止中です',409);await stampFriend(db,next.id,submittedFriendId,accountId);nextFriend=await canonicalStampFriend(db,next.id,submittedFriendId);}
  if(staffId===null)staffId=(await identifyStampStaff(db,accountId,pin)).id;else await verifyStampPin(db,accountId,staffId,pin);
  const statements=[
    db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,actor_id,reason,idempotency_key,occurred_at)
      SELECT ?,r.card_id,r.friend_id,r.line_account_id,'redeem',-r.stamps,?,r.reward_name,'redeem:'||r.id,datetime('now') FROM visit_stamp_redemptions r
      JOIN visit_stamp_wallets w ON w.card_id=r.card_id AND w.friend_id=r.friend_id JOIN visit_stamp_cards c ON c.id=r.card_id
      WHERE r.id=? AND r.status='offered' AND w.balance>=r.stamps AND (w.expires_at IS NULL OR julianday(w.expires_at)>julianday('now')) AND c.active=1 AND c.version=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM visit_stamp_cards nc JOIN visit_stamp_card_accounts na ON na.card_id=nc.id
        WHERE nc.id=? AND nc.active=1 AND nc.version=? AND na.line_account_id=r.line_account_id))`)
      .bind(crypto.randomUUID(),staffId,id,card.version,next?.id??null,next?.id??null,next?.version??null),
    db.prepare(`UPDATE visit_stamp_redemptions SET status='used',used_by=?,used_at=datetime('now') WHERE id=? AND status='offered'
      AND EXISTS(SELECT 1 FROM visit_stamp_entries WHERE idempotency_key='redeem:'||? AND card_id=? AND friend_id=?)`).bind(staffId,id,id,r.card_id,friendId),
  ];
  if(next&&nextFriend)statements.push(...createStampWalletStatements(db,next.id,nextFriend,accountId,(JSON.parse(next.settings_json) as VisitStampSettings).receiptBonus??0,
    `changes()=1 AND EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND active=1 AND version=?)`,[next.id,next.version]));
  const results=await db.batch(statements);
  if(!results[0].meta.changes)throw new StampError('使用済み、期限切れ、またはスタンプ不足です',409);
  const member=await getStaffById(db,staffId);
  return {id,status:'used' as const,staffId,staffName:member?.name??'店員',...(next?{nextCardId:next.id}:{})};
}
export async function applyPaperStamps(db:D1Database,id:string,tenantId:string,actorId:string,approve:boolean,reason:string) {
  if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw new StampError('承認・却下の理由を入力してください');
  const r=await db.prepare(`SELECT p.* FROM visit_stamp_paper_requests p JOIN visit_stamp_cards c ON c.id=p.card_id WHERE p.id=? AND c.tenant_id=?`).bind(stampId(id),tenantId).first<{card_id:string;friend_id:string;line_account_id:string;stamps:number;status:string}>();
  if(!r)throw new StampError('申請が見つかりません',404);if(r.status!=='pending')throw new StampError('申請は処理済みです',409);
  await readStampWallet(db,r.card_id,r.friend_id);
  const card=await stampCard(db,r.card_id);if(!card.active)throw new StampError('カードは停止中です',409);
  const now=new Date().toISOString(),expiry=stampExpiryExpression(JSON.parse(card.settings_json) as VisitStampSettings,now);
  const sql=[db.prepare(`UPDATE visit_stamp_paper_requests SET status=?,reason=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'`)
    .bind(approve?'approved':'rejected',reason.trim(),actorId,now,id)];
  if(approve)sql.push(db.prepare(`INSERT INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,actor_id,reason,idempotency_key,expires_at,occurred_at)
    SELECT ?,p.card_id,p.friend_id,p.line_account_id,'paper',p.stamps,p.reviewed_by,p.reason,'paper:'||p.id,${expiry.sql},? FROM visit_stamp_paper_requests p JOIN visit_stamp_wallets w ON w.card_id=p.card_id AND w.friend_id=p.friend_id WHERE p.id=? AND changes()=1`).bind(crypto.randomUUID(),...expiry.args,now,id));
  const result=await db.batch(sql);if(!result[0].meta.changes)throw new StampError('申請は処理済みです',409);return {id,status:approve?'approved':'rejected'};
}
export async function requestPaperStamps(db:D1Database,cardId:string,friendId:string,accountId:string,photo:unknown,count:number) {
  const url=safeRestaurantHttpsUrl(photo);if(!url||!Number.isSafeInteger(count)||count<1||count>10000)throw new StampError('写真のHTTPS URLと押印数を確認してください');
  const submittedFriendId=friendId;friendId=(await stampWallet(db,cardId,friendId,accountId)).friendId;const id=crypto.randomUUID();
  const res=await db.prepare(`INSERT OR IGNORE INTO visit_stamp_paper_requests(id,card_id,friend_id,line_account_id,photo_url,stamps,submitted_friend_id) VALUES(?,?,?,?,?,?,?)`).bind(id,cardId,friendId,accountId,url,count,submittedFriendId).run();
  if(!res.meta.changes)throw new StampError('申請済みまたは移行済みです',409);return {id,status:'pending' as const};
}

export type StampVisitKind='restaurant'|'booking';
export async function getStampVisit(db:D1Database,kind:StampVisitKind,id:string) {
  if(!['restaurant','booking'].includes(kind))throw new StampError('来店の種類を確認してください');
  if(kind==='restaurant')return db.prepare(`SELECT r.id,r.customer_version AS source_version,r.updated_at AS source_updated_at,
    COALESCE((SELECT generation FROM visit_stamp_visit_queue WHERE kind='restaurant' AND visit_id=r.id),0) AS queue_generation,
    s.line_account_id AS account_id,f.id AS friend_id,COALESCE((SELECT marked_at FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL ORDER BY marked_at DESC LIMIT 1),r.starts_at) AS occurred_at,
    CASE WHEN r.status IN ('visited','seated') THEN 1 ELSE 0 END AS visited
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id LEFT JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid WHERE r.id=?`).bind(stampId(id)).first<StampVisit>();
  return db.prepare(`SELECT id,lock_version AS source_version,updated_at AS source_updated_at,
    COALESCE((SELECT generation FROM visit_stamp_visit_queue WHERE kind='booking' AND visit_id=bookings.id),0) AS queue_generation,
    line_account_id AS account_id,friend_id,COALESCE((SELECT marked_at FROM booking_visit_marks WHERE booking_id=bookings.id AND kind='visited' ORDER BY marked_at DESC LIMIT 1),starts_at) AS occurred_at,CASE WHEN status='completed' THEN 1 ELSE 0 END AS visited FROM bookings WHERE id=?`).bind(stampId(id)).first<StampVisit>();
}
type StampVisit={id:string;account_id:string;friend_id:string|null;occurred_at:string;visited:number;source_version:number;source_updated_at:string;queue_generation:number};
/** 状態・版・時刻・queue世代を、押印のSQLが実行される時点で照合する。 */
function stampVisitWriteGuard(kind:StampVisitKind,visit:StampVisit):{sql:string;args:unknown[]} {
  const table=kind==='restaurant'?'rt_reservations':'bookings';
  const version=kind==='restaurant'?'customer_version':'lock_version';
  const visited=kind==='restaurant'?"status IN ('visited','seated')":"status='completed'";
  return {sql:`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND ${version}=? AND updated_at=?
    AND CASE WHEN ${visited} THEN 1 ELSE 0 END=?)
    AND COALESCE((SELECT generation FROM visit_stamp_visit_queue WHERE kind=? AND visit_id=?),0)=?`,
    args:[visit.id,visit.source_version,visit.source_updated_at,visit.visited,kind,visit.id,visit.queue_generation]};
}
/** 来店と会計から同じキーで押す。再送・同時処理では既存の押印を増やさない。 */
export async function reconcileStampVisit(db:D1Database,kind:StampVisitKind,id:string,expectedGeneration?:number) {
  const visit=await getStampVisit(db,kind,id);if(!visit?.account_id||!visit.friend_id)return;
  if(expectedGeneration!==undefined&&visit.queue_generation!==expectedGeneration)return;
  const guard=stampVisitWriteGuard(kind,visit);
  const key=kind+':'+id;
  const cards=(await db.prepare(`SELECT c.* FROM visit_stamp_cards c JOIN visit_stamp_card_accounts a ON a.card_id=c.id WHERE a.line_account_id=?`).bind(visit.account_id).all<CardRow>()).results;
  for(const card of cards) {
    if(visit.visited&&await stampCardLocked(db,card.id,visit.friend_id,visit.account_id))continue;
    const subject=await canonicalStampFriend(db,card.id,visit.friend_id);
    const original=await db.prepare(`SELECT id,delta FROM visit_stamp_entries WHERE card_id=? AND friend_id=? AND visit_key=? AND kind='visit'`).bind(card.id,subject,key).first<{id:string;delta:number}>();
    if(!visit.visited) {
      if(original) {
        const positive=await db.prepare(`SELECT e.id,e.delta FROM visit_stamp_entries e WHERE e.card_id=? AND e.friend_id=? AND e.visit_key=? AND e.delta>0
          AND NOT EXISTS(SELECT 1 FROM visit_stamp_entries r WHERE r.original_id=e.id) ORDER BY e.created_at DESC LIMIT 1`).bind(card.id,subject,key).first<{id:string;delta:number}>();
        if(positive)await db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,original_id,visit_key,occurred_at)
          SELECT ?,?,?,?,'reverse',?,'来店記録の取消',?,?,?,datetime('now') WHERE ${guard.sql}`).bind(crypto.randomUUID(),card.id,subject,visit.account_id,-positive.delta,'reverse:'+positive.id,positive.id,key,...guard.args).run();
      }
      continue;
    }
    if(original) {
      const cancelled=await db.prepare(`SELECT r.id,r.delta FROM visit_stamp_entries r WHERE r.card_id=? AND r.friend_id=? AND r.visit_key=? AND r.kind='reverse' AND r.reason='来店記録の取消'
        AND NOT EXISTS(SELECT 1 FROM visit_stamp_entries e WHERE e.original_id=r.id) ORDER BY r.created_at DESC LIMIT 1`).bind(card.id,subject,key).first<{id:string;delta:number}>();
      if(cancelled&&card.active&&await featureJobCanRun(db,{accountId:visit.account_id,featureId:'visit_stamps',job:'visit stamps'}))await db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,original_id,visit_key,occurred_at)
        SELECT ?,?,?,?,'restore',?,'来店記録の再確認',?,?,?,datetime('now') WHERE ${guard.sql}`).bind(crypto.randomUUID(),card.id,subject,visit.account_id,-cancelled.delta,'restore:'+cancelled.id,cancelled.id,key,...guard.args).run();
      continue;
    }
    if(!card.active||!await featureJobCanRun(db,{accountId:visit.account_id,featureId:'visit_stamps',job:'visit stamps'}))continue;
    const s=JSON.parse(card.settings_json) as VisitStampSettings;
    const checkout=await db.prepare('SELECT amount FROM visit_stamp_checkouts WHERE kind=? AND visit_id=?').bind(kind,id).first<{amount:number}>();
    if(s.mode==='amount'&&!checkout)continue;
    if(!await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.args).first())continue;
    await stampWallet(db,card.id,visit.friend_id,visit.account_id,guard);
    const tags=(await db.prepare('SELECT t.name FROM tags t JOIN friend_tags ft ON ft.tag_id=t.id WHERE ft.friend_id=?').bind(visit.friend_id).all<{name:string}>()).results.map(x=>x.name);
    // SQLで初回かどうかを最後に判定し、別の来店との競合でも初回ボーナスは1度。
    const regular=calculateVisitStamps(s,checkout?.amount??0,visit.occurred_at,false,tags),first=calculateVisitStamps(s,checkout?.amount??0,visit.occurred_at,true,tags);
    if(!first&&!regular)continue;
    const expiry=stampExpiryExpression(s,visit.occurred_at),interval=stampIntervalCondition(s,visit.occurred_at);
    await db.prepare(`INSERT OR IGNORE INTO visit_stamp_entries(id,card_id,friend_id,line_account_id,kind,delta,reason,idempotency_key,visit_key,expires_at,occurred_at)
      SELECT ?,?,?,?,'visit',CASE WHEN w.visit_count=0 THEN ? ELSE ? END,'来店から自動押印',?,?,${expiry.sql},? FROM visit_stamp_wallets w
      WHERE w.card_id=? AND w.friend_id=? AND EXISTS(SELECT 1 FROM visit_stamp_cards WHERE id=? AND active=1)
      AND CASE WHEN w.visit_count=0 THEN ? ELSE ? END>0 AND ${interval.sql} AND ${guard.sql}`).bind(crypto.randomUUID(),card.id,subject,visit.account_id,first,regular,'auto:'+key,key,...expiry.args,visit.occurred_at,card.id,subject,card.id,first,regular,...interval.args,...guard.args).run();
  }
}
export async function processVisitStampQueue(env:Env['Bindings']) {
  const db=dbFor(env);let queue:Array<{kind:StampVisitKind;visit_id:string;generation:number}>;
  try {queue=(await db.prepare('SELECT kind,visit_id,generation FROM visit_stamp_visit_queue ORDER BY updated_at LIMIT 100').all<{kind:StampVisitKind;visit_id:string;generation:number}>()).results;}
  catch {logger.error("visit_stamps.read_queue_failed");return;}
  for(const q of queue) {
    try {await reconcileStampVisit(db,q.kind,q.visit_id,q.generation);await db.prepare('DELETE FROM visit_stamp_visit_queue WHERE kind=? AND visit_id=? AND generation=?').bind(q.kind,q.visit_id,q.generation).run();}
    catch {
      // 失敗を先頭に固定しない。並走して積まれた新しい世代は触らない。
      await db.prepare("UPDATE visit_stamp_visit_queue SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE kind=? AND visit_id=? AND generation=?")
        .bind(q.kind,q.visit_id,q.generation).run().catch(()=>undefined);
      logger.error("visit_stamps.reconcile_failed");
    }
  }
}

/** 店舗全体にも5回/15分の制限を置き、店員IDを知らない試行でも制限を回避できない。 */
export async function identifyStampStaff(db:D1Database,accountId:string,pin:string) {
 if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw new StampError('暗証番号は4桁です');
 await db.prepare('INSERT OR IGNORE INTO visit_stamp_pin_attempts(line_account_id) VALUES(?)').bind(accountId).run();
 const attempt=await db.prepare(`UPDATE visit_stamp_pin_attempts SET attempts=CASE WHEN julianday(locked_until)<=julianday('now') THEN 1 ELSE attempts+1 END,
 locked_until=CASE WHEN julianday(locked_until)<=julianday('now') THEN NULL ELSE locked_until END
 WHERE line_account_id=? AND (locked_until IS NULL OR julianday(locked_until)<=julianday('now')) RETURNING attempts`).bind(accountId).first<{attempts:number}>();
 if(!attempt)throw new StampError('試行回数の上限です。15分後に確認してください',429);
 if(attempt.attempts>5){await db.prepare("UPDATE visit_stamp_pin_attempts SET locked_until=datetime('now','+15 minutes') WHERE line_account_id=? AND attempts>=? AND locked_until IS NULL").bind(accountId,attempt.attempts).run();throw new StampError('試行回数の上限です。15分後に確認してください',429);}
 const rows=(await db.prepare(`SELECT p.* FROM visit_stamp_staff_pins p JOIN staff_members s ON s.id=p.staff_id JOIN line_accounts a ON a.id=p.line_account_id
 WHERE p.line_account_id=? AND s.is_active=1 AND s.tenant_id=a.tenant_id AND s.access_level<>'read_only'`).bind(accountId).all<{staff_id:string;salt:string;hash:string}>()).results;
 const matches=[];
 for(const row of rows){const member=await getStaffById(db,row.staff_id);if(!member)continue;
  if(!(await getVisibleLineAccountScope(db,{id:member.id,name:member.name,role:member.role,tenantId:member.tenant_id!,readOnly:false})).ids.includes(accountId))continue;
  if(await stampPinHash(pin,row.salt)===row.hash)matches.push(member);
 }
 if(matches.length!==1){if(attempt.attempts>=5)await db.prepare("UPDATE visit_stamp_pin_attempts SET locked_until=datetime('now','+15 minutes') WHERE line_account_id=?").bind(accountId).run();
  throw new StampError(matches.length?'暗証番号が重複しています。管理者へお知らせください':'暗証番号が違います',matches.length?409:403);}
 await verifyStampPin(db,accountId,matches[0].id,pin);
 await db.prepare('UPDATE visit_stamp_pin_attempts SET attempts=0,locked_until=NULL WHERE line_account_id=? AND attempts=?').bind(accountId,attempt.attempts).run();
 return matches[0];
}
