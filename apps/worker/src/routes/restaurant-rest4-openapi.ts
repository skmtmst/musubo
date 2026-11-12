const string={type:'string'};
const account={name:'account_id',in:'query',required:true,schema:string};
const liff={name:'liffId',in:'query',required:true,schema:string};
const path=(name:string)=>({name,in:'path',required:true,schema:string});
const query=(name:string)=>({name,in:'query',required:true,schema:string});
const result={'200':{description:'許可した店舗の公開情報・既存予約の結果'},'201':{description:'設定作成'},'400':{description:'入力不正'},'401':{description:'未認証'},'403':{description:'権限・本人確認・友だち追加が必要'},'404':{description:'範囲外'},'409':{description:'満席・版ずれ・案内停止'}};
const body=(properties:Record<string,unknown>,required=Object.keys(properties))=>({required:true,content:{'application/json':{schema:{type:'object',required,properties}}}});
const member={storeId:string,referralEnabled:{type:'boolean'},maxDistance:{type:'number',minimum:0,maximum:1000}};
export const restaurantRest4Paths={
 '/api/liff/restaurant/courses':{get:{summary:'同じ店舗の公開コースと所要時間（登録アレルゲンは安全の判定ではない）',security:[{liffIdToken:[]}],parameters:[liff,query('storeId')],responses:result}},
 '/api/liff/restaurant/referrals':{
  get:{summary:'満席・休業時の同人数・日時の系列店候補。顧客情報は返さない',security:[{liffIdToken:[]}],parameters:[liff,...['storeId','date','guestCount'].map(query),{name:'startsAt',in:'query',schema:{type:'string',format:'date-time'}},{name:'courseId',in:'query',schema:string}],responses:result},
  post:{summary:'案内を記録し予約先のLIFF入口を返す。別のLINEアカウントで再認証',security:[{liffIdToken:[]}],parameters:[liff],requestBody:body({storeId:string,targetStoreId:string,date:{type:'string',format:'date'},startsAt:{type:'string',format:'date-time'},guestCount:{type:'integer',minimum:1,maximum:100},courseId:{type:'string',nullable:true}},['storeId','targetStoreId','date','startsAt','guestCount']),responses:result},
 },
 '/api/liff/restaurant/form-booking':{post:{summary:'保存済みフォームの公開版から既存の席予約口へ一度だけ渡す',security:[{liffIdToken:[]}],parameters:[liff],requestBody:body({formId:string,blockId:string,submissionKey:string}),responses:result}},
 '/api/restaurant-test/store-groups':{
  get:{summary:'読めるお店だけで構成された系列店の組を読む',parameters:[account],responses:result},
  post:{summary:'案内可のお店の組を作る（owner/admin、閲覧権限は広げない）',parameters:[account],requestBody:body({name:{type:'string',maxLength:100},members:{type:'array',minItems:2,maxItems:50,items:{type:'object',required:Object.keys(member),properties:member}}}),responses:result},
 },
 '/api/restaurant-test/store-groups/{id}/members/{storeId}':{patch:{summary:'案内参加と距離を変更（owner/admin）。確認時の版を任意で指定できる',parameters:[account,path('id'),path('storeId')],requestBody:body({referralEnabled:member.referralEnabled,maxDistance:member.maxDistance,expectedVersion:{type:'integer',minimum:1}},['referralEnabled','maxDistance']),responses:result}},
 '/api/restaurant-test/stores/{id}/referral-location':{put:{summary:'確認済みの店舗の座標を登録（owner/admin）',parameters:[account,path('id')],requestBody:body({latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180},confirmed:{const:true}}),responses:result}},
};
