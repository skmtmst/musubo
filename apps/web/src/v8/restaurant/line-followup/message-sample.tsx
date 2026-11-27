'use client'
import { requiredRestaurantFollowupParts, type BroadcastBubble, type RestaurantFollowupTrigger } from '@line-crm/shared'
import LinePreview, { LinePreviewFlex, LinePreviewMessage } from '@/components/shared/line-preview'
import { BubblePreview } from '@/components/broadcasts/broadcast-preview-model'
export function FollowupMessageSample({bubbles,storeName,trigger,compact=false,overview=false}:{
 bubbles:BroadcastBubble[];storeName:string;trigger?:RestaurantFollowupTrigger;compact?:boolean;overview?:boolean
}){
 const preview = bubbles.map(bubble=><BubblePreview key={bubble.id} bubble={bubble} accountName={storeName} composer/>)
 if (trigger) for (const part of requiredRestaurantFollowupParts(trigger, JSON.stringify(bubbles))) {
  preview.push(part.messageType === 'flex'
   ? <LinePreviewFlex key={part.id} maxWidth={210} content={part.messageContent} />
   : <LinePreviewMessage key={part.id} accountName={storeName} avatar={storeName.slice(0, 1)} time="">{part.messageContent}</LinePreviewMessage>)
 }
 if (overview) return <>{preview.slice(0, 1)}</>
 return <LinePreview title={null} accountName={storeName} scaleToFit={compact} compact={compact}>{preview}</LinePreview>
}
