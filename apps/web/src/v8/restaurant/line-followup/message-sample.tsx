'use client'
import type { BroadcastBubble, RestaurantFollowupTrigger } from '@line-crm/shared'
import LinePreview, { LinePreviewFlex, LinePreviewMessage } from '@/components/shared/line-preview'
import { BubblePreview } from '@/components/broadcasts/broadcast-preview-model'
export function FollowupMessageSample({bubbles,storeName,trigger,compact=false,overview=false}:{
 bubbles:BroadcastBubble[];storeName:string;trigger?:RestaurantFollowupTrigger;compact?:boolean;overview?:boolean
}){
 const preview = bubbles.map(bubble=><BubblePreview key={bubble.id} bubble={bubble} accountName={storeName} composer/>)
 const content=JSON.stringify(bubbles)
 if(trigger==='reservation_24h' && !['restaurant_going','restaurant_change','restaurant_cancel'].every(key=>content.includes(`{{var.${key}}}`))) {
  const actions=['行きます','変更したい','取り消す']
  preview.push(<LinePreviewFlex key="confirmation" maxWidth={210} content={JSON.stringify({type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:'ご予約について',wrap:true}]},footer:{type:'box',layout:'vertical',contents:actions.map(label=>({type:'button',action:{type:'postback',label}}))}})} />)
 }
 if(trigger==='waitlist_invited' && !['waitlist_book_url','waitlist_decline_url'].every(key=>content.includes(`{{var.${key}}}`))) preview.push(<LinePreviewMessage key="invitation" accountName={storeName} avatar={storeName.slice(0,1)} time="">{'この時間で予約する：{{var.waitlist_book_url}}\n今回は見送る：{{var.waitlist_decline_url}}'}</LinePreviewMessage>)
 if (overview) return <>{preview.slice(0, 1)}</>
 return <LinePreview title={null} accountName={storeName} scaleToFit={compact} compact={compact}>{preview}</LinePreview>
}
