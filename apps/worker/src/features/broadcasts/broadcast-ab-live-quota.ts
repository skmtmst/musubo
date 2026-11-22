import type {Env} from '../../worker-env.js';
import {activeTenantLineAccountSql,resolveLineCredential} from '@line-crm/db';
import {fetchQuotaDetails,tryReserveQuotaSlot} from './broadcast-quota-guard.js';
import {GapError} from '../../services/gap-common.js';

/** 確認できない送信枠は足りるものとして扱わない。 */
export async function reserveAbLiveQuota(env:Env['Bindings'],id:string,accountId:string,count:number){
 if(!Number.isSafeInteger(count)||count<0)throw new GapError('SEND_PREVIEW_CHANGED',409);
 if(count===0)return;
 const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
 if(!account)throw new GapError('account_unavailable',409);
 const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
 if(!token)throw new GapError('account_unavailable',409);
 const quota=await fetchQuotaDetails(token);
 if(quota.unlimited)return;
 if(quota.limit===null||quota.used===null)throw new GapError('ab_quota_unknown',409);
 if(quota.limit-quota.used<count||!await tryReserveQuotaSlot(env.DB,accountId,id,count,quota.used,quota.limit,{replaceOwn:true}))throw new GapError('ab_quota_exceeded',409);
}
