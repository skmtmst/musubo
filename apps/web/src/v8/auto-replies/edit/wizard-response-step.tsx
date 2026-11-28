'use client'

import { useActionOptions } from '@/components/auto-replies/inline-action-list';
import InlineActionRowsV8 from '@/components/auto-replies/inline-action-rows-v8';
import Button from '@/components/shared/button';
import Card,{ CardHeader } from '@/components/shared/card';
import Notice from '@/components/shared/notice';
import Toggle from '@/components/shared/toggle';
import { EntityKindField } from '@/components/shared/entity-picker-sources';
import { Field,FieldError } from '@/components/shared/form-controls';
import ImageUploader from '@/components/shared/image-uploader';
import InsertTextField from '@/components/shared/insert-text-field';
import MessageInsertRow,{ MessageBody } from '@/components/shared/message-insert-row';
import NumberInput from '@/components/shared/number-field';
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import Select from '@/components/shared/select';
import { TextArea } from '@/components/shared/text-field';
import { formatNumber } from '@/lib/format';
import {
CircleCheck,
FileText,
Image as ImageIcon,
LayoutTemplate,
PenLine
} from 'lucide-react';
import { useInsertReferences } from '@/lib/use-insert-token-names'
import { referenceTokenNames } from '@/components/shared/insert-tokens'
import AutoReplyInsertChips from './insert-chips';
import { REPLY_DELAY_OPTIONS,ResponseMode,WizardForm } from './wizard-model';
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css';

type WizardResponseStepContext = {
  disabled?: boolean
  lockedReason?: string
  actionOptions: ReturnType<typeof useActionOptions>
  fieldError: (field: string) => string | undefined
  form: WizardForm
  imageContent: { originalContentUrl: string; previewImageUrl: string; } | null
  matchedAccountId: string | null
  patch: (part: Partial<WizardForm>) => void
  templates: { id: string; name: string; messageType: string; messageContent: string; folderId?: string | null; updatedAt?: string; }[]
  templateState?: 'loading' | 'ready' | 'error' | 'retrying'
  loadTemplates?: () => Promise<void>
}

export function WizardResponseStep({ disabled = false, lockedReason, actionOptions, fieldError, form, imageContent, matchedAccountId, patch, templates, templateState = 'ready', loadTemplates }: WizardResponseStepContext) {
  const { references, state: referenceState } = useInsertReferences(matchedAccountId)
  const tokenNames = referenceTokenNames(references)
  return (<>
              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>返すもの</>} />
                <div className={styles.chips} role="group" aria-label="返すもの">
                  {(
                    [
                      ['inline-text', 'この画面で書く', PenLine],
                      ['template', 'テンプレートから', FileText],
                      ['inline-flex', 'カード', LayoutTemplate],
                      ['inline-image', '画像', ImageIcon],
                      ['silent', '返信しない（後の処理だけ）', CircleCheck],
                    ] as Array<[ResponseMode, string, typeof PenLine]>
                  ).map(([value, label, Icon]) => (
                    <button disabled={disabled}
                      key={value}
                      type="button"
                      className={styles.pickChip}
                      aria-pressed={form.mode === value}
                      onClick={() => patch({ mode: value })}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>

                {form.mode === 'inline-text' && (
                  <MessageBody>
                    <SaveErrorField names={["responseContent","form.responseContent","response_content","form.response_content"]}><InsertTextField tokenNames={tokenNames} disabled={disabled}
                      id="wiz-content"
                      aria-invalid={!!fieldError('wiz-content') || undefined}
                      aria-describedby={fieldError('wiz-content') ? 'wiz-content-error' : undefined}
                      aria-label="返す文"
                      editorSize="message"
                      value={form.responseContent}
                      onValueChange={(next) => patch({ responseContent: next })}
                      placeholder="例：予約の変更を承りました。担当者が確認次第ご連絡します。"
                      maxLength={5000}
                    /></SaveErrorField>
                    <MessageInsertRow count={`${formatNumber(form.responseContent.length)} / 5,000`}>
                      <AutoReplyInsertChips references={references} referenceState={referenceState} disabled={disabled} lockedReason={lockedReason} accountId={matchedAccountId} onInsert={(token) => patch({ responseContent: form.responseContent + token })} />
                    </MessageInsertRow>
                    {fieldError('wiz-content') ? <FieldError id="wiz-content-error">{fieldError('wiz-content')}</FieldError> : null}
                  </MessageBody>
                )}

                {form.mode === 'template' && (
                  <div className={styles.field}>
                    <span className={styles.label}>
                      テンプレート
                    </span>
                    <SaveErrorField names={["templateId","form.templateId"]}><EntityKindField disabled={disabled}
                      kind="template"
                      id="wiz-template"
                      label="テンプレート"
                      options={templates}
                      accountId={matchedAccountId}
                      invalid={!!fieldError('wiz-template')}
                      value={form.templateId ?? ''}
                      onChange={(v) => patch({ templateId: v || null })}
                    /></SaveErrorField>
                    {fieldError('wiz-template') ? <FieldError id="wiz-template-error">{fieldError('wiz-template')}</FieldError> : null}
                    {templateState === 'error' || templateState === 'retrying' ? (
                      <Notice
                        tone="warn"
                        message="テンプレートを読み込めませんでした。入力中の内容はそのまま残ります。"
                        action={
                          loadTemplates ? (
                            <Button
                              variant="text"
                              size="inline"
                              onClick={() => void loadTemplates()}
                              disabled={templateState === 'retrying'}
                              busy={templateState === 'retrying'}
                              busyLabel="読み込んでいます"
                            >
                              テンプレートを読み直す
                            </Button>
                          ) : undefined
                        }
                      />
                    ) : null}
                    <p className={styles.hint}>テンプレートの管理は「ひな形を管理」からできます。</p>
                  </div>
                )}

                {form.mode === 'inline-flex' && (
                  <div className={styles.field}><Field label="カードの内容（JSON）" htmlFor="wiz-flex"><SaveErrorField names={["responseContent","form.responseContent","response_content","form.response_content"]}><TextArea disabled={disabled}
                      id="wiz-flex"
                      invalid={!!fieldError('wiz-flex')}
                      aria-describedby={fieldError('wiz-flex') ? 'wiz-flex-error' : undefined}
                      value={form.responseContent}
                      onChange={(e) => patch({ responseContent: e.target.value })}
                      placeholder='{"type":"bubble", ...}'
                    /></SaveErrorField>
{fieldError('wiz-flex') ? <FieldError id="wiz-flex-error">{fieldError('wiz-flex')}</FieldError> : null}</Field></div>
                )}

                {form.mode === 'inline-image' && (
                  <div id="wiz-image" role="group" aria-label="返信する画像" aria-describedby={fieldError('wiz-image') ? 'wiz-image-error' : undefined} data-invalid={!!fieldError('wiz-image') || undefined} className={styles.compositeField}>
                  <ImageUploader disabled={disabled}
                    mode="line-image"
                    label="返信する画像"
                    title="返信する画像を追加"
                    value={
                      imageContent
                        ? { mode: 'line-image', ...imageContent }
                        : null
                    }
                    onChange={(v) =>
                      patch({
                        responseContent:
                          v && v.mode === 'line-image'
                            ? JSON.stringify({ originalContentUrl: v.originalContentUrl, previewImageUrl: v.previewImageUrl })
                            : '',
                      })
                    }
                  />
                  {fieldError('wiz-image') ? <FieldError id="wiz-image-error">{fieldError('wiz-image')}</FieldError> : null}
                  </div>
                )}

                {form.mode === 'silent' && (
                  <p className={styles.hint}>
                    返信は送りません。下の「返したあとに行うこと」で決めた処理だけが動きます。
                  </p>
                )}
              </Card>

              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>返したあとに行うこと</>} meta={<>上から順に動きます。失敗したときの動きも決められます。</>} />
                <InlineActionRowsV8 disabled={disabled} lockedReason={lockedReason}
                  actions={form.actions}
                  onChange={(next) => patch({ actions: next })}
                  {...actionOptions}
                />
              </Card>

              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>細かい決まり</>} />
                <div className={styles.ruleRows}>
                <div className={styles.toggleRow}>
                  <div className={styles.toggleText}>
                    <p className={styles.toggleTitle}>返すまで待つ時間</p>
                  </div>
                  <SaveErrorField names={["replyDelaySeconds","form.replyDelaySeconds","reply_delay_seconds","form.reply_delay_seconds"]}><Select disabled={disabled}
                    aria-label="返すまで待つ時間"
                    value={form.replyDelaySeconds}
                    onChange={(v) => patch({ replyDelaySeconds: v })}
                    options={[...REPLY_DELAY_OPTIONS]}
                  /></SaveErrorField>
                </div>
                <div className={styles.toggleRow}>
                  <div className={styles.toggleText}>
                    <p className={styles.toggleTitle}>同じ人へ続けて返さない</p>
                  </div>
                  <div className={styles.toggleExtra}>
                    {form.cooldownOn ? (
                        <SaveErrorField names={["cooldownMinutes","form.cooldownMinutes","cooldown_minutes","form.cooldown_minutes"]}><NumberInput disabled={disabled}
                          id="wiz-cooldown"
                          aria-invalid={!!fieldError('wiz-cooldown') || undefined}
                          aria-describedby={fieldError('wiz-cooldown') ? 'wiz-cooldown-error' : undefined}
                          type="number"
                          unit="分あける"
                          aria-label="あける時間（分）"
                          min={1}
                          max={10080}
                          value={form.cooldownMinutes}
                          onChange={(e) => patch({ cooldownMinutes: e.target.value })}
                        /></SaveErrorField>
                    ) : (
                      <span className={styles.toggleNote}>何度でも返す</span>
                    )}
                    <SaveErrorField names={["cooldownOn","form.cooldownOn","cooldown_on","form.cooldown_on"]}><Toggle disabled={disabled}
                      label="同じ人へ続けて返さない"
                      checked={form.cooldownOn}
                      onChange={(on) => patch({ cooldownOn: on })}
                    /></SaveErrorField>
                  </div>
                </div>
                {fieldError('wiz-cooldown') ? <FieldError id="wiz-cooldown-error">{fieldError('wiz-cooldown')}</FieldError> : null}
                <div className={styles.toggleRow}>
                  <div className={styles.toggleText}>
                    <p className={styles.toggleTitle}>担当者が対応中のトークには返さない</p>
                  </div>
                  <SaveErrorField names={["skipWhenOperatorActive","form.skipWhenOperatorActive","skip_when_operator_active","form.skip_when_operator_active"]}><Toggle disabled={disabled}
                    label="担当者が対応中のトークには返さない"
                    checked={form.skipWhenOperatorActive}
                    onChange={(on) => patch({ skipWhenOperatorActive: on })}
                  /></SaveErrorField>
                </div>
                <div className={styles.toggleRow}>
                  <div className={styles.toggleText}>
                    <p className={styles.toggleTitle}>1人につき1回だけ返す</p>
                    <p className={styles.toggleNote}>
                      オフのときは、同じ人が何度送っても返します（上の「続けて返さない」の時間は守ります）
                    </p>
                  </div>
                  <SaveErrorField names={["oncePerFriend","form.oncePerFriend","once_per_friend","form.once_per_friend"]}><Toggle disabled={disabled}
                    label="1人につき1回だけ返す"
                    checked={form.oncePerFriend}
                    onChange={(on) => patch({ oncePerFriend: on })}
                  /></SaveErrorField>
                </div>
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>条件に合わなかったとき</span>
                  <SaveErrorField names={["unmatched","unmatchedMode","form.unmatchedMode"]}><RadioCardGroup legend="条件に合わなかったとき" className={styles.radioPair}>
                    <RadioCard disabled={disabled}
                      name="unmatched"
                      value="none"
                      checked={form.unmatchedMode === 'none'}
                      onChange={() => patch({ unmatchedMode: 'none' })}
                      title="何もしない"
                      note="反応しないまま終わります"
                    />
                    <RadioCard disabled={disabled}
                      name="unmatched"
                      value="notify"
                      checked={form.unmatchedMode === 'notify_operator'}
                      onChange={() => patch({ unmatchedMode: 'notify_operator' })}
                      title="担当者へ引き継ぐ"
                      note="人手で対応するよう知らせます"
                    />
                  </RadioCardGroup></SaveErrorField>
                </div>
              </Card>
            </>)
}
