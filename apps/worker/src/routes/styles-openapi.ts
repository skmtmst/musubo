type Operation = {tags:string[]; summary:string; description:string; parameters:unknown[]; responses:Record<string,{description:string}>; security?:unknown[]; requestBody?:unknown};
const paths:Record<string,Record<string,Operation>> = {};
const definitions: Array<[string,string,string]> = [
  ["get", "/api/dashboard/style/ec-summary", "ECの注文と再購入の集計"],
  ["get", "/api/dashboard/style", "業種と設定"],
  ["put", "/api/dashboard/style", "業種と設定"],
  ["get", "/api/dashboard/style/warnings", "未設定の案内"],
  ["get", "/api/dashboard/style/starter-set", "使い始めの見本"],
  ["get", "/api/dashboard/style/template-samples", "業種別の文面見本"],
  ["get", "/api/hq/style-template-samples", "統括の業種別見本"],
  ["get", "/api/dashboard/style/resources", "参照できる素材"],
  ["put", "/api/dashboard/style/cards", "表示する情報"],
  ["delete", "/api/dashboard/style/cards", "表示する情報"],
  ["post", "/api/dashboard/style/results/{id}/audiences", "集計結果の対象者"],
  ["patch", "/api/dashboard/style/menus/{id}", "予約メニュー"],
  ["patch", "/api/dashboard/style/bookings/{id}", "予約一覧"],
  ["patch", "/api/dashboard/style/classes/{id}", "レッスン枠"],
  ["patch", "/api/dashboard/style/events/{id}", "イベント"],
  ["patch", "/api/dashboard/style/event-bookings/{id}", "イベント予約"],
  ["patch", "/api/dashboard/style/event-waitlist/{id}", "イベントの空き待ち"],
  ["get", "/api/dashboard/style/members", "会員"],
  ["put", "/api/dashboard/style/members/{friendId}", "会員"],
  ["put", "/api/dashboard/style/holidays/{date}", "休みの日"],
  ["put", "/api/dashboard/style/targets", "目標"],
  ["get", "/api/dashboard/style/analytics-settings", "集計設定"],
  ["get", "/api/hq/style-starter-sets/catalog", "初期セットで選べるカタログの版"],
  ["get", "/api/hq/style-starter-sets/catalog/{templateId}/versions/{versionId}", "選んだカタログの版の中身"],
  ["get", "/api/hq/style-starter-sets", "統括の見本セット"],
  ["put", "/api/hq/style-starter-sets/{style}", "統括の見本セット"],
  ["post", "/api/hq/style-starter-sets/{style}/preflight", "初期セットを配る前の確認"],
  ["post", "/api/hq/style-starter-sets/{style}/distribute", "初期セットを配る"],
  ["get", "/api/hq/style-starter-sets/{style}/default", "musubo の標準の初期セット"],
  ["post", "/api/hq/style-starter-sets/{style}/reset", "初期セットを標準に戻す"],
  ["post", "/api/dashboard/style/starter-items/{key}/accept-update", "本部の新しい版を取り込む"],
  ["get", "/api/hq/style-attention", "統括の要確認一覧"],
  ["post", "/api/dashboard/style/closures", "休業・貸切"],
  ["post", "/api/dashboard/style/closures/confirmation", "休業前の予約確認"],
  ["post", "/api/dashboard/style/closures/confirmed", "確認した予約に対する休業登録"],
  ["patch", "/api/dashboard/style/meet/{id}", "個別相談"],
  ["get", "/api/dashboard/style/starter-items", "登録した見本"],
  ["post", "/api/dashboard/style/starter-items/ensure", "足りない見本を入れ直す"],
  ["post", "/api/dashboard/style/activate", "見本の利用開始"],
  ["get", "/api/dashboard/style/menus/{id}", "予約メニュー"],
  ["get", "/api/dashboard/style/bookings/{id}", "予約一覧"],
  ["get", "/api/dashboard/style/classes/{id}", "レッスン枠"],
  ["patch", "/api/dashboard/style/restaurant-reservations/{id}", "席の予約"],
  ["get", "/api/dashboard/style/summary", "予約のまとめ"],
  ["get", "/api/dashboard/style/analytics", "予約の集計"],
  ["get", "/api/dashboard/style/bookings", "予約一覧"],
  ["get", "/api/dashboard/style/people", "お客さま一覧"],
  ["get", "/api/dashboard/style/schedule", "予約カレンダー"],
  ["get", "/api/liff/booking/style-readiness", "予約の準備状態"],
  ["post", "/api/liff/booking/page-views", "予約ページを開いた記録"],
 ];
for(const [method,path,summary] of definitions) {
  const liff=path.startsWith('/api/liff/');
  const parameters:unknown[]=[...path.matchAll(/\{([^}]+)\}/g)].map(match=>({name:match[1],in:'path',required:true,schema:{type:'string'}}));
  if(path.startsWith('/api/dashboard/'))parameters.push({name:'account_id',in:'query',required:true,schema:{type:'string'}});
  if(liff)parameters.push({name:'liffId',in:'query',required:true,schema:{type:'string'}},{name:'Authorization',in:'header',required:true,schema:{type:'string'},description:'本人のLINE IDトークン'});
  const operation:Operation={tags:[liff?'Booking':'Styles'],summary,description:liff?'LINE IDトークンで本人とお店を確定する。別の人やお店の記録は操作できない。':'管理画面の認証と店舗の範囲を確認する。更新は閲覧専用の担当者に許可しない。版が古い更新は409。',parameters,responses:{'200':{description:'操作または取得の結果'},'201':{description:'新しい記録を保存'},'400':{description:'入力を確認してください'},'401':{description:'認証が必要'},'403':{description:'操作する権限がない'},'404':{description:'対象が見つからない'},'409':{description:'版または予約枠の競合'},'422':{description:'入力した値を使えない'}}};
  if(path === '/api/dashboard/style/analytics') {
    operation.description += ' 支払い集計は店舗時間帯の選択期間[from,to)と担当者の範囲を使う。入金日・返金日など記録ごとの日付で数え、予約日や来店日と混ぜない。支払い閲覧権限がなければpayments.status=forbidden。';
    operation.parameters.push(...['from','to','staff_id'].map(name => ({ name, in: 'query', required: false, schema: { type: 'string' } })));
    operation.responses['200'].description = '予約の集計と支払い集計。利用できる支払い集計はpayments.periodにfrom/to/timeZone/dateBasis=paymentを返す。0件と取得失敗は別で、取得失敗はエラー応答。';
  }
  if(liff)operation.security=[];
  if(!['get','delete'].includes(method))operation.requestBody={required:true,content:{'application/json':{schema:{type:'object'}}}};
  (paths[path]??={})[method]=operation;
}
export const stylePaths=paths;
