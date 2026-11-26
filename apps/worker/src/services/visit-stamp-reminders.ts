import { activeTenantLineAccountSql, isOperationCapabilityStopped, resolveLineCredential } from '@line-crm/db';
import type { VisitStampSettings } from '@line-crm/shared';
import { featureJobCanRun } from './feature-enforcement.js';
import { pushViaHarnessProxy, type HarnessProxyDispatch } from './line-proxy-send.js';
import { stampExpiry } from './visit-stamps.js';

type Candidate = { card_id:string; friend_id:string; line_account_id:string; expires_at:string; settings_json:string; name:string; line_user_id:string; channel_access_token:string; channel_access_token_encrypted:string|null };
const DAY=86_400_000;
export function stampReminderAt(expiry:string,kind:VisitStampSettings['expiryReminder']):string|null {
  if(!kind||kind==='none')return null;
  if(kind==='month_before')return stampExpiry(expiry,-1,true);
  const days={day_before:1,three_days_before:3,week_before:7,two_weeks_before:14}[kind];
  return new Date(Date.parse(expiry)-days*DAY).toISOString();
}
export function stampReminderText(name:string,expiry:string):string {
  const date=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'long',day:'numeric'}).format(new Date(expiry));
  return `「${name}」の有効期限は${date}です。期限までにスタンプ・特典をご利用ください。`;
}

/** 共通の通知台帳を使う。財布と期限で一意、期限が伸びたら別の通知になる。 */
export async function processVisitStampReminders(db:D1Database,options:{now:Date;proxyBaseUrl:string;proxyDispatch?:HarnessProxyDispatch}) {
  const now=options.now.toISOString();let sent=0,failed=0;
  const rows=(await db.prepare(`SELECT w.card_id,w.friend_id,w.expires_at,c.settings_json,c.name,f.line_account_id,f.line_platform_user_id AS line_user_id,
    a.channel_access_token,a.channel_access_token_encrypted FROM visit_stamp_wallets w
    JOIN visit_stamp_cards c ON c.id=w.card_id JOIN friends f ON f.id=w.friend_id JOIN line_accounts a ON a.id=f.line_account_id
    JOIN visit_stamp_card_accounts ca ON ca.card_id=w.card_id AND ca.line_account_id=a.id
    WHERE c.active=1 AND w.expires_at IS NOT NULL AND julianday(w.expires_at)>julianday(?) AND f.is_following=1
    AND json_extract(c.settings_json,'$.expiryReminder') IS NOT NULL AND json_extract(c.settings_json,'$.expiryReminder')<>'none'
    AND ${activeTenantLineAccountSql('a.id')}
    AND julianday(?) >= CASE json_extract(c.settings_json,'$.expiryReminder')
      WHEN 'day_before' THEN julianday(w.expires_at)-1 WHEN 'three_days_before' THEN julianday(w.expires_at)-3
      WHEN 'week_before' THEN julianday(w.expires_at)-7 WHEN 'two_weeks_before' THEN julianday(w.expires_at)-14
      WHEN 'month_before' THEN julianday(date(w.expires_at,'+9 hours','start of month','-1 month',
        '+'||(MIN(CAST(strftime('%d',w.expires_at,'+9 hours') AS INTEGER),CAST(strftime('%d',date(w.expires_at,'+9 hours','start of month','-1 day')) AS INTEGER))-1)||' days')
        ||strftime('T%H:%M:%f',w.expires_at,'+9 hours'),'-9 hours') END
    AND NOT EXISTS(SELECT 1 FROM notification_instances i JOIN notification_deliveries d ON d.instance_id=i.id
      WHERE i.source_event_type='visit_stamp_expiry' AND i.source_event_id=w.card_id||':'||w.friend_id||':'||w.expires_at
      AND d.status IN ('provider_accepted','failed')) ORDER BY w.expires_at,w.card_id,w.friend_id LIMIT 500`).bind(now,now).all<Candidate>()).results;
  for(const row of rows){
    const settings=JSON.parse(row.settings_json) as VisitStampSettings;
    if(settings.expiryBasis==='none'||settings.expiryMonths===null)continue;
    const due=stampReminderAt(row.expires_at,settings.expiryReminder);
    if(!due||Date.parse(due)>options.now.getTime())continue;
    if(!await featureJobCanRun(db,{accountId:row.line_account_id,featureId:'visit_stamps',job:'visit stamp expiry'})
      ||await isOperationCapabilityStopped(db,row.line_account_id,'reminder_dispatch'))continue;
    const key=`visit-stamp-expiry:${row.card_id}:${row.friend_id}:${row.expires_at}`;
    const source=`${row.card_id}:${row.friend_id}:${row.expires_at}`,instanceId=crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO notification_instances(id,line_account_id,audience_type,source_event_type,source_event_id,dedupe_key,created_at,updated_at)
        VALUES(?,?,'customer','visit_stamp_expiry',?,?,?,?)`).bind(instanceId,row.line_account_id,source,key,now,now),
      db.prepare(`INSERT OR IGNORE INTO notification_deliveries(id,line_account_id,instance_id,audience_type,recipient_type,recipient_id,channel,idempotency_key,queued_at,updated_at)
        SELECT ?,?,id,'customer','friend',?,'line',?,?,? FROM notification_instances WHERE line_account_id=? AND dedupe_key=?`)
        .bind(crypto.randomUUID(),row.line_account_id,row.friend_id,key,now,now,row.line_account_id,key),
    ]);
    // 送信リースを一文で取る。応答不明は同じLINE再試行キーで再送するが、24時間を超えると二重送信を避けて止める。
    const delivery=await db.prepare(`UPDATE notification_deliveries SET attempts=attempts+1,status='retry_wait',retryable=1,next_retry_at=?,updated_at=?
      WHERE line_account_id=? AND idempotency_key=? AND status IN ('pending','retry_wait')
      AND (next_retry_at IS NULL OR julianday(next_retry_at)<=julianday(?)) AND julianday(queued_at)>julianday(?)-23.0/24
      RETURNING id,instance_id,attempts`).bind(new Date(options.now.getTime()+60_000).toISOString(),now,row.line_account_id,key,now,now)
      .first<{id:string;instance_id:string;attempts:number}>();
    if(!delivery){await db.prepare(`UPDATE notification_deliveries SET status='failed',retryable=0,error_code='retry_window_elapsed',updated_at=?
      WHERE line_account_id=? AND idempotency_key=? AND status IN ('pending','retry_wait') AND julianday(queued_at)<=julianday(?)-23.0/24`).bind(now,row.line_account_id,key,now).run();continue;}
    try{
      const token=await resolveLineCredential(row.channel_access_token_encrypted,row.channel_access_token,{lineAccountId:row.line_account_id,field:'channel_access_token'});
      if(!await featureJobCanRun(db,{accountId:row.line_account_id,featureId:'visit_stamps',job:'visit stamp expiry'})
        ||await isOperationCapabilityStopped(db,row.line_account_id,'reminder_dispatch'))continue;
      const live=await db.prepare(`SELECT 1 FROM visit_stamp_wallets w JOIN visit_stamp_cards c ON c.id=w.card_id
        JOIN friends f ON f.id=w.friend_id WHERE w.card_id=? AND w.friend_id=? AND w.expires_at=? AND c.active=1
        AND c.settings_json=? AND f.is_following=1 AND f.line_account_id=? AND f.line_platform_user_id=? AND ${activeTenantLineAccountSql('f.line_account_id')}`)
        .bind(row.card_id,row.friend_id,row.expires_at,row.settings_json,row.line_account_id,row.line_user_id).first();
      if(!live)continue;
      const accepted=await pushViaHarnessProxy(options.proxyBaseUrl,token,row.line_user_id,[{type:'text',text:stampReminderText(row.name,row.expires_at)}],delivery.id,options.proxyDispatch,'reminder_dispatch');
      await db.batch([
        db.prepare(`UPDATE notification_deliveries SET status='provider_accepted',retryable=0,accepted_at=?,provider_request_id=?,updated_at=? WHERE id=? AND attempts=?`)
          .bind(now,accepted.requestId,now,delivery.id,delivery.attempts),
        db.prepare(`UPDATE notification_instances SET status='completed',updated_at=? WHERE id=?`).bind(now,delivery.instance_id),
      ]);sent++;
    }catch(error){
      const status=(error as {status?:number}).status;
      const retry=!status||status===429||status>=500;
      await db.prepare(`UPDATE notification_deliveries SET status=?,retryable=?,error_code=?,updated_at=? WHERE id=? AND attempts=?`)
        .bind(retry?'retry_wait':'failed',retry?1:0,'line_delivery_failed',now,delivery.id,delivery.attempts).run();failed++;
    }
  }
  return {sent,failed};
}
