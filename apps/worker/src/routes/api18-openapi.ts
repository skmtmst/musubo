import { hqAuthoringPaths } from './hq-authoring-openapi.js';
/** 統括の画面を店と同じ欄にするAPI。権限と未取得の意味も契約に残す。 */
type Schema=Record<string,unknown>;
const string:Schema={type:'string'},number:Schema={type:'integer',minimum:0},nullableNumber:Schema={type:['integer','null']};
const revision={type:'object',required:['expectedVersion'],properties:{expectedVersion:{type:'integer',minimum:1}}};
const version={type:'object',properties:{id:string,version:number,created_by:{type:['string','null']},creator_name:{type:['string','null']},created_at:string,
 is_draft:{type:'boolean',description:'成功した配布がない保存版は下書き'},is_current:{type:'boolean'}}};
const targetVersion={type:'object',properties:{version:nullableNumber,latestVersion:number,status:{enum:['latest','older','undistributed']},label:string}};
const folder={type:'object',properties:{id:string,name:string,revision:number,item_count:number}};
function op(summary:string,params:string[]=[],data:Schema={},body?:Schema,query:Record<string,Schema>={}) {
 return {tags:['HQ Templates','HQ Broadcasts'],summary,description:'統括全体のオーナー・管理者。閲覧のみはGETだけ利用可。別統括のデータは返さない。',
  parameters:[...params.map(name=>({name,in:'path',required:true,schema:string})),...Object.entries(query).map(([name,schema])=>({name,in:'query',schema}))],
  ...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),
  responses:{'200':{description:'処理結果。計測の未取得はnull',content:{'application/json':{schema:{type:'object',properties:{success:{const:true},data}}}}},
   '400':{description:'入力を確認'},'403':{description:'統括の権限が不足'},'404':{description:'対象がない・別統括'},'409':{description:'編集・承認・宛先条件の競合'}}};
}
export const api18Paths={
 '/api/webinars/{id}/notifications/test':{get:op('ウェビナー通知のテスト受信者と確認用情報を取得する',['id'],{type:'object',properties:{count:number,recipients:{type:'array'},token:string,confirmationId:string}})},
 ...hqAuthoringPaths,
 '/api/hq/templates/attribute-kind-counts':{get:op('友だち属性の種類別件数。情報欄・対応マークは所属未対応のためnull',[],{type:'object',properties:{tag:number,friend_field:{type:'null'},support_mark:{type:'null'}}})},
 '/api/hq/templates/{id}/versions':{get:op('ひな形の版履歴・作った人・日時・下書きか',['id'],{type:'array',items:version})},
 '/api/hq/templates/{id}/versions/compare':{get:op('2つの版の内容を比べる',['id'],{type:'object',properties:{from:{type:'object'},to:{type:'object'},changed:{type:'boolean'}}},undefined,{from:{type:'integer',minimum:1},to:{type:'integer',minimum:1}})},
 '/api/hq/templates/{id}/versions/{version}/restore':{post:op('履歴を残して選んだ内容を新しい版へ戻す。店の内容は変えない',['id','version'],{type:'object'}, {type:'object',required:['expectedRevision'],properties:{expectedRevision:{type:'integer',minimum:1}}})},
 '/api/hq/templates/{id}/received-versions':{get:op('配った先が最後に受け取った版と今の版を読む',['id'],{type:'array',items:{type:'object',properties:{accountId:string,accountName:string,receivedAt:{type:['string','null']},targetVersion}}})},
 '/api/hq/broadcasts/folders':{
  get:op('統括配信の分類と件数',[],{type:'array',items:folder}),
  post:op('統括配信の分類を作る',[],folder,{type:'object',required:['name'],properties:{name:{type:'string',maxLength:100}}})},
 '/api/hq/broadcasts/folders/{id}':{
  patch:op('統括配信の分類名を版付きで変える',['id'],folder,{...revision,required:['name','expectedVersion'],properties:{name:string,...revision.properties}}),
  delete:op('統括配信の分類を論理削除。配信の履歴は残す',['id'],{type:'object'},revision)},
 '/api/hq/broadcasts/approvals/candidates':{get:op('自分を除く統括の承認担当者',[],{type:'array',items:{type:'object',properties:{id:string,name:string,role:string,canApprove:{type:'boolean'}}}})},
 '/api/hq/broadcasts/{id}/approval':{get:op('店と同じ承認・人数・操作者の形で判定を読む',['id'],{type:'object',properties:{approval:{type:'object'},gate:{type:'object'},viewer:{type:'object'}}})},
 '/api/hq/broadcasts/{id}/approval-request':{post:op('別の統括担当者へ承認を依頼する',['id'],{type:'object'},{...revision,required:['expectedVersion','approverStaffId'],properties:{...revision.properties,approverStaffId:string,note:string}})},
 '/api/hq/broadcasts/{id}/approve':{post:op('別人が人数を確認して承認。店と同じ本人再確認が必要',['id'],{type:'object'},revision)},
 '/api/hq/broadcasts/{id}/reject':{post:op('理由を付けて差し戻す',['id'],{type:'object'},{...revision,required:['expectedVersion','reason'],properties:{...revision.properties,reason:string}})},
 '/api/hq/broadcasts/{id}/approval-cancel':{post:op('依頼した人が承認を取り消す',['id'],{type:'object'},revision)},
 '/api/hq/broadcasts/test-recipients':{get:op('統括のテスト送信で確認する宛先と照合情報',[],{type:'object',properties:{count:number,recipients:{type:'array',items:{type:'object',properties:{id:string,displayName:{type:['string','null']}}}},token:string}},undefined,{accountId:string})},
 '/api/hq/broadcasts/{id}/test-send':{post:op('対象店の設定済みテスト宛先へ全吹き出しを送る。5人まで・10秒制限',['id'],{type:'object',properties:{sent:number,failed:number}},{type:'object',required:['accountId'],properties:{accountId:string,expectedRecipientToken:string}})},
 '/api/hq/broadcasts/{id}/targets/{accountId}/recipients':{get:op('店ごとの宛先台帳をページ送りで読む',['id','accountId'],{type:'object',properties:{rows:{type:'array',items:{type:'object'}},total:number,nextCursor:{type:['string','null']}}},undefined,{cursor:number,limit:{type:'integer',minimum:1,maximum:100}})},
 '/api/hq/broadcasts/{id}/activity':{get:op('統括配信の操作記録をページ送りで読む',['id'],{type:'object'},undefined,{cursor:number,limit:{type:'integer',minimum:1,maximum:100}})},
 '/api/hq/broadcasts/{id}/export.csv':{get:{...op('店別の送信・開封・クリック・反応人数をCSVで出す。未取得は空欄',['id']),responses:{'200':{description:'数式として実行されないUTF-8 BOM付きCSV',content:{'text/csv':{schema:{type:'string'}}}},'403':{description:'統括の閲覧権限が不足'},'404':{description:'対象が見つからない'}}}},
};
