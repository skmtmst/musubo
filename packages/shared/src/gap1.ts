/** 第1波。画面とWorkerの受け渡し。 */
export interface LineSenderSnapshot {name:string;iconUrl?:string}
export interface LineSender {
 id:string;name:string;iconMediaId:string|null;iconUrl:string|null;visibility:'all'|'owner_only';ownerStaffId:string|null;
 status:'active'|'inactive';version:number;usageCount?:number;iconMissing?:boolean;
}
export interface SendConfirmationPreview {
 recipients:number;excluded:{blocked:number;optedOut:number;duplicate:number;hidden?:number;missingDestination?:number};
 purpose:'marketing';scheduledAt:string|null;quietHoursShiftTo:string|null;needsApproval:boolean;firstText:string;sender:LineSenderSnapshot|null;
 deliveryLimit?:{candidateCount:number;recipientCount:number;random:boolean};
 expectedVersion:string|number;stoppable?:boolean;perAccount?:Array<{accountId:string;recipients:number;recipientToken?:string;excluded:SendConfirmationPreview['excluded']}>;
}
export interface InboxFirstResponseSettings {strategy:'none'|'even'|'priority'|'random_weighted';targets?:Array<{staffId:string;priority:number;cap:number}>;enabled:boolean;firstResponseMinutes:number;businessHoursOnly:boolean;version:number;escalateTeamId:string|null}
export type InboxFirstResponseWrite=Omit<InboxFirstResponseSettings,'version'|'escalateTeamId'> & {expectedVersion:number;escalateTeamId?:string|null};
export type InboxSlaState='none'|'ok'|'soon'|'overdue'|'outside_hours';
export interface BookingCancellationPolicy {enabled:boolean;tiers:Array<{beforeHours:number;percent:number}>;noShowPercent:number;version:number}
export interface BookingCancellationQuote {freeUntil:string|null;feeNow:number;feeNoShow:number;text:string;policyAcceptedRequired:boolean}
export interface BookingCancellationReview extends BookingCancellationQuote {cancelDeadlineAt:string;canCancel:boolean;lockVersion:number}
export interface BookingCancellationConfirmation {feeAccepted:boolean;expectedFeeAmount:number}
export interface BookingCancellationCharge {
 id:string;booking_id:string;line_account_id:string;kind:'cancellation_fee'|'no_show_fee';amount:number;
 status:'pending'|'processing'|'succeeded'|'failed'|'unknown'|'waived'|'refunded';version:number;
 actor_staff_id:string|null;reason:string|null;test_mode:1;
}
export interface BookingCalendarSwitch {readEnabled:boolean;writeEnabled:boolean;version:number;effectiveReadEnabled?:boolean;effectiveWriteEnabled?:boolean;connected?:boolean;futureEventCount?:number}
export interface BookingCalendarSwitchWrite {readEnabled:boolean;writeEnabled:boolean;expectedVersion:number;confirmed?:boolean;removeFutureEvents?:boolean;includeBacklog?:boolean}
