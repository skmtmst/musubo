import { RESTAURANT_FOLLOWUP_LABELS,type BroadcastBubble,type RestaurantFollowupTrigger,type RestaurantFollowupTiming,type RestaurantFollowupEngineDraftInput } from '@line-crm/shared'
import { messageTemplateToBubble } from '@/lib/broadcast-template'
import type { FollowupBoardSnapshot } from '@/lib/api/helpers/restaurant-followup-board'
export const FOLLOWUP_ORDER:RestaurantFollowupTrigger[]=['reservation_created','reservation_24h','reservation_2h','post_visit','review_request','waitlist_invited','anniversary_before']
export const FOLLOWUP_NAMES=RESTAURANT_FOLLOWUP_LABELS
export interface FollowupCardModel {
 trigger:RestaurantFollowupTrigger;enabled:boolean;timing:RestaurantFollowupTiming;bubbles:BroadcastBubble[];
 rowVersion:number;targetVersion:number;contentRevision:string|null;targetId:string|null;
 sending:boolean;reason:string|null;detailPath:string|null;editable:boolean;
}
export function boardRows(snapshot:FollowupBoardSnapshot):FollowupCardModel[]{
 if(!Array.isArray(snapshot.board?.engines)||!Array.isArray(snapshot.board.legacyContents))throw new Error('送り方の状態を読み込めませんでした。読み直してください')
 return FOLLOWUP_ORDER.map(trigger=>{
  const row=snapshot.page.rows?.find(row=>row.trigger===trigger)
  if(!row)throw new Error('送り方の設定が足りません。読み直してください')
  const engine=snapshot.board.engines.find(item=>item.trigger===trigger)
  const content=engine&&engine.engine!=='scenario'?engine.editorContent:snapshot.board.legacyContents.find(item=>item.trigger===trigger)?.content
  const bubbles=content?.messageParts.map((part,i)=>messageTemplateToBubble({id:`${trigger}-${i}`,name:FOLLOWUP_NAMES[trigger],category:'',messageType:part.messageType,messageContent:part.messageContent} ))??[]
  const editable=!!content&&bubbles.length>0&&bubbles.every(bubble=>bubble!==null)
  return {trigger,enabled:row.enabled??snapshot.page.bindings.some(binding=>binding.trigger===trigger&&binding.enabled===1),timing:content?.timing??{mode:'countdown',offsetMinutes:row.default_offset_minutes},bubbles:bubbles.filter((bubble):bubble is BroadcastBubble=>!!bubble),rowVersion:row.version,targetVersion:engine?.targetVersion??0,contentRevision:engine?.contentRevision??null,targetId:engine?.targetId??null,sending:engine?engine.effectiveSendingStatus==='active':snapshot.page.template?.sending_status==='active'&&!!row.enabled,reason:engine?.reason??null,detailPath:engine?.detailPath??(snapshot.page.template?.scenario_id?`/scenarios/detail?id=${encodeURIComponent(snapshot.page.template.scenario_id)}`:null),editable}
 })
}
export function draftInput(row:FollowupCardModel):RestaurantFollowupEngineDraftInput{return {expectedRowVersion:row.rowVersion,expectedTargetVersion:row.targetVersion,expectedContentRevision:row.contentRevision,enabled:row.enabled,timing:row.timing,messageBubbles:row.bubbles}}
export function rowContentKey(row:FollowupCardModel){return JSON.stringify([row.enabled,row.timing,row.bubbles.map(bubble=>[bubble.type,bubble.content])])}
export function rowVersionKey(row:FollowupCardModel){return JSON.stringify([row.rowVersion,row.targetVersion,row.contentRevision])}
function span(minutes:number){return minutes%1440===0?`${minutes/1440}日`:minutes%60===0?`${minutes/60}時間`:`${minutes}分`}
export function followupTimingLabel(trigger:RestaurantFollowupTrigger,timing:RestaurantFollowupTiming){
 const origin=trigger==='anniversary_before'?'記念日':'予約'
 if(timing.mode==='next_day'){
  const sendAt=timing.sendAtTime?.trim()
  return sendAt?`退店の翌日 ${sendAt} に送る`:'退店の翌日に送る'
 }
 if(timing.mode==='time'){
  const sendAt=timing.sendAtTime?.trim()
  if(!Number.isFinite(timing.offsetDays)||!sendAt)return '送るタイミング未設定'
  const days=Math.trunc(timing.offsetDays)
  const dayLabel=days===-1?'前日':days===0?'当日':days<0?`${Math.abs(days)}日前`:`${days}日後`
  return `${origin}の${dayLabel} ${sendAt} に送る`
 }
 const minutes=timing.offsetMinutes
 if(!Number.isFinite(minutes))return '送るタイミング未設定'
 if(trigger==='reservation_24h'||trigger==='reservation_2h'||trigger==='anniversary_before')return `${origin}の${span(Math.abs(minutes))}前に送る`
 const event=trigger==='waitlist_invited'?'席が空いたら':trigger==='reservation_created'?'予約が入ったら':'退店から'
 const safeMinutes=Math.max(0,minutes)
 return safeMinutes===0?`${event}すぐに送る`:`${event}${span(safeMinutes)}後に送る`
}
export function followupTimingError(trigger:RestaurantFollowupTrigger,timing:RestaurantFollowupTiming):string|null{
 const reminder=['reservation_24h','reservation_2h','anniversary_before'].includes(trigger)
 if(timing.mode==='next_day')return !['post_visit','review_request'].includes(trigger)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.sendAtTime)?'翌日の時刻を確認してください':null
 if(timing.mode==='time')return !reminder||!Number.isInteger(timing.offsetDays)||timing.offsetDays< -365||timing.offsetDays>(trigger==='anniversary_before'?-1:0)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.sendAtTime)?'送る日と時刻を確認してください':null
 const count=timing.offsetMinutes
 if(!Number.isSafeInteger(count)||Math.abs(count)>525600)return '待つ時間は365日以内で入れてください'
 if(reminder)return count>=0||trigger==='anniversary_before'?'予約前の日と時刻を選んでください':null
 return count<0||count>0&&count%5!==0?'待つ時間は0以上・5分単位で入れてください':null
}
