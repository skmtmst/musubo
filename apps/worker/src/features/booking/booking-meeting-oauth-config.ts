import type {Env} from '../../worker-env.js';
import type {ConnectionProvider} from './booking-meeting-credentials.js';
import type {MeetingOAuthConfig} from './booking-meeting-oauth-client.js';
/** 設定値は Worker の秘密設定から読み、外へ返さない。 */
export function meetingOAuthConfig(env:Env['Bindings'],provider:ConnectionProvider):MeetingOAuthConfig|null {
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_OAUTH_ENABLED!=='true'||!env.BOOKING_MEETING_OAUTH_CONFIG)return null;
 try{
  const parsed:unknown=JSON.parse(env.BOOKING_MEETING_OAUTH_CONFIG);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  const item=(parsed as Record<string,unknown>)[provider];if(!item||typeof item!=='object'||Array.isArray(item))return null;
  const config=item as Record<string,unknown>;if(typeof config.clientId!=='string'||!config.clientId||typeof config.clientSecret!=='string'||!config.clientSecret)return null;
  const origin=new URL(env.WORKER_URL);if(origin.protocol!=='https:'||origin.username||origin.password)return null;
  return {provider,clientId:config.clientId,clientSecret:config.clientSecret,redirectUri:new URL('/api/booking/admin/meeting-oauth/callback',origin).toString()};
 }catch{return null;}
}
