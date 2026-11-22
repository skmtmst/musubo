// API契約の第2弾。画面の呼び出し関数はapi-gap2.ts。
const responses={
 '200':{description:'成功。各操作のdataの形はdescriptionを参照。'},
 '201':{description:'作成済み。同じキーの再送は同じ結果。'},
 '400':{description:'入力不備'},'401':{description:'本人確認・署名が無効'},
 '403':{description:'権限不足・閲覧のみ・代理で禁止された操作'},'404':{description:'対象なし・店または本人の範囲外'},
 '409':{description:'版・冪等キー・空きの競合。入力を保持して読み直す。'},'503':{description:'外部機能または保存先が利用不可'},
};
function operation(method:string,path:string,summary:string,description:string){
 const liff=path.startsWith('/api/liff/'),optionalLiff=path.endsWith('/addons');
 const parameters:Array<Record<string,unknown>>=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
 if(liff)parameters.push({name:'liffId',in:'query',required:true,schema:{type:'string'}});
 else if(!path.startsWith('/api/me/')&&!path.startsWith('/api/chats/'))parameters.push({name:'account_id',in:'query',required:true,schema:{type:'string'}});
 return {tags:['Gap2'],summary,description,parameters,responses,
 ...(liff?{security:optionalLiff?[]:[{liffIdToken:[]}]}:{}),
 ...(['POST','PUT','PATCH','DELETE'].includes(method)&&!path.startsWith('/api/me/push/test')?{requestBody:{required:false,description:'入力と必須ヘッダはdescriptionを参照。',content:{'application/json':{schema:{type:'object'}}}}}:{}),
 };
}
export const gap2Paths:Record<string,Record<string,ReturnType<typeof operation>>>={};
(gap2Paths["/api/booking/admin/menus/preview-as"]??={}).get=operation("GET","/api/booking/admin/menus/preview-as","B9: 指定した友だちから見えるメニュー","friend_id必須。dataはvisible/reasonを含むメニュー配列。予約の閲覧権限。閲覧のみ・代理可。");
(gap2Paths["/api/liff/booking/menus/{id}/addons"]??={}).get=operation("GET","/api/liff/booking/menus/{id}/addons","B5: 追加できる1人分のメニュー","dataはid/name/duration_minutes/base_price/versionの配列。限定メニューには本人token必須。匿名は全員向けのみ。");
(gap2Paths["/api/booking/admin/series/preview"]??={}).post=operation("POST","/api/booking/admin/series/preview","B4: 繰り返し予約の空きを確認","body: menuId,friendId,staffId?,startsAt,rule:{freq:weekly/biweekly/monthly_nth,count?:2..52,until?,weekday?,nth?}。data.occurrencesにindex/startsAt/available/staffId/reason/alternatives。閲覧のみ・代理可。");
(gap2Paths["/api/booking/admin/series"]??={}).post=operation("POST","/api/booking/admin/series","B4: 繰り返し予約を一括作成","previewと同じbodyにchoices:[{index,action:keep/skip,alternativeStartsAt?}]。Idempotency-Key必須。data:{series,bookings,skipped}。競合時は全部戻す。編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/booking/admin/series/{id}"]??={}).get=operation("GET","/api/booking/admin/series/{id}","B4: 繰り返し予約の組を読む","data:{series,bookings}。予約の閲覧権限。");
(gap2Paths["/api/booking/admin/series/{id}"]??={}).patch=operation("PATCH","/api/booking/admin/series/{id}","B4: 1回または以後の回を変更","body:{scope:this/following,fromBookingId,change:{startsAt?,staffId?},expectedVersion}。data:{changed,conflicts,version}。変更できない回は保持。編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/booking/admin/series/{id}/cancel"]??={}).post=operation("POST","/api/booking/admin/series/{id}/cancel","B4: 1回または以後の回を取消","body:{scope:this/following,fromBookingId,expectedVersion,reason?}。data:{cancelled,fees,version}。編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/forms/{id}/routing/preview"]??={}).post=operation("POST","/api/forms/{id}/routing/preview","B6: 回答による行き先を見本で確認","body:{answers,blockId?,layout?}。layoutは未保存のフォーム定義。data:{matchedIndex,target,usable,fellBack,blockId}。フォーム閲覧権限、何も保存せず閲覧のみ・代理可。");
(gap2Paths["/api/liff/forms/{id}/routing/resolve"]??={}).post=operation("POST","/api/liff/forms/{id}/routing/resolve","B6: 公開したフォームの行き先を確定","body:{answers,blockId?}。LINE本人token必須。公開不変版を使い、dataにroutingToken/expiresAtを返す。署名は30分、本人・店・フォーム版・行き先を固定。");
(gap2Paths["/api/booking/admin/routing-staff-groups"]??={}).get=operation("GET","/api/booking/admin/routing-staff-groups","B6: 振り分け用の担当の組","dataは保存した組の配列。メニュー閲覧権限。");
(gap2Paths["/api/booking/admin/routing-staff-groups/{id}"]??={}).put=operation("PUT","/api/booking/admin/routing-staff-groups/{id}","B6: 担当の組を保存","body:{name,staffIds,expectedVersion}。新規は版0。data:{version}。owner/admin、閲覧のみ・代理不可。");
(gap2Paths["/api/events/admin/{id}/makeup-rule"]??={}).put=operation("PUT","/api/events/admin/{id}/makeup-rule","B3: 欠席と振替の決まりを保存","body:{rule:{enabled,cutoffHours,validDays,monthlyCap,target:same_kind/list,targetIds},expectedRevision}。events.versionで照合。data:{rule,revision}。owner/admin、閲覧のみ・代理不可。");
(gap2Paths["/api/liff/events/bookings/{id}/absence"]??={}).post=operation("POST","/api/liff/events/bookings/{id}/absence","B3: 本人の欠席を届け出る","Idempotency-Keyと本人token必須。data:{eventBooking:{id,status:absent},makeupCredit,reasonIfNone}。振替先はこの操作で選ばない。");
(gap2Paths["/api/events/admin/bookings/{id}/absence"]??={}).post=operation("POST","/api/events/admin/bookings/{id}/absence","B3: 店で欠席を登録","body:{grantMakeup?,reason?}。締め後の券発行は理由必須。data:{eventBooking,makeupCredit,reasonIfNone}。編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/liff/events/makeup-credits"]??={}).get=operation("GET","/api/liff/events/makeup-credits","B3: 本人の振替券一覧","dataは本人の券の配列。LINE本人token必須。期限切れを反映。");
(gap2Paths["/api/booking/admin/makeup-credits"]??={}).get=operation("GET","/api/booking/admin/makeup-credits","B3: 店の友だちの振替券一覧","friend_id必須。dataは指定した店内の本人の券の配列。予約閲覧権限。");
(gap2Paths["/api/liff/events/makeup-credits/{id}/options"]??={}).get=operation("GET","/api/liff/events/makeup-credits/{id}/options","B3: 振替先の空き一覧","任意のfrom=YYYY-MM-DD。dataは期限内かつ空きのある回の配列。本人token必須。");
(gap2Paths["/api/liff/events/makeup-credits/{id}/use"]??={}).post=operation("POST","/api/liff/events/makeup-credits/{id}/use","B3: 振替券を使って予約","body:{eventSlotId}。本人tokenとIdempotency-Key必須。data:{bookingId,replayed}。空きの確保と券の使用を同じbatchで行う。");
(gap2Paths["/api/broadcasts/{id}/variants/{key}"]??={}).put=operation("PUT","/api/broadcasts/{id}/variants/{key}","G1: A/Bのテキスト案を保存","key=A/B。body:{text,expectedVersion}。配信のlock_versionを使う。内容を変えると承認を外す。配信編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/broadcasts/{id}/ab-test"]??={}).put=operation("PUT","/api/broadcasts/{id}/ab-test","G1: 模擬A/Bの決まりを保存","body:{testRatioPct:10/20/30/50,metric:click,decideAfterMinutes:60/120/240/480/1440,undecidedPolicy:stop/send_a,expectedVersion}。タグ/絞り込み限定。配信編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/broadcasts/{id}/ab-test"]??={}).delete=operation("DELETE","/api/broadcasts/{id}/ab-test","G1: 未開始のA/B設定を外す","body:{expectedVersion}。配信編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/broadcasts/{id}/ab-result"]??={}).get=operation("GET","/api/broadcasts/{id}/ab-result","G1: 模擬A/Bの結果","data:{status,variants,winner,remainder,version,testMode:true,...}。クリック以外の未提供の指標はnull。配信閲覧権限。");
(gap2Paths["/api/broadcasts/{id}/ab-test/choose"]??={}).post=operation("POST","/api/broadcasts/{id}/ab-test/choose","G1: 模擬A/Bの勝者を選ぶ","body:{variant:A/B/none,confirmedRecipientCount,testMode:true}。Idempotency-KeyとX-Confirm-Irreversible:broadcast-send必須。配信送信権限、閲覧のみ・代理不可。本物の送信なし。");
(gap2Paths["/api/ai-settings"]??={}).get=operation("GET","/api/ai-settings","G2: AI設定を読む","data:{mode,version,...,autoReplyAvailable:false}。初期off。自動応答の閲覧権限。");
(gap2Paths["/api/ai-settings"]??={}).put=operation("PUT","/api/ai-settings","G2: 要約と返信案を有効化・停止","body:{mode:off/draft_only/suspended,expectedVersion,confirmed?,reason?}。owner/admin、draft_onlyは確認必須。代理は理由つきoff/suspendedだけ。auto_qaはtestMode:true/confirmed:true/公開QA/オーナー本人確認がある模擬だけ。実送信なし。指定なしは409、他の管理者403。");
(gap2Paths["/api/chats/{id}/ai/summary"]??={}).post=operation("POST","/api/chats/{id}/ai/summary","G2: 会話の3行要約","data:{lines,generatedAt,basedOnMessageId}。閲覧できる会話だけ。閲覧のみ・代理可。個人情報を伏せ、月3000回、外部への保存なし。LINEへ送らない。");
(gap2Paths["/api/chats/{id}/ai/draft"]??={}).post=operation("POST","/api/chats/{id}/ai/draft","G2: 返信案を作る","data:{text,sources,generatedAt,basedOnMessageId}。会話の返信権限、閲覧のみ・代理不可。公開Q&Aと過去返信を参照。個人情報は伏せ、LINEへ送らない。");
(gap2Paths["/api/qa-entries"]??={}).get=operation("GET","/api/qa-entries","G2: Q&Aの一覧","任意のqとoffset。dataは最大20件、total/nextOffsetを返す。自動応答の閲覧権限。");
(gap2Paths["/api/qa-entries"]??={}).post=operation("POST","/api/qa-entries","G2: Q&Aを下書きで作成","body:{questions:string[],answer}。Idempotency-Key必須。dataは保存した行。編集権限、閲覧のみ・代理不可。");
(gap2Paths["/api/qa-entries/{id}"]??={}).put=operation("PUT","/api/qa-entries/{id}","G2: Q&Aの内容を保存","body:{questions:string[],answer,expectedVersion}。data:{version,status:draft}。スタッフは下書きのみ。閲覧のみ・代理不可。");
(gap2Paths["/api/qa-entries/{id}"]??={}).delete=operation("DELETE","/api/qa-entries/{id}","G2: Q&Aを保管する","body:{expectedVersion}。data:{status:stopped,version}。物理削除しない。owner/admin、閲覧のみ・代理不可。");
(gap2Paths["/api/qa-entries/{id}/publish"]??={}).post=operation("POST","/api/qa-entries/{id}/publish","G2: Q&Aを公開","body:{expectedVersion}。data:{status,version}。owner/admin、閲覧のみ・代理不可。");
(gap2Paths["/api/qa-entries/{id}/stop"]??={}).post=operation("POST","/api/qa-entries/{id}/stop","G2: Q&Aを停止","body:{expectedVersion}。data:{status,version}。owner/admin、閲覧のみ・代理不可。");
(gap2Paths["/api/me/push"]??={}).get=operation("GET","/api/me/push","G4: 自分の通知端末と設定","data:{subscriptions,preferences,vapidPublicKey,configured}。購読の秘密や秘密鍵は返さない。閲覧のみ可。");
(gap2Paths["/api/me/push/subscriptions"]??={}).post=operation("POST","/api/me/push/subscriptions","G4: 本人の端末を登録","body:{endpoint,keys:{p256dh,auth},label}。Idempotency-Key必須。data:{id,user_agent_label}。既知HTTPSサービス限定。閲覧のみ可、代理不可。");
(gap2Paths["/api/me/push/subscriptions/{id}"]??={}).delete=operation("DELETE","/api/me/push/subscriptions/{id}","G4: 端末を外す","本人または同じ統括のowner/admin。代理不可。");
(gap2Paths["/api/me/push/preferences"]??={}).put=operation("PUT","/api/me/push/preferences","G4: 自分の通知の好みを保存","body:{kinds:[new_inquiry,assigned_reply],quietStart,quietEnd,quietAllowCritical,expectedVersion}。新規版0。閲覧のみ可、代理不可。");
(gap2Paths["/api/me/push/test"]??={}).post=operation("POST","/api/me/push/test","G4: 自分の端末へ試験通知","1分に1回。VAPID未設定503。本人だけ、閲覧のみ可、代理不可。顧客本文・連絡先は送らない。");

(gap2Paths['/api/ai-settings/simulate']??={}).post=operation('POST','/api/ai-settings/simulate','G2: Q&A自動応答を模擬','body:{chatId,question,kind?,testMode:true}。Idempotency-Key必須。管理者以上。代理・閲覧のみ不可。dataにaction/handoffReason/messages/sent:false/testMode:true/replayed。実送信なし。');
(gap2Paths['/api/chats/{id}/ai/typing']??={}).post=operation('POST','/api/chats/{id}/ai/typing','G2: 入力中の1分間の借用','body:{typing:boolean}。会話の返信権限。代理・閲覧のみ不可。falseは自分の借用だけを解放。競合409。');
