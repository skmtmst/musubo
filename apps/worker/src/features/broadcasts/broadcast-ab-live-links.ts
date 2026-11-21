import type {Message} from '@line-crm/line-sdk';
import {getOrCreateAutoTrackedLink} from '@line-crm/db';
import {resolveTrackedLinkBaseUrl} from '../../lib/link-base-url.js';
import {issueTrackedLinkIdentity} from '../../services/tracked-link-identity.js';
import {GapError} from '../../services/gap-common.js';

export function validateAbLiveUrls(messages:Message[]):void {
 for(const message of messages){
  if(message.type!=='text')continue;
  for(const match of message.text.matchAll(/https?:\/\/[^\s"'<>\])}]+/g)){
   const raw=match[0].replace(/[.,;:!?)]+$/,'');
   let url:URL;try{url=new URL(raw);}catch{throw new GapError('ab_tracking_unsupported',409);}
   if(url.hostname==='line.me'||url.hostname.endsWith('.line.me'))throw new GapError('ab_tracking_unsupported',409);
  }
 }
}

/** 案・配信単位で異なるリンクを使い、押した人は署名付きの識別子で確かめる。 */
export async function trackAbLiveMessages(db:D1Database,input:{broadcastId:string;variantKey:'A'|'B';accountId:string;friendId:string;workerUrl:string;messages:Message[]}):Promise<Message[]>{
 const base=await resolveTrackedLinkBaseUrl(db,input.workerUrl),out:Message[]=[];
 for(const message of input.messages){
  if(message.type!=='text'){out.push(message);continue;}
  let text=message.text;
  const matches=[...text.matchAll(/https?:\/\/[^\s"'<>\])}]+/g)];
  for(const match of matches){
   const raw=match[0],url=raw.replace(/[.,;:!?)]+$/,'');
   let parsed:URL;try{parsed=new URL(url);}catch{throw new GapError('ab_tracking_unsupported',409);}
   if(parsed.hostname==='line.me'||parsed.hostname.endsWith('.line.me')||url.startsWith(`${base}/t/`))throw new GapError('ab_tracking_unsupported',409);
   const link=await getOrCreateAutoTrackedLink(db,{originalUrl:url,lineAccountId:input.accountId,dedupScope:`ab-live:${input.broadcastId}:${input.variantKey}`});
   const identity=await issueTrackedLinkIdentity(db,link,input.friendId);
   if(!identity)throw new GapError('ab_tracking_identity_unavailable',409);
   const dest=new URL(`${base}/t/${link.short_code??link.id}`);dest.searchParams.set('identity',identity);
   text=text.replace(url,dest.toString());
  }
  if(text.length>5000)throw new GapError('ab_tracked_message_too_long',409);
  out.push({...message,text});
 }
 return out;
}
