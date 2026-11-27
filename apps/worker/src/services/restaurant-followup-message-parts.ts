import type { BroadcastMessagePart } from '../features/broadcasts/broadcast-message-set/index.js';
import { requiredRestaurantFollowupParts, type RestaurantFollowupTrigger } from '@line-crm/shared';

/** 本文を変えても、来店確認の返事と招待の予約・見送りの入口は失わない。 */
export function protectRestaurantFollowupMessageParts(trigger:RestaurantFollowupTrigger,parts:BroadcastMessagePart[]):BroadcastMessagePart[]{
 parts=[...parts,...requiredRestaurantFollowupParts(trigger, JSON.stringify(parts))];
 if(parts.length>5)throw new Error('予約の返事の入口を含めて5つ以内になるよう、吹き出しを減らしてください');
 return parts;
}
