import { comparisonPeriod } from './store-comparison.js';

/** 集計は必ず店の範囲を固定し、スタッフと閲覧のみは本人の返信だけを見る。 */
export async function inboxResponseAnalytics(db:D1Database, account:string, staffId:string, allStaff:boolean, from?:string, to?:string) {
  const period=comparisonPeriod(from,to);
  const start=new Date(`${period.from}T00:00:00+09:00`).toISOString();
  const end=new Date(Date.parse(`${period.to}T00:00:00+09:00`)+86400000).toISOString();
  const source=`SELECT s.*,m.name,date(s.responded_at,'+09:00','-'||((CAST(strftime('%w',s.responded_at,'+09:00') AS INTEGER)+6)%7)||' days') AS week
    FROM inbox_response_samples s LEFT JOIN staff_members m ON m.id=s.responder_staff_id
    WHERE s.account_id=? AND julianday(s.responded_at)>=julianday(?) AND julianday(s.responded_at)<julianday(?) AND (?=1 OR s.responder_staff_id=?)`;
  const [staffRows,weekRows]=await db.batch([
    db.prepare(`WITH sample AS (${source}), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY responder_staff_id ORDER BY minutes) AS rn,COUNT(*) OVER(PARTITION BY responder_staff_id) AS n FROM sample)
      SELECT responder_staff_id AS staffId,COALESCE(MAX(name),'担当不明') AS name,COUNT(*) AS count,COUNT(DISTINCT chat_id) AS conversationCount,
      AVG(CASE WHEN rn IN ((n+1)/2,(n+2)/2) THEN minutes END) AS medianFirstResponseMinutes,
      100.0*SUM(CASE WHEN julianday(due_at) IS NOT NULL AND julianday(responded_at)<=julianday(due_at) THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN julianday(due_at) IS NOT NULL THEN 1 ELSE 0 END),0) AS withinSlaRate
      FROM ranked GROUP BY responder_staff_id`).bind(account,start,end,allStaff?1:0,staffId),
    db.prepare(`WITH sample AS (${source}), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY week ORDER BY minutes) AS rn,COUNT(*) OVER(PARTITION BY week) AS n FROM sample)
      SELECT week,COUNT(*) AS count,AVG(CASE WHEN rn IN ((n+1)/2,(n+2)/2) THEN minutes END) AS medianFirstResponseMinutes FROM ranked GROUP BY week ORDER BY week`)
      .bind(account,start,end,allStaff?1:0,staffId),
  ]);
  const byStaff=staffRows.results,weekly=weekRows.results;
  const automatic=allStaff?Number((await db.prepare(`SELECT count(*) n FROM messages_log m JOIN friends f ON f.id=m.friend_id WHERE f.line_account_id=? AND m.line_account_id=? AND m.direction='outgoing' AND m.source='auto_reply' AND julianday(m.created_at)>=julianday(?) AND julianday(m.created_at)<julianday(?)`).bind(account,account,start,end).first<{n:number}>())?.n??0):null;
  return {period,byStaff,weekly,automatic:{count:automatic}};
}

/** 集計と同じ返信を返す。会話へのリンクは店と担当者を再確認してから作る。 */
export async function inboxResponseConversations(db:D1Database,account:string,staffId:string,allStaff:boolean,selected:string|null,from?:string,to?:string,offset=0) {
  if(!allStaff && selected!==staffId) throw new Error('forbidden');
  const period=comparisonPeriod(from,to);
  const start=new Date(`${period.from}T00:00:00+09:00`).toISOString();
  const end=new Date(Date.parse(`${period.to}T00:00:00+09:00`)+86400000).toISOString();
  const rows=await db.prepare(`SELECT s.chat_id AS chatId,c.friend_id AS friendId,COALESCE(f.display_name,'名前なし') AS name,MAX(s.responded_at) AS respondedAt
    FROM inbox_response_samples s JOIN chats c ON c.id=s.chat_id JOIN friends f ON f.id=c.friend_id AND f.line_account_id=s.account_id
    WHERE s.account_id=? AND s.responder_staff_id IS ? AND julianday(s.responded_at)>=julianday(?) AND julianday(s.responded_at)<julianday(?)
    GROUP BY s.chat_id,c.friend_id,f.display_name ORDER BY respondedAt DESC,s.chat_id DESC LIMIT 101 OFFSET ?`).bind(account,selected,start,end,offset).all<{chatId:string;friendId:string;name:string;respondedAt:string}>();
  return {items:rows.results.slice(0,100),nextOffset:rows.results.length>100?offset+100:null};
}
