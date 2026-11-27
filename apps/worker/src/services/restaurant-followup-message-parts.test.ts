import { expect,it } from 'vitest';
import { protectRestaurantFollowupMessageParts } from './restaurant-followup-message-parts.js';
import { buildMessages } from '../features/broadcasts/broadcast-message-set/index.js';
const parts=[{id:'body',messageType:'text',messageContent:'予約ありがとうございます'}];
it('前日の本文だけを保存しても返事の押し口を残し、二重に付けない',()=>{
 const saved=protectRestaurantFollowupMessageParts('reservation_24h',parts);
 expect(saved).toHaveLength(2);expect(buildMessages(saved)).toHaveLength(2);
 expect(protectRestaurantFollowupMessageParts('reservation_24h',saved)).toEqual(saved);
 for(const key of ['restaurant_going','restaurant_change','restaurant_cancel'])expect(JSON.stringify(saved)).toContain(`{{var.${key}}}`);
});
it('招待の予約と見送りの両方を残し、通常のお礼には足さない',()=>{
 const saved=protectRestaurantFollowupMessageParts('waitlist_invited',parts);expect(saved).toHaveLength(2);
 expect(protectRestaurantFollowupMessageParts('waitlist_invited',saved)).toEqual(saved);
 expect(protectRestaurantFollowupMessageParts('post_visit',parts)).toEqual(parts);
});
it('送信上限を超える時は本文を落とさず保存を断る',()=>{
 expect(()=>protectRestaurantFollowupMessageParts('reservation_24h',Array.from({length:5},(_,index)=>({...parts[0],id:String(index)})))).toThrow('吹き出しを減らして');
});
it('来店確認の追加 JSON は送信先とボタン順を変えない',()=>{
 const saved=protectRestaurantFollowupMessageParts('reservation_24h',parts);
 expect(saved[1].messageContent).toBe('{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"ご予約について","wrap":true}]},"footer":{"type":"box","layout":"vertical","contents":[{"type":"button","action":{"type":"postback","label":"行きます","data":"{{var.restaurant_going}}"}},{"type":"button","action":{"type":"postback","label":"変更したい","data":"{{var.restaurant_change}}"}},{"type":"button","action":{"type":"postback","label":"取り消す","data":"{{var.restaurant_cancel}}"}}]}}');
});
it('招待に自動追加する本文を送信時と同じに保つ',()=>{
 const saved=protectRestaurantFollowupMessageParts('waitlist_invited',parts);
 expect(saved[1]).toEqual({id:'invitation',messageType:'text',messageContent:'この時間で予約する：{{var.waitlist_book_url}}\n今回は見送る：{{var.waitlist_decline_url}}'});
});
