/** API contracts for the third gap tranche. No live external writes. */
export type InboxStrategy='none'|'even'|'priority'|'random_weighted';
export interface InboxRoutingTarget {staffId:string;priority:number;cap:number}
export interface RankTier {id:string;name:string;threshold:number;mileMultiplier:number;tagId?:string;benefitDescriptions?:string[];couponCode?:string|null;upgradeMessages?:Array<{type:"text";text:string}>;downgradeMessages?:Array<{type:"text";text:string}>}
export interface RankProgram {metric:'visits'|'amount'|'miles';windowMonths:number;status:'stopped'|'active';version:number;activatedAt:string|null;tiers:RankTier[];notificationsAvailable:false;simulationAvailable:true;testMode:true;notifyUpgrade:boolean;notifyDowngrade:boolean}
export interface CustomerSegments {cells:Array<{r:number;f:number;name:string;count:number|null;optedOutCount:number|null}>;outside:{count:number|null};total:number|null;computedAt:string|null;status:string}
export type StoreComparisonKey='friendChange'|'blockRate'|'clickRate'|'bookings'|'visits'|'noShowRate'|'responseMinutes';
/** coveredDays＝期間のうち集計がそろった日の数、periodDays＝期間の日数。数はそろった日の分だけで出す。 */
export interface StoreComparisonRow {accountId:string;name:string;style:string|null;computedAt:string|null;coveredDays:number;periodDays:number;metrics:Record<StoreComparisonKey,{value:number|null;diff:number|null;unit:string;available:boolean}>}
export interface StoreComparisonResult {rows:StoreComparisonRow[];average:Record<StoreComparisonKey,number|null>;total:number;computedAt:string|null}
export type HqAttentionKind = 'unhandledChats'|'pendingBookings'|'unpaid'|'connections'|'stoppedDeliveries';
export type HqAttentionCounts = Record<HqAttentionKind, number>;
export interface StoreComparisonDay { date:string; values:Record<StoreComparisonKey,number|null>; state:'ready'|'partial'|'failed'|'missing' }
export interface StoreComparisonDetail {
 accountId:string; style:string|null; computedAt:string|null; coveredDays:number; periodDays:number; values:Record<StoreComparisonKey,number|null>;
 trend:StoreComparisonDay[];
 recentBroadcasts:Array<{id:string;title:string;status:string;sent_at:string|null}>;
 attention:{status:'ready';counts:HqAttentionCounts;targets:Partial<Record<HqAttentionKind,Array<{href:string;count:number}>>>}|{status:'unavailable';counts:null};
}
export type AutoLineKind='cart'|'browse'|'restock';
export interface AutoLineRule {kind:AutoLineKind;enabled:boolean;waitMinutes:number;messages:unknown[];version:number;testMode:true}
export interface BookingPassPlan {id:string;kind:'ticket'|'monthly';name:string;price:number;count:number|null;monthlyLimit:number|null;eventIds?:string[]|null;validDays:number;menuIds:string[];allowWithoutPass:boolean;status:'draft'|'on_sale'|'stopped';version:number}
export type BookingPassPlanSummary={onSale:number;holders:number;expiringIn30d:number;billingFailed:number|null;billingStatus:'unconfigured';billingSimulationFailed:number;billingSimulationCancelled:number};
export type BookingPassPlanWrite=Omit<BookingPassPlan,'id'|'status'|'version'>;
export interface McpConnection {id:string;name:string;level:'read'|'draft'|'send_request';accounts:Array<{id:string;name:string}>;keyPrefix:string;expiresAt:string;lastUsedAt:string|null;status:'active'|'stopped'|'expired';previousKeyExpiresAt:string|null;version:number}
export interface AiAnswerLog {testMode?:boolean;id:string;createdAt:string;chatId:string|null;friendId:string|null;friendName:string|null;questionText:string;action:'answered'|'handed_off'|'customer_asked_human';handoffReason:string|null;qaEntryId:string|null;qaTitle:string|null;qaVersion:number|null}

export interface MemberCard {memberNumber:string;name:string;benefits:string[];benefitDetails:{couponCode:string|null;mileMultiplier:number;tagId?:string};since:string;downgradeDueAt:string|null;next:{name:string;remaining:number;metric:string;progress:number}|null}
export type AccountAiFeature='banner'|'google_review';
export interface AccountAiSetting {feature:AccountAiFeature;enabled:boolean;version:number;consentBy:string|null;consentAt:string|null;disclosureVersion:string|null}
