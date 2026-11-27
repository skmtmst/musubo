'use client'

import { StageFrame } from './edit-model'

import { fillPreviewSample } from '@/components/shared/preview-sample'
import ActionMenu,{ type ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import { TimeField } from '@/components/shared/date-time-field'
import DetailPanel from '@/components/shared/detail-panel'
import { referenceTokenNames } from '@/components/shared/insert-tokens'
import InsertTextField,{ type InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import MessageInsertRow,{ MessageBody,MessageInsertButton } from '@/components/shared/message-insert-row'
import NumberInput from '@/components/shared/number-field'
import Notice from '@/components/shared/notice'
import ReorderHandle,{ useReorder } from '@/components/shared/reorder-handle'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { CreatePage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import {
type FriendField,
type ReminderDraftSettings,
type ReminderDraftStep
} from '@line-crm/shared'
import {
ArrowDown,
ArrowRight,
ArrowUp,
GripVertical,
Plus,
Smartphone,
Trash2
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect,useRef,useState } from 'react'
import { REMINDER_TOKENS,exampleSendAt,formatJpDay,formatMd,formatShort,sampleBaseDate,stepShortTiming } from './edit-model'
import styles from './edit.module.css'
import { PhoneV8,WizardFooterV8 } from './ui'

/* ---------------- 手順3：通知の中身（・1152 は ） ---------------- */
export const MAX_STEPS = 10

export const BODY_LIMIT = 5000

export function MessagesStageV8({
  frame,
  notice,
  narrow,
  settings,
  onChange,
  busy,
  onNext,
  onSaveDraft,
  onCancel,
}: {
  frame: StageFrame
  notice: ReactNode
  /** 1152 の板：右の列は「LINEでの見え方を見る」と例だけにし、スマホは横から出す。 */
  narrow: boolean
  settings: ReminderDraftSettings
  onChange: (value: ReminderDraftSettings) => void
  busy: boolean
  onNext: () => void
  onSaveDraft: () => void
  onCancel: () => void
}) {
  const { selectedAccount, selectedAccountId } = useAccount()
  const [selectedStepId, setSelectedStepId] = useState<string | null>(settings.steps[0]?.stableStepId ?? null)
  const [loadedFields, setLoadedFields] = useState<{ accountId: string; items: FriendField[] } | null>(null)
  const [fieldsErrorAccount, setFieldsErrorAccount] = useState<string | null>(null)
  const [fieldsAttempt, setFieldsAttempt] = useState(0)
  const fields = loadedFields?.accountId === selectedAccountId ? loadedFields.items : []
  const tokenNames = referenceTokenNames({ friendFields: fields, commonVars: [] })
  const [phoneOpen, setPhoneOpen] = useState(false)
  const bodyRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)
  const sampleBase = useRef<Date>(sampleBaseDate())

  useEffect(() => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    let active = true
    setFieldsErrorAccount(null)
    void api.friendFields.list(accountId).then((res) => {
      if (!res.success) throw new Error('friend_fields_unavailable')
      if (active) setLoadedFields({ accountId, items: res.data })
    }).catch(() => { if (active) { setLoadedFields(null); setFieldsErrorAccount(accountId) } })
    return () => { active = false }
  }, [selectedAccountId, fieldsAttempt])

  const selectedIndex = settings.steps.findIndex((step) => step.stableStepId === selectedStepId)
  const selectedStep = (selectedIndex >= 0 ? settings.steps[selectedIndex] : settings.steps[0]) ?? null
  const allStepsHaveContent = settings.steps.length > 0
    && settings.steps.every((step) => Boolean(step.templateId || step.messageContent.trim()))

  const updateStep = (stableStepId: string, patch: Partial<ReminderDraftStep>) => {
    onChange({
      ...settings,
      steps: settings.steps.map((step) => step.stableStepId === stableStepId ? { ...step, ...patch } : step),
    })
  }

  const addStep = () => {
    const step: ReminderDraftStep = {
      stableStepId: crypto.randomUUID(),
      offsetMinutes: 0,
      offsetDays: 0,
      sendAtTime: '09:00',
      messageType: 'text',
      messageContent: '',
    }
    onChange({ ...settings, steps: [...settings.steps, step] })
    setSelectedStepId(step.stableStepId)
  }

  const removeStep = (stableStepId: string) => {
    if (settings.steps.length <= 1) return
    onChange({ ...settings, steps: settings.steps.filter((step) => step.stableStepId !== stableStepId) })
    if (selectedStepId === stableStepId) setSelectedStepId(null)
  }

  /*
   * 通知の並べ替え（共通の並び替え）。つまみのドラッグ・上下キー・「前へ／後ろへ」は
   * どれも同じ入口で並びを変える。
   */
  const stepOrder = useReorder({
    items: settings.steps,
    idOf: (step) => step.stableStepId,
    disabledReason: settings.steps.length < 2 ? '通知が1つのときは並び替えできません' : null,
    onReorder: ({ ids }) => {
      const byId = new Map(settings.steps.map((step) => [step.stableStepId, step]))
      const steps = ids.map((id) => byId.get(id)).filter((step): step is typeof settings.steps[number] => Boolean(step))
      if (steps.length === settings.steps.length) onChange({ ...settings, steps })
    },
  })

  /** 差し込みをカーソルの位置に入れる。 */
  const insertToken = (token: string) => {
    if (!selectedStep) return
    const area = bodyRef.current
    const value = selectedStep.messageContent
    const start = area?.selectionStart ?? value.length
    const end = area?.selectionEnd ?? value.length
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`.slice(0, BODY_LIMIT)
    updateStep(selectedStep.stableStepId, { messageContent: next })
    requestAnimationFrame(() => {
      area?.focus()
      const caret = Math.min(start + token.length, next.length)
      area?.setSelectionRange(caret, caret)
    })
  }

  const phone = (
    <PhoneV8
      accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
      chip={selectedStep ? formatMd(exampleSendAt(selectedStep, settings.deliveryMode, sampleBase.current)) : '通知はまだありません'}
      empty={!selectedStep}
      hasSampledBody={Boolean(selectedStep?.messageContent.trim())}
      message={selectedStep ? (selectedStep.messageContent ? fillPreviewSample(selectedStep.messageContent).text : '本文を入力すると、ここに表示例が出ます。') : undefined}
    />
  )

  const examples = (
    <section className={styles.sideBox} aria-label="届く日時の例">
      <h2 className={styles.sideBoxTitle}>届く日時の例</h2>
      <p className={styles.sideBoxNote}>{formatJpDay(sampleBase.current)} に{settings.triggerType === 'friend_field' ? '基準日がある' : '予約した'} 人</p>
      <dl className={styles.sideRows}>
        {settings.steps.map((step, index) => (
          <div key={step.stableStepId} className={styles.sideRow}>
            <dt>{index + 1} 通目</dt>
            <dd>{formatMd(exampleSendAt(step, settings.deliveryMode, sampleBase.current))}</dd>
          </div>
        ))}
      </dl>
      {settings.steps.length === 0 ? <p className={styles.sideBoxNote}>通知を足すと、ここに届く日時の例が出ます。</p> : null}
    </section>
  )

  return (
    <>
      <CreatePage
        {...frame}
        preview={narrow ? (
          <div className={styles.narrowSide}>
            <Button type="button" className={styles.wideButton} onClick={() => setPhoneOpen(true)}>
              <Smartphone size={16} aria-hidden="true" />LINEでの見え方を見る
            </Button>
            {examples}
          </div>
        ) : (
          <>
            {examples}
            {phone}
          </>
        )}
        footerActions={(
          <WizardFooterV8
            onCancel={onCancel}
            cancelDisabled={busy}
            onDraft={onSaveDraft}
            draftBusy={busy}
            nextLabel="次へ：配信予定"
            nextIcon={<ArrowRight size={16} aria-hidden="true" />}
            onNext={onNext}
            nextDisabled={busy || !allStepsHaveContent}
          />
        )} dirty={false}
      >
        {notice}
        <section className={styles.card} aria-labelledby="rm-steps-title">
          <div className={styles.cardHead}>
            <h2 id="rm-steps-title" className={styles.cardTitle}>通知</h2>
            <p className={styles.cardNote}>基準日に近い順に並びます。最大 {MAX_STEPS} 通</p>
          </div>
          {settings.steps.length === 0 ? (
            <p className={styles.fieldNote}>通知はまだありません。「通知を足す」で1通目を作成してください。本文が入るまで次へは進めません。</p>
          ) : null}
          {stepOrder.shown.map((step, index) => {
            const open = step.stableStepId === (selectedStep?.stableStepId ?? null)
            return (
              <div key={step.stableStepId} className={styles.stepCard} data-open={open || undefined} {...stepOrder.rowProps(step.stableStepId)}>
                <div className={styles.stepHead}>
                  <ReorderHandle
                    look="bare"
                    className={styles.grip}
                    label={`${index + 1} 通目の通知`}
                    {...stepOrder.handle(step.stableStepId)}
                    {...stepOrder.handleProps(step.stableStepId)}
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </ReorderHandle>
                  <span className={styles.stepNum}>{index + 1}</span>
                  <button
                    type="button"
                    className={styles.stepTiming}
                    aria-expanded={open}
                    onClick={() => setSelectedStepId(open ? null : step.stableStepId)}
                  >
                    {stepShortTiming(step, settings.deliveryMode)}
                  </button>
                  <span className={styles.spacer} aria-hidden="true" />
                  <Button type="button" variant="text" title={stepOrder.moveReason(step.stableStepId, -1) ?? undefined} disabled={!stepOrder.canMoveBy(step.stableStepId, -1)} onClick={() => stepOrder.moveBy(step.stableStepId, -1, 'menu')}>
                    <ArrowUp size={16} aria-hidden="true" />前へ
                  </Button>
                  <Button type="button" variant="text" title={stepOrder.moveReason(step.stableStepId, 1) ?? undefined} disabled={!stepOrder.canMoveBy(step.stableStepId, 1)} onClick={() => stepOrder.moveBy(step.stableStepId, 1, 'menu')}>
                    <ArrowDown size={16} aria-hidden="true" />後ろへ
                  </Button>
                  <Button type="button" variant="text" disabled={settings.steps.length <= 1} onClick={() => removeStep(step.stableStepId)}>
                    <Trash2 size={16} aria-hidden="true" />消す
                  </Button>
                </div>
                {open ? (
                  <>
                    <TimingEditor
                      step={step}
                      mode={settings.deliveryMode}
                      base={sampleBase.current}
                      onChange={(patch) => updateStep(step.stableStepId, patch)}
                    />
                    <MessageBody>
                      {fieldsErrorAccount === selectedAccountId && selectedAccountId ? <><Notice tone="warn">友だち情報の差し込み候補を読み込めませんでした。本文はそのまま編集できます。</Notice><Button type="button" variant="secondary" onClick={() => setFieldsAttempt(value => value + 1)}>差し込み候補を読み直す</Button></> : null}
                      <SaveErrorField names={[`shown.${index}.messageContent`,`shown.${index}.message_content`,"messageContent","step.messageContent","message_content","step.message_content"]}><InsertTextField tokenNames={tokenNames}
                        ref={bodyRef}
                        className={styles.bodyArea}
                        value={step.messageContent}
                        maxLength={BODY_LIMIT}
                        aria-label={`${index + 1} 通目の本文`}
                        placeholder="友だちに届く本文を書きます"
                        onValueChange={(next) => updateStep(step.stableStepId, { messageContent: next })}
                        extraTokens={REMINDER_TOKENS}
/></SaveErrorField>
                      <MessageInsertRow count={`${formatNumber(step.messageContent.length)} / ${formatNumber(BODY_LIMIT)}`} more={<>
                        <MessageInsertButton kind="date" label="予約日時" onClick={() => insertToken('{{date}}')} />
                        <MessageInsertButton kind="other" label="Google Meet の URL" onClick={() => insertToken('{{meet_url}}')} />
                        </>}>
                        <MessageInsertButton kind="name" label="名前" onClick={() => insertToken('{{name}}')} />
                        <FieldInsert fields={fields} onInsert={insertToken} />
                      </MessageInsertRow>
                    </MessageBody>
                  </>
                ) : (
                  <button type="button" className={styles.stepPreview} onClick={() => setSelectedStepId(step.stableStepId)}>
                    {(step.messageContent || '本文はまだありません').split('\n')[0]}…
                  </button>
                )}
              </div>
            )
          })}
          <div>
            <Button type="button" variant="text" onClick={addStep} disabled={settings.steps.length >= MAX_STEPS}>
              <Plus size={16} aria-hidden="true" />通知を足す
            </Button>
          </div>
        </section>
      </CreatePage>
      <DetailPanel open={phoneOpen} title="LINEでの見え方" onClose={() => setPhoneOpen(false)}>{phone}</DetailPanel>
    </>
  )
}

/** 「友だち情報」を差し込む。押すと情報欄の一覧から選ぶ（ボタン＋メニュー）。 */
export function FieldInsert({ fields, onInsert }: { fields: FriendField[]; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const items: ActionMenuItem[] = fields.length > 0
    ? fields.map((field) => ({ id: field.id, label: field.name, onSelect: () => { onInsert(`{{field.${field.fieldKey}}}`); setOpen(false) } }))
    : [{ id: 'none', label: '友だち情報欄がありません', disabled: true, disabledReason: '友だち情報欄を作ると差し込めます', onSelect: () => {} }]
  return (
    <span ref={anchorRef} className={styles.fieldInsert}>
      <MessageInsertButton kind="field" label="友だち情報" expanded={open} onClick={() => setOpen(value => !value)} />
      <ActionMenu open={open} onClose={() => setOpen(false)} ariaLabel="差し込む友だち情報" items={items} anchorRef={anchorRef} />
    </span>
  )
}

export type TimingUnit = 'day' | 'hour' | 'min'

/**
 * 「基準日の [1] [日] [前] の [18:00]」の入力行。
 * 日で書く通（○日前の●時）と、時間・分で書く通（1時間前など）を単位で切り替える。
 * 日 → 時間・分にすると時刻は外れ、分の数で持つ。逆は 9:00 を入れる。
 */
export function TimingEditor({
  step,
  mode,
  base,
  onChange,
}: {
  step: ReminderDraftStep
  mode: ReminderDraftSettings['deliveryMode']
  base: Date
  onChange: (patch: Partial<ReminderDraftStep>) => void
}) {
  const dayWritten = mode === 'time' && step.offsetDays != null && step.sendAtTime != null
  const minutes = step.offsetMinutes ?? 0
  const abs = Math.abs(minutes)
  const unit: TimingUnit = dayWritten ? 'day' : abs % 1440 === 0 && abs > 0 ? 'day' : abs % 60 === 0 ? 'hour' : 'min'
  const amount = dayWritten ? Math.abs(step.offsetDays ?? 0) : unit === 'day' ? abs / 1440 : unit === 'hour' ? abs / 60 : abs
  const after = dayWritten ? (step.offsetDays ?? 0) > 0 : minutes > 0
  const sign = (value: number, isAfter: boolean) => (isAfter ? value : -value)

  /** 数・単位・前後から、保存する形（日で書く／分で書く）を作る。 */
  const build = (n: number, u: TimingUnit, isAfter: boolean): Partial<ReminderDraftStep> => {
    if (mode === 'time' && u === 'day') {
      return { offsetDays: sign(n, isAfter), sendAtTime: step.sendAtTime ?? '09:00', offsetMinutes: 0 }
    }
    const per = u === 'day' ? 1440 : u === 'hour' ? 60 : 1
    return { offsetDays: null, sendAtTime: null, offsetMinutes: sign(n * per, isAfter) }
  }

  const example = exampleSendAt(step, mode, base)

  return (
    <div className={styles.timingRow}>
      <span className={styles.timingWord}>基準日の</span>
      <SaveErrorField names={["amount"]}><NumberInput
        type="number"
        min={0}
        max={unit === 'day' ? 365 : undefined}
        aria-label="基準日からの数"
        className={styles.timingDays}
        value={String(amount)}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isInteger(next) && next >= 0) onChange(build(next, unit, after))
        }}
      /></SaveErrorField>
      <SaveErrorField names={["unit"]}><Select
        value={unit}
        onChange={(next) => onChange(build(amount, next as TimingUnit, after))}
        aria-label="単位"
        width={72}
        options={[{ value: 'day', label: '日' }, { value: 'hour', label: '時間' }, { value: 'min', label: '分' }]}
      /></SaveErrorField>
      <Select
        value={after ? 'after' : 'before'}
        onChange={(next) => onChange(build(amount, unit, next === 'after'))}
        aria-label="基準日の前か後か"
        width={72}
        options={[{ value: 'before', label: '前' }, { value: 'after', label: '後' }]}
      />
      {dayWritten ? (
        <>
          <span className={styles.timingWord}>の</span>
          <SaveErrorField names={["sendAtTime","step.sendAtTime","send_at_time","step.send_at_time"]}><TimeField
            aria-label="送る時刻"
            className={styles.timingTime}
            value={step.sendAtTime ?? ''}
            onChange={(next) => onChange({ sendAtTime: next || null })}
          /></SaveErrorField>
        </>
      ) : null}
      <span className={styles.spacer} aria-hidden="true" />
      <span className={styles.timingExample}>{`例：${formatShort(base)} の予約 → ${formatShort(example)} に届く`}</span>
    </div>
  )
}
