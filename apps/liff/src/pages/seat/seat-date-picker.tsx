import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { resolveLook } from '../../lib/liff-look.js';
import { addDays } from '../../lib/seat-reserve.js';
import { BookingDateViews, BookingDayChoice, type BookingDayState } from '../../components/booking-date-parts.js';
import Button from '../../components/ui/button/index.js';
import { FieldError } from '../../components/forms/controls.js';
import Icon from '../../components/ui/icon.js';
import type { DaySlots } from './seat-reserve-types.js';

function stateOf(date:string,today:string,days:Record<string,DaySlots>):BookingDayState {
  if(date<today)return 'past';
  const data=days[date];
  if(data==='closed')return 'closed';
  if(!Array.isArray(data))return 'empty';
  if(data.some(s=>s.available && s.remainingTables>2))return 'open';
  if(data.some(s=>s.available && s.remainingTables>0))return 'few';
  return data.length?'full':'closed';
}
function label(date:string,state:BookingDayState) {
  const d=new Date(`${date}T00:00:00Z`);const text=state==='open'?'空きあり':state==='few'?'残りわずか':state==='full'?'満席':state==='closed'?'お休み':state==='past'?'過ぎた日':'空きなし';
  return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${text}`;
}
function shiftMonth(month:string,n:number) {const d=new Date(`${month}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,7)}

export default function SeatDatePicker({today,date,days,onDate,onRequestDates}:{today:string;date:string;days:Record<string,DaySlots>;onDate:(date:string)=>void;onRequestDates:(dates:string[],retry?:boolean)=>void}) {
  const [view,setView]=useState<'list'|'calendar'>('list');
  const [mode,setMode]=useState('week-first');const [marks,setMarks]=useState(true);
  const [week,setWeek]=useState(date);const [month,setMonth]=useState(date.slice(0,7));
  useEffect(()=>{let live=true;api.bookingSettings().then(r=>{if(!live)return;const look=resolveLook(r);setMode(look.calendarMode);setMarks(look.vacancyDots);if(look.calendarMode==='month-only'||look.calendarMode==='month-first')setView('calendar')}).catch(()=>{});return()=>{live=false}},[]);
  const visible=useMemo(()=>{if(view==='list')return Array.from({length:5},(_,i)=>addDays(week,i));const start=`${month}-01`;const next=`${shiftMonth(month,1)}-01`;const result:string[]=[];for(let d=start;d<next;d=addDays(d,1))if(d>=today)result.push(d);return result},[view,week,month,today]);
  useEffect(()=>{onRequestDates(visible)},[visible,onRequestDates]);
  useEffect(()=>{if(view!=='list'||visible.includes(date)||visible.some(d=>days[d]===undefined||days[d]==='loading'))return;const first=visible.find(d=>['open','few'].includes(stateOf(d,today,days)))??visible[0];if(first)onDate(first)},[view,visible,date,days,today,onDate]);
  const changeView=(next:'list'|'calendar')=>{setView(next);if(next==='list')setWeek(date);else setMonth(date.slice(0,7))};
  const choice=(d:string,calendar=false)=>{const state=stateOf(d,today,days);return <BookingDayChoice key={d} calendar={calendar} date={d} state={state} active={d===date} disabled={state!=='open'&&state!=='few'} showMarks={marks} label={label(d,state)} onClick={()=>{onDate(d);if(calendar&&mode!=='month-only'){setWeek(d);setView('list')}}} />};
  const first=new Date(`${month}-01T00:00:00Z`).getUTCDay();const monthLabel=`${Number(month.slice(0,4))}年${Number(month.slice(5))}月`;
  return <div className="space-y-3.5">
    {mode!=='week-only'&&mode!=='month-only'&&<BookingDateViews view={view} onChange={changeView} />}
    {visible.some(d=>days[d]==='error') && <FieldError tone="inherit"><span className="text-xs text-liff-sub">日付の空きを読み込めませんでした。<Button variant="text" onClick={()=>onRequestDates(visible,true)}>もう一度読み込む</Button></span></FieldError>}
    {view==='list'?<div className="flex items-center gap-[5px]" role="group" aria-label="週をえらぶ">
      <Button variant="icon" aria-label="前の週" disabled={week<=today} onClick={()=>setWeek(week<=addDays(today,5)?today:addDays(week,-5))}><Icon name="chevron-left" className="h-[18px] w-[18px]" /></Button>
      <div className="grid flex-1 grid-cols-5 gap-[5px]" role="group" aria-label="日付">{visible.map(d=>choice(d))}</div>
      <Button variant="icon" aria-label="次の週" onClick={()=>setWeek(addDays(week,5))}><Icon name="chevron-right" className="h-[18px] w-[18px]" /></Button>
    </div>:<div><div aria-label="月をえらぶ" className="mb-3.5 flex h-[22px] items-center justify-between"><Button variant="icon" aria-label="前の月" disabled={month<=today.slice(0,7)} onClick={()=>setMonth(shiftMonth(month,-1))}><Icon name="chevron-left" className="h-[18px] w-[18px]" /></Button><p aria-live="polite" className="text-[15px] font-bold text-ink">{monthLabel}</p><Button variant="icon" aria-label="次の月" onClick={()=>setMonth(shiftMonth(month,1))}><Icon name="chevron-right" className="h-[18px] w-[18px]" /></Button></div>
      <div className="mb-3.5 grid grid-cols-7" aria-label={`${monthLabel}の曜日`}>{'日月火水木金土'.split('').map((d,i)=><span key={i} className={`text-center text-[11px] ${i===0?'text-liff-sun':i===6?'text-liff-sat':'text-liff-sub'}`}>{d}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-3.5" aria-label={`${monthLabel}の日付`}>{Array.from({length:first},(_,i)=><span key={i} aria-hidden="true" />)}{Array.from({length:new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`).map(d=>choice(d,true))}</div>
    </div>}
  </div>;
}
