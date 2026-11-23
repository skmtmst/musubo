import type { Ref, KeyboardEvent } from 'react';
import Button from './ui/button/index.js';
import { formatWeekday } from '../lib/datetime.js';

export type BookingDayState = 'open' | 'few' | 'full' | 'closed' | 'past' | 'off' | 'empty';
export function BookingDateTab({active, label, onClick, buttonRef}: {active:boolean;label:string;onClick:()=>void;buttonRef?:Ref<HTMLButtonElement>}) {
  return <Button variant="tab" selected={active} ref={buttonRef} type="button" role="radio" aria-checked={active} onClick={onClick}>{label}</Button>;
}
export function BookingDayChoice({date,state,active,disabled,showMarks,label,onClick,calendar=false}: {date:string;state:BookingDayState;active:boolean;disabled:boolean;showMarks:boolean;label:string;onClick:()=>void;calendar?:boolean}) {
  const open=state==='open', selectable=open||state==='few';
  if (calendar) return <Button variant="calendarDay" selected={active} unavailable={!selectable} full={state==='full'} type="button" onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={label}>
    <span className="liff-num text-sm leading-tight">{Number(date.slice(8,10))}</span>
    <span className="flex min-h-1.5 items-center text-[11px] leading-none">{state==='off'?'受付外':null}{showMarks&&selectable&&<span className={`block h-[5px] w-[5px] rounded-full ${state==='few'?'bg-liff-dot-few':'bg-liff-primary'}`} aria-hidden="true" />}</span>
  </Button>;
  const mark=state==='open'?'空き':state==='few'?'わずか':state==='closed'?'休み':'満';
  return <Button variant="day" selected={active} unavailable={state==='closed'||state==='empty'} type="button" onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={label} title={label}>
    <span className="text-[10px] text-liff-sub">{formatWeekday(date)}</span>
    <span className={`liff-num text-base font-bold ${active?'text-liff-primary':selectable||state==='full'?'text-ink':'text-liff-off-ink'}`}>{Number(date.slice(8,10))}</span>
    {showMarks&&<span className={`text-[9px] ${active||open?'text-liff-primary':state==='few'?'text-liff-dot-few':state==='full'?'text-liff-full':'text-liff-off-ink'}`}>{mark}</span>}
  </Button>;
}

export function BookingDateViews({view,onChange,onKeyDown,listRef,calendarRef}: {view:'list'|'calendar';onChange:(view:'list'|'calendar')=>void;onKeyDown?:(e:KeyboardEvent<HTMLDivElement>)=>void;listRef?:Ref<HTMLButtonElement>;calendarRef?:Ref<HTMLButtonElement>}) {
  return <div role="radiogroup" aria-label="表示の切り替え" className="flex gap-1 rounded-(--liff-radius) bg-liff-chip p-[3px]" onKeyDown={onKeyDown ?? (e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const next=e.key==='ArrowLeft'||e.key==='ArrowUp'?'list':'calendar';onChange(next);(e.currentTarget.querySelectorAll('button')[next==='list'?0:1] as HTMLButtonElement)?.focus();})}>
    <BookingDateTab buttonRef={listRef} active={view==='list'} label="週で見る" onClick={()=>onChange('list')} />
    <BookingDateTab buttonRef={calendarRef} active={view==='calendar'} label="カレンダー" onClick={()=>onChange('calendar')} />
  </div>;
}
