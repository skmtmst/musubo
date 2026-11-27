'use client'

import ActionList from '@/components/shared/action-list'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import DateTimeField, { TimeField } from '@/components/shared/date-time-field'
import { EntityPickerSummary } from '@/components/shared/entity-picker'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import EntityRemoteField from '@/components/shared/entity-remote-field'
import { Field, FieldError } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { TextArea, TextField } from '@/components/shared/text-field'
import type { Automation } from '@line-crm/shared'
import { Zap } from 'lucide-react'
import WaitFields from '@/components/automations/wait-fields'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { ActionDraft } from './action-draft'
import { UNKNOWN_CONDITION_REASON } from './draft-conditions'
import styles from './create.module.css'
import { b244Requirements, newActionDraft } from './draft-model'
import { EDITABLE_ACTIONS, EVENTS, REPRESENTATIVE_TRIGGER_EVENTS, TRIGGER_SHORT_NOTES } from './draft-options'
import { actionRowIcon, actionRowTitle, ResourcePick } from './draft-view-parts'
import { FriendMultiSelect } from './friend-multi-select'
import { friendNamesOf, normalizeFriendIds } from './trigger-helpers'
import { WeekdaySelect } from './weekday-select'

export function AutomationFields({
  isDraft, inputError, name, setName,
  setInputError, expandedEvents, normalizedEventQuery, eventQuery,
  setEventQuery, triggerEventGroups, matchedEvents, eventType,
  setEventType, representativeIcon, setShowAllEvents, usesKeyword,
  keyword, setKeyword, triggerConfig, setTriggerConfig,
  tags, selectedAccountId, triggerConfigSummary, conditionUnreadable, unknownCondition,
  setConditionUnreadable, conditionSummaries, setConditionOpen, actions,
  setActions, canEdit, editingActionKey, actionRowDetail,
  scenarios, commonActions, updateAction, tagsLoading,
  tagsFailed,
}: {
  isDraft: boolean
  inputError: { target: string; message: string; } | null
  name: string
  setName: Dispatch<SetStateAction<string>>
  setInputError: Dispatch<SetStateAction<{ target: string; message: string; } | null>>
  expandedEvents: boolean
  normalizedEventQuery: string
  eventQuery: string
  setEventQuery: Dispatch<SetStateAction<string>>
  triggerEventGroups: { events: { value: Automation["eventType"]; label: string; note: string; }[]; id: string; label: string; values: readonly string[]; }[] | { id: string; label: string; events: { value: Automation["eventType"]; label: string; note: string; }[]; }[]
  matchedEvents: { value: Automation["eventType"]; label: string; note: string; }[] | null
  eventType: string
  setEventType: Dispatch<SetStateAction<string>>
  representativeIcon: Record<string, ReactNode>
  setShowAllEvents: Dispatch<SetStateAction<boolean>>
  usesKeyword: boolean
  keyword: string
  setKeyword: Dispatch<SetStateAction<string>>
  triggerConfig: Record<string, unknown>
  setTriggerConfig: Dispatch<SetStateAction<Record<string, unknown>>>
  tags: { id: string; name: string; }[]
  selectedAccountId: string | null
  triggerConfigSummary: string
  conditionUnreadable: boolean
  unknownCondition: boolean
  setConditionUnreadable: Dispatch<SetStateAction<boolean>>
  conditionSummaries: string[]
  setConditionOpen: Dispatch<SetStateAction<boolean>>
  actions: ActionDraft[]
  setActions: Dispatch<SetStateAction<ActionDraft[]>>
  canEdit: boolean
  editingActionKey: number | null
  actionRowDetail: (row: ActionDraft) => string
  scenarios: { id: string; name: string; }[]
  commonActions: { id: string; name: string; }[]
  updateAction: (key: number, patch: Partial<ActionDraft>) => void
  tagsLoading: boolean
  tagsFailed: boolean
}) {
  return (<>

      <Card variant="form" gap="normal" aria-label="名前">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{isDraft ? '1. どのルールか' : '名前'}</h2>
          <p className={styles.cardDesc}>一覧で見分けるための名前。お客さまには見えません</p>
        </div>
        <Field requirement={b244Requirements.name} label={isDraft ? 'ルール名' : '名前'} htmlFor="v8-rule-name" error={inputError?.target === 'v8-rule-name' ? inputError.message : undefined}>
          <SaveErrorField names={["name"]}><TextField
            id="v8-rule-name"
            value={name}
            onChange={(event) => { setName(event.target.value); if (inputError?.target === 'v8-rule-name') setInputError(null) }}
            placeholder="例：「予約」と送られたら担当へ知らせる"
            maxLength={120}
          /></SaveErrorField>
        </Field>
      </Card>

      <Card variant="form" gap="normal" aria-label="どんなときに動かしますか">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{isDraft ? '2. 何が起きたら動かすか' : 'どんなときに動かしますか'}</h2>
        </div>
        {expandedEvents || normalizedEventQuery ? (
          <SaveErrorField names={["eventQuery","event_query"]}><TextField
            aria-label="きっかけを探す"
            type="search"
            value={eventQuery}
            onChange={(e) => setEventQuery(e.target.value)}
            placeholder="きっかけを言葉で探す（例：予約・タグ・時刻）"
          /></SaveErrorField>
        ) : null}
        {triggerEventGroups.map((group) => group.events.length === 0 ? null : (
          <div key={group.id} className={styles.triggerGroup}>
            {expandedEvents || matchedEvents ? <p className={styles.groupLabel}>{group.label}</p> : null}
            <SaveErrorField names={["v8-trigger","value","event.value","eventType"]}><RadioCardGroup legend={group.label} className={styles.triggerGrid}>
              {group.events.map((event) => (
                <RadioCard
                  key={event.value}
                  name="v8-trigger"
                  value={event.value}
                  checked={eventType === event.value}
                  onChange={() => setEventType(event.value)}
                  icon={representativeIcon[event.value] ?? <Zap size={16} />}
                  title={event.label}
                  note={TRIGGER_SHORT_NOTES[event.value] ?? event.note}
                  className={styles.triggerCard}
                />
              ))}
            </RadioCardGroup></SaveErrorField>
          </div>
        ))}
        {matchedEvents && matchedEvents.length === 0 ? (
          <p className={styles.cardDesc}>合うきっかけがありません。言葉を変えるか、すべてのきっかけから選んでください。</p>
        ) : null}
        {!normalizedEventQuery && !expandedEvents ? (
          <button type="button" className={styles.linkButton} onClick={() => setShowAllEvents(true)}>
            ほかのきっかけもすべて見る（あと{EVENTS.length - REPRESENTATIVE_TRIGGER_EVENTS.length} 件）
          </button>
        ) : null}
        {usesKeyword ? (
          <Field label="含まれる言葉" htmlFor="v8-rule-keyword"><SaveErrorField names={["keyword"]}><TextField
              id="v8-rule-keyword"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="例：予約（空欄なら、どんな内容でも動きます）"
              maxLength={100}
            /></SaveErrorField></Field>
        ) : null}
        {['tag_change', 'form_submitted', 'link_clicked', 'calendar_booked', 'datetime', 'daily', 'weekly'].includes(eventType) ? (
          <div className={styles.subBox}>
            <p className={styles.subTitle}>きっかけの詳しい設定</p>
            <div className={styles.formGrid}>
              {eventType === 'tag_change' ? <SaveErrorField names={["tagId","triggerConfig.tagId","triggerConfig"]}><EntityKindField id="v8-trigger-tag" invalid={inputError?.target === 'v8-trigger-tag'} aria-describedby={inputError?.target === 'v8-trigger-tag' ? 'v8-trigger-error' : undefined} kind="tag" label="きっかけのタグ" placeholder="（どのタグか選ぶ）" value={String(triggerConfig.tagId ?? '')} onChange={(value) => setTriggerConfig({ ...triggerConfig, tagId: value })} options={tags} /></SaveErrorField> : null}
              {eventType === 'tag_change' ? <SaveErrorField names={["action","triggerConfig.action","trigger_config.action","trigger_config"]}><Select aria-label="付いたとき・外れたとき" value={String(triggerConfig.action ?? 'add')} onChange={(value) => setTriggerConfig({ ...triggerConfig, action: value })} options={[{ value: 'add', label: '付いたとき' }, { value: 'remove', label: '外れたとき' }]} size="full" /></SaveErrorField> : null}
              {eventType === 'form_submitted' ? <SaveErrorField names={["formId","triggerConfig.formId","form_id","trigger_config.form_id","trigger_config"]}><EntityRemoteField kind="form" label="回答フォーム" value={String(triggerConfig.formId ?? '')} accountId={selectedAccountId} emptyLabel="すべて" onChange={(value) => setTriggerConfig({ ...triggerConfig, formId: value })} /></SaveErrorField> : null}
              {eventType === 'link_clicked' ? <SaveErrorField names={["trackedLinkId","triggerConfig.trackedLinkId","tracked_link_id","trigger_config.tracked_link_id","trigger_config"]}><EntityRemoteField kind="tracked_link" label="計測リンク" value={String(triggerConfig.trackedLinkId ?? '')} accountId={selectedAccountId} emptyLabel="すべて" onChange={(value) => setTriggerConfig({ ...triggerConfig, trackedLinkId: value })} /></SaveErrorField> : null}
              {eventType === 'calendar_booked' ? <SaveErrorField names={["bookingType","triggerConfig.bookingType","booking_type","trigger_config.booking_type","trigger_config"]}><Select aria-label="予約の種類" value={String(triggerConfig.bookingType ?? '')} onChange={(value) => setTriggerConfig({ ...triggerConfig, bookingType: value })} options={[{ value: '', label: 'すべての予約' }, { value: 'salon', label: 'サロン予約' }, { value: 'event', label: 'イベント予約' }]} size="full" /></SaveErrorField> : null}
              {eventType === 'calendar_booked' && triggerConfig.bookingType !== 'event' ? <SaveErrorField names={["menuId","triggerConfig.menuId","menu_id","trigger_config.menu_id","trigger_config"]}><EntityRemoteField kind="booking_menu" label="予約メニュー" value={String(triggerConfig.menuId ?? '')} accountId={selectedAccountId} emptyLabel="すべて" onChange={(value) => setTriggerConfig({ ...triggerConfig, menuId: value })} /></SaveErrorField> : null}
              {eventType === 'calendar_booked' && triggerConfig.bookingType === 'event' ? <SaveErrorField names={["eventId","triggerConfig.eventId","event_id","trigger_config.event_id","trigger_config"]}><EntityRemoteField kind="event" label="対象イベント" value={String(triggerConfig.eventId ?? '')} accountId={selectedAccountId} emptyLabel="すべて" onChange={(value) => setTriggerConfig({ ...triggerConfig, eventId: value })} /></SaveErrorField> : null}
              {eventType === 'datetime' ? <SaveErrorField names={["at","triggerConfig.at","trigger_config.at","trigger_config"]}><DateTimeField id="v8-trigger-at" invalid={inputError?.target === 'v8-trigger-at'} aria-describedby={inputError?.target === 'v8-trigger-at' ? 'v8-trigger-error' : undefined} aria-label="実行日時" value={String(triggerConfig.at ?? '')} onChange={(v) => setTriggerConfig({ ...triggerConfig, at: v })} /></SaveErrorField> : null}
              {eventType === 'weekly' ? (
                <WeekdaySelect
                  value={triggerConfig.weekdays as ReadonlyArray<number>}
                  error={inputError?.target === 'au-weekday-first' ? inputError.message : undefined}
                  time={String(triggerConfig.time ?? '')}
                  onChange={(days) => setTriggerConfig({ ...triggerConfig, weekdays: days })}
                />
              ) : null}
              {eventType === 'daily' || eventType === 'weekly' ? <SaveErrorField names={["time","triggerConfig.time","trigger_config.time","trigger_config"]}><TimeField id="v8-trigger-time" invalid={inputError?.target === 'v8-trigger-time'} aria-describedby={inputError?.target === 'v8-trigger-time' ? 'v8-trigger-error' : undefined} aria-label="実行時刻" step={300} value={String(triggerConfig.time ?? '')} onChange={(v) => setTriggerConfig({ ...triggerConfig, time: v })} /></SaveErrorField> : null}
              {eventType === 'datetime' || eventType === 'daily' || eventType === 'weekly' ? (
                <FriendMultiSelect
                  accountId={selectedAccountId ?? null}
                  error={inputError?.target === 'au-friend-search' ? inputError.message : undefined}
                  selectedIds={normalizeFriendIds(triggerConfig.friendIds)}
                  names={friendNamesOf(triggerConfig)}
                  onChange={(ids, nextNames) => setTriggerConfig({ ...triggerConfig, friendIds: ids, friendNames: nextNames })}
                />
              ) : null}
            </div>
            {inputError?.target === 'v8-trigger-tag' || inputError?.target === 'v8-trigger-at' || inputError?.target === 'v8-trigger-time' ? <FieldError id="v8-trigger-error">{inputError.message}</FieldError> : null}
            <p className={styles.cardDesc}>{triggerConfigSummary}。保存後も設定を確認できます。</p>
          </div>
        ) : null}
      </Card>

      <Card variant="form" gap="normal" aria-label="だれに動かしますか">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>だれに動かしますか</h2>
        </div>
        {unknownCondition ? <Notice tone="warn">{UNKNOWN_CONDITION_REASON}</Notice> : null}
        {conditionUnreadable ? (
          <Notice tone="danger" heading={<> 保存されていた条件は読めませんでした </>} action={<> <div>
              <Button id="v8-repair-condition" aria-describedby={inputError?.target === 'v8-repair-condition' ? 'v8-repair-condition-error' : undefined} onClick={() => { setConditionUnreadable(false); setInputError(null) }}>以前の条件を外して付け直す</Button>
              {inputError?.target === 'v8-repair-condition' ? <FieldError id="v8-repair-condition-error">{inputError.message}</FieldError> : null}
            </div> </>} >以前の画面が別の形で保存した条件です。このままでは人数を数えられないため、保存できません。
              以前の条件を外してもよければ、下のボタンから付け直せます。</Notice>
        ) : (
          <>
            <div className={styles.field}>
              <span className={styles.subLabel} id="v8-target-label">動かす相手</span>
              {/* 条件は一斉配信・シナリオと同じ部品（ConditionBuilder）で作る。押すと窓で開く。 */}
              <EntityPickerSummary
                label="動かす相手"
                noun="動かす相手"
                name={conditionSummaries.length > 0 ? conditionSummaries.join('・') : 'すべての友だち'}
                ariaLabel="動かす相手を変更する"
                aria-describedby="v8-target-label"
                onOpen={() => setConditionOpen(true)}
              />
            </div>
            <button type="button" className={styles.linkButton} onClick={() => setConditionOpen(true)}>
              ＋「いずれか1つ以上を満たす」条件を足す
            </button>
          </>
        )}
      </Card>

      <Card variant="form" gap="normal" aria-label="何をするか">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{isDraft ? '3. 何をするか' : '何をするか'}</h2>
          <p className={styles.cardDesc}>上から順に動きます</p>
        </div>
        <ActionList<ActionDraft> value={actions} onChange = {setActions} readOnly ={!canEdit} idOf={row => String(row.key)} addId="v8-add-action" editingId={editingActionKey === null ? null : String(editingActionKey)}
          titleOf={actionRowDetail} kindOf={row =>actionRowTitle(row.type)} iconOf={row => actionRowIcon(row.type)} quickAddChoiceId="common_action"
          choices={EDITABLE_ACTIONS.map(kind =>{
            const target= kind.value === 'add_tag' ? { items: tags,key : 'tagId', title: 'タグ'}
              : kind.value=== 'start_scenario' ?{ items: scenarios, key: 'scenarioId', title: 'シナリオ' }
              : kind.value === 'common_action' ? { items: commonActions, key: 'commonActionId', title: '共通アクション' } : null
            return { id: kind.value, label: kind.label, make: () =>(
                        { ...newActionDraft(), type: kind.value}), picker: target ? {
              title: `${target.title}を選ぶ`, items: target.items, apply: (row, ids) =>({ ...row, [target.key]: ids[0
                      ]}
                ),} : undefined }
          })}
          renderEditor={(row) =>
          <div className={styles.dialogBody}>{row.type === 'add_tag' ? (
              <ResourcePick
                kind="tag"
                title="付けるタグ"
                id={`v8-tag-${row.key}`}
                error={inputError?.target === `v8-tag-${row.key}` ? inputError.message : undefined}
                selectLabel="自動化で付けるタグ"
                value={row.tagId}
                onPick={(value) => updateAction(row.key, { tagId: value })}
                options={tags}
                loading={tagsLoading}
                failed={tagsFailed}
                failedNote="タグを読み込めませんでした。画面を再読み込みしてください。"
              />
            ) : row.type === 'start_scenario' ? (
              <ResourcePick
                kind="scenario"
                title="始めるシナリオ"
                id={`v8-scenario-${row.key}`}
                error={inputError?.target === `v8-scenario-${row.key}` ? inputError.message : undefined}
                selectLabel="自動化で始めるシナリオ"
                value={row.scenarioId}
                onPick={(value) => updateAction(row.key, { scenarioId: value })}
                options={scenarios}
                loading={tagsLoading}
                failed={tagsFailed}
                failedNote="シナリオを読み込めませんでした。画面を再読み込みしてください。"
              />
            ) : row.type === 'common_action' ? (
              <ResourcePick
                kind="common_action"
                title="使う共通アクション"
                id={`v8-common-action-${row.key}`}
                error={inputError?.target === `v8-common-action-${row.key}` ? inputError.message : undefined}
                selectLabel="自動化で使う共通アクション"
                value={row.commonActionId}
                onPick={(value) => updateAction(row.key, { commonActionId: value })}
                options={commonActions}
                loading={tagsLoading}
                failed={tagsFailed}
                failedNote="共通アクションを読み込めませんでした。画面を再読み込みしてください。"
              />
            ) : row.type === 'wait' ? (
              <WaitFields id={`v8-wait-${row.key}`} value={row.kept ?? { durationMinutes: 5 }}
                error={inputError?.target === `v8-wait-${row.key}` ? inputError.message : undefined}
                onChange={kept => updateAction(row.key, { kept })} />
            ) : row.type === 'notify_staff' ? (
              <p className={styles.cardDesc}>
                知らせる相手と文面は、見本から作ったときのまま保ちます。変えるときは、することを選び直してください。
              </p>
            ) : (
              <Field label="送る文面" htmlFor={`v8-message-${row.key}`} requirement={b244Requirements.row_message}><SaveErrorField names={["message","editingRow.message","editing_row.message"]}><TextArea
                  invalid={inputError?.target === `v8-message-${row.key}`}
                  aria-describedby={inputError?.target === `v8-message-${row.key}` ? 'v8-action-error' : undefined}
                  id={`v8-message-${row.key}`}
                  value={row.message}
                  onChange={(event) => updateAction(row.key, { message: event.target.value })}
                /></SaveErrorField>
{inputError?.target === `v8-message-${row.key}` ? <FieldError id="v8-action-error">{inputError.message}</FieldError> : null}</Field>
            )}
          </div>} />
        {inputError?.target === 'v8-add-action' ? <FieldError id="v8-add-action-error">{inputError.message}</FieldError> : null}
      </Card>

</>)
}
