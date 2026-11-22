import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getTemplateById } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { resolveAutoReplyContent } from '../features/auto-replies/auto-reply.js';
import { buildStepMessages } from '../features/scenarios/scenario-test-send.js';
import { buildMessage } from '../services/line-message.js';
import { parseBroadcastMessageParts } from '../features/broadcasts/broadcast-message-set.js';

const gates = vi.hoisted(() => ({allowed:true}));
vi.mock('../services/file-scan.js', () => ({checkKeyGate: async()=>gates,checkMediaGate:async()=>gates}));
vi.mock('../features/media/media-metadata.js', () => ({imageDimensions:()=>({width:1040,height:520})}));
vi.mock('../services/account-access.js', () => ({canAccessAllLineAccounts:async()=>true,getVisibleLineAccountScope:async()=>({allowedAccountIds:['a'],canSeeUnassigned:false})}));
import { templates } from './templates.js';

let store: SqliteD1;
let role: 'owner' | 'staff' = 'owner';
const videoKey='broadcast-media/11111111-1111-4111-8111-111111111111.mp4';
const imageKey='broadcast-media/22222222-2222-4222-8222-222222222222.jpg';
const videoUrl=`https://worker.example/images/${videoKey}`;
const imageUrl=`https://worker.example/images/${imageKey}`;
const transforms=vi.fn();
const put=vi.fn();
let videoSize=200*1024*1024;
let previewSize=1024;
function payload(button=true) {return {baseUrl:'',baseSize:{width:1040,height:520},actions:[],altText:'新しい動画が届きました',video:{originalContentUrl:videoUrl,previewImageUrl:imageUrl,area:{x:0,y:0,width:1040,height:520},...(button?{externalLink:{label:'詳しく見る',linkUri:'https://example.com/menu'}}:{})}};}
function bindings() {
  return {DB:store.db,WORKER_URL:'https://worker.example',IMAGES:{head:async(key:string)=>({size:key===videoKey?videoSize:previewSize,httpMetadata:{contentType:key===videoKey?'video/mp4':'image/jpeg'}}),get:async()=>({size:previewSize,arrayBuffer:async()=>new Uint8Array([255,216,255]).buffer}),put},CF_IMAGES:{input:()=>({transform:(options:unknown)=>{transforms(options);return{output:async()=>({image:()=>new Uint8Array([255,216,255])})}}})}} as unknown as Env['Bindings'];
}
function app(){const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',{id:'owner',name:'Owner',role,readOnly:role==='staff'});await next()});app.route('/',templates);return app;}
async function request(method:string,path:string,body?:unknown){return app().request(`https://worker.example${path}`,{method,headers:{'content-type':'application/json', 'Idempotency-Key':'publish-1'},...(body?{body:JSON.stringify(body)}:{})},bindings());}
beforeEach(()=>{
  store=createTestD1();role='owner';gates.allowed=true;videoSize=200*1024*1024;previewSize=1024;vi.clearAllMocks();
  store.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','channel-a','A','test','test')");
  store.raw.prepare(`INSERT INTO broadcast_media_upload_sessions(id,line_account_id,created_by,r2_key,public_key,filename,mime_type,expected_size,expires_at,completed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('s','a','owner','temp',videoKey,'video.mp4','video/mp4',videoSize,'2099-01-01','2026-01-01','2026-01-01');
});
afterEach(()=>store.raw.close());
async function create(button=true){return request('POST','/api/templates',{accountId:'a',name:'動画',messageType:'imagemap',messageContent:JSON.stringify(payload(button))});}

describe('リッチビデオの保存・公開・送信',()=>{
  it.each([true,false])('ボタン=%s:実DBで保存→読み直し→更新→公開→同じ動画付きimagemapを送る',async(button)=>{
    const response=await create(button);expect(response.status).toBe(201);
    const body=await response.json() as {data:{id:string}};const id=body.data.id;
    const got=await (await request('GET',`/api/templates/${id}`)).json() as {data:{messageContent:string;publishedVersion:number;draftRevision:number}};
    const saved=JSON.parse(got.data.messageContent);
    expect(saved.baseUrl).toMatch(/^https:\/\/worker.example\/images\/imagemaps\//);
    expect(saved.baseSize).toEqual({width:1040,height:520});expect(transforms.mock.calls.map(c=>c[0].width)).toEqual([240,300,460,700,1040]);
    expect(saved.video.externalLink).toEqual(button?{label:'詳しく見る',linkUri:'https://example.com/menu'}:undefined);
    expect((await request('PUT',`/api/templates/${id}`,{expectedVersion:got.data.publishedVersion,expectedDraftRevision:got.data.draftRevision,messageType:'imagemap',messageContent:JSON.stringify({...payload(button),altText:'変更した通知'})})).status).toBe(200);
    const draft=await getTemplateById(store.db,id);expect(draft?.message_content).not.toContain('変更した通知');
    expect((await request('POST',`/api/templates/${id}/publish`,{expectedVersion:0,expectedDraftRevision:2})).status).toBe(200);
    const live=await getTemplateById(store.db,id);const message=buildMessage(live!.message_type,live!.message_content);
    expect(message).toMatchObject({type:'imagemap',altText:'変更した通知',actions:[],video:{originalContentUrl:videoUrl,previewImageUrl:imageUrl,area:{x:0,y:0,width:1040,height:520}}});
    const parts=parseBroadcastMessageParts({messageType:'imagemap',messageContent:live!.message_content,messageBubbles:[{id:'r',type:'rich_video',content:JSON.parse(live!.message_content)}]});
    expect(buildMessage(parts[0].messageType,parts[0].messageContent,parts[0].altText)).toEqual(message);
    const auto=await resolveAutoReplyContent(store.db,{template_id:id,response_type:'text',response_content:'控え'});
    expect(buildMessage(auto.messageType,auto.content)).toEqual(message);
    insertFriend(store.raw,'f',{line_account_id:'a',line_user_id:'U1'});
    const scenario=await buildStepMessages(store.db,{id:'s',template_id:id,message_type:'text',message_content:'控え'} as never,'f','a');
    expect(scenario).toEqual([message]);
  });
  it.each(['http://example.com','javascript:alert(1)','https://user:password@example.com','https://','https://example.com/ a'])('不正URL %s を変換前に拒否する',async(url)=>{
    const p=payload();p.video.externalLink!.linkUri=url;
    const res=await request('POST','/api/templates',{accountId:'a',name:'動画',messageType:'imagemap',messageContent:JSON.stringify(p)});expect(res.status).toBe(422);expect(put).not.toHaveBeenCalled();
  });
  it.each([
    {altText:undefined}, {altText:''}, {altText:'あ'.repeat(1501)},
    {video:{...payload().video,area:{x:0,y:0,width:1041,height:520}}},
    {video:{...payload().video,externalLink:{label:'あ'.repeat(31),linkUri:'https://example.com'}}},
    {video:{...payload().video,previewImageUrl:'http://example.com/image.jpg'}},
  ])('通知・再生範囲・ボタン・画像URLの誤りを保存しない %j',async(patch)=>{
    const res=await request('POST','/api/templates',{accountId:'a',name:'動画',messageType:'imagemap',messageContent:JSON.stringify({...payload(),...patch})});
    expect(res.status).toBe(422);expect(put).not.toHaveBeenCalled();
  });
  it('他アカウントの動画は拒否する',async()=>{store.raw.prepare('UPDATE broadcast_media_upload_sessions SET line_account_id=?').run('other');expect((await create()).status).toBe(422);expect(put).not.toHaveBeenCalled()});
  it('動画200MB超・プレビュー1MB超・検査未完了は拒否する',async()=>{videoSize++;expect((await create()).status).toBe(422);videoSize--;previewSize=1024*1024+1;expect((await create()).status).toBe(422);previewSize=1024;gates.allowed=false;expect((await create()).status).toBe(422)});
  it('閲覧のみでは作成・更新できない',async()=>{const res=await create();const {data}=await res.json() as {data:{id:string}};role='staff';expect((await create()).status).toBe(403);expect((await request('PUT',`/api/templates/${data.id}`,{name:'変更'})).status).toBe(403);expect((await request('GET',`/api/templates/${data.id}`)).status).toBe(200)});
});
