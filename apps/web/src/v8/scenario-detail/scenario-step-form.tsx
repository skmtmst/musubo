'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'

import CarouselPicker from '@/components/scenarios/carousel-picker'
import InsertToolbar from '@/components/scenarios/insert-toolbar'
import MessageKindFields, { serializeMessageKind, type MessageKind, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import type { StepMessageKind } from '@/components/scenarios/message-type-tabs'
import QuestionEditor, { emptyQuestion, withChoiceKeys, type ScenarioQuestion } from '@/components/scenarios/question-editor'
import ScheduleInput, { buildSchedulePayload } from '@/components/scenarios/schedule-input'
import StepPreview from '@/components/scenarios/step-preview'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import { emptyValue } from '@/components/shared/empty-value'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { Field, FieldError } from '@/components/shared/form-controls'
import InsertTextField, { type InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import { MessageBody } from '@/components/shared/message-insert-row'
import NumberInput from '@/components/shared/number-field'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { formatNumber } from '@/lib/format'
import { useFormErrors } from '@/lib/use-form-errors'
import { scenarioDraftStatus, BrowserDraftNotice, ScenarioDraftConflictNotice } from '@/v8/autosave/public/browser-draft-notice/index'
import { ScenarioDraftLoadNotice } from '@/v8/autosave/public/scenario-draft-load-notice/index'
import { useScenarioDraft } from '@/v8/autosave/public/use-scenario-draft/index'
import type { DeliveryMode, MessageType, ScenarioStep } from '@line-crm/shared'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { formatScheduleLabel, FormSection, isStructuredKind, messageTypeOptions, ScenarioWithSteps, StepFormState, TagOpt, TemplateOpt } from './detail-model'
import { cloneScenarioQuestion } from './question-template-model'
import { describeAfterSend, describeStepAudience } from './scenario-step-audience'

export function ScenarioStepForm({
  editingStepId, stepDraft, restoreStepDraft, loadLatestStepDraft,
  stepForm, setStepForm, stepFields, deliveryMode,
  scenario, setActionTarget, templates, folderAccountId,
  kindState, setKindState, stepBodyRef, setStepTargetOpen,
  tags, stepError, handleSaveStep, stepSaving,
  closeStepForm, stepFormPreview, accountName,
}: {
  editingStepId: string | null
  stepDraft: ReturnType<typeof useScenarioDraft>
  restoreStepDraft: () => void
  loadLatestStepDraft: () => void
  stepForm: StepFormState
  setStepForm: Dispatch<SetStateAction<StepFormState>>
  stepFields: ReturnType<typeof useFormErrors>
  deliveryMode: DeliveryMode
  scenario: ScenarioWithSteps | null
  setActionTarget: Dispatch<SetStateAction<{ hook: "step_sent" | "scenario_completed" | "choice_selected"; stepId: string | null; choiceIndex: number | null; title: string; } | null>>
  templates: TemplateOpt[]
  folderAccountId: string | null
  kindState: MessageKindState
  setKindState: Dispatch<SetStateAction<MessageKindState>>
  stepBodyRef: RefObject<HTMLTextAreaElement | InsertTextFieldHandle | null>
  setStepTargetOpen: Dispatch<SetStateAction<boolean>>
  tags: TagOpt[]
  stepError: string
  handleSaveStep: () => Promise<void>
  stepSaving: boolean
  closeStepForm: () => void
  accountName?: string
  stepFormPreview: { offsetDays: number; offsetHours: number; offsetMinutes: number; }
}) {
  const tokenNames = useInsertTokenNames(scenario?.lineAccountId ?? null)
  const displayOrder = editingStepId ? [...(scenario?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder).findIndex((step) => step.id === editingStepId) + 1 : (scenario?.steps ?? []).filter((step) => step.stepOrder < stepForm.stepOrder).length + 1
  return (    <div className={editingStepId ? '' : 'border-hairline rounded-card bg-canvas-sunken border p-4'}>
      {!editingStepId && (
        <h4 className="text-sm font-semibold text-ink-secondary mb-3">新しいステップを追加</h4>
      )}
      <ScenarioDraftLoadNotice failed={stepDraft.loadFailed} onRetry={stepDraft.retryLoad} />
      <BrowserDraftNotice ago={stepDraft.pendingAgo} onRestore={restoreStepDraft} onDiscard={stepDraft.clear} />
      <ScenarioDraftConflictNotice ago={stepDraft.conflictAgo} onLoadLatest={loadLatestStepDraft} onOverwrite={stepDraft.overwrite} />
      {/* 左が編集、右が「いまどの通を触っているか」。任意値の桁指定ではなく
          3列の標準段で組む（2:1）。直書きの数を増やさない。 */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <div className="min-w-0 space-y-4 xl:col-span-2">
        <FormSection
          node="xfYLn"
          title="配信タイミング"
          description="いつ送るか。送ったあと次の通へ進むかどうかも、設計どおりここでそろえて決めます。"
        >
          <div className="space-y-3">
        <div><Field label="ステップ順序"><SaveErrorField names={["stepOrder","stepForm.stepOrder","step_order","step_form.step_order","step_form"]}><NumberInput
            type="number"
            min={1}
            className="w-32 border-hairline rounded-control bg-canvas text-ink border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            value={stepForm.stepOrder}
            onChange={(e) => setStepForm({ ...stepForm, stepOrder: Number(e.target.value) })}
          /></SaveErrorField></Field></div>
        <div {...stepFields.bind('time')} aria-invalid={stepFields.invalid('time') || undefined}>
          <ScheduleInput
            mode={deliveryMode}
            value={stepForm.schedule}
            onChange={(schedule) => { stepFields.clear('time'); setStepForm({ ...stepForm, schedule }) }}
          />
          <FieldError id="step-time-error">{stepFields.error('time')}</FieldError>
        </div>
        {/*
          送ったあと止めるかどうか。体調の記録をお願いして返事を待つ、と
          いった流れで要る。止めておけば、返事が来てから人が再開できる。

          設計（xfYLn）はこれを配信タイミングの4つ目の口として並べる。
          以前は画面のいちばん下、到達タグと同じ束に置いていたので、
          「いつ送るか」を決めているときに目に入らなかった。
        */}
        <div><Field note={<>
            一時停止にすると、この通を送ったところで止まります。再開するまで次は届きません。
          </>} label="送信後"><SaveErrorField names={["afterSend","stepForm.afterSend","after_send","step_form.after_send","step_form"]}><Select
            aria-label="送信後"
            value={stepForm.afterSend}
            onChange={(value) =>
              setStepForm({ ...stepForm, afterSend: value as 'continue' | 'pause' })
            }
            options={[
              { value: 'continue', label: '送信後：次のステップへ進む' },
              { value: 'pause', label: '送信後：ここで止める' },
            ]}
            size="full"
          /></SaveErrorField>
</Field></div>
          </div>
        </FormSection>

        <FormSection title="メッセージ" description="LINEへ届く中身です。">
          <div className="space-y-3">
        {/* 入力モード切替: 直接入力 / テンプレート参照 */}
        <div className="space-y-2">
          <SaveErrorField names={["step-input-mode","inputMode","stepForm.inputMode","stepForm"]}><RadioCardGroup legend="メッセージの指定方法" className="grid gap-2 sm:grid-cols-2">
            <RadioCard
              name="step-input-mode"
              value="direct"
              checked={stepForm.inputMode === 'direct'}
              onChange={() => setStepForm({ ...stepForm, inputMode: 'direct', templateId: null })}
              title="直接入力"
            />
            <RadioCard
              name="step-input-mode"
              value="template"
              checked={stepForm.inputMode === 'template'}
              onChange={() => setStepForm({ ...stepForm, inputMode: 'template' })}
              title="テンプレートを使う"
            />
          </RadioCardGroup></SaveErrorField>
        </div>

        {/*
          質問（分岐）の通。本文の代わりに選択肢を組み立てる。ふつうの通と
          行き来できるように、切り替えのボタンをここに置く。
        */}
        {stepForm.question ? (
          <div className="border-hairline rounded-card border p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-ink text-sm font-bold">質問（分岐）</h4>
              <Button variant="secondary" className="text-ink-secondary h-9 px-3 text-xs whitespace-normal" type="button" onClick={() => setStepForm({ ...stepForm, question: null })}>
                ふつうの通に戻す
              </Button>
            </div>
            <div {...stepFields.bind('question')} ref={node => stepFields.bind('question').ref(node?.querySelector<HTMLElement>('input[aria-invalid="true"]') ?? node)} aria-invalid={stepFields.invalid('question') || undefined}>
            <FieldError id="step-question-error">{stepFields.error('question')}</FieldError>
            <QuestionEditor
              accountId={scenario?.lineAccountId ?? null}
              value={stepForm.question}
              onChange={(next) => { stepFields.clear('question'); setStepForm({ ...stepForm, question: next }) }}
              onOpenChoiceActions={
                editingStepId
                  ? (choiceIndex) =>
                      setActionTarget({
                        hook: 'choice_selected',
                        stepId: editingStepId,
                        choiceIndex,
                        title: `選択肢${choiceIndex + 1}が押されたとき`,
                      })
                  : undefined
              }
            />
            </div>
            {!editingStepId && (
              <p className="text-ink-faint mt-3 text-xs">
                選択肢ごとのアクションは、この通を保存してから設定できます。
              </p>
            )}
          </div>
        ) : (
          <Button variant="secondary" className="text-ink-secondary h-9 self-start px-3 text-xs whitespace-normal" type="button" onClick={() => setStepForm({ ...stepForm, question: emptyQuestion() })}>
            この通を質問（分岐）にする
          </Button>
        )}

        {!stepForm.question && stepForm.inputMode === 'template' && (
          <div>
            <span className="block text-xs font-medium text-ink-secondary mb-1">テンプレート <span className="text-danger">*</span></span>
            <div {...stepFields.bind('template')}>
            <SaveErrorField names={["templateId","stepForm.templateId","stepForm"]}><EntityKindField
              kind="template"
              label="テンプレート"
              options={templates}
              accountId={scenario?.lineAccountId ?? undefined}
              invalid={stepFields.invalid('template')}
              describedBy={stepFields.invalid('template') ? 'step-template-error' : undefined}
              value={stepForm.templateId ?? ''}
              onChange={(value) => {
                stepFields.clear('template')
                const templateId = value || null
                const template = templates.find((item) => item.id === templateId)
                setStepForm({
                  ...stepForm,
                  templateId,
                  question: template?.question
                    ? withChoiceKeys(cloneScenarioQuestion(template.question))
                    : null,
                  messageType: (template?.messageType as MessageType | undefined) ?? stepForm.messageType,
                  messageContent: template?.messageContent ?? stepForm.messageContent,
                })
              }}
            /></SaveErrorField>
            </div>
            <FieldError id="step-template-error">{stepFields.error('template')}</FieldError>
            <p className="text-xs text-warning mt-1">
              ⓘ テンプレートが修正されると、このステップの内容も自動で同期されます
            </p>
          </div>
        )}

        {!stepForm.question && stepForm.inputMode === 'direct' && (
          <>
            <div><Field label="メッセージタイプ"><SaveErrorField names={["messageType","stepForm.messageType","message_type","step_form.message_type","step_form"]}><Select
                aria-label="メッセージタイプ"
                value={stepForm.messageType}
                onChange={(value) => setStepForm({ ...stepForm, messageType: value as MessageType })}
                options={messageTypeOptions}
                size="full"
              /></SaveErrorField></Field></div>
            {/*
              位置情報・動画・音声・スタンプは、本文ではなく専用の欄で書く。
              中身は JSON なので、生のまま書かせると必ず壊れる。
            */}
            <div {...stepFields.bind('content')} aria-invalid={stepFields.invalid('content') || undefined}>
            {stepForm.messageType === 'carousel' ? (
              // カルーセルはテンプレートを指す形。中身はそちらが持つ。
              <CarouselPicker
                accountId={scenario?.lineAccountId ?? null}
                value={stepForm.templateId ?? ''}
                onChange={(id, tpl) =>
                  setStepForm((prev) => ({
                    ...prev,
                    templateId: id || null,
                    // 控えは実物を入れる。テンプレートを消したときに
                    // これが使われるので、要約では送れなくなる。
                    messageContent: tpl?.messageContent ?? '',
                  }))
                }
              />
            ) : isStructuredKind(stepForm.messageType) ? (
              <MessageKindFields
                kind={stepForm.messageType as MessageKind}
                mediaAccountId={folderAccountId}
                value={kindState}
                onChange={(next) => {
                  setKindState(next)
                  const json = serializeMessageKind(stepForm.messageType as MessageKind, next)
                  setStepForm((prev) => ({ ...prev, messageContent: json ?? '' }))
                }}
              />
            ) : (
              <div><Field label="メッセージ内容" required><MessageBody><SaveErrorField names={["messageContent","stepForm.messageContent","message_content","step_form.message_content","step_form"]}><InsertTextField tokenNames={tokenNames}
                  ref={stepBodyRef}
                  className="w-full border-hairline rounded-control bg-canvas text-ink resize-none border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  rows={4}
                  placeholder="メッセージ内容を入力…"
                  value={stepForm.messageContent}
                  onValueChange={(next) => setStepForm({ ...stepForm, messageContent: next })}
                  aria-invalid={stepFields.invalid('content') || undefined}
                  aria-describedby={stepFields.invalid('content') ? 'step-content-error' : undefined}
                /></SaveErrorField>
                  {stepForm.messageType === 'text' ? <InsertToolbar targetRef={stepBodyRef} value={stepForm.messageContent} onChange={(next) => setStepForm(prev => ({ ...prev, messageContent: next }))} count={`${formatNumber(stepForm.messageContent.length)} / 5,000`} /> : null}
                </MessageBody></Field></div>
            )}
            <FieldError id="step-content-error">{stepFields.error('content')}</FieldError>
            </div>
          </>
        )}

          </div>
        </FormSection>

        {/*
          1通ごとの配信対象。シナリオ全体の絞り込みとは別。対象から外れた人は
          この通だけ飛ばして次へ進む（止めない）。

          設計（r6Gzsu）では独立した面。以前は到達タグ・配信後・下書きと
          同じ束に埋まっていて、「この通だけ誰に送るか」を決める場所だと
          読み取れなかった。
        */}
        <FormSection
          node="r6Gzsu"
          title="この通の配信対象"
          description="条件に合わない人には、この通だけ送りません。次の通へはそのまま進みます。"
          action={
            <button
              type="button"
              onClick={() => setStepTargetOpen(true)}
              className="text-action shrink-0 text-xs hover:underline"
            >
              条件を編集
            </button>
          }
        >
          <p className="text-ink text-sm font-bold">
            {describeStepAudience(stepForm.targetCondition, tags)}
          </p>
        </FormSection>

        {/*
          送信後のアクション。設計（hz9ti）では独立した面。ここでは段の枠だけ
          作り、中の並びは触っていない（別担当の受け持ち）。
        */}
        <FormSection
          node="hz9ti"
          title="送信後のアクション"
          description="この通が届いたあとに動かすものです。"
          action={
            editingStepId ? (
              <button
                type="button"
                onClick={() =>
                  setActionTarget({
                    hook: 'step_sent',
                    stepId: editingStepId,
                    choiceIndex: null,
                    title: `${displayOrder} 通目を送ったあと`,
                  })
                }
                className="text-action shrink-0 text-xs hover:underline"
              >
                ＋ アクションを追加
              </button>
            ) : undefined
          }
        >
          <div className="space-y-3">
            <div><Field note={<>
                このステップが配信完了したら、選んだタグを友だちに付与します
              </>} label="到達したらタグ付与"><SaveErrorField names={["onReachTagId","stepForm.onReachTagId","on_reach_tag_id","step_form.on_reach_tag_id","step_form"]}><EntitySelect kind="tag"
                aria-label="到達したらタグ付与"
                value={stepForm.onReachTagId ?? ''}
                onChange={(value) => setStepForm({ ...stepForm, onReachTagId: value || null })}
                options={[
                  { value: '', label: '-- なし --' },
                  ...tags.map((t) => ({ ...entityOptionMetadata(t), value: t.id, label: t.name })),
                ]}
                size="full"
              /></SaveErrorField>
</Field></div>
            {!editingStepId && (
              <p className="text-ink-faint text-xs">
                そのほかのアクションは、この通を保存してから設定できます。
              </p>
            )}
          </div>
        </FormSection>

        {/* 下書き。書きかけを保存しておくため。配信からは外れる。 */}
        <SaveErrorField names={["isDraft","stepForm.isDraft","is_draft","step_form.is_draft","step_form"]}><Checkbox
          checked={stepForm.isDraft}
          onCheckedChange={(checked) => setStepForm({ ...stepForm, isDraft: checked })}
        >
          下書きにする（配信されません。テスト送信では送れます）
        </Checkbox></SaveErrorField>

        {stepError && <p className="text-danger text-xs">{stepError}</p>}

        <div className="flex gap-2">
          <Button variant="primary" onClick={handleSaveStep} disabled={stepSaving} busy={stepSaving}>
            {editingStepId ? '更新' : '追加する'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              stepDraft.clear()
              closeStepForm()
            }}
          >
            キャンセル
          </Button>
          {stepDraft.label ? <p className="text-ink-secondary self-center text-xs" aria-live="polite" data-autosave-status>{scenarioDraftStatus(stepDraft.label)}</p> : null}
        </div>
      </div>

      {/*
        設計（xfYLn）の右の柱。いま何通目を触っているのか、その通が誰に
        どう届くのかを、編集の手を止めずに読めるようにする。
        以前は編集を閉じて表へ戻らないと、前後の通が見えなかった。
      */}
      <aside data-design-node="xfYLn" className="min-w-0 space-y-4">
        <StepPreview
          accountName={accountName}
          deliveryMode={deliveryMode}
          stepOrder={displayOrder}
          offsetDays={stepFormPreview.offsetDays}
          deliveryTime={stepForm.schedule.deliveryTime}
          offsetHours={stepFormPreview.offsetHours}
          offsetMinutes={stepFormPreview.offsetMinutes}
          kind={(stepForm.question
            ? 'question'
            : stepForm.messageType === 'flex'
              ? 'text'
              : stepForm.messageType) as StepMessageKind}
          templateName={
            stepForm.templateId
              ? templates.find((template) => template.id === stepForm.templateId)?.name
              : null
          }
          body={stepForm.messageContent}
          imageUrl={null}
          question={stepForm.question}
          kindState={kindState}
          audienceLabel={describeStepAudience(stepForm.targetCondition, tags)}
          afterSend={stepForm.afterSend}
        />

        <div className="bg-canvas content-card rounded-card border p-4">
          <h4 className="text-ink text-sm font-bold">設定内容</h4>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint shrink-0">配信対象</dt>
              <dd className="text-ink min-w-0 text-right font-semibold">
                {describeStepAudience(stepForm.targetCondition, tags)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint shrink-0">配信日時</dt>
              <dd className="text-ink min-w-0 text-right font-semibold">
                {formatScheduleLabel(deliveryMode, {
                  delayMinutes: stepForm.schedule.delayMinutes,
                  ...buildSchedulePayload(deliveryMode, stepForm.schedule),
                } as unknown as ScenarioStep)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint shrink-0">送信後</dt>
              <dd className="text-ink min-w-0 text-right font-semibold">
                {describeAfterSend(stepForm.afterSend).label}
              </dd>
            </div>
            {/* 「送信枠を超えていません」「テスト送信が未完了です」は設計にあるが、
                残りの送信枠もテスト送信の済み／未済も**数える口が無い**。
                数を作らずに、繋がっていないことをそのまま書く。 */}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint shrink-0">配信前チェック</dt>
              <dd className="text-ink-faint min-w-0 text-right">{emptyValue('unknown')}</dd>
            </div>
          </dl>
          <p className="text-ink-faint mt-2 text-xs leading-relaxed">
            配信前チェックはまだ繋がっていません。残りの送信枠とテスト送信の記録を返す取得口が接続されると表示されます。
          </p>
        </div>
      </aside>
      </div>
    </div>
)
}
