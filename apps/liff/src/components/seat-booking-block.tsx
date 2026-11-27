import { useEffect, useRef, useState } from 'react';
import { normalizeBookingValue, type FormBookingValue, type FormInputBlock, type RestaurantCustomerSlot, type RestaurantCustomerCourse } from '@line-crm/shared';
import { restaurantBookingApi } from '../lib/api.js';
import { zonedToday, zonedParts, addDays } from '../lib/seat-reserve.js';
import { FieldLabel, TextInput } from './forms/controls.js';
import CourseChoice from './course-choice.js';
import Button from './ui/button/index.js';

export default function SeatBookingBlock({block,value,onChange,courseRefresh=0}:{block:FormInputBlock;value:unknown;onChange:(next:FormBookingValue|'')=>void;courseRefresh?:number}) {
 const storeId=block.booking?.storeId??'';
 const picked=normalizeBookingValue(value);
 const [timeZone,setTimeZone]=useState('Asia/Tokyo');
 const firstLoad=useRef(true);
 useEffect(()=>{firstLoad.current=true},[storeId]);
 const [coursesFailed,setCoursesFailed]=useState(false);
 const [count,setCount]=useState(picked?.guestCount??2);
 const [courseId,setCourseId]=useState<string|null>(block.booking?.courseId??picked?.courseId??null);
 const [courses,setCourses]=useState<RestaurantCustomerCourse[]>([]);
 const [date,setDate]=useState(zonedToday(timeZone));
 const [slots,setSlots]=useState<RestaurantCustomerSlot[]>([]);
 const [failed,setFailed]=useState(false);
 const [loading,setLoading]=useState(true);
 const [retry,setRetry]=useState(0);
 useEffect(()=>{let live=true;
  setCoursesFailed(false);
  restaurantBookingApi.courses(storeId).then(r=>{if(live){if(!r || !Array.isArray(r.data))throw new Error('Invalid courses response');setCourses(r.data);if(courseRefresh>0 && courseId && !block.booking?.courseId && !r.data.some(course=>course.id===courseId)){setCourseId(null);onChange('');}if(r.timezone){setTimeZone(r.timezone);if(firstLoad.current)setDate(zonedToday(r.timezone));}firstLoad.current=false;}}).catch(()=>{if(live)setCoursesFailed(true);});
  return()=>{live=false;};
 },[storeId,retry,courseRefresh]);
 useEffect(()=>{let live=true;setLoading(true);setFailed(false);
  restaurantBookingApi.availability(storeId,date,count,courseId).then(r=>{if(live){if(!r?.data || !Array.isArray(r.data.slots))throw new Error('Invalid availability response');setSlots(r.data.slots);}}).catch(()=>{if(live){setFailed(true);setSlots([]);}}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[storeId,date,count,courseId,retry]);
 const clear=()=>onChange('');
 const fixedCourse=block.booking?.courseId ? courses.find(course=>course.id===block.booking?.courseId) : null;
 return <div className="space-y-3">
  <FieldLabel htmlFor={`${block.id}-guests`} required>人数</FieldLabel>
  <TextInput id={`${block.id}-guests`} type="number" min={1} max={100} value={count} onChange={e=>{setCount(Number(e.target.value));clear();}} />
  {!block.booking?.courseId && (courses.length>0 || courseId!==null || courseRefresh>0) && <CourseChoice courses={courses} value={courseId} onChange={id=>{setCourseId(id);clear();}} />}
  {fixedCourse && <p className="truncate text-sm text-liff-sub" title={`${fixedCourse.name}・${fixedCourse.durationMinutes}分`}>{fixedCourse.name}・{fixedCourse.durationMinutes}分</p>}
  <FieldLabel htmlFor={`${block.id}-date`} required>日にち</FieldLabel>
  <TextInput id={`${block.id}-date`} type="date" min={zonedToday(timeZone)} max={addDays(zonedToday(timeZone),Math.min(60,Math.max(1,block.booking?.daysAhead??14))-1)} value={date} onChange={e=>{setDate(e.target.value);clear();}} />
  {loading ? <p role="status">空きを読み込んでいます…</p> : failed || coursesFailed ? <><p role="alert">空きを読み込めませんでした。</p><Button variant="secondary" onClick={()=>setRetry(n=>n+1)}>もう一度読み込む</Button></> : <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="予約の時刻">
   {slots.map(s=><Button key={s.startsAt} variant="chip" role="radio" aria-checked={picked?.startsAt===s.startsAt} selected={picked?.startsAt===s.startsAt} disabled={!s.available} onClick={()=>onChange({kind:'seats',storeId,courseId,guestCount:count,startsAt:s.startsAt,menuId:'',staffId:''})}>{zonedParts(s.startsAt,timeZone).hm}{s.available?'':' 満席'}</Button>)}
   {!slots.some(s=>s.available) && <p className="col-span-3">この日は空きがありません。ほかの日を選んでください。</p>}
  </div>}
 </div>;
}
