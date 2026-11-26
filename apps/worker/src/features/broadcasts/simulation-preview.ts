import { GapError } from '../../services/gap-common.js';
export type BroadcastPurpose='transaction'|'notice'|'marketing';

export const audience=`f.line_account_id=b.line_account_id AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND COALESCE(f.line_platform_user_id,'')<>'' AND (b.target_type='all' OR b.target_type='tag' AND EXISTS(SELECT 1 FROM friend_tags t WHERE t.friend_id=f.id AND t.tag_id=b.target_tag_id))`;

export const permitted=`NOT EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.line_account_id=f.line_account_id AND c.friend_id=f.id AND c.state='revoked' AND c.purpose IN(SELECT value FROM json_each(CASE x.purpose WHEN 'transaction' THEN '["transaction","transactional","reservation"]' WHEN 'notice' THEN '["notice","notification"]' ELSE '["marketing","promotion","advertising","宣伝"]' END)))`;

export async function simulationContext(db:D1Database,id:string){const row=await db.prepare('SELECT * FROM broadcast_execution_contexts WHERE broadcast_id=?').bind(id).first<Record<string,unknown>>();return row?.execution_mode==='simulation'?row:null;}

export async function simulationPreview(db:D1Database,id:string){
 const row=await db.prepare(`SELECT b.lock_version version,x.purpose,x.execution_mode executionMode,x.created_via createdVia,x.state,
 (SELECT COUNT(*) FROM friends f WHERE ${audience}) matched,
 (SELECT COUNT(*) FROM friends f WHERE ${audience} AND ${permitted}) recipients,
 (SELECT count(*) FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.error_code='simulation_only') simulated
 FROM broadcasts b JOIN broadcast_execution_contexts x ON x.broadcast_id=b.id WHERE b.id=?`).bind(id).first<{version:number;purpose:BroadcastPurpose;executionMode:string;createdVia:string;state:string;matched:number;recipients:number;simulated:number}>();if(!row)throw new GapError('not_found',404);
 return {...row,optedOut:row.matched-row.recipients,sent:0,testMode:true};
}
