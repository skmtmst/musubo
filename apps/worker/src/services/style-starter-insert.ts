import { formMediaUsageStatements } from '@line-crm/db';
import { styleMenuActionData } from './style-menu-action-data.js';
import { planInitialMenuHistory } from './style-initial-assets.js';
import { initialMenuImageKey } from '@line-crm/shared';
import { initialFormLayout,initialFormScopeGuards } from './style-initial-form.js';
import { initialMenuNeedsRefresh } from './style-initial-refresh.js';
import type { PlannedInitialForms } from './style-initial-buttons.js';
import { sameStarterSnapshot } from './style-starter-snapshot.js';
import {prepareStarterInsert} from './style-starter-insert-context.js';
import { styleMenuButtons } from './style-menu-buttons.js';
import { friendAddStarterStatements } from './style-starter-friend-add.js';
import { scenarioStepStatements, starterTagSetTarget } from './style-starter-samples.js';
import {
  recordSnapshot,
  resourceSnapshot,
  overwriteResource,
  snapshotGuard,
} from './style-starter-resource.js';
import { type AccountStyle, type SetupAnswer } from '@line-crm/shared';

import { profile } from './style-profile.js';
import type { starter } from './style-starter-set.js';
import { StyleError, readCards, defaultCards } from './style-setup-core.js';
/** 入れなかった理由。画面がそのまま札に使うので、決まった値だけを返す。 */
export type StarterSkipReason = 'answer_later' | 'not_for_style' | 'auto_insert_off' | 'already_exists';
export type StarterSkip = { key: string; reason: StarterSkipReason };
export async function insertStyleStarterItems(
  db: D1Database,
  account: string,
  tenant: string | null,
  actor: string,
  input: Record<string, unknown>,
  selected: boolean,
  style: AccountStyle,
  answers: Record<string, SetupAnswer>,
  statements: D1PreparedStatement[],
  now: string,
  options: {
    set?: Awaited<ReturnType<typeof starter>>;
    skipExisting?: boolean;
    plannedForms?: PlannedInitialForms;
  } = {},
) {
  const {set,existing,oldProfile,choice}=await prepareStarterInsert(db,account,tenant,style,input,{...options,initialMenu:!options.set && answers.image?.value === 'simple'});
  const inserted:unknown[]=[];
  const updated:Array<{key:string;kind:string}>=[];
  const plannedForms:PlannedInitialForms=options.plannedForms??new Map(existing.filter(row=>row.kind==='form').map(row=>[row.item_key,row.target_id]));
  if(input.confirmInitialMenu===true && selected && style==='restaurant' && answers.image?.value==='simple' && set.definition.items.some(item=>item.initialMenu))
    await planInitialMenuHistory(db,account,statements,plannedForms,actor);
  const skipped:StarterSkip[]=[];
  const skip=(key:string,reason:StarterSkipReason)=>{skipped.push({key,reason});};
  // スタイルを選んでいない（あとで・手動）時は何も入れない。黙って飛ばさず理由を返す。
  if (!selected) for (const item of set.definition.items) skip(item.key,'answer_later');
  const ordered=[...set.definition.items.filter(item=>item.kind==='form'),...set.definition.items.filter(item=>item.kind!=='form')];
  for (const item of selected ? ordered : []) {
    if ((item.initialMenu && answers.image?.value!=='simple' && !choice?.[item.key])
      || (item.kind==='rich_menu' && (!answers.image || answers.image.mode!=='configured'))
      || (item.kind==='form' && answers.image?.value!=='simple')) { skip(item.key,'answer_later');continue; }
    if (item.kind === 'booking_menu' && !['salon', 'consult'].includes(style)) {
      skip(item.key,'not_for_style');
      continue;
    }
    if (!set.autoInsert && !choice?.[item.key] && !(answers.image?.value==='simple' && (item.kind==='form'||item.initialMenu))) {
      skip(item.key,'auto_insert_off');
      continue;
    }
    const previous=existing.find(row=>row.item_key===item.key);
    if(item.kind==='form'&&previous&&((input.answers as Record<string,SetupAnswer>|undefined)?.image?.value==='simple'||input.confirmInitialMenu===true)) {
      const available=await db.prepare(`SELECT 1 FROM forms f WHERE f.id=? AND f.status='active'
        AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=f.id AND a.line_account_id=?) AND (SELECT COUNT(*) FROM form_accounts a WHERE a.form_id=f.id)=1`).bind(previous.target_id,account).first();
      if(!available) {
        const snapshot=await resourceSnapshot(db,account,previous.kind,previous.target_id);
        statements.push(snapshotGuard(db,account,previous.kind,previous.target_id,snapshot),
          db.prepare("UPDATE style_starter_items SET item_key=item_key||':previous:'||target_id WHERE line_account_id=? AND item_key=?").bind(account,item.key));
        existing.splice(existing.indexOf(previous),1);
      }
    }

    if(item.initialMenu && previous && ((input.answers as Record<string,SetupAnswer>|undefined)?.image?.value==='simple' || (oldProfile?.style!==style && answers.image?.value==='simple'))) {
      const snapshot=await resourceSnapshot(db,account,previous.kind,previous.target_id);
      const canonical=await db.prepare(`SELECT 1 FROM rich_menu_groups g JOIN rich_menu_pages p ON p.id=g.default_page_id
        WHERE g.id=? AND g.account_id=? AND g.status='draft' AND p.image_r2_key=?
        AND (SELECT COUNT(*) FROM rich_menu_areas a WHERE a.page_id=p.id)=4`).bind(previous.target_id,account,initialMenuImageKey(account,style)).first();
      if(!canonical || !sameStarterSnapshot(previous.kind,snapshot,previous.source_snapshot)) {
        statements.push(snapshotGuard(db,account,previous.kind,previous.target_id,snapshot));
        statements.push(db.prepare("UPDATE style_starter_items SET item_key=item_key||':previous:'||target_id WHERE line_account_id=? AND item_key=?").bind(account,item.key));
        existing.splice(existing.indexOf(previous),1);
      }
    }
    if (
      options.skipExisting !== false &&
      existing.some((e) => e.item_key === item.key)
    ) {
      if (!choice?.[item.key] || choice[item.key].mode === 'sample') {
        const old = existing.find((e) => e.item_key === item.key)!;
        if(old.is_sample && old.source_snapshot && (item.kind==='form'||item.initialMenu)) {
          const snapshot=await resourceSnapshot(db,account,old.kind,old.target_id);
          if(sameStarterSnapshot(old.kind,snapshot,old.source_snapshot)) {
            const refresh=item.kind==='form'||await initialMenuNeedsRefresh(db,account,old.target_id,style,plannedForms);
            const changes=refresh?await overwriteResource(db,account,old.target_id,item,now,style,answers,plannedForms):[];
            if(changes.length) {
              statements.push(snapshotGuard(db,account,old.kind,old.target_id,snapshot),...changes,
                recordSnapshot(db,account,old.style,item.key,old.kind,old.target_id));
              updated.push({key:item.key,kind:item.kind});
            }
          }
        }
        // スタイルをまたいでも未編集の同じリソースを使い、業種内容だけを更新する。
        if (
          oldProfile?.style !== style &&
          !item.initialMenu &&
          old.kind === item.kind &&
          old.is_sample &&
          old.source_snapshot &&
          ['template', 'rich_menu'].includes(item.kind) &&
          (!answers.content || (answers.content.mode === 'configured' && answers.content.value !== false))
        ) {
          const snapshot = await resourceSnapshot(
            db,
            account,
            old.kind,
            old.target_id,
          );
          if (sameStarterSnapshot(old.kind, snapshot, old.source_snapshot)) {
            statements.push(
              snapshotGuard(db, account, old.kind, old.target_id, snapshot),
            );
            statements.push(
              ...(await overwriteResource(
                db,
                account,
                old.target_id,
                item,
                now,
                style,
                answers,
              )),
            );
            statements.push(
              db
                .prepare(
                  'UPDATE style_starter_items SET set_id=?,set_version=? WHERE line_account_id=? AND item_key=?',
                )
                .bind(set.id, set.version, account, item.key),
            );
            statements.push(
              recordSnapshot(
                db,
                account,
                old.style,
                item.key,
                old.kind,
                old.target_id,
              ),
            );
          }
        }
        skip(item.key,'already_exists');
        continue;
      }
      statements.push(
        db
          .prepare(
            'DELETE FROM style_starter_items WHERE line_account_id=? AND item_key=?',
          )
          .bind(account, item.key),
      );
    }
    if (
      ['template', 'rich_menu'].includes(item.kind) && !item.initialMenu &&
      answers.content &&
      (answers.content.mode !== 'configured' || answers.content.value === false)
    ) {
      skip(item.key,'answer_later');
      continue;
    }
    const intrinsicFeature =
      item.kind === 'booking_menu'
        ? 'booking'
        : ['automation', 'reminder'].includes(item.kind)
          ? 'reminders'
          : undefined;
    const requiredFeatures = [item.feature, intrinsicFeature].filter(
      (feature): feature is string => !!feature,
    );
    if (
      requiredFeatures.some(
        (feature) =>
          answers[feature]?.mode !== 'configured' ||
          answers[feature]?.value === false,
      )
    ) {
      skip(item.key,'answer_later');
      continue;
    }
    const chosen = choice?.[item.key];
    if (chosen && !['sample', 'existing', 'configured'].includes(chosen.mode))
      throw new StyleError('invalid_choices');
    let id = crypto.randomUUID(),
      sample = true;
    const table =
      item.kind === 'template'
        ? 'templates'
        : item.kind === 'rich_menu'
          ? 'rich_menu_groups'
          : item.kind === 'automation'
            ? 'automation_definitions'
            : item.kind === 'reminder'
              ? 'reminders'
              : item.kind === 'booking_menu'
                ? 'menus'
                : item.kind === 'scenario'
                  ? 'scenarios'
                  : null;
    const accountColumn =
      item.kind === 'rich_menu' ? 'account_id' : 'line_account_id';
    if (chosen && chosen.mode !== 'sample') {
      if ((!table && item.kind!=='form') || !chosen.resourceId)
        throw new StyleError('invalid_resource');
      const source = item.kind==='form' ? await db.prepare(`SELECT f.id FROM forms f JOIN form_accounts a ON a.form_id=f.id WHERE f.id=? AND a.line_account_id=? AND f.status!='archived' AND (SELECT COUNT(*) FROM form_accounts b WHERE b.form_id=f.id)=1`).bind(chosen.resourceId,account).first<{id:string}>() : await db
        .prepare(`SELECT id FROM ${table} WHERE id=? AND ${accountColumn}=?`)
        .bind(chosen.resourceId, account)
        .first<{ id: string }>();
      if (!source) throw new StyleError('resource_not_found', 404);
      id = source.id;
      sample = false;
      if(item.kind==='form')plannedForms.set(item.key,id);
    } else if (item.sourceId) {
      // アカウント間の複製は統括の既存配布へ委ね、生きた ID をそのままコピーしない。
      throw new StyleError('use_hq_distribution_for_source', 422);
    } else if (item.kind === 'form') {
      if(!item.formTarget) throw new StyleError('invalid_initial_form');
      const definition=await initialFormLayout(db,account,style,item.formTarget),layout=JSON.stringify(definition);
      statements.push(...initialFormScopeGuards(db,account,definition));
      statements.push(db.prepare(`INSERT INTO forms(id,name,description,fields,layout,is_active,save_to_metadata) VALUES(?,?,?,'[]',?,0,0)`)
        .bind(id,item.name,null,layout),
        db.prepare('INSERT INTO form_accounts(form_id,line_account_id) VALUES(?,?)').bind(id,account), ...formMediaUsageStatements(db, id));
      plannedForms.set(item.key,id);
    } else if (item.kind === 'template')
      statements.push(
        db
          .prepare(
            `INSERT INTO templates(id,line_account_id,name,message_type,message_content) VALUES(?,?,?,'text',?)`,
          )
          .bind(
            id,
            account,
            '【見本】' + item.name,
            item.text ?? item.name,
          ),
      );
    else if (item.kind === 'automation') {
      const draftId = crypto.randomUUID();
      statements.push(
        db
          .prepare(
            `INSERT INTO automation_definitions(id,line_account_id,name,status,created_by) VALUES(?,?,?,'draft',?)`,
          )
          .bind(id, account, '【見本】' + item.name, actor),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO automation_versions(id,automation_id,version_number,status,trigger_type,trigger_config,condition_config,action_config,created_by) VALUES(?,?,1,'draft',?,'{}','{}',?,?)`,
          )
          .bind(
            draftId,
            id,
            item.triggerType ?? 'calendar_booked',
            JSON.stringify([
              {
                id: 'message',
                type: 'send_message',
                params: {
                  messageType: 'text',
                  content: item.text ?? item.name,
                },
                onFailure: 'stop',
              },
            ]),
            actor,
          ),
      );
      statements.push(
        db
          .prepare(
            'UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_draft_version_id=? WHERE id=?',
          )
          .bind(draftId, id),
      );
    } else if (item.kind === 'reminder') {
      const v = crypto.randomUUID(),
        step = crypto.randomUUID();
      const settings = {
        stopConditions: {
          bookingCancelled: true,
          supportMarkCompleted: false,
          daysAfterTarget: null,
          friendBlocked: true,
        },
        steps: [
          {
            stableStepId: step,
            offsetDays: item.offsetDays ?? null,
            sendAtTime: item.sendAtTime ?? null,
            offsetMinutes: item.offsetMinutes ?? -1440,
            messageType: 'text',
            messageContent: item.text ?? item.name,
          },
        ],
        lineAccountId: account,
        name: '【見本】' + item.name,
        description: null,
        triggerType: style === 'lesson' ? 'event' : 'booking',
        triggerOffsetMinutes: null,
        sendAtTime: null,
        targetTagId: null,
        folderId: null,
        deliveryMode: 'countdown',
        triggerFieldId: null,
        repeatYearly: false,
        leapYearPolicy: 'mar1',
        triggerEventId: null,
        isActive: false,
      };
      statements.push(
        db
          .prepare(
            `INSERT INTO reminders(id,line_account_id,name,is_active,lifecycle_status,trigger_type,current_draft_version_id) VALUES(?,?,?,0,'draft',?,?)`,
          )
          .bind(id, account, settings.name, settings.triggerType, v),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO reminder_versions(id,reminder_id,version_number,status,settings_snapshot,created_at,updated_at) VALUES(?,?,1,'draft',?,?,?)`,
          )
          .bind(v, id, JSON.stringify(settings), now, now),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO reminder_version_steps(id,reminder_version_id,stable_step_id,position,offset_minutes,offset_days,send_at_time,message_type,message_content,created_at) VALUES(?,?,?,0,?,?,?,'text',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            v,
            step,
            item.offsetMinutes ?? -1440,
            item.offsetDays ?? null,
            item.sendAtTime ?? null,
            item.text ?? item.name,
            now,
          ),
      );
    } else if (item.kind === 'booking_menu')
      statements.push(
        db
          .prepare(
            `INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,is_active) VALUES(?,?,?,?,?,0)`,
          )
          .bind(
            id,
            account,
            '【見本】' + item.name,
            item.durationMinutes ?? 60,
            item.price ?? 0,
          ),
      );
    else if (item.kind === 'rich_menu') {
      const page = crypto.randomUUID();
      statements.push(
        db
          .prepare(
            `INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size,status) VALUES(?,?,?,'メニュー','large','draft')`,
          )
          .bind(id, account, '【見本】' + item.name),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO rich_menu_pages(id,group_id,order_index,name,alias_id) VALUES(?,?,0,'メニュー',?)`,
          )
          .bind(page, id, 'style-' + page),
      );
      if(item.initialMenu) {
        statements.push(db.prepare("UPDATE rich_menu_pages SET image_r2_key=?,image_content_type='image/png' WHERE id=?").bind(initialMenuImageKey(account,style),page));
      } else if (answers.image?.mode === 'configured' && answers.image.resourceId) {
        const image = await db
          .prepare(
            `SELECT p.image_r2_key,p.image_content_type FROM rich_menu_pages p JOIN rich_menu_groups g ON g.id=p.group_id WHERE p.id=? AND g.account_id=? AND p.image_r2_key IS NOT NULL`,
          )
          .bind(answers.image.resourceId, account)
          .first<{ image_r2_key: string; image_content_type: string | null }>();
        if (!image) throw new StyleError('image_not_found', 404);
        statements.push(
          db
            .prepare(
              'UPDATE rich_menu_pages SET image_r2_key=?,image_content_type=? WHERE id=?',
            )
            .bind(image.image_r2_key, image.image_content_type, page),
        );
      }
      const buttons=await styleMenuButtons(db,account,style,item,answers,plannedForms);
      for (const [i,button] of buttons.entries()) {
        const bounds=button.bounds??{x:(i%3)*833,y:Math.floor(i/3)*843,width:833,height:843};
        statements.push(db.prepare(`INSERT INTO rich_menu_areas(id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,action_data,intent,label,form_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(crypto.randomUUID(),page,bounds.x,bounds.y,bounds.width,bounds.height,button.actionType,styleMenuActionData(button),button.intent,button.label,button.formId??null));
      }
      statements.push(
        db
          .prepare('UPDATE rich_menu_groups SET default_page_id=? WHERE id=?')
          .bind(page, id),
      );
    } else if (item.kind === 'tag_set') {
      // 本物のタグはまだ作らない。作ると③が押さずに「済み」になり、同じ名前のタグも作れなくなる。
      id = starterTagSetTarget(item.key);
    } else if (item.kind === 'scenario') {
      // 止めた下書き。きっかけを持たせず、友だち追加の決まりにもつながないので、だれも入らない。
      statements.push(
        db
          .prepare(
            `INSERT INTO scenarios(id,name,description,trigger_type,is_active,allow_concurrent,line_account_id,created_at,updated_at) VALUES(?,?,?,'manual',0,1,?,?,?)`,
          )
          .bind(id, '【見本】' + item.name, '友だち追加から始める見本です。動かすまで、だれにも届きません。', account, now, now),
        ...scenarioStepStatements(db, id, item, now),
      );
    } else if (item.kind === 'friend_add_rule') {
      const prepared = await friendAddStarterStatements(db, account, item, now);
      // 受け皿に店の設定か下書きが既にある。上書きせず、黙って落とさずに理由を返す。
      if (!prepared) {
        skip(item.key,'already_exists');
        continue;
      }
      id = prepared.id;
      statements.push(...prepared.statements);
    } else if (item.kind === 'dashboard')
      statements.push(
        db
          .prepare(
            'UPDATE account_styles SET cards_json=? WHERE line_account_id=? AND cards_json IS NULL',
          )
          .bind(
            JSON.stringify(readCards(item.cards ?? defaultCards(style), style)),
            account,
          ),
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO style_starter_items(line_account_id,style,item_key,kind,target_id,is_sample,feature,set_id,set_version,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          account,
          style,
          item.key,
          item.kind,
          id,
          Number(sample),
          item.feature ?? intrinsicFeature ?? null,
          set.id,
          set.version,
          now,
        ),
    );
    statements.push(
      recordSnapshot(db, account, style, item.key, item.kind, id),
    );
    inserted.push({
      key: item.key,
      name: item.name,
      definition: item,
      setId: set.id,
      setVersion: set.version,
      kind: item.kind,
      id,
      isSample: sample,
      requiresActivation:
        item.kind === 'automation' ||
        item.kind === 'reminder' ||
        item.kind === 'friend_add_rule' ||
        item.kind === 'tag_set' ||
        item.kind === 'scenario' ||
        item.kind === 'booking_menu' ||
        item.kind === 'rich_menu',
    });
  }
  if (inserted.length) statements.push(db.prepare("UPDATE account_styles SET first_starter_at=COALESCE(first_starter_at,?) WHERE line_account_id=?").bind(now, account));
  return { set, inserted, updated, skipped, existing };
}
