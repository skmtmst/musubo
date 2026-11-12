import { formMediaUsageStatements } from '@line-crm/db';
import { styleMenuActionData } from './style-menu-action-data.js';
import { initialMenuImageKey } from '@line-crm/shared';
import { initialFormLayout,initialFormScopeGuards } from './style-initial-form.js';
import type { PlannedInitialForms } from './style-initial-buttons.js';
import { publishedVersionStatement } from '@line-crm/db';
import { reminderReplacement } from './style-starter-reminder.js';
import { styleMenuButtons } from './style-menu-buttons.js';
import { profile } from './style-profile.js';
import type { AccountStyle, SetupAnswer } from '@line-crm/shared';
import type { StarterItem } from './style-starter-definition.js';
import { StyleError } from './style-setup-core.js';
import { friendAddWelcomeDefinition } from './style-starter-friend-add.js';
import { scenarioStepStatements } from './style-starter-samples.js';

export const resourceTables: Record<
  string,
  { table: string; account: string }
> = {
  template: { table: 'templates', account: 'line_account_id' },
  rich_menu: { table: 'rich_menu_groups', account: 'account_id' },
  reminder: { table: 'reminders', account: 'line_account_id' },
  automation: { table: 'automation_definitions', account: 'line_account_id' },
  booking_menu: { table: 'menus', account: 'line_account_id' },
  friend_add_rule: { table: 'friend_add_rules', account: 'line_account_id' },
  scenario: { table: 'scenarios', account: 'line_account_id' },
};
/** SQL の照合には、子行を含む編集内容と公開状態の両方を含める。 */
export function snapshotSql(kind: string) {
  const jsonRows = (table: string, where: string) =>
    `(SELECT json_group_array(json_object(${table === 'rich_menu_pages' ? "'id',id,'name',name,'image',image_r2_key,'order',order_index" : table === 'rich_menu_areas' ? "'id',id,'x',bounds_x,'y',bounds_y,'w',bounds_width,'h',bounds_height,'action',action_type,'intent',intent,'data',action_data,'label',label,'template',template_id,'form',form_id" : "'id',id,'status',status,'trigger',trigger_type,'config',trigger_config,'conditions',condition_config,'actions',action_config"})) FROM ${table} WHERE ${where})`;
  if (kind === 'dashboard')
    return `(SELECT json_object('cards',cards_json) FROM account_styles WHERE line_account_id=? AND line_account_id=?)`;
  if (kind === 'form')
    return `(SELECT json_object('id',id,'name',name,'description',description,'fields',fields,'layout',layout,'active',is_active,'status',status,'revision',content_revision,'published',current_published_version_id) FROM forms r WHERE id=? AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=r.id AND a.line_account_id=?) AND (SELECT COUNT(*) FROM form_accounts a WHERE a.form_id=r.id)=1)`;
  // タグの見本は行を持たない。店が触れる物が無いので、いつも同じ値（＝手を加えていない）。
  if (kind === 'tag_set')
    return `(SELECT json_object('heldTagSet',?,'account',?))`;
  const r = resourceTables[kind];
  if (!r) throw new StyleError('invalid_resource');
  if (kind === 'scenario')
    return `(SELECT json_object('name',name,'description',description,'trigger',trigger_type,'active',is_active,'published',current_published_version_id,'updated',updated_at,'steps',(SELECT json_group_array(json_object('id',s.id,'order',s.step_order,'delay',s.delay_minutes,'type',s.message_type,'content',s.message_content,'draft',s.is_draft)) FROM scenario_steps s WHERE s.scenario_id=r.id),'triggers',(SELECT COUNT(*) FROM scenario_triggers t WHERE t.scenario_id=r.id)) FROM scenarios r WHERE id=? AND line_account_id=?)`;
  if (kind === 'reminder')
    return `(SELECT json_object('name',name,'active',is_active,'status',lifecycle_status,'draft',current_draft_version_id,'published',current_published_version_id,'updated',updated_at,'versions',(SELECT json_group_array(json_object('id',v.id,'settings',v.settings_snapshot,'status',v.status,'steps',(SELECT json_group_array(json_object('id',s.id,'offset',s.offset_minutes,'content',s.message_content)) FROM reminder_version_steps s WHERE s.reminder_version_id=v.id))) FROM reminder_versions v WHERE v.reminder_id=r.id)) FROM reminders r WHERE id=? AND line_account_id=?)`;
  if (kind === 'friend_add_rule')
    return `(SELECT json_object('status',status,'lock',lock_version,'current',current_version_id,'archived',archived_at,'versions',(SELECT json_group_array(json_object('id',v.id,'status',v.status,'definition',v.definition_snapshot)) FROM friend_add_rule_versions v WHERE v.rule_id=r.id)) FROM friend_add_rules r WHERE id=? AND line_account_id=?)`;
  const fields =
    kind === 'template'
      ? "'id',id,'name',name,'content',message_content,'type',message_type,'draft',draft_message_content,'bubbles',message_bubbles_json,'draftBubbles',draft_message_bubbles_json,'updated',updated_at,'published',published_version,'draftRevision',draft_revision,'folder',folder_id,'question',question_json,'draftQuestion',draft_question_json,'carousel',carousel_actions_json,'draftCarousel',draft_carousel_actions_json"
      : kind === 'booking_menu'
        ? "'id',id,'name',name,'duration',duration_minutes,'price',base_price,'active',is_active,'version',version,'deleted',deleted_at"
        : kind === 'rich_menu'
          ? `'id',id,'name',name,'status',status,'updated',updated_at,'version',version,'chat',chat_bar_text,'size',size,'folder',folder_id,'target',targeting_condition,'priority',targeting_priority,'enabled',targeting_enabled,'defaultOpen',default_open,'pages',${jsonRows('rich_menu_pages', 'group_id=r.id')},'areas',${jsonRows('rich_menu_areas', 'page_id IN(SELECT id FROM rich_menu_pages WHERE group_id=r.id)')}`
          : `'id',id,'name',name,'status',status,'updated',updated_at,'draft',current_draft_version_id,'published',current_published_version_id,'versions',${jsonRows('automation_versions', 'automation_id=r.id')}`;
  return `(SELECT json_object(${fields}) FROM ${r.table} r WHERE id=? AND ${r.account}=?)`;
}
export async function resourceSnapshot(
  db: D1Database,
  account: string,
  kind: string,
  id: string,
) {
  return (
    (
      await db
        .prepare(`SELECT ${snapshotSql(kind)} snapshot`)
        .bind(kind === 'dashboard' ? account : id, account)
        .first<{ snapshot: string | null }>()
    )?.snapshot ?? null
  );
}
export function snapshotGuard(
  db: D1Database,
  account: string,
  kind: string,
  id: string,
  expected: string | null,
) {
  return db
    .prepare(
      `SELECT json(CASE WHEN ${snapshotSql(kind)} IS ? THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
    )
    .bind(kind === 'dashboard' ? account : id, account, expected);
}
export function recordSnapshot(
  db: D1Database,
  account: string,
  style: string,
  key: string,
  kind: string,
  id: string,
) {
  return db
    .prepare(
      `UPDATE style_starter_items SET source_snapshot=${snapshotSql(kind)} WHERE line_account_id=? AND style=? AND item_key=?`,
    )
    .bind(kind === 'dashboard' ? account : id, account, account, style, key);
}
export async function overwriteResource(
  db: D1Database,
  account: string,
  id: string,
  item: StarterItem,
  now: string,
  style?: AccountStyle,
  answersOverride?: Record<string, SetupAnswer>,
  plannedForms?: PlannedInitialForms,
) {
  const name = '【見本】' + item.name;
  if (item.kind === 'template') {
    const current = await db
      .prepare(
        'SELECT published_version FROM templates WHERE id=? AND line_account_id=?',
      )
      .bind(id, account)
      .first<{ published_version: number }>();
    if (!current) throw new StyleError('not_found', 404);
    const statements: D1PreparedStatement[] = [];
    if (
      !(await db
        .prepare(
          'SELECT 1 FROM template_versions WHERE template_id=? AND version_number=?',
        )
        .bind(id, current.published_version)
        .first())
    ) {
      statements.push(
        db
          .prepare(
            'UPDATE templates SET confirmation_revision=confirmation_revision+1, name=name WHERE id=? AND line_account_id=?',
          )
          .bind(id, account),
        publishedVersionStatement(db, id, current.published_version, {}, now),
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE templates SET confirmation_revision=confirmation_revision+1, name=?,message_type='text',message_content=?,message_bubbles_json=NULL,carousel_actions_json=NULL,question_json=NULL,question_status='published',
      draft_message_type=NULL,draft_message_content=NULL,draft_message_bubbles_json=NULL,draft_carousel_actions_json=NULL,draft_carousel_tap_limit_mode=NULL,draft_carousel_tap_limit_text=NULL,draft_question_json=NULL,draft_question_status=NULL,draft_revision=0,
      published_version=published_version+1,published_at=?,updated_at=? WHERE id=? AND line_account_id=?`,
        )
        .bind(
          name,
          item.text ?? item.name,
          now,
          now,
          id,
          account,
        ),
      publishedVersionStatement(db, id, current.published_version + 1, {}, now),
    );
    return statements;
  }
  if (item.kind === 'form') {
    if(!style || !item.formTarget) throw new StyleError('invalid_initial_form');
    const current=await db.prepare(`SELECT f.layout FROM forms f WHERE f.id=? AND f.is_active=0 AND f.status='active'
      AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=f.id AND a.line_account_id=?)
      AND (SELECT COUNT(*) FROM form_accounts a WHERE a.form_id=f.id)=1`).bind(id,account).first<{layout:string|null}>();
    if(!current)return [];
    const definition=await initialFormLayout(db,account,style,item.formTarget),layout=JSON.stringify(definition);
    if(layout===current.layout)return [];
    return [...initialFormScopeGuards(db,account,definition),db.prepare('UPDATE forms SET layout=?,content_revision=content_revision+1,updated_at=? WHERE id=? AND is_active=0').bind(layout,now,id), ...formMediaUsageStatements(db, id)];
  }
  if (item.kind === 'booking_menu')
    return [
      db
        .prepare(
          `UPDATE menus SET name=?,duration_minutes=?,base_price=?,is_active=0,version=version+1 WHERE id=? AND line_account_id=?`,
        )
        .bind(name, item.durationMinutes ?? 60, item.price ?? 0, id, account),
    ];
  if (item.kind === 'dashboard')
    return [
      db
        .prepare(
          'UPDATE account_styles SET cards_json=?,version=version+1 WHERE line_account_id=?',
        )
        .bind(JSON.stringify(item.cards ?? []), account),
    ];
  if (item.kind === 'reminder')
    return reminderReplacement(db, account, id, item, now);
  if (item.kind === 'automation') {
    const version = crypto.randomUUID();
    return [
      db
        .prepare(
          `INSERT INTO automation_versions(id,automation_id,version_number,status,trigger_type,trigger_config,condition_config,action_config) SELECT ?,?,COALESCE(MAX(version_number),0)+1,'draft',?,'{}','{}',? FROM automation_versions WHERE automation_id=?`,
        )
        .bind(
          version,
          id,
          item.triggerType ?? 'calendar_booked',
          JSON.stringify([
            {
              id: 'message',
              type: 'send_message',
              params: { messageType: 'text', content: item.text ?? item.name },
              onFailure: 'stop',
            },
          ]),
          id,
        ),
      db
        .prepare(
          `UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, name=?,status='draft',current_draft_version_id=?,updated_at=? WHERE id=? AND line_account_id=?`,
        )
        .bind(name, version, now, id, account),
    ];
  }
  if (item.kind === 'rich_menu') {
    const statements = [
      db
        .prepare(
          `UPDATE rich_menu_groups SET name=?,status='draft',version=version+1,confirmation_revision=confirmation_revision+1,updated_at=? WHERE id=? AND account_id=?`,
        )
        .bind(name, now, id, account),
      db
        .prepare(
          `DELETE FROM rich_menu_areas WHERE page_id IN(SELECT id FROM rich_menu_pages WHERE group_id=? AND group_id IN(SELECT id FROM rich_menu_groups WHERE account_id=?))`,
        )
        .bind(id, account),
    ];
    const p = await profile(db, account);
    const buttons = await styleMenuButtons(db, account, style ?? p?.style ?? 'standard', item, answersOverride ?? JSON.parse(p?.answers_json ?? '{}'), plannedForms);
    for (const [i, button] of buttons.entries()) {
      const bounds=button.bounds??{x:(i%3)*833,y:Math.floor(i/3)*843,width:833,height:843};
      statements.push(db.prepare(`INSERT INTO rich_menu_areas(id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,action_data,intent,label,form_id)
        SELECT ?,default_page_id,?,?,?,?,?,?,?,?,? FROM rich_menu_groups WHERE id=? AND account_id=?`)
        .bind(crypto.randomUUID(),bounds.x,bounds.y,bounds.width,bounds.height,button.actionType,styleMenuActionData(button),button.intent,button.label,button.formId??null,id,account));
    }
    if(item.initialMenu) statements.push(db.prepare(`UPDATE rich_menu_pages SET image_r2_key=?,image_content_type='image/png' WHERE id=(SELECT default_page_id FROM rich_menu_groups WHERE id=? AND account_id=?)`)
      .bind(initialMenuImageKey(account,item.initialMenu),id,account));
    return statements;
  }
  if (item.kind === 'tag_set')
    // 見本の名前を初期セットの組から読むので、書き換える行が無い。
    return [];
  if (item.kind === 'scenario')
    // 手を加えていない止めた見本だけが来る（照合は呼ぶ側）。止めたまま、名前と通数を差し替える。
    return [
      db
        .prepare(
          `UPDATE scenarios SET content_revision = content_revision + 1, name=?,is_active=0,updated_at=? WHERE id=? AND line_account_id=?`,
        )
        .bind(name, now, id, account),
      db
        .prepare(
          `DELETE FROM scenario_steps WHERE scenario_id=? AND scenario_id IN(SELECT id FROM scenarios WHERE id=? AND line_account_id=?)`,
        )
        .bind(id, id, account),
      ...scenarioStepStatements(db, id, item, now),
    ];
  if (item.kind === 'friend_add_rule')
    // 下書きの文だけを差し替える。公開済みの版・受け皿の状態は触らない。
    return [
      db
        .prepare(
          `UPDATE friend_add_rule_versions SET definition_snapshot=?,last_test_status=NULL,last_tested_at=NULL,last_tested_by_staff_id=NULL,updated_at=? WHERE rule_id=? AND status='draft' AND rule_id IN(SELECT id FROM friend_add_rules WHERE id=? AND line_account_id=?)`,
        )
        .bind(JSON.stringify(friendAddWelcomeDefinition(item)), now, id, id, account),
    ];
  throw new StyleError('invalid_resource');
}
