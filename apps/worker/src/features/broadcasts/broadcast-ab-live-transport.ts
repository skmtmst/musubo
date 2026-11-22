import type {Env} from '../../worker-env.js';
import type {AbLiveTransmit} from './broadcast-ab-live.js';
import {liveTestAudience} from './broadcast-ab-live.js';
import {trackAbLiveMessages} from './broadcast-ab-live-links.js';
import {activeTenantLineAccountSql,isOperationCapabilityStopped,resolveLineCredential} from '@line-crm/db';
import {getSendPermissionForAccount} from '../../services/send-entitlements.js';
import {featureJobCanRun} from '../../services/feature-enforcement.js';
import {pushViaHarnessProxy} from '../../services/line-proxy-send.js';
import {dispatchLineProxyLocally} from '../../services/local-line-proxy.js';
import {NotificationDeliveryBlocked} from '../../services/recorded-notification-send.js';
import {broadcastQuietHoursShift} from '../../services/gap-send-preview.js';

/** テスト・残りの両方で、送信直前に同じ条件を確かめる。 */
export function createStagingAbTransmit(env:Env['Bindings'],id:string,accountId:string):AbLiveTransmit{
 return async input=>{
  if(env.DEPLOY_ENV!=='staging'||env.AB_LIVE_DELIVERY_ENABLED!=='true'||!(await getSendPermissionForAccount(env.DB,accountId)).allowed||await isOperationCapabilityStopped(env.DB,accountId,'broadcast_dispatch')||!await featureJobCanRun(env.DB,{accountId,featureId:'broadcasts',job:'broadcast deliveries'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
  if(!account)throw new NotificationDeliveryBlocked('account_unavailable');
  const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
  if(!token)throw new NotificationDeliveryBlocked('account_unavailable');
  const current=await liveTestAudience(env.DB,id);
  const friend=await env.DB.prepare('SELECT line_user_id FROM friends WHERE id=? AND line_account_id=?').bind(input.friendId,accountId).first<{line_user_id:string|null}>();
  const active=await env.DB.prepare("SELECT 1 FROM broadcasts WHERE id=? AND stopped_at IS NULL").bind(id).first();
  if(!active||!(await getSendPermissionForAccount(env.DB,accountId)).allowed||await isOperationCapabilityStopped(env.DB,accountId,'broadcast_dispatch')||!await featureJobCanRun(env.DB,{accountId,featureId:'broadcasts',job:'broadcast deliveries'}))throw new NotificationDeliveryBlocked('sending_stopped');
  if(await broadcastQuietHoursShift(env.DB,accountId,new Date().toISOString()))throw new NotificationDeliveryBlocked('quiet_hours');
  if(!current.ids.includes(input.friendId)||friend?.line_user_id!==input.to[0])throw new NotificationDeliveryBlocked('recipient_changed');
  const workerUrl=env.WORKER_PUBLIC_URL||env.WORKER_URL;if(!workerUrl)throw new NotificationDeliveryBlocked('tracking_url_unavailable');
  const messages=await trackAbLiveMessages(env.DB,{broadcastId:id,variantKey:input.variantKey,accountId,friendId:input.friendId,workerUrl,messages:input.messages});
  await pushViaHarnessProxy(workerUrl,token,input.to[0],messages,input.retryKey,request=>dispatchLineProxyLocally(request,env),'broadcast_dispatch');
 };
}
