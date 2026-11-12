import { restaurantFollowupEnabledRowsSql } from './restaurant-followup-enabled.js';
import type { RestaurantFollowupRow, RestaurantFollowupTrigger } from '@line-crm/shared';

const initialRows: Record<RestaurantFollowupTrigger, { offset: number; message: string }> = {
  reservation_created: { offset: 0, message: 'ご予約ありがとうございます。当日のご来店をお待ちしています。' },
  reservation_24h: { offset: -1440, message: '明日はご予約の日です。お気をつけてお越しください。' },
  reservation_2h: { offset: -120, message: '本日はご予約ありがとうございます。お待ちしています。' },
  post_visit: { offset: 180, message: '本日はご来店ありがとうございました。またのお越しをお待ちしています。' },
  review_request: { offset: 1440, message: 'よろしければ口コミの投稿をお願いします。' },
  waitlist_invited: { offset: 0, message: 'お席のご用意ができました。ご案内します。\nこの時間で予約する：{{var.waitlist_book_url}}\n今回は見送る：{{var.waitlist_decline_url}}' },
  anniversary_before: { offset: -10080, message: 'もうすぐ記念日ですね。お祝いのご用意はいかがですか。' },
};
export function restaurantFollowupInitialValues(trigger:RestaurantFollowupTrigger){return {...initialRows[trigger]};}
export function isRestaurantFollowupTrigger(value: unknown): value is RestaurantFollowupTrigger {
  return typeof value === 'string' && Object.hasOwn(initialRows, value);
}
/** 飲食以外へは接続しない。行だけを足し、既存本文・時期・承認には触れない。 */
export function restaurantFollowupSeedStatement(db: D1Database, selector: { storeId?: string; accountId?: string }) {
  return db.prepare(`INSERT OR IGNORE INTO rt_store_followup_rows(store_id,trigger,initial_key,step_id)
    SELECT s.id,k.value,k.value,(SELECT b.step_id FROM rt_store_followup_step_bindings b
      JOIN rt_store_followup_templates t ON t.store_id=b.store_id
      JOIN scenario_steps step ON step.id=b.step_id AND step.scenario_id=t.scenario_id
      WHERE b.store_id=s.id AND b.trigger=k.value ORDER BY b.step_id LIMIT 1)
    FROM rt_stores s,json_each(?) k WHERE (? IS NULL OR s.id=?) AND (? IS NULL OR s.line_account_id=?)`)
    .bind(JSON.stringify(Object.keys(initialRows)),selector.storeId??null,selector.storeId??null,selector.accountId??null,selector.accountId??null);
}
export async function readRestaurantFollowupRows(db: D1Database, storeId: string): Promise<RestaurantFollowupRow[]> {
  await restaurantFollowupSeedStatement(db,{storeId}).run();
  const rows=(await db.prepare('SELECT * FROM rt_store_followup_rows WHERE store_id=? ORDER BY trigger').bind(storeId).all<Omit<RestaurantFollowupRow,'default_offset_minutes'|'initial_message'>>()).results;
  const enabled=(await db.prepare(`SELECT trigger FROM (${restaurantFollowupEnabledRowsSql}) WHERE store_id=?`).bind(storeId).all<{trigger:string}>()).results;
  return rows.map(row=>({...row,enabled:enabled.some(item=>item.trigger===row.trigger),default_offset_minutes:initialRows[row.trigger].offset,initial_message:initialRows[row.trigger].message}));
}
function initialMessage(trigger: RestaurantFollowupTrigger) {
  const message=initialRows[trigger].message;
  if(trigger!=='reservation_24h')return {type:'text',content:message};
  // 予約確認の返事を本文の編集で失わないよう、既存の前日確認と同じ導線を持つ。
  return {type:'flex',content:JSON.stringify({type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:message,wrap:true}]},footer:{type:'box',layout:'vertical',contents:[
    {type:'button',action:{type:'postback',label:'行きます',data:'{{var.restaurant_going}}'}},
    {type:'button',action:{type:'postback',label:'変更したい',data:'{{var.restaurant_change}}'}},
    {type:'button',action:{type:'postback',label:'取り消す',data:'{{var.restaurant_cancel}}'}},
  ]}})};
}
/** 行のCASと本体の作成を同じbatchにする。失敗時は本体も結びも残さない。 */
export class RestaurantFollowupRowError extends Error {}
export async function setRestaurantFollowupRow(db: D1Database, storeId: string, trigger: RestaurantFollowupTrigger, expectedRowVersion: number, enabled: boolean) {
  const rows=await readRestaurantFollowupRows(db,storeId),row=rows.find(item=>item.trigger===trigger);
  if(!row||row.version!==expectedRowVersion)return null;
  const template=await db.prepare('SELECT scenario_id,template_version FROM rt_store_followup_templates WHERE store_id=?').bind(storeId).first<{scenario_id:string;template_version:number}>();
  const store=await db.prepare('SELECT line_account_id FROM rt_stores WHERE id=?').bind(storeId).first<{line_account_id:string|null}>();
  if(!store?.line_account_id)throw new RestaurantFollowupRowError('line_account_required');
  const scenarioId=template?.scenario_id??crypto.randomUUID(),stepId=row.step_id??crypto.randomUUID();
  const batch=[db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM rt_store_followup_rows r JOIN rt_stores s ON s.id=r.store_id
    WHERE r.store_id=? AND r.trigger=? AND r.version=? AND s.line_account_id IS NOT NULL)
    AND COALESCE((SELECT template_version FROM rt_store_followup_templates WHERE store_id=?),0)=?
    THEN '{}' ELSE 'FOLLOWUP_ROW_CONFLICT' END)`).bind(storeId,trigger,expectedRowVersion,storeId,template?.template_version??0)];
  if(enabled) {
    if(!template)batch.push(
      db.prepare(`INSERT INTO scenarios(id,name,description,trigger_type,is_active,line_account_id)
        SELECT ?,'LINE来店フォロー：'||name,'予約ごとの起点から送る共通シナリオ','manual',0,line_account_id FROM rt_stores WHERE id=?`).bind(scenarioId,storeId),
      db.prepare('INSERT INTO rt_store_followup_templates(store_id,scenario_id) VALUES(?,?)').bind(storeId,scenarioId),
    );
    if(!row.step_id) {
      const message=initialMessage(trigger);
      batch.push(
        db.prepare(`INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content,is_draft)
          SELECT ?,?,COALESCE(MAX(step_order)+1,0),?,?,0 FROM scenario_steps WHERE scenario_id=?`).bind(stepId,scenarioId,message.type,message.content,scenarioId),
        db.prepare('UPDATE scenarios SET content_revision=content_revision+1 WHERE id=? AND changes()>0').bind(scenarioId),
      );
    }
    batch.push(db.prepare(`INSERT INTO rt_store_followup_step_bindings(store_id,trigger,step_id,offset_minutes,enabled)
      SELECT ?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM rt_store_followup_step_bindings WHERE store_id=? AND trigger=? AND step_id=?)`)
      .bind(storeId,trigger,stepId,initialRows[trigger].offset,storeId,trigger,stepId));
  }
  if(row.step_id||enabled)batch.push(db.prepare(`UPDATE rt_store_followup_step_bindings SET enabled=?,version=version+1
    WHERE store_id=? AND trigger=? AND step_id=?`).bind(enabled?1:0,storeId,trigger,stepId));
  batch.push(db.prepare('UPDATE rt_store_followup_rows SET step_id=?,version=version+1 WHERE store_id=? AND trigger=?').bind(row.step_id||enabled?stepId:null,storeId,trigger));
  if(enabled)batch.push(db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM rt_store_followup_rows r
    JOIN rt_store_followup_templates t ON t.store_id=r.store_id
    JOIN scenario_steps st ON st.id=r.step_id AND st.scenario_id=t.scenario_id
    JOIN rt_store_followup_step_bindings b ON b.store_id=r.store_id AND b.trigger=r.trigger AND b.step_id=r.step_id
    WHERE r.store_id=? AND r.trigger=? AND b.enabled=1 AND t.sending_status='stopped')
    THEN '{}' ELSE 'FOLLOWUP_ROW_INCOMPLETE' END)`).bind(storeId,trigger));
  try { await db.batch(batch); }
  catch(error) {
    if(String(error).includes('malformed JSON'))return null;
    throw error;
  }
  return (await db.prepare('SELECT version,step_id FROM rt_store_followup_rows WHERE store_id=? AND trigger=?').bind(storeId,trigger).first<{version:number;step_id:string|null}>());
}
