'use client'

import type { InsertTokenNames } from '@/components/shared/insert-tokens'
import Button from '@/components/shared/button';
import PermissionGatedButton from '@/components/shared/permission-gated-button';
import Card,{ CardHeader } from '@/components/shared/card';
import Toggle from '@/components/shared/toggle';
import { TimeField } from '@/components/shared/date-time-field';
import Dialog from '@/components/shared/dialog';
import { emptyValue } from '@/components/shared/empty-value';
import { EntityKindField } from '@/components/shared/entity-picker-sources';
import { Field } from '@/components/shared/form-controls';
import InsertTextField,{ type InsertTextFieldHandle } from '@/components/shared/insert-text-field';
import MessageInsertRow,{ MessageBody,MessageInsertButton } from '@/components/shared/message-insert-row';
import Notice from '@/components/shared/notice';
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import SegmentedControl from '@/components/shared/segmented';
import { TextField } from '@/components/shared/text-field';
import { type FriendAddRuleDefinition,type FriendAddRuleKind,type FriendAddRuleOptions } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { Ban,FileText,ListChecks,Pencil,Plus,Workflow } from 'lucide-react';
import type { Dispatch,SetStateAction } from 'react';
import { useRef,useState } from 'react';
import { MESSAGE_LIMIT } from './editor-model';
import styles from './editor.module.css';
import { addTimeWindow,MESSAGE_TYPE_LABEL,removeTimeWindow,updateTimeWindow } from './flow';
import { resendSuppressionText } from './text';

/* ===== 作る③ 初回案内（板 ・競合 ） ===== */
export const MESSAGE_TABS: Array<{ key: FriendAddRuleDefinition['messageType'] | 'none'; label: string; icon: typeof Pencil; enabled: boolean; reason?: string }> = [
  { key: 'text', label: 'この画面で書く', icon: Pencil, enabled: true },
  /* できていない形式は選べない形で出す（理由を title に）。 */
  { key: 'template', label: 'テンプレートから', icon: FileText, enabled: false, reason: 'テンプレートからの作成はこの版では選べません' },
  { key: 'form', label: '回答フォーム', icon: ListChecks, enabled: false, reason: '回答フォームの作成はこの版では選べません' },
  { key: 'scenario', label: 'シナリオを始める', icon: Workflow, enabled: false, reason: 'シナリオからの開始は「あわせて行うこと」で選びます' },
  { key: 'none', label: '送らない', icon: Ban, enabled: false, reason: '送らない設定は「以前からの友だち」のときに選びます' },
]

export function MessageStep({ definition, setDefinition, friendKind, scenarios, canEdit, scenarioError, tokenNames }: {
  tokenNames?: InsertTokenNames
  definition: FriendAddRuleDefinition
  setDefinition: Dispatch<SetStateAction<FriendAddRuleDefinition>>
  friendKind: FriendAddRuleKind
  scenarios: FriendAddRuleOptions['scenarios']
  canEdit: boolean
  scenarioError?: string
}) {
  const messageRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement | null>(null)
  const insertToken = (token: string) => {
    const area = messageRef.current
    if (!area) return
    const start = area.selectionStart ?? definition.messageText.length
    const end = area.selectionEnd ?? start
    const next = definition.messageText.slice(0, start) + token + definition.messageText.slice(end)
    setDefinition((current) => ({ ...current, messageText: next }))
    requestAnimationFrame(() => {
      area.focus()
      area.setSelectionRange(start + token.length, start + token.length)
    })
  }
  if (friendKind === 'returning') {
    return <ReturningMessage tokenNames={tokenNames} definition={definition} setDefinition={setDefinition} scenarios={scenarios} canEdit={canEdit} scenarioError={scenarioError} />
  }
  const scheduled = definition.timeWindows != null && definition.timeWindows.length > 0
  const suppressOn = (definition.resendSuppressionHours ?? 24) > 0
  return (
    <>
      <Card variant="form" gap="normal" className={styles.card} aria-label="最初に送るもの">
        <CardHeader size="stacked" title={<>最初に送るもの</>} />
        {!canEdit ? (
          <ReadOnlyText label="最初に送るものの種類" value={MESSAGE_TABS.find((tab) => tab.key === definition.messageType)?.label ?? MESSAGE_TYPE_LABEL[definition.messageType] ?? emptyValue('unconfigured')} />
        ) : (
        <div className={styles.chipRow} role="group" aria-label="最初に送るものの種類">
          {MESSAGE_TABS.map((tab) => {
            const selected = definition.messageType === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                aria-pressed={selected}
                disabled={!tab.enabled}
                title={tab.reason}
                className={styles.pickChip}
                data-selected={selected || undefined}
                onClick={() => { if (tab.key !== 'none') setDefinition((current) => ({ ...current, messageType: tab.key as FriendAddRuleDefinition['messageType'] })) }}
              >
                <tab.icon size={16} aria-hidden="true" />
                {tab.label}
              </button>
            )
          })}
        </div>
        )}
        <MessageBody>
          <SaveErrorField names={["messageText","definition.messageText","message_text","mine","definition.message_text"]}><InsertTextField tokenNames={tokenNames}
            ref={messageRef}
            aria-label="最初に送るメッセージ"
            editorSize="message"
            maxLength={MESSAGE_LIMIT}
            value={definition.messageText}
            readOnly={!canEdit}
            onValueChange={(next) => setDefinition((current) => ({ ...current, messageText: next }))}
          /></SaveErrorField>
          <MessageInsertRow readOnly={!canEdit} count={`${formatNumber(definition.messageText.length)} / ${formatNumber(MESSAGE_LIMIT)}`}>
            {canEdit ? <MessageInsertButton kind="name" label="名前" onClick={() => insertToken('{{name}}')} /> : null}
          </MessageInsertRow>
        </MessageBody>
        {scenarioError && canEdit ? (
          <div className={styles.field}>
            <span className={styles.label}>実際に配信するシナリオ</span>
            <ScenarioPicker id="fa-scenario" label="実際に配信するシナリオ" scenarios={scenarios} error={scenarioError}
              value={definition.scenarioId ?? ''}
              onChange={(value) => setDefinition((current) => ({ ...current, scenarioId: value || null }))} />
          </div>
        ) : null}
      </Card>
      <Card variant="form" gap="normal" className={styles.card} aria-label="いつ送るか">
        <CardHeader size="stacked" title={<>いつ送るか</>} />
        <div className={styles.segRow}>
          {!canEdit ? (
            <ReadOnlyText label="送るタイミング" value={scheduled ? '時間帯を決める' : '追加してすぐ'} />
          ) : (
          <SaveErrorField names={["definition"]}><SegmentedControl
            aria-label="送るタイミング"
            value={scheduled ? 'window' : 'now'}
            onChange={(next) => {
              setDefinition((current) => next === 'now'
                ? { ...current, weekdays: [0, 1, 2, 3, 4, 5, 6], timeWindows: [] }
                : { ...current, timeWindows: current.timeWindows && current.timeWindows.length > 0 ? current.timeWindows : addTimeWindow(current.timeWindows) })
            }}
            options={[
              { value: 'now', label: '追加してすぐ' },
              { value: 'window', label: '時間帯を決める' },
            ]}
          /></SaveErrorField>
          )}
        </div>
        <p className={styles.cardDesc}>「時間帯を決める」にすると、時間帯の外に追加した人には、次の時間帯の始めに届きます。</p>
        {scheduled ? (
          <div className={styles.field}>
            <span className={styles.label}>曜日</span>
            {!canEdit ? (
              <ReadOnlyText label="曜日" value={['日', '月', '火', '水', '木', '金', '土'].filter((_, day) => (definition.weekdays ?? []).includes(day)).join('・') || '選んでいません'} />
            ) : (
            <div className={styles.weekRow}>
              {['日', '月', '火', '水', '木', '金', '土'].map((label, day) => {
                const checked = (definition.weekdays ?? []).includes(day)
                return (
                  <button
                    key={label}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`${label}曜日`}
                    className={styles.pickChip}
                    data-selected={checked || undefined}
                    onClick={() => setDefinition((current) => {
                      const days = current.weekdays ?? []
                      return { ...current, weekdays: days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort() }
                    })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            )}
            {(definition.timeWindows ?? []).map((slot, index) => (
              <div key={index} className={styles.timeRow}>
                <SaveErrorField names={["start","slot.start","definition"]}><TimeField
                  aria-label={`時間帯${index + 1}の開始`}
                  value={slot.start}
                  readOnly={!canEdit}
                  onChange={(next) => setDefinition((current) => ({ ...current, timeWindows: updateTimeWindow(current.timeWindows, index, { start: next }) }))}
                /></SaveErrorField>
                <span aria-hidden="true">〜</span>
                <SaveErrorField names={["end","slot.end","definition"]}><TimeField
                  aria-label={`時間帯${index + 1}の終了`}
                  value={slot.end}
                  readOnly={!canEdit}
                  onChange={(next) => setDefinition((current) => ({ ...current, timeWindows: updateTimeWindow(current.timeWindows, index, { end: next }) }))}
                /></SaveErrorField>
                {canEdit ? (
                  <Button type="button" variant="text" aria-label={`時間帯${index + 1}を削除`} onClick={() => setDefinition((current) => ({ ...current, timeWindows: removeTimeWindow(current.timeWindows, index) }))}>削除</Button>
                ) : null}
              </div>
            ))}
            {canEdit ? (
              <Button type="button" variant="text" onClick={() => setDefinition((current) => ({ ...current, timeWindows: addTimeWindow(current.timeWindows) }))}>
                <Plus size={16} aria-hidden="true" />時間帯を足す
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
      <Card variant="form" gap="normal" className={styles.card} aria-label="同じ人に何度も送らない">
        <CardHeader size="stacked" title={<>同じ人に何度も送らない</>} />
        <div className={styles.switchRow}>
          <span className={styles.switchText}>{`同じ人へは ${resendSuppressionText(definition.resendSuppressionHours)}まで`}</span>
          <span className={styles.spacer} aria-hidden="true" />
          {/* 閲覧のみ：つまみは置かない（左の文で今の設定が読める）。 */}
          {canEdit ? (
            <SaveErrorField names={["suppressOn","definition","suppress_on"]}><Toggle
              checked={suppressOn}
              label="同じ人に何度も送らない"
              onChange={(next) => setDefinition((current) => ({ ...current, resendSuppressionHours: next ? 24 : 0 }))}
            /></SaveErrorField>
          ) : null}
        </div>
      </Card>
    </>
  )
}

export const RETURNING_MODES = [
  { key: 'none', title: '何も送らない', desc: '案内後の操作だけを行う' },
  { key: 'same', title: 'はじめてと同じ', desc: 'はじめての人と同じ案内を送る' },
  { key: 'other', title: '別のシナリオ', desc: '選んだシナリオから始める' },
] as const

export const START_POSITIONS = [
  { key: 'beginning', title: '最初から', desc: '一度も届いていない人にも最初から届きます' },
  { key: 'resume', title: '前回送った次から', desc: '途中まで届いた人へ続きを送ります' },
] as const

/** 閲覧のみ：選ぶ部品（RadioCard・Select・つまみ・曜日の札）の代わりに、選んでいる値を読み取りだけの欄で見せる。 */
/** シナリオを選ぶ欄（選ぶ窓）。誤りは欄の下に出す。保存する値は今と同じ ID（空は ''）。 */
export function ScenarioPicker({ id, label, scenarios, value, error, onChange }: {
  id: string
  label: string
  scenarios: FriendAddRuleOptions['scenarios']
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  return <>
    <SaveErrorField names={["value"]}><EntityKindField kind="scenario" id={id} label={label} options={scenarios} value={value} invalid={Boolean(error)}
      placeholder="（選んでください）" onChange={onChange} /></SaveErrorField>
    {error ? <span id={`${id}-error`} className={styles.fieldError} role="alert">{error}</span> : null}
  </>
}

export function ReadOnlyText({ id, label, value }: { id?: string; label: string; value: string }) {
  return <SaveErrorField names={["value"]}><TextField id={id} aria-label={label} value={value} readOnly aria-readonly="true" title={value} /></SaveErrorField>
}

export function ReturningMessage({ definition, setDefinition, scenarios, canEdit, scenarioError, tokenNames }: {
  tokenNames?: InsertTokenNames
  definition: FriendAddRuleDefinition
  setDefinition: Dispatch<SetStateAction<FriendAddRuleDefinition>>
  scenarios: FriendAddRuleOptions['scenarios']
  canEdit: boolean
  scenarioError?: string
}) {
  const [messageOpen, setMessageOpen] = useState(false)
  const mode = definition.returningMode ?? 'same'
  const start = definition.startPosition ?? 'beginning'
  return (
    <>
      <Card variant="form" gap="normal" className={styles.card} aria-label="追加のときに送るもの">
        <CardHeader size="stacked" title={<>追加のときに送るもの</>} meta={<>戻ってきた人に何を送るか選びます。</>} />
        {!canEdit ? (
          <ReadOnlyText label="追加のときに送るもの" value={RETURNING_MODES.find((option) => option.key === mode)?.title ?? ''} />
        ) : (
        <SaveErrorField names={["fa-returning","key","option.key","mode","definition"]}><RadioCardGroup legend="追加のときに送るもの" className={styles.kindTriple}>
          {RETURNING_MODES.map((option) => (
            <RadioCard
              key={option.key}
              name="fa-returning"
              value={option.key}
              checked={mode === option.key}
              onChange={() => setDefinition((current) => ({ ...current, returningMode: option.key }))}
              title={option.title}
              note={option.desc}
            />
          ))}
        </RadioCardGroup></SaveErrorField>
        )}
        {mode === 'none' ? <Notice tone="info" message="この設定はメッセージを届けません。案内後のアクションだけを行います。" /> : null}
        {mode === 'other' || scenarioError ? (
          <div className={styles.field}>
            <span className={styles.label}>始めるシナリオ</span>
            {canEdit ? (
              <ScenarioPicker id="fa-returning-scenario" label="始めるシナリオ" scenarios={scenarios} error={scenarioError}
                value={definition.scenarioId ?? ''}
                onChange={(value) => setDefinition((current) => ({ ...current, scenarioId: value || null }))} />
            ) : (
              <ReadOnlyText id="fa-returning-scenario" label="始めるシナリオ" value={scenarios.find((scenario) => scenario.id === definition.scenarioId)?.name ?? '選んでいません'} />
            )}
          </div>
        ) : null}
        {mode === 'other' ? <PermissionGatedButton allowed={canEdit} type="button" variant="text" onClick={() => setMessageOpen(true)}>初回メッセージを確認・変更</PermissionGatedButton> : null}
      </Card>
      {mode !== 'none' ? <Card variant="form" gap="normal" className={styles.card} aria-label="どこから始めるか">
        <CardHeader size="stacked" title={<>どこから始めるか</>} />
        {!canEdit ? (
          <ReadOnlyText label="どこから始めるか" value={START_POSITIONS.find((option) => option.key === start)?.title ?? ''} />
        ) : (
        <SaveErrorField names={["fa-start","key","option.key","start","definition"]}><RadioCardGroup legend="どこから始めるか" className={styles.kindPair}>
          {START_POSITIONS.map((option) => (
            <RadioCard
              key={option.key}
              name="fa-start"
              value={option.key}
              checked={start === option.key}
              onChange={() => setDefinition((current) => ({ ...current, startPosition: option.key }))}
              title={option.title}
              note={option.desc}
            />
          ))}
        </RadioCardGroup></SaveErrorField>
        )}
      </Card> : null}
      <Dialog open={messageOpen && mode === 'other' && canEdit} title="初回メッセージ" dirty={false} onCancel={() => setMessageOpen(false)} >
        <Field label="最初に送るメッセージ"><MessageBody><SaveErrorField names={["messageText","definition.messageText","message_text"]}><InsertTextField tokenNames={tokenNames} editorSize="message" aria-label="最初に送るメッセージ" maxLength={MESSAGE_LIMIT} value={definition.messageText} onValueChange={(messageText) => setDefinition((current) => ({ ...current, messageText }))} /></SaveErrorField></MessageBody></Field>
      </Dialog>
    </>
  )
}
