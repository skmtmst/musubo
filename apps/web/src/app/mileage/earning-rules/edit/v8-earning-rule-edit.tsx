'use client'

/*
 * ★V8-B マイル「たまる決めごとを編集」（作るの板  と同じ器、
 * 競合 ）。
 *
 * 直せるのは下書きの項目だけ（管理画面 の edit と同じ）。動いている内容は
 * ここを保存しても変わらず、一覧の「公開して反映」でだけ変わる。
 * 保存時に版がずれていたら（409）、競合の帯を板の頭の下に出し、
 * 「最新の内容を読み込んで続ける」と「比べてから保存」を出す。
 */

import { describeApiFailure } from '@/components/shared/api-error-message'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Check } from 'lucide-react'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import DateField from '@/components/shared/date-field'
import ConditionBuilder, {
  pruneCondition,
  type SegmentCondition,
} from '@/components/shared/condition-builder'
import { FieldError, TextInput } from '@/components/shared/form-controls'
import { useFormErrors } from '@/lib/use-form-errors'
import Checkbox from '@/components/shared/checkbox'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import LinePreview from '@/components/shared/line-preview'
import { ApiError, api, type MileageEarningRuleV6 } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useResponseGate } from '@/lib/use-response-gate'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import {
  EARNING_RULE_EVENT_TYPES as EVENT_TYPES,
  EARNING_RULE_NOTIFY_TEMPLATE,
  earningRuleCancellationEvent,
} from '../rule-fields'
import formStyles from '../new/v8-create-form.module.css'
import { Field } from '@/components/shared/form-controls'
import NumberInput from '@/components/shared/number-field'
import { PageHeading } from '@/components/templates/page-frame'
import { emptyValue } from '@/components/shared/empty-value'

type LoadState = 'loading' | 'ready' | 'error' | 'missing'

function EditInner() {
  const ruleId = useSearchParams().get('id') ?? ''
  const { selectedAccountId } = useAccount()

  const [state, setState] = useState<LoadState>('loading')
  const [rule, setRule] = useState<MileageEarningRuleV6 | null>(null)
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState('')
  const [source, setSource] = useState('')
  const [amount, setAmount] = useState('')
  const [initialStatus, setInitialStatus] = useState<'available' | 'pending'>('available')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [expiresAfterDays, setExpiresAfterDays] = useState('')
  const [reverseOnCancellation, setReverseOnCancellation] = useState(false)
  const [targetConditions, setTargetConditions] = useState<SegmentCondition | null>(null)
  const [notifyFriend, setNotifyFriend] = useState(true)
  const [messageTemplate, setMessageTemplate] = useState(EARNING_RULE_NOTIFY_TEMPLATE)
  const [originalDraft, setOriginalDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /* ：保存時に版がずれていたら競合の帯を出す。 */
  const [conflict, setConflict] = useState(false)

  /* W156：対象（ルール・アカウント）が変わったら、前の読み込みの応答を捨てる。 */
  const gate = useResponseGate()

  const load = useCallback(async () => {
    const token = gate.begin()
    // 前の対象の版・中身で、今の対象へ保存できないようにする。
    setRule(null)
    if (!ruleId || !selectedAccountId) {
      setState(selectedAccountId ? 'missing' : 'loading')
      return
    }
    setState('loading')
    try {
      let found: MileageEarningRuleV6 | undefined
      let offset = 0
      while (!found) {
        const res = await api.mileage.earningRulesV6({ accountId: selectedAccountId, limit: 100, offset })
        if (!gate.current(token)) return
        if (!res.success) throw new Error(res.error)
        found = res.data.items.find((item) => item.id === ruleId)
        offset += res.data.items.length
        if (found || res.data.items.length === 0 || offset >= res.data.pagination.total) break
      }
      if (!found) {
        setState('missing')
        return
      }
      setRule(found)
      setName(found.draft.name)
      setEventType(found.draft.eventType)
      setSource(found.draft.source ?? '')
      setAmount(String(found.draft.amount))
      setInitialStatus(found.draft.initialStatus)
      setValidFrom(found.draft.validFrom ? found.draft.validFrom.slice(0, 10) : '')
      setValidUntil(found.draft.validUntil ? found.draft.validUntil.slice(0, 10) : '')
      setExpiresAfterDays(found.draft.expiresAfterDays == null ? '' : String(found.draft.expiresAfterDays))
      setReverseOnCancellation(found.draft.cancellationEventTypes.length > 0)
      setTargetConditions(found.draft.targetConditions ?? null)
      setNotifyFriend(found.draft.notification?.enabled ?? true)
      setMessageTemplate(found.draft.notification?.messageTemplate || EARNING_RULE_NOTIFY_TEMPLATE)
      const loadedCancellation = earningRuleCancellationEvent(found.draft.eventType)
      setOriginalDraft(JSON.stringify({
        name: found.draft.name.trim(),
        eventType: found.draft.eventType,
        source: found.draft.source ?? null,
        amount: found.draft.amount,
        initialStatus: found.draft.initialStatus,
        validFrom: found.draft.validFrom ? found.draft.validFrom.slice(0, 10) : null,
        validUntil: found.draft.validUntil ? found.draft.validUntil.slice(0, 10) : null,
        expiresAfterDays: found.draft.expiresAfterDays,
        cancellationEventTypes: found.draft.cancellationEventTypes.length > 0 && loadedCancellation
          ? [loadedCancellation]
          : [],
        targetConditions: pruneCondition(found.draft.targetConditions ?? null),
        sortOrder: found.draft.sortOrder,
        notification: {
          enabled: found.draft.notification?.enabled ?? true,
          messageTemplate: found.draft.notification?.messageTemplate || EARNING_RULE_NOTIFY_TEMPLATE,
        },
      }))
      setConflict(false)
      setState('ready')
    } catch {
      if (!gate.current(token)) return
      setState('error')
    }
  }, [ruleId, selectedAccountId, gate])

  useEffect(() => {
    void load()
  }, [load])

  const selected = EVENT_TYPES.find((t) => t.value === eventType)
  const value = Number(amount)
  const validAmount = Number.isInteger(value) && value >= 1
  const expiryDays = expiresAfterDays === '' ? null : Number(expiresAfterDays)
  const cancellationEvent = earningRuleCancellationEvent(eventType)

  const draftPayload = {
    name: name.trim(),
    eventType,
    source: source || null,
    amount: value,
    initialStatus,
    validFrom: validFrom || null,
    validUntil: validUntil || null,
    expiresAfterDays: expiryDays,
    cancellationEventTypes: reverseOnCancellation && cancellationEvent ? [cancellationEvent] : [],
    targetConditions: pruneCondition(targetConditions),
    sortOrder: rule?.draft.sortOrder ?? 0,
    notification: { enabled: notifyFriend, messageTemplate },
  }
  const dirty = state === 'ready' && JSON.stringify(draftPayload) !== originalDraft
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  /* 保存で落ちた欄は、その欄の真下に理由を出して移る。 */
  const fields = useFormErrors()
  fields.define('name', 'ルール名', () => (name.trim() ? null : 'ルール名を入力してください'))
  fields.define('amount', '付与マイル', () => (validAmount ? null : '付与マイルは1以上の整数で入力してください'))
  fields.define('period', '開始日・終了日', () => (validFrom && validUntil && validFrom > validUntil ? '終了日は開始日より後にしてください' : null))
  fields.define('expiry', '有効期限の日数', () => (expiryDays !== null && (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650) ? '有効期限は1〜3650日で入力してください' : null))
  const describedBy = (key: string) => (fields.invalid(key) ? `er-${key}-error` : undefined)

  const save = async () => {
    if (!rule || !selectedAccountId || rule.id !== ruleId) return
    if (fields.submit().length > 0) {
      setSaveError('')
      return
    }
    setSaving(true)
    setSaveError('')
    setConflict(false)
    try {
      const res = await api.mileage.saveEarningRuleDraft(ruleId, {
        accountId: selectedAccountId,
        expectedVersion: rule.draftVersion,
        draft: draftPayload,
      })
      if (!res.success) throw new Error(res.error)
      window.location.href = '/mileage?tab=earning-rules'
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
      } else {
        setSaveError(describeApiFailure(error, '保存'))
      }
    } finally {
      setSaving(false)
    }
  }

  if (state === 'loading') {
    return (
      <div data-design-node="ctLwT">
        <ListState kind="loading" title="たまる決めごとを読み込んでいます" />
      </div>
    )
  }
  if (state === 'missing') {
    return (
      <div data-design-node="ctLwT">
        <ListState
          kind="empty"
          title="この決めごとが見つかりません"
          description="すでに削除されたか、別のLINEアカウントの決めごとです。一覧からもう一度開いてください。"
          action={<Button href="/mileage?tab=earning-rules">たまる決めごとへ戻る</Button>}
        />
      </div>
    )
  }
  if (state === 'error' || !rule) {
    return (
      <div data-design-node="ctLwT">
        <ListState
          kind="error"
          title="たまる決めごとを読み込めませんでした"
          description="再読み込みしても直らない場合はエラー報告へ。"
          onRetry={() => void load()}
        />
      </div>
    )
  }

  return (
    <div data-design-node="ctLwT" className={formStyles.page}>
      <div className={formStyles.head}>
        <PageHeading title="たまる決めごとを編集" help={<>
          下書きを直します。動いている内容は変わりません——一覧の「公開して反映」でだけ反映されます。
        </>} />

      </div>

      {conflict ? (
        <Notice tone="warn" role="alert" heading={<>ほかの人が先にこの決めごとを直しました</>} action={<>
          <div className={formStyles.conflictActions}>
            <Button onClick={() => void load()}>最新を読み込んで続ける</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving} busy={saving} busyLabel="保存しています">
              比べてから保存
            </Button>
          </div>
        </>}>
          <p className={formStyles.conflictText}>
            開いている間に下書きが変わっています。そのまま保存すると上書きになります。
            最新を読み込んで違いを比べてから、もう一度直してください。
          </p>
        </Notice>
      ) : null}
      {saveError ? <Notice tone="danger" message={saveError} /> : null}

      <div className={formStyles.columns}>
        <div className={formStyles.main}>
          <section className={formStyles.card} aria-label="どのルールか">
            <h2 className={formStyles.cardTitle}>どのルールか</h2>
            <p className={formStyles.cardNote}>きっかけになる行動を選びます</p>
            <div className={formStyles.field}>
              <span className={formStyles.label}>ルール名 <span className={formStyles.required}>必須</span></span>
              <TextInput {...fields.bind('name')} invalid={fields.invalid('name')} aria-describedby={describedBy('name')} type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="ルール名" />
              <FieldError id="er-name-error">{fields.error('name')}</FieldError>
              <span className={formStyles.hint}>一覧に表示される名前です。お客様には見えません。</span>
            </div>
            <div className={formStyles.grid2}>
              <Field note={<>{selected?.note ?? 'この画面で扱えない種類です。選び直すと元には戻せません。'}</>} label="きっかけ" required><Select
                  aria-label="きっかけ"
                  value={eventType}
                  onChange={(next) => {
                    setEventType(next)
                    setSource('')
                  }}
                  options={[
                    ...EVENT_TYPES.map((t) => ({ value: t.value, label: t.label })),
                    ...(selected ? [] : [{ value: eventType, label: 'その他の行動（この画面では選び直せません）' }]),
                  ]}
                  size="full"
                />
</Field>
              <Field label="行動の出どころ"><Select
                  aria-label="行動の出どころ"
                  value={source}
                  onChange={(next) => setSource(next)}
                  size="full"
                  options={[
                    ...(selected?.sources.map(([optionValue, label]) => ({ value: optionValue, label })) ?? [{ value: '', label: 'すべて' }]),
                    ...(source && !selected?.sources.some(([v]) => v === source)
                      ? [{ value: source, label: '今の出どころ（この画面では選び直せません）' }]
                      : []),
                  ]}
                /></Field>
            </div>
          </section>

          <section className={formStyles.card} aria-label="何マイル付けるか">
            <h2 className={formStyles.cardTitle}>何マイル付けるか</h2>
            <div className={formStyles.grid2}>
              <div className={formStyles.field}>
                <span className={formStyles.label}>付与マイル <span className={formStyles.required}>必須</span></span>
                <NumberInput {...fields.bind('amount')} invalid={fields.invalid('amount')} aria-describedby={describedBy('amount')} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="付与マイル" />
                <FieldError id="er-amount-error">{fields.error('amount')}</FieldError>
                <span className={formStyles.hint}>1以上で入力してください。</span>
              </div>
              <div className={formStyles.field}>
                <span className={formStyles.label}>付与のされ方</span>
                <div className={formStyles.grid2} role="group" aria-label="付与のされ方">
                  {([
                    { value: 'available' as const, title: 'すぐ使える', note: 'その場で残高に入ります' },
                    { value: 'pending' as const, title: '確定待ち', note: '確定するまで使えません' },
                  ]).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={formStyles.choice}
                      aria-pressed={initialStatus === option.value}
                      data-selected={initialStatus === option.value}
                      onClick={() => setInitialStatus(option.value)}
                    >
                      <span className={formStyles.choiceTitle}>{option.title}</span>
                      <span className={formStyles.choiceNote}>{option.note}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className={formStyles.card} aria-label="だれに付けるか">
            <h2 className={formStyles.cardTitle}>だれに付けるか</h2>
            <p className={formStyles.cardNote}>条件を付けない場合は全員が対象です。</p>
            <div className={formStyles.conditionBox}>
              <ConditionBuilder value={targetConditions} onChange={setTargetConditions} label="利用対象の条件" />
            </div>
            <p className={formStyles.hint}>
              1日の回数・同じ対象の数えかた・受け取る人・倍率の設定は、今の内容がそのまま引き継がれます。
              動かす・止めるは一覧の操作から行います。
            </p>
          </section>

          <section className={formStyles.card} aria-label="期間・失効・取り消し">
            <h2 className={formStyles.cardTitle}>期間・失効・取り消し</h2>
            <div className={formStyles.grid2}>
              <div className={formStyles.field}>
                <span className={formStyles.label}>開始日・終了日</span>
                <span className={formStyles.inlineRow} {...fields.bind('period')}>
                  <DateField value={validFrom} onChange={setValidFrom} aria-label="開始日" invalid={fields.invalid('period')} aria-describedby={describedBy('period')} />
                  <span className="text-body" aria-hidden="true">〜</span>
                  <DateField value={validUntil} onChange={setValidUntil} aria-label="終了日" invalid={fields.invalid('period')} aria-describedby={describedBy('period')} />
                </span>
                <FieldError id="er-period-error">{fields.error('period')}</FieldError>
                <span className={formStyles.hint}>空欄なら期限なしです。</span>
              </div>
              <div className={formStyles.field}>
                <span className={formStyles.label}>付いたマイルの有効期限</span>
                <span className={formStyles.inlineRow}>
                  <NumberInput {...fields.bind('expiry')} invalid={fields.invalid('expiry')} aria-describedby={describedBy('expiry')} type="number" min={1} max={3650} value={expiresAfterDays} onChange={(e) => setExpiresAfterDays(e.target.value)} aria-label="有効期限の日数" />
                  <span className={formStyles.hint}>日後（空欄なら期限なし）</span>
                </span>
                <FieldError id="er-expiry-error">{fields.error('expiry')}</FieldError>
              </div>
            </div>
            {cancellationEvent ? (
              <Checkbox
                checked={reverseOnCancellation}
                onCheckedChange={setReverseOnCancellation}
                description={`${eventType === 'booking_created' ? '予約の取り消し' : '注文の取り消し'}を同じ記録から追跡します。`}
              >
                取り消されたら、付けたぶんを引く
              </Checkbox>
            ) : null}
          </section>
        </div>

        <aside className={formStyles.aside}>
          <section className={formStyles.card} aria-label="この設定だとこう貯まります">
            <h2 className={formStyles.cardTitle}>この設定だとこう貯まります</h2>
            <p className={formStyles.hint}>
              行動した本人に <strong>{validAmount ? value : emptyValue('unknown')}マイル</strong> を付与します。
              {initialStatus === 'pending' ? '確定するまで使えません。' : ''}
            </p>
          </section>

          <section className={formStyles.card} aria-label="お客様への知らせ">
            <h2 className={formStyles.cardTitle}>お客様への知らせ</h2>
            <LinePreview caption="行動のあと、すぐに届く想定です">
              <div className="text-body">{messageTemplate}</div>
            </LinePreview>
            <Checkbox checked={notifyFriend} onCheckedChange={setNotifyFriend}>
              マイルが付いたら、この内容を自動で知らせる
            </Checkbox>
          </section>
        </aside>
      </div>

      <div className={formStyles.stickyBar}>
        <Button variant="secondary" href="/mileage?tab=earning-rules">キャンセル</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !dirty} busy={saving} busyLabel="保存しています">
          <Check size={16} aria-hidden="true" /> 下書きを保存
        </Button>
      </div>

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="下書きへの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </div>
  )
}

export default function V8EarningRuleEdit() {
  return (
    <Suspense fallback={<ListState kind="loading" title="たまる決めごとを読み込んでいます" />}>
      <EditInner />
    </Suspense>
  )
}
