import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatJstEventAt } from '../lib/datetime.js';
import LiffHeader from '../components/ui/liff-header.js';
import Card from '../components/ui/card.js';
import Button from '../components/ui/button/index.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import StatusView from '../components/ui/status-view.js';

type Catalog=Awaited<ReturnType<typeof api.listEvents>>;
function checkedCatalog(value: Catalog): Catalog {
 if (!value || !Array.isArray(value.items) || !(value.nextCursor === null || typeof value.nextCursor === 'string') ||
     !value.items.every(item => item && typeof item.id === 'string' && item.id.trim() !== '' &&
       typeof item.name === 'string' && typeof item.nextStartsAt === 'string' && Number.isFinite(Date.parse(item.nextStartsAt)) &&
       (item.venue_name === null || typeof item.venue_name === 'string'))) {
  throw new Error('Invalid event catalog response');
 }
 return value;
}
export default function EventCatalog() {
 const [data,setData]=useState<Catalog|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[moreError,setMoreError]=useState(false);
 const generation=useRef(0),pending=useRef(false);
 const navigate=useNavigate(),{search}=useLocation();
 useEffect(()=>{const scope=generation.current+1;generation.current=scope;pending.current=false;setBusy(false);setMoreError(false);setError(false);setData(null);void api.listEvents().then(checkedCatalog).then(data=>{if(generation.current===scope)setData(data)}).catch(()=>{if(generation.current===scope)setError(true)});return ()=>{generation.current=scope+1}},[tick]);
 const more=async()=>{
  if(!data?.nextCursor||pending.current)return;
  const cursor=data.nextCursor,scope=generation.current;
  pending.current=true;setBusy(true);
  try{
   const next=checkedCatalog(await api.listEvents(cursor));
   if(generation.current!==scope)return;
   setData(current=>{
    if(!current||current.nextCursor!==cursor)return current;
    const seen=new Set(current.items.map(item=>item.id));
    const added=next.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true});
    return {items:[...current.items,...added],nextCursor:next.nextCursor};
   });
   setMoreError(false);
  }catch{if(generation.current===scope)setMoreError(true)}
  finally{if(generation.current===scope){pending.current=false;setBusy(false)}}
 };
 return <div className="min-h-screen bg-canvas"><LiffHeader title="クラス・スケジュール"/><main className="mx-auto flex max-w-md flex-col gap-4 p-4">
  {error?<LoadErrorView onRetry={()=>setTick(n=>n+1)}/>:null}
  {!data&&!error?<LoadingView/>:null}
  {data?.items.length===0?<StatusView icon="calendar" title="これからのクラスはありません" body="スケジュールが公開されるまでお待ちください。"/>:null}
  {data?.items.map(event=><Card key={event.id} className="space-y-3 p-4"><h2 className="text-base font-semibold">{event.name}</h2><p className="text-sm text-liff-sub">{formatJstEventAt(event.nextStartsAt)}</p>{event.venue_name?<p className="text-sm">{event.venue_name}</p>:null}<Button variant="primary" onClick={()=>navigate({pathname:`/events/${encodeURIComponent(event.id)}`,search})}>日時を選ぶ</Button></Card>)}
  {data?.nextCursor?moreError?<LoadErrorView inline busy={busy} message="続きのクラスを読み込めませんでした。表示済みのクラスはそのまま確認できます。" onRetry={()=>void more()}/>:<Button variant="secondary" onClick={()=>void more()} disabled={busy}>続きを見る</Button>:null}
 </main></div>
}
