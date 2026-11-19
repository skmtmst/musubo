const store={name:'storeId',in:'path',required:true,schema:{type:'string'}};
const account={name:'account_id',in:'query',required:true,schema:{type:'string'}};
const requestId={name:'requestId',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const result={'200':{description:'予約版と本人を確認した結果'},'201':{description:'開始承認を申請した。送信は承認後'},'400':{description:'入力の型・時刻・版が不正'},'401':{description:'未認証'},'403':{description:'権限・取消期限を満たさない'},'404':{description:'本人・店舗・予約が対象範囲にない'},'409':{description:'予約版・起点版・公開版・返事・承認の競合'}};
const json=(properties:Record<string,unknown>,required:string[])=>({required:true,content:{'application/json':{schema:{type:'object',properties,required}}}});
const version={type:'integer',minimum:1};
const binding={expectedVersion:version,trigger:{type:'string',enum:['reservation_created','reservation_24h','reservation_2h','post_visit','review_request','waitlist_invited','anniversary_before']},offsetMinutes:{type:'integer'},enabled:{type:'boolean'}};
const edit={parameters:[account,store,{name:'stepId',in:'path',required:true,schema:{type:'string'}}],requestBody:json(binding,Object.keys(binding)),responses:result};
export const restaurantFollowupPaths={
 '/api/restaurant-test/followups/{storeId}':{get:{summary:'店の共通フォロー・起点・予約別の仕事を読む',parameters:[account,store],responses:result}},
 '/api/restaurant-test/followups/{storeId}/bindings/{stepId}':{
  post:{summary:'共通の行へ予約の起点を結ぶ（管理者）',...edit},
  patch:{summary:'起点の時刻・停止を版付きで変更（管理者）',...edit},
  delete:{summary:'起点を解除して旧承認を無効にする（管理者）',...edit,requestBody:json({expectedVersion:version,trigger:binding.trigger},['expectedVersion','trigger'])},
 },
 '/api/restaurant-test/followups/{storeId}/steps/{stepId}/messages':{put:{summary:'共通フォローの1つの行へ複数吹き出しを版付き保存し、旧承認を無効にする',parameters:[account,store,{name:'stepId',in:'path',required:true,schema:{type:'string'}}],requestBody:json({expectedVersion:version,messageBubbles:{type:'array',minItems:1,maxItems:5,items:{type:'object'}}},['expectedVersion','messageBubbles']),responses:{...result,'422':{description:'吹き出しの内容が不正'}}}},
 '/api/restaurant-test/followups/{storeId}/request-start':{post:{summary:'公開版と起点の版で本送信の承認を申請',parameters:[account,store],requestBody:json({expectedVersion:version},['expectedVersion']),responses:result}},
 '/api/restaurant-test/followups/{storeId}/stop':{post:{summary:'本送信を停止し旧承認を無効にする',parameters:[account,store],responses:result}},
 '/api/restaurant-test/followups/{storeId}/review-history':{get:{summary:'LINEの口コミ依頼履歴。実口コミの由来を推測しない',parameters:[account,store],responses:result}},
 '/api/restaurant-test/reservations/{id}':{get:{summary:'登録されたコースアレルゲンを含む予約詳細（安全判定なし）',parameters:[account,{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:result},patch:{summary:'既存の予約変更を予約版・店舗・空きの検査で保存する',parameters:[account,{name:'id',in:'path',required:true,schema:{type:'string'}}],requestBody:json({expectedVersion:version,startsAt:{type:'string',format:'date-time'},endsAt:{type:'string',format:'date-time'},guestCount:{type:'integer',minimum:1},tableId:{type:['string','null']},note:{type:['string','null']},status:{type:'string',enum:['pending','confirmed','seated','visited','cancelled','no_show']},cancellationCause:{type:'string',enum:['store','customer'],description:'押さえの解除を除く取消では必須'}},['expectedVersion']),responses:result}},
 '/api/restaurant-test/reservations/{id}/confirmations':{get:{summary:'前日の返事と予約版を読む',parameters:[account,{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:result}},
 '/api/liff/restaurant/confirmations/{requestId}/respond':{post:{summary:'検証済みLIFF本人として前日の案内へ返事する',security:[],description:'管理用API鍵は不要。LINEのIDトークンをAuthorization: Bearerで渡し、本人・所属・予約版を検証する。',parameters:[requestId,{name:'Authorization',in:'header',required:true,schema:{type:'string'},description:'Bearer LINE ID token'},{name:'liffId',in:'query',required:true,schema:{type:'string'}}],requestBody:json({expectedVersion:version,response:{type:'string',enum:['going','change_requested','cancel']}},['expectedVersion','response']),responses:result}},
};
