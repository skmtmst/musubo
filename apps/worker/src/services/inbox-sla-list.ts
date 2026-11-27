import { assigneeFilter } from './chat-assignees.js';
import { buildOffsetListResponse, listQueryNumber } from '../lib/list-paging.js';
import type {Context} from 'hono';
import type { Env } from '../worker-env.js';
import {getVisibleLineAccountScope} from './account-access.js';
import {inboxSlaSettings,refreshInboxSla,slaState,businessWindows} from './inbox-sla.js';
/** 期限による絞り込みもページを確定する前に行う。 */
export async function slaChatList(c:Context<Env>) {
 const scope=await getVisibleLineAccountScope(c.env.DB,c.get('staff'));
 const account=c.req.query('lineAccountId');
 const ids=account?scope.allowedAccountIds.filter(x=>x===account):scope.allowedAccountIds;
 for(const id of ids)await refreshInboxSla(c.env.DB,id);
 const clauses=['f.line_account_id IN(SELECT value FROM json_each(?))',"c.status!='resolved'",'s.sla_enabled=1','c.first_response_at IS NULL','c.sla_due_at IS NOT NULL'];
 const binds:unknown[]=[JSON.stringify(ids)];
 if(['overdue','soon'].includes(c.req.query('slaState')??'')){clauses.push(c.req.query('slaState')==='soon'?"julianday(c.sla_due_at)>julianday(?) AND julianday(c.sla_due_at)<=julianday(?,'+15 minutes')":'julianday(c.sla_due_at)<=julianday(?)');binds.push(new Date().toISOString());if(c.req.query('slaState')==='soon')binds.push(new Date().toISOString());}
 const operatorId=c.req.query('operatorId');
 if(operatorId){const filter=assigneeFilter('c',operatorId,true);clauses.push(filter.sql);binds.push(...filter.binds);}
 if(c.req.query('status')){clauses.push('c.status=?');binds.push(c.req.query('status'));}
 if(c.req.query('q')){clauses.push('instr(lower(f.display_name),lower(?))>0');binds.push(c.req.query('q'));}
 const join='FROM chats c JOIN friends f ON f.id=c.friend_id JOIN inbox_routing_settings s ON s.account_id=f.line_account_id';
 const total=await c.env.DB.prepare(`SELECT COUNT(*) n ${join} WHERE ${clauses.join(' AND ')}`).bind(...binds).first<{n:number}>();
 const due=c.req.query('beforeDueAt'),id=c.req.query('beforeId');
 if(due&&id){clauses.push('(julianday(c.sla_due_at)>julianday(?) OR (c.sla_due_at=? AND f.id>?))');binds.push(due,due,id);}
 const limit=Math.min(200,Math.max(1,listQueryNumber(c.req.query('limit'), Number.NaN)||50));
 const rows=(await c.env.DB.prepare(`SELECT c.*,(SELECT COUNT(*) FROM messages_log incoming LEFT JOIN inbox_staff_reads reads ON reads.channel='line' AND reads.conversation_id=c.friend_id AND reads.staff_id=? WHERE incoming.friend_id=c.friend_id AND incoming.direction='incoming' AND (incoming.delivery_type IS NULL OR incoming.delivery_type!='test') AND (reads.last_read_at IS NULL OR incoming.created_at>reads.last_read_at)) AS unread_count_for_staff,CASE WHEN c.assignee_staff_id IS NOT NULL THEN COALESCE((SELECT name FROM staff_members WHERE id=c.assignee_staff_id),'担当者不明') WHEN c.operator_id IS NOT NULL THEN COALESCE((SELECT name FROM operators WHERE id=c.operator_id),'担当者不明') END AS operator_name,(SELECT content FROM messages_log WHERE friend_id=c.friend_id ORDER BY created_at DESC LIMIT 1) last_message,f.display_name,f.picture_url,f.line_account_id,CASE WHEN json_valid(f.metadata) THEN json_extract(f.metadata, '$.__attention') = '1' ELSE 0 END AS is_attention ${join} WHERE ${clauses.join(' AND ')} ORDER BY julianday(c.sla_due_at),f.id LIMIT ?`).bind(c.get('staff').id,...binds,limit).all<Record<string,unknown>>()).results;
 const data=await enrichSlaChats(c.env.DB,rows.map(r=>({id:String(r.friend_id),friendId:r.friend_id,friendName:r.display_name,friendPictureUrl:r.picture_url,isAttention:Boolean(r.is_attention),operatorId:r.assignee_staff_id ? `staff:${r.assignee_staff_id}` : r.operator_id,operatorName:r.operator_name,status:r.status,revision:r.revision,lastMessageAt:r.last_message_at,lastMessage:r.last_message,isUnread:Number(r.unread_count_for_staff)>0,unreadCount:Number(r.unread_count_for_staff),unread:r.status==='unread',conversationId:r.id})));
 const responseItems = data;
 return c.json(buildOffsetListResponse({ success:true,data: responseItems,total:total?.n??0, items: responseItems, paging: { limit }, sort: [{ field: 'sla_due_at', direction: 'asc' }, { field: 'id', direction: 'asc' }] }));
}
export async function enrichSlaChats<T extends {id:string;friendId?:unknown}>(db:D1Database,items:T[]) {
 if(!items.length)return items;
 const rows=(await db.prepare(`SELECT c.friend_id,c.sla_due_at,c.first_response_at,c.assigned_by,f.line_account_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.friend_id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(items.map(r=>r.friendId??r.id))).all<{friend_id:string;sla_due_at:string|null;first_response_at:string|null;assigned_by:string|null;line_account_id:string}>()).results;
 const settings=new Map<string,{enabled:boolean;windows:Array<[number,number]>|null}>();
 for(const account of new Set(rows.map(r=>r.line_account_id))){const s=await inboxSlaSettings(db,account);settings.set(account,{enabled:s.enabled,windows:s.enabled&&s.businessHoursOnly?await businessWindows(db,account,new Date().toISOString()):null});}
 return items.map(item=>{const r=rows.find(r=>r.friend_id===(item.friendId??item.id)),s=r?settings.get(r.line_account_id):null;return {...item,slaDueAt:s?.enabled?r?.sla_due_at??null:null,slaState:slaState(r?.sla_due_at??null,s?.enabled??false,r?.first_response_at,Date.now(),s?.windows??null),assignedBy:r?.assigned_by??null};});
}
