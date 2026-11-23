import type { Message } from '@line-crm/line-sdk';
import type { Env } from '../../worker-env.js';
import { getAccountTimeZone, tzDateStr, tzHHMM } from '../../services/availability.js';
import { NotificationDeliveryBlocked, NotificationDeliveryIncomplete, sendRecordedNotification } from '../../services/recorded-notification-send.js';

type Audience = 'friend' | 'store';
type Recipient = { account_id:string; friend_id:string; line_user_id:string; audience:Audience };
type Transmit = (input:{cycleId:string;audience:Audience;accountId:string;friendId:string;to:string;messages:Message[];retryKey:string})=>Promise<void>;

/** 対象者・同意・テスト宛先・停止状態を送信直前にも読み直す。 */
async function eligible(db:D1Database, cycle:string, audience:Audience, now:Date):Promise<Recipient|null> {
  const row = await db.prepare(`SELECT n.account_id,f.id friend_id,f.line_user_id,n.audience
    FROM booking_monthly_failure_notices n JOIN booking_monthly_cycles y ON y.id=n.cycle_id AND y.state='exhausted'
    JOIN booking_monthly_contracts c ON c.id=y.contract_id AND c.account_id=n.account_id AND c.friend_id=n.friend_id AND c.state='stopped'
    JOIN line_accounts la ON la.id=n.account_id AND la.is_active=1 AND la.archived_at IS NULL
    JOIN tenants t ON t.id=la.tenant_id AND t.status='active'
    JOIN friends f ON f.line_account_id=n.account_id AND f.is_following=1 AND f.is_hidden=0 AND length(trim(f.line_user_id))>0
    WHERE n.cycle_id=? AND n.audience=? AND (n.audience='friend' AND f.id=n.friend_id OR n.audience='store' AND EXISTS(
      SELECT 1 FROM staff_members s WHERE s.line_user_id=f.line_user_id AND s.is_active=1 AND s.tenant_id=la.tenant_id
      AND (COALESCE(s.account_scope,'all')='all' OR s.assigned_line_account_id=la.id OR EXISTS(SELECT 1 FROM staff_account_scopes sc WHERE sc.staff_id=s.id AND sc.line_account_id=la.id))))
    AND EXISTS(SELECT 1 FROM account_settings settings, json_each(CASE WHEN json_valid(settings.value) THEN CASE WHEN json_type(settings.value)='array' THEN settings.value ELSE '[]' END ELSE '[]' END) recipient
      WHERE settings.line_account_id=n.account_id AND settings.key='test_recipients' AND recipient.type='text' AND recipient.value=f.id
      AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(settings.value) THEN CASE WHEN json_type(settings.value)='array' THEN settings.value ELSE '[]' END ELSE '[]' END) invalid WHERE invalid.type!='text' OR length(trim(invalid.value))=0))
    AND NOT EXISTS(SELECT 1 FROM friend_delivery_consents d WHERE d.line_account_id=n.account_id AND d.friend_id=f.id AND d.purpose IN ('transaction','transactional','reservation','booking_reminders') AND d.state!='granted')
    ORDER BY f.id LIMIT 1`).bind(cycle,audience).first<Recipient>();
  if (!row) return null;
  const hour = tzHHMM(await getAccountTimeZone(db,row.account_id),now);
  return hour >= '08:00' && hour < '21:00' ? row : null;
}

export async function processMonthlyFailureNotices(db:D1Database, now:Date, transmit:Transmit, clock:()=>Date = ()=>new Date()) {
  const notices=(await db.prepare(`SELECT n.cycle_id,n.audience FROM booking_monthly_failure_notices n
    WHERE NOT EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='monthly-failure:'||n.cycle_id||':'||n.audience AND o.status IN ('succeeded','unknown','in_progress'))
    ORDER BY n.created_at,n.cycle_id,n.audience LIMIT 100`).all<{cycle_id:string;audience:Audience}>()).results;
  let processed=0;
  for (const notice of notices) {
    const row=await eligible(db,notice.cycle_id,notice.audience,now); if(!row)continue;
    const day=tzDateStr('Asia/Tokyo',now);
    const cap=await db.prepare(`INSERT INTO booking_monthly_notice_cap(cycle_id,audience,account_id,friend_id,day_jst,reserved_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(notice.cycle_id,notice.audience,row.account_id,row.friend_id,day,now.toISOString()).run();
    if(cap.meta.changes!==1 && !await db.prepare(`SELECT 1 FROM booking_monthly_notice_cap
      WHERE cycle_id=? AND audience=? AND account_id=? AND friend_id=? AND day_jst=?`)
      .bind(notice.cycle_id,notice.audience,row.account_id,row.friend_id,day).first())continue;
    const messages:Message[]=[{type:'text',text:row.audience==='friend'?'月謝のお支払いを確認できなかったため、利用を停止しました。お店へお問い合わせください。':'月謝のお支払いを確認できず、利用を停止しました。管理画面でご確認ください。'}];
    try {
      await sendRecordedNotification(db,{sourceId:`monthly-failure:${notice.cycle_id}:${notice.audience}`,channel:'line',recipient:row.friend_id,lineAccountId:row.account_id,payload:JSON.stringify(messages),send:async retryKey=>{
        const fresh=await eligible(db,notice.cycle_id,notice.audience,clock());
        if(!fresh||fresh.friend_id!==row.friend_id||fresh.line_user_id!==row.line_user_id)throw new NotificationDeliveryBlocked('monthly_notice_changed');
        await transmit({cycleId:notice.cycle_id,audience:notice.audience,accountId:row.account_id,friendId:row.friend_id,to:row.line_user_id,messages,retryKey});
      }});
      processed++;
    } catch(error) { if(!(error instanceof NotificationDeliveryIncomplete))throw error; }
  }
  return {processed};
}

export async function processStagingMonthlyFailureNotices(env:Env['Bindings'],now:Date) {
  if(env.DEPLOY_ENV!=='staging'||env.MONTHLY_FAILURE_STAGING_DELIVERY_ENABLED!=='true')return {processed:0};
  const {activeTenantLineAccountSql,isOperationCapabilityStopped,resolveLineCredential}=await import('@line-crm/db');
  const {getSendPermissionForAccount}=await import('../../services/send-entitlements.js');
  const {featureJobCanRun}=await import('../../services/feature-enforcement.js');
  const {pushViaHarnessProxy}=await import('../../services/line-proxy-send.js');
  const {dispatchLineProxyLocally}=await import('../../services/local-line-proxy.js');
  return processMonthlyFailureNotices(env.DB,now,async input=>{
    if(!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'reminder_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'booking',job:'monthly failure notice'}))throw new NotificationDeliveryBlocked('sending_stopped');
    const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(input.accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
    if(!account)throw new NotificationDeliveryBlocked('account_unavailable');
    const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:input.accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    if(!token||!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'reminder_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'booking',job:'monthly failure notice'}))throw new NotificationDeliveryBlocked('sending_stopped');
    const fresh=await eligible(env.DB,input.cycleId,input.audience,new Date());
    const cap=await env.DB.prepare('SELECT 1 FROM booking_monthly_notice_cap WHERE cycle_id=? AND audience=? AND account_id=? AND friend_id=? AND day_jst=?')
      .bind(input.cycleId,input.audience,input.accountId,input.friendId,tzDateStr('Asia/Tokyo',new Date())).first();
    if(!cap||!fresh||fresh.account_id!==input.accountId||fresh.friend_id!==input.friendId||fresh.line_user_id!==input.to)throw new NotificationDeliveryBlocked('monthly_notice_changed');
    await pushViaHarnessProxy(env.WORKER_PUBLIC_URL||env.WORKER_URL||'https://worker.invalid',token,input.to,input.messages,input.retryKey,request=>dispatchLineProxyLocally(request,env));
  });
}
