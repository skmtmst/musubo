'use client'
import type { BroadcastBubble } from '@line-crm/shared'
import LinePreview from '@/components/shared/line-preview'
import { BubblePreview } from '@/components/broadcasts/broadcast-preview-model'
export function FollowupMessageSample({bubbles,storeName,compact=false,overview=false}:{
 bubbles:BroadcastBubble[];storeName:string;compact?:boolean;overview?:boolean
}){
 const preview = bubbles.map(bubble=><BubblePreview key={bubble.id} bubble={bubble} accountName={storeName} composer/>)
 if (overview) return <>{preview.slice(0, 1)}</>
 return <LinePreview title={null} accountName={storeName} scaleToFit={compact} compact={compact}>{preview}</LinePreview>
}
