'use client'

import {
MESSAGE_KIND_WORDS
} from '@/v8/auto-replies/auto-reply-words';
import {
HOLIDAY_RULE_LABELS,
WEEKDAY_LABELS,
applyMatchType,
type HolidayRuleValue,
type KeywordRuleDraft
} from '@/components/auto-replies/draft-fields';
import Card,{ CardHeader } from '@/components/shared/card';
import Checkbox from '@/components/shared/checkbox';
import ConditionBuilder from '@/components/shared/condition-builder';
import { TimeField } from '@/components/shared/date-time-field';
import { Field,FieldError } from '@/components/shared/form-controls';
import KeywordInput from '@/components/shared/keyword-input';
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import Select from '@/components/shared/select';
import {
ListFilter,
MessagesSquare,
TextSearch,
Users,
X
} from 'lucide-react';
import type { Dispatch,JSX,SetStateAction } from 'react';
import { KIND_ICONS,MAIN_KINDS,WEEKDAY_PRESETS,WizardForm,kindOrder,weekdaySummary } from './wizard-model';
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css';

type WizardTriggerStepContext = {
  disabled?: boolean
  lockedReason?: string
  effectiveKeywords: KeywordRuleDraft[]
  fieldError: (field: string) => string | undefined
  form: WizardForm
  moreKindsButton: JSX.Element | null
  narrow: boolean
  patch: (part: Partial<WizardForm>) => void
  setWeekdayNotice: Dispatch<SetStateAction<string>>
  showMoreKinds: boolean
  weekdayNotice: string
}

export function WizardTriggerStep({ disabled = false, lockedReason, effectiveKeywords, fieldError, form, moreKindsButton, narrow, patch, setWeekdayNotice, showMoreKinds, weekdayNotice }: WizardTriggerStepContext) {
  return (<>
              <Card variant="form" gap="normal" className={`${styles.cardContent} ${styles.stepTrigger}`}>
                <CardHeader size="stacked" title={<>1. どのメッセージに反応するか</>} meta={<>届いた言葉で決めます。</>} />
                <SaveErrorField names={["trigger-kind","respondToAll","form.respondToAll"]}><RadioCardGroup legend="反応するメッセージ" className={styles.radioPair}>
                  <RadioCard disabled={disabled}
                    name="trigger-kind"
                    value="keyword"
                    checked={!form.respondToAll}
                    onChange={() => patch({ respondToAll: false })}
                    title="言葉で反応する"
                    icon={<TextSearch size={16} />}
                    note="決めた言葉が入っていたら返す"
                  />
                  <RadioCard disabled={disabled}
                    name="trigger-kind"
                    value="all"
                    checked={form.respondToAll}
                    onChange={() => patch({ respondToAll: true })}
                    title="すべてのメッセージ"
                    icon={<MessagesSquare size={16} />}
                    note="届いたものすべてに返す"
                  />
                </RadioCardGroup></SaveErrorField>

                {!form.respondToAll && (
                  <>
                    <div className={`${styles.field} ${styles.kwField}`}>
                      <span className={styles.label} id="wiz-keywords-label">反応する言葉</span>
                      <div className={styles.kwRow} role="group" aria-labelledby="wiz-keywords-label">
                        {effectiveKeywords.map((rule, index) => (
                          <span key={`${rule.keyword}-${index}`} className={styles.chip}>
                            {rule.keyword.trim()}
                            <button disabled={disabled}
                              type="button"
                              className={styles.chipRemove}
                              data-hit-area=""
                              aria-label={`「${rule.keyword.trim()}」を外す`}
                              onClick={() =>
                                patch({
                                  keywordRules: effectiveKeywords.filter((_, i) => i !== index),
                                })
                              }
                            >
                              <X size={16} aria-hidden="true" />
                            </button>
                          </span>
                        ))}
                        <SaveErrorField names={["value"]}><KeywordInput disabled={disabled} maxLength={200}
                          id="wiz-keywords" label="反応する言葉を足す" errorId="wiz-keywords-error"
                          error={fieldError('wiz-keywords')}
                          onAdd={(word) => {
                            const trimmed = word.trim()
                            if (!trimmed) return
                            if (form.keywordRules.some((r) => r.keyword.trim() === trimmed)) return
                            patch({
                              keywordRules: [
                                ...form.keywordRules.filter((r) => r.keyword.trim() !== ''),
                                { keyword: trimmed, matchType: form.matchType, minLength: '', caseSensitive: true },
                              ],
                            })
                          }}
                        /></SaveErrorField>
                      </div>
                      {fieldError('wiz-keywords') ? <FieldError id="wiz-keywords-error">{fieldError('wiz-keywords')}</FieldError> : null}
                    </div>
                    <div className={styles.pairRow}>
                    <div className={styles.field}>
                      <span className={styles.label}>言葉の合い方</span>
                      <div className={styles.seg} role="group" aria-label="言葉の合い方">
                        <button disabled={disabled}
                          type="button"
                          className={styles.segBtn}
                          aria-pressed={form.matchType === 'contains'}
                          onClick={() =>
                            patch({
                              matchType: 'contains',
                              keywordRules: applyMatchType(form.keywordRules, 'contains'),
                            })
                          }
                        >
                          部分一致（含む）
                        </button>
                        <button disabled={disabled}
                          type="button"
                          className={styles.segBtn}
                          aria-pressed={form.matchType === 'exact'}
                          onClick={() =>
                            patch({
                              matchType: 'exact',
                              keywordRules: applyMatchType(form.keywordRules, 'exact'),
                            })
                          }
                        >
                          完全一致
                        </button>
                      </div>
                    </div>
                    {effectiveKeywords.length > 1 && (
                      <div className={styles.field}>
                        <span className={styles.label}>言葉が2つ以上のとき</span>
                        <div className={styles.seg} role="group" aria-label="言葉が2つ以上のとき">
                          <button disabled={disabled}
                            type="button"
                            className={styles.segBtn}
                            aria-pressed={form.keywordMatchMode === 'any'}
                            onClick={() => patch({ keywordMatchMode: 'any' })}
                          >
                            どれか1つで反応
                          </button>
                          <button disabled={disabled}
                            type="button"
                            className={styles.segBtn}
                            aria-pressed={form.keywordMatchMode === 'all'}
                            onClick={() => patch({ keywordMatchMode: 'all' })}
                          >
                            すべて入っていたら
                          </button>
                        </div>
                      </div>
                    )}
                    </div>
                  </>
                )}

                <div className={`${styles.field} ${!narrow ? styles.kindField : ''}`}>
                  <div className={styles.labelRow}>
                    <span className={styles.label}>反応するメッセージの種類</span>
                    {/* 1152 の板（Z2LIUx）は札の行に余地が無いので、題の行の右に置く。 */}
                    {narrow ? moreKindsButton : null}
                    {/* 受け取る場所（LINE・メール）は機能として残す。絵に場所が無いので題の行の右に小さく。 */}
                    <span className={styles.sourceInline} role="group" aria-label="受け取る場所">
                      受け取る場所
                      <Checkbox disabled={disabled}
                      checked={form.receiveSources.includes('line')}
                      onCheckedChange={(on) =>
                        patch({
                          receiveSources: on
                            ? [...new Set([...form.receiveSources, 'line' as const])]
                            : form.receiveSources.filter((s) => s !== 'line'),
                        })
                      }
                    >
                      LINE
                    </Checkbox>
                    <Checkbox disabled={disabled}
                      checked={form.receiveSources.includes('email')}
                      onCheckedChange={(on) =>
                        patch({
                          receiveSources: on
                            ? [...new Set([...form.receiveSources, 'email' as const])]
                            : form.receiveSources.filter((s) => s !== 'email'),
                        })
                      }
                    >
                      メール
                    </Checkbox>
                    </span>
                  </div>
                  <div className={styles.kindsRow} role="group" aria-label="反応するメッセージの種類">
                    {[...MESSAGE_KIND_WORDS]
                      .sort((p, q) => kindOrder(p.label) - kindOrder(q.label))
                      .filter((kind) => showMoreKinds || MAIN_KINDS.includes(kind.label) || form.messageKinds.includes(kind.key))
                      .map((kind) => {
                      const on = form.messageKinds.includes(kind.key)
                      return (
                        <button disabled={disabled}
                          key={kind.key}
                          type="button"
                          className={styles.pickChip}
                          aria-pressed={on}
                          onClick={() =>
                            patch({
                              messageKinds: on
                                ? form.messageKinds.filter((k) => k !== kind.key)
                                : [...form.messageKinds, kind.key],
                            })
                          }
                        >
                          {(() => { const Icon = KIND_ICONS[kind.label]; return Icon ? <Icon size={16} aria-hidden="true" /> : null })()}
                          {kind.label}
                        </button>
                      )
                    })}
                    {!narrow && moreKindsButton}
                    <span className={styles.kindsNote}>
                      {form.messageKinds.length === 0
                        ? '何も選ばなければ、どの種類にも反応'
                        : '言葉で反応するときは、テキストだけ'}
                    </span>
                  </div>
                </div>

              </Card>

              <Card variant="form" gap="normal" className={`${styles.cardContent} ${styles.stepTrigger}`}>
                <CardHeader size="stacked" title={<>2. いつ反応するか</>} meta={<>曜日と時間帯を決めます。祝日は「営業日」の設定に従います。</>} />
                <div className={styles.field}>
                  <span className={styles.label}>曜日</span>
                  <div className={styles.weekdayRow}>
                  <div className={styles.weekdays} role="group" aria-label="反応する曜日" aria-describedby={weekdayNotice ? 'wiz-weekday-error' : undefined} aria-invalid={Boolean(weekdayNotice)}>
                    {/* 絵 A0pDt は月曜はじまり。保存する値（0=日〜6=土）は変えない。 */}
                    {[1, 2, 3, 4, 5, 6, 0].map((index) => {
                      const label = WEEKDAY_LABELS[index]
                      const on = form.weekdays.includes(index)
                      return (
                        <button disabled={disabled}
                          key={label}
                          type="button"
                          className={styles.weekday}
                          /* つなげた7つ。選んだ日は地の色だけで示し、共通の選択の枠は付けない。 */
                          data-part="joined-segment"
                          aria-pressed={on}
                          onClick={() => {
                            const next = on
                              ? form.weekdays.filter((d) => d !== index)
                              : [...form.weekdays, index].sort()
                            if (next.length === 0) {
                              setWeekdayNotice('反応する曜日を1つ以上選んでください。')
                              return
                            } else {
                              setWeekdayNotice('')
                            }
                            patch({ weekdays: next })
                          }}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                  <div className={styles.weekdayPresets}>
                    <span>まとめて：</span>
                    {WEEKDAY_PRESETS.map((preset) => (
                      <button disabled={disabled}
                        key={preset.key}
                        type="button"
                        className={styles.weekdayPreset}
                        onClick={() => {
                          setWeekdayNotice('')
                          patch({ weekdays: preset.days })
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <span className={styles.weekdaySummary}>
                      {weekdaySummary(form.weekdays)}
                    </span>
                  </div>
                  </div>
                  {weekdayNotice ? <FieldError id="wiz-weekday-error">{weekdayNotice}</FieldError> : null}
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>時間帯</span>
                  <div className={styles.weekdayRow}>
                  <div className={styles.seg} role="group" aria-label="反応する時間帯">
                    <button disabled={disabled}
                      type="button"
                      className={styles.segBtn}
                      aria-pressed={form.timeMode === 'always'}
                      onClick={() => patch({ timeMode: 'always' })}
                    >
                      いつでも
                    </button>
                    <button disabled={disabled}
                      type="button"
                      className={styles.segBtn}
                      aria-pressed={form.timeMode === 'custom' && form.activeFrom === '21:00' && form.activeUntil === '09:00'}
                      onClick={() => patch({ timeMode: 'custom', activeFrom: '21:00', activeUntil: '09:00' })}
                      title="夜21時から朝9時まで。時刻はあとから変えられます"
                    >
                      夜21時〜朝9時
                    </button>
                    <button disabled={disabled}
                      type="button"
                      className={styles.segBtn}
                      aria-pressed={form.timeMode === 'custom' && !(form.activeFrom === '21:00' && form.activeUntil === '09:00')}
                      onClick={() => patch({ timeMode: 'custom', activeFrom: form.activeFrom || '09:00', activeUntil: form.activeUntil || '18:00' })}
                    >
                      時刻を決める
                    </button>
                  </div>
                  {/* 祝日の扱いは機能として残す（絵は説明の1行だけ）。場所を取らないよう時間帯の横に小さく。 */}
                  <Field label="祝日"><SaveErrorField names={["holidayRule","form.holidayRule","holiday_rule","form.holiday_rule"]}><Select disabled={disabled}
                      aria-label="祝日の扱い"
                      value={form.holidayRule}
                      onChange={(v) => patch({ holidayRule: v as HolidayRuleValue })}
                      options={HOLIDAY_RULE_LABELS.map((o) => ({ value: o.value, label: o.label }))}
                    /></SaveErrorField></Field>
                  </div>
                  {form.timeMode === 'custom' && (
                    <div className={styles.chips}>
                      <SaveErrorField names={["activeFrom","form.activeFrom","active_from","form.active_from"]}><TimeField disabled={disabled}
                        aria-label="始める時刻"
                        value={form.activeFrom}
                        onChange={(v) => patch({ activeFrom: v })}
                      /></SaveErrorField>
                      <span className={styles.weekdayNow}>〜</span>
                      <SaveErrorField names={["activeUntil","form.activeUntil","active_until","form.active_until"]}><TimeField disabled={disabled}
                        aria-label="終わる時刻"
                        value={form.activeUntil}
                        onChange={(v) => patch({ activeUntil: v })}
                      /></SaveErrorField>
                    </div>
                  )}
                </div>
              </Card>

              <Card variant="form" gap="normal" className={`${styles.cardContent} ${styles.stepTrigger}`}>
                <CardHeader size="stacked" title={<>3. 誰に反応するか</>} />
                <SaveErrorField names={["friend-target","friendTarget","form.friendTarget"]}><RadioCardGroup legend="反応する相手" className={styles.radioPair}>
                  <RadioCard disabled={disabled}
                    name="friend-target"
                    value="all"
                    checked={form.friendTarget === 'all'}
                    onChange={() => patch({ friendTarget: 'all' })}
                    title="すべての友だち"
                    icon={<Users size={16} />}
                    note="届いた人みんなに返す"
                  />
                  <RadioCard disabled={disabled}
                    name="friend-target"
                    value="filtered"
                    checked={form.friendTarget === 'filtered'}
                    onChange={() => patch({ friendTarget: 'filtered' })}
                    title="条件に合う友だち"
                    icon={<ListFilter size={16} />}
                    note="タグ・友だち情報・予約などで絞る"
                  />
                </RadioCardGroup></SaveErrorField>
                {form.friendTarget === 'filtered' ? (
                  <div id="wiz-conditions" role="group" aria-label="反応する友だちの条件" aria-describedby={fieldError('wiz-conditions') ? 'wiz-conditions-error' : undefined} data-invalid={!!fieldError('wiz-conditions') || undefined} className={styles.compositeField}>
                  <ConditionBuilder disabled={disabled} lockedReason={lockedReason}
                    value={form.friendConditions}
                    onChange={(next) => patch({ friendConditions: next })}
                    label="反応する友だちの条件"
                  />
                  {fieldError('wiz-conditions') ? <FieldError id="wiz-conditions-error">{fieldError('wiz-conditions')}</FieldError> : null}
                  </div>
                ) : (
                  <p className={styles.hint}>条件を入れないと、全員に反応します。</p>
                )}
              </Card>
            </>)
}
