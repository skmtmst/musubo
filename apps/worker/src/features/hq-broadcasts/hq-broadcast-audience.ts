import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { buildSegmentWhere } from '@line-crm/db';
import type { HqBroadcastInput, SegmentCondition, SegmentRule } from '@line-crm/shared';

import { StampError } from '../../services/visit-stamps.js';

/** 統括の条件には店のIDを固定しない。同じ名前を店ごとに一意に解決する。 */
export async function resolveHqBroadcastAudience(db: D1Database, tenantId: string, accountId: string, input: HqBroadcastInput): Promise<SegmentCondition> {
  if(!await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=?').bind(accountId,tenantId).first())throw new StampError('対象店の所属が変わりました',403);
  async function accountReference(table: 'tags'|'scenarios'|'saved_searches', value: unknown): Promise<string> {
    if(typeof value!=='string'||!value.trim()) throw new StampError('条件の名前を確認してください');
    const source=await db.prepare(`SELECT t.name FROM ${table} t JOIN line_accounts a ON a.id=t.line_account_id AND a.tenant_id=? WHERE t.id=?`).bind(tenantId,value).first<{name:string}>();
    const name=source?.name??value;
    const rows=(await db.prepare(`SELECT id FROM ${table} WHERE line_account_id=? AND name=? ${table==='tags'?"AND status='active'":''}`).bind(accountId,name).all<{id:string}>()).results;
    if(rows.length!==1) throw new StampError('同じ名前の条件が1件だけ見つかりません',409);
    return rows[0].id;
  }
  async function resolveRule(r:SegmentRule):Promise<SegmentRule> {
    let value=r.value;
    if(['tag_exists','tag_not_exists'].includes(r.type)) value=await accountReference('tags',value);
    if(['tag_all','tag_not_all'].includes(r.type)) {
      if(!Array.isArray(value)||value.length>100) throw new StampError('タグを確認してください');
      value=await Promise.all(value.map(v=>accountReference('tags',v)));
    }
    if(r.type==='scenario_subscribed'&&value!=='') value=await accountReference('scenarios',value);
    if(r.type==='scenario_state') {
      if(!value||typeof value!=='object'||Array.isArray(value)) throw new StampError('購読条件を確認してください');
      const v=value as Record<string,unknown>;value={...v,scenarioId:await accountReference('scenarios',v.scenarioId)};
    }
    // 個々の店でしか意味を持たない履歴IDは、統括の条件に持ち込まない。
    if(['analytics_audience','broadcast_link_clicked','friend_id_in','operator_id','form_answered','friend_field','support_mark'].includes(r.type))
      throw new StampError('この条件は配布先の店で指定してください',400);
    return {...r,value};
  }
  let totalRules=0;
  async function resolve(c:SegmentCondition,depth=0):Promise<SegmentCondition> {
    if(depth>8||!c||!['AND','OR'].includes(c.operator)||!Array.isArray(c.rules)||!Array.isArray(c.groups??[])) throw new StampError('詳細条件を確認してください');
    totalRules+=c.rules.length;if(totalRules>100) throw new StampError('条件は100件までです');
    return {operator:c.operator,rules:await Promise.all(c.rules.map(resolveRule)),...(c.groups?{groups:await Promise.all(c.groups.map(g=>resolve(g,depth+1)))}:{})};
  }
  const groups:SegmentCondition[]=[];
  if(input.segmentConditions) groups.push(await resolve(input.segmentConditions));
  if(input.savedSearchId) {
    const id=await accountReference('saved_searches',input.savedSearchId);
    const saved=await db.prepare(`SELECT conditions_json,condition_format FROM saved_searches WHERE id=? AND line_account_id=? AND scope='friends'`).bind(id,accountId).first<{conditions_json:string;condition_format:string}>();
    if(!saved||saved.condition_format!=='segment_v1') throw new StampError('配信対象として保存した条件を選んでください',400);
    const parsed=JSON.parse(saved.conditions_json);if(parsed.version!==1) throw new StampError('保存した条件を確認してください');
    // 保存条件はその店の中のIDで既に解決済み。IDを他店へ移さない。
    groups.push(await resolve(parsed.condition));
  }
  const rules:SegmentRule[]=[{type:'is_following',value:true}];
  if(input.followupOfRunId) {
    const source=await db.prepare(`SELECT b.id FROM hq_broadcast_runs r JOIN hq_broadcast_targets t ON t.run_id=r.id AND t.excluded=0
      JOIN broadcasts b ON b.id=t.broadcast_id AND b.line_account_id=t.line_account_id
      WHERE r.id=? AND r.tenant_id=? AND t.line_account_id=? AND b.status='sent' AND b.track_links=1
      AND EXISTS(SELECT 1 FROM broadcast_tracked_links l WHERE l.broadcast_id=b.id)`).bind(input.followupOfRunId,tenantId,accountId).first<{id:string}>();
    if(!source)throw new StampError('追送元の送信記録と計測リンクを確認してください',409);
    rules.push({type:'broadcast_link_clicked',value:{broadcastId:source.id,clicked:false}});
  }
  if(input.audience.kind==='tag')rules.push({type:'tag_exists',value:await accountReference('tags',input.audience.tagName)});
  else if(input.targetType==='tag')rules.push({type:'tag_exists',value:await accountReference('tags',input.targetTagId)});
  if(input.targetType==='segment'&&!input.segmentConditions&&!input.savedSearchId&&!input.followupOfRunId) throw new StampError('詳細条件を指定してください');
  for(const tag of input.excludedTagIds??[])rules.push({type:'tag_not_exists',value:await accountReference('tags',tag)});
  const condition:SegmentCondition={operator:'AND',rules,...(groups.length?{groups}:{})};
  try{buildSegmentWhere(condition);}catch{throw new StampError('詳細条件を確認してください');}
  return condition;
}
export async function countHqAudience(db:D1Database,accountId:string,condition:SegmentCondition) {
  const where=buildSegmentWhere(condition);
  const result=await db.prepare(`SELECT COALESCE(SUM(${DELIVERY_CONSENT_ALLOWED_SQL}),0) AS count,
    COALESCE(SUM(NOT (${DELIVERY_CONSENT_ALLOWED_SQL})),0) AS consentExcluded FROM friends f WHERE f.line_account_id=? AND COALESCE(f.is_hidden,0)=0
    AND f.line_platform_user_id IS NOT NULL AND f.line_platform_user_id<>'' AND (${where.sql})`).bind(accountId,...where.bindings).first<{count:number;consentExcluded:number}>();
  if (!result) throw new Error('audience_count_unavailable');
  return result;
}
