import type { Env } from '../worker-env.js';
import {GapError} from './gap-common.js';
export type AccountAiFeature='banner'|'google_review';
export const AI_DISCLOSURE_VERSION='2026-10-16';
export const AI_DISCLOSURE='会話や入力した文章・画像がAIの提供会社に送られることに同意します';
/** 運用者が設定する配備変数を使い、環境が未指定・不明なら閉じる。 */
export function g2OpenAiAvailable(env:Pick<Env['Bindings'],'DEPLOY_ENV'|'G2_OPENAI_ENABLED'>){
 return env.G2_OPENAI_ENABLED==='true'&&['local','test','development','staging'].includes(env.DEPLOY_ENV??'');
}
export function accountAiAlwaysOn(_env?:Pick<Env['Bindings'],'DEPLOY_ENV'>){
 return true;
}
export async function accountAiSetting(db:D1Database,account:string,feature:AccountAiFeature,env?:Pick<Env['Bindings'],'DEPLOY_ENV'>){
 const row=await db.prepare('SELECT enabled,version,consent_by,consent_at,disclosure_version FROM account_ai_features WHERE account_id=? AND feature=?').bind(account,feature).first<{enabled:number;version:number;consent_by:string|null;consent_at:string|null;disclosure_version:string|null}>();
 const alwaysOn=accountAiAlwaysOn(env);
 return {feature,enabled:alwaysOn||row?.enabled===1,alwaysOn,version:row?.version??0,consentBy:row?.consent_by??null,consentAt:row?.consent_at??null,disclosureVersion:row?.disclosure_version??null};
}
/** キュー投入後の利用停止も守るため、バナーの永続処理側でも確認する。 */
export async function requireAccountAi(db:D1Database,account:string|null|undefined,_feature:AccountAiFeature,tenant?:string,_env?:Pick<Env['Bindings'],'DEPLOY_ENV'>){
 if(!account)throw new GapError('ai_disabled',409);
 const active=await db.prepare(`SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE a.id=? AND a.is_active=1 AND t.status='active' AND (? IS NULL OR a.tenant_id=?)`).bind(account,tenant??null,tenant??null).first();
 if(!active)throw new GapError('ai_disabled',409);
}
