import { comparisonPeriod } from './store-comparison.js';

type ResponseSample = { responder_staff_id: string | null; name: string | null; minutes: number; due_at: string | null; responded_at: string };
const median = (values: number[]) => {
  if (!values.length) return null;
  values.sort((a,b)=>a-b);
  return (values[Math.floor((values.length-1)/2)] + values[Math.floor(values.length/2)]) / 2;
};
const weekOf = (timestamp: string) => {
  const date = new Date(Date.parse(timestamp) + 9 * 3600_000);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay()+6)%7);
  return monday.toISOString().slice(0,10);
};
/** 集計は必ず店の範囲を固定し、スタッフと閲覧のみは本人の返信だけを見る。 */
export async function inboxResponseAnalytics(db:D1Database, account:string, staffId:string, allStaff:boolean, from?:string, to?:string) {
  const period=comparisonPeriod(from,to);
  const start=new Date(`${period.from}T00:00:00+09:00`).toISOString();
  const end=new Date(Date.parse(`${period.to}T00:00:00+09:00`)+86400000).toISOString();
  const rows=(await db.prepare(`SELECT s.responder_staff_id,m.name,s.minutes,s.due_at,s.responded_at
    FROM inbox_response_samples s LEFT JOIN staff_members m ON m.id=s.responder_staff_id
    WHERE s.account_id=? AND julianday(s.responded_at)>=julianday(?) AND julianday(s.responded_at)<julianday(?)
      AND (?=1 OR s.responder_staff_id=?) ORDER BY s.responded_at LIMIT 10001`)
    .bind(account,start,end,allStaff?1:0,staffId).all<ResponseSample>()).results;
  if(rows.length>10000) throw new Error('inbox_response_period_too_large');
  const grouped=new Map<string|null,ResponseSample[]>(), weeks=new Map<string,ResponseSample[]>();
  for(const row of rows){const group=grouped.get(row.responder_staff_id)??[];group.push(row);grouped.set(row.responder_staff_id,group);const week=weekOf(row.responded_at);const groupWeek=weeks.get(week)??[];groupWeek.push(row);weeks.set(week,groupWeek);}
  const byStaff=[...grouped].map(([id,items])=>{const due=items.filter(x=>x.due_at!==null&&Number.isFinite(Date.parse(x.due_at)));return {staffId:id,name:items[0].name??'担当不明',count:items.length,medianFirstResponseMinutes:median(items.map(x=>x.minutes)),withinSlaRate:due.length?100*due.filter(x=>Date.parse(x.responded_at)<=Date.parse(x.due_at!)).length/due.length:null};});
  const weekly=[...weeks].sort(([a],[b])=>a.localeCompare(b)).map(([week,items])=>({week,count:items.length,medianFirstResponseMinutes:median(items.map(x=>x.minutes))}));
  const automatic=allStaff?Number((await db.prepare(`SELECT count(*) n FROM messages_log m JOIN friends f ON f.id=m.friend_id WHERE f.line_account_id=? AND m.line_account_id=? AND m.direction='outgoing' AND m.source='auto_reply' AND julianday(m.created_at)>=julianday(?) AND julianday(m.created_at)<julianday(?)`).bind(account,account,start,end).first<{n:number}>())?.n??0):null;
  return {period,byStaff,weekly,automatic:{count:automatic}};
}
