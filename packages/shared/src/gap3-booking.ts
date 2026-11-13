export interface DepositRule {
 kind:'none'|'amount'|'percent';value:number|null;
 conditions:{always:boolean;minPeople:number|null;weekdays:number[]|null;timeBand:string|null};version:number;
}
export interface CancellationOptions {cardRequiredFor:'all'|'no_show_flagged'|'conditions';chargeMode:'manual'|'auto';version:number;autoChargeAvailable:false}
export interface BookingGroupView {groupId:string;ownerName:string|null;version:number;members:Array<{bookingId:string;personName:string;label:string;menuName:string;staffName:string|null;startsAt:string;endsAt:string;status:string;version?:number}>}
