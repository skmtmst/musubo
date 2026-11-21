import type { MenuItem, StaffItem } from './api.js';
import type { PartyState } from './party.js';
import type { SlotPick } from '../components/date-time-picker.js';
import { getLiffId, getLineUserId } from './liff-auth.js';

const STORAGE_KEY = 'booking.cardSetup.resume.v1';
export interface CardSetupResume {
  liffId:string; lineUserId:string; savedAt:number; menu:MenuItem; staff:StaffItem; slot:SlotPick; party?:PartyState;
  note:string; meetingMode:'online'|'in_person'|null; setupKey:string; bookingKey:string;
}
/** タブを離れる間だけ申込を保持し、別店舗・古い申込では復元しない。 */
export function readCardSetupResume():CardSetupResume|null {
  try {
    const raw=sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length>100_000) return null;
    const r=JSON.parse(raw) as CardSetupResume;
    if (!r || r.liffId!==getLiffId() || r.lineUserId!==getLineUserId() || !Number.isFinite(r.savedAt) || Date.now()-r.savedAt>24*60*60*1000 || r.savedAt>Date.now()
      || typeof r.menu?.id!=='string' || typeof r.staff?.id!=='string' || typeof r.slot?.date!=='string' || typeof r.slot?.start!=='string'
      || typeof r.setupKey!=='string' || typeof r.bookingKey!=='string' || typeof r.note!=='string'
      || (r.meetingMode!==null && r.meetingMode!=='online' && r.meetingMode!=='in_person')) return null;
    return r;
  } catch { return null; }
}
export function saveCardSetupResume(value:Omit<CardSetupResume,'liffId'|'lineUserId'|'savedAt'>):void {
  sessionStorage.setItem(STORAGE_KEY,JSON.stringify({...value,liffId:getLiffId(),lineUserId:getLineUserId(),savedAt:Date.now()}));
}
export function clearCardSetupResume():void { try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* 記録がなくても予約は完了している。 */ } }
