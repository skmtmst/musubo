'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import Card, { CardHeader } from '@/components/shared/card'
import { useStaffRole, canManageRole } from '@/lib/staff-role'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  name: requiredText("ルール名を入力してください"),
}

import { formatDate as polishFormatDate } from '@/lib/format'
import { createPageReturnHref } from '@/components/shared/create-page'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Hourglass, Share2, User, Zap } from 'lucide-react'
import type { Tag } from '@line-crm/shared'
import { ApiError, api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { formatNumber } from '@/lib/format'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConditionBuilder, { pruneCondition, type SegmentCondition } from '@/components/shared/condition-builder'
import DateField from '@/components/shared/date-field'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { focusMileageField } from '../form-validation'
import Disclosure from '@/components/shared/disclosure'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import {
  EARNING_RULE_EVENT_TYPES as EVENT_TYPES,
  EARNING_RULE_NOTIFY_TEMPLATE,
  earningRuleCancellationEvent,
} from './rule-fields'
import styles from './create.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { ToggleField } from '@/components/shared/toggle'


/*
 * ★V8-B マイル「たまる決めごとを作る」（Pencil：作る ・競合 ）。
 *
 * 型（CreatePage）に、4つの段（どのルールか・何マイル付けるか・受け取る人・使えるまで・付けすぎを防ぐ）と、
 * 右の列（この設定だとこう貯まります・気をつけること）、下の帯（キャンセル・保存して続けて作る・保存して動かす）を渡す。
 *
 * 聞く項目・保存の口・送る形・失敗の扱いは今の作る画面（app/mileage/earning-rules/new/v8-earning-rule-new.tsx）と同じ
 * （BEHAVIOR.md）。違うのは見せ方だけ。
 */

const DAILY_CAPS = [
  ['', '制限なし'],
  ['1', '1日1回まで'],
  ['2', '1日2回まで'],
  ['3', '1日3回まで'],
  ['5', '1日5回まで'],
  ['10', '1日10回まで'],
]

const LIST_HREF = '/mileage?tab=earning-rules'

/** 数を桁区切りで出す。取れていない数は「—」。 */
const miles = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : emptyValue('unknown')

/** 競合の帯の「だれが・いつ」。口が返したときだけ使う（無ければ言い切らない）。 */
function conflictWho(data: unknown): { who: string | null; at: string | null } {
  if (!data || typeof data !== 'object') return { who: null, at: null }
  const record = data as Record<string, unknown>
  const who = typeof record.updatedByName === 'string' ? record.updatedByName : typeof record.updatedBy === 'string' ? record.updatedBy : null
  const raw = typeof record.updatedAt === 'string' ? record.updatedAt : null
  const date = raw ? new Date(raw) : null
  const at = date && !Number.isNaN(date.getTime())
    ? polishFormatDate(date, { style: 'time' })
    : null
  return { who, at }
}

export default function EarningRuleCreateV8() {
  const canManage = canManageRole(useStaffRole())
  usePageTitle('たまる決めごとを作る')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'マイル', href: LIST_HREF }])
  if (!canManage) return <CreatePage boardId="ctLwT" title="たまる決めごとを作る" readOnly dirty={false}
    footerActions={<Button href={LIST_HREF}>一覧へ戻る</Button>}>{null}</CreatePage>
  return <EarningRuleCreateBody />
}

function EarningRuleCreateBody() {
  const [formNumber, setFormNumber] = useState(0)
  return <EarningRuleForm key={formNumber} focusName={formNumber > 0} onContinue={() => setFormNumber((number) => number + 1)} />
}

function EarningRuleForm({ focusName, onContinue }: { focusName: boolean; onContinue: () => void }) {
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focusName) nameRef.current?.focus() }, [focusName])
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState<string>('booking_created')
  const [source, setSource] = useState('')
  const [amount, setAmount] = useState('')
  const [initialStatus, setInitialStatus] = useState<'available' | 'pending'>('available')
  const [ignoreMultiplier, setIgnoreMultiplier] = useState(false)
  const [dailyCap, setDailyCap] = useState('')
  const [uniqueMode, setUniqueMode] = useState<'' | 'subject' | 'subjectPerDay'>('')
  const [beneficiary, setBeneficiary] = useState<'actor' | 'referrer'>('actor')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [expiresAfterDays, setExpiresAfterDays] = useState('365')
  const [reverseOnCancellation, setReverseOnCancellation] = useState(true)
  const [showConditions, setShowConditions] = useState(false)
  const [targetConditions, setTargetConditions] = useState<SegmentCondition | null>(null)
  const [isActive, setIsActive] = useState(true)
  const [notifyFriend, setNotifyFriend] = useState(true)
  const [tags, setTags] = useState<Tag[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [touched, setTouched] = useState(false)
  /** ：保存が 409 で返ったとき。口が返した「だれが・いつ」を持つ。 */
  const [conflict, setConflict] = useState<{ who: string | null; at: string | null } | null>(null)
  const [trialBusy, setTrialBusy] = useState(false)
  const [trialError, setTrialError] = useState('')
  const [trial, setTrial] = useState<{ matchedFriends: number; estimatedTotalMiles: number } | null>(null)
  const createKeyRef = useRef<{ fingerprint: string; key: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.tags.list(selectedAccountId ? { accountId: selectedAccountId } : undefined).then((res) => {
      if (!cancelled && res.success) setTags(res.data)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selectedAccountId])

  const selected = EVENT_TYPES.find((t) => t.value === eventType) ?? EVENT_TYPES[0]
  const value = Number(amount)
  const validAmount = amount.trim() !== '' && Number.isInteger(value) && value >= 1
  const expiryDays = expiresAfterDays === '' ? null : Number(expiresAfterDays)
  const cancellationEvent = earningRuleCancellationEvent(eventType)

  const multiplierTags = useMemo(
    () => tags.filter((t) => t.mileageMultiplierBps != null),
    [tags],
  )

  const dirty = Boolean(
    name || eventType !== 'booking_created' || source ||
    amount || initialStatus !== 'available' || ignoreMultiplier || dailyCap ||
    uniqueMode || beneficiary !== 'actor' || validFrom || validUntil ||
    expiresAfterDays !== '365' || !reverseOnCancellation || targetConditions !== null ||
    !isActive || !notifyFriend,
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  const fieldErrors: Record<string, string> = {}
  if ((FIELD_REQUIREMENTS.name.check(name) !== null)) fieldErrors['er-name'] = 'ルール名を入力してください'
  if (!validAmount) fieldErrors['er-amount'] = '付与マイルは1以上の整数で入力してください'
  if (validFrom && validUntil && validFrom > validUntil) fieldErrors['er-until'] = '終了日は開始日より後にしてください'
  if (expiryDays !== null && (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650)) {
    fieldErrors['er-expiry'] = '有効期限は1〜3650日で入力してください'
  }
  const errorOf = (id: string) => touched ? fieldErrors[id] : undefined
  const validate = () => {
    setTouched(true)
    const first = Object.keys(fieldErrors)[0]
    if (first) {
      setSaveError('')
      setTrialError('')
      focusMileageField(first)
      return false
    }
    if (!selectedAccountId) {
      setSaveError('LINEアカウントを選択してください')
      return false
    }
    return true
  }

  const draftBody = () => ({
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
    sortOrder: 0,
  })

  const save = async (continueAfter: boolean) => {
    if (!validate()) return
    setSaving(true)
    setSaveError('')
    setConflict(null)
    try {
      const payload = {
        name: name.trim(),
        eventType,
        source: source || null,
        amount: value,
        initialStatus,
        lineAccountId: selectedAccountId!,
        conditions: {
          ...(dailyCap ? { dailyCapActions: Number(dailyCap) } : {}),
          ...(uniqueMode === 'subject' ? { uniquePerSubject: true } : {}),
          ...(uniqueMode === 'subjectPerDay' ? { uniquePerSubjectPerDay: true } : {}),
          ...(ignoreMultiplier ? { ignoreMultiplier: true } : {}),
          ...(beneficiary === 'referrer' ? { beneficiary: 'referrer' as const } : {}),
        },
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        isActive,
      }
      const fingerprint = JSON.stringify(payload)
      if (createKeyRef.current?.fingerprint !== fingerprint) {
        createKeyRef.current = { fingerprint, key: crypto.randomUUID() }
      }
      const res = await api.mileage.createRule(payload, { idempotencyKey: createKeyRef.current.key })
      if (!res.success) throw new Error(res.error)
      const draftResponse = await api.mileage.saveEarningRuleDraft(res.data.id, {
        accountId: selectedAccountId!,
        expectedVersion: 0,
        draft: {
          ...draftBody(),
          notification: { enabled: notifyFriend, messageTemplate: EARNING_RULE_NOTIFY_TEMPLATE },
        },
      })
      if (!draftResponse.success) {
        const deleted = await api.mileage.deleteRule(res.data.id).catch(() => null)
        if (!deleted?.success) {
          await api.mileage.updateRule(res.data.id, { isActive: false }).catch((saveFailure) => { saveErrors.capture(saveFailure); return undefined })
          throw new Error(`${draftResponse.error}（作りかけの決めごとが残っているかもしれません。一覧で確認してください）`)
        }
        throw new Error(draftResponse.error)
      }
      if (continueAfter) onContinue()
      else router.push(createPageReturnHref(LIST_HREF, res.data.id))
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      /* ：同時に作られた・版がずれたときは競合の帯で知らせる。 */
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(conflictWho(caught.data))
        { if (!fieldFailure)
        setSaveError('')
      }
      } else {
        { if (!fieldFailure)
        setSaveError(describeApiFailure(caught, '保存')) }
      }
    } finally {
      setSaving(false)
    }
  }

  const runTrial = async () => {
    if (!selectedAccountId || trialBusy) return
    if (!validate()) return
    setTrialBusy(true)
    setTrialError('')
    try {
      const response = await api.mileage.testEarningRule(selectedAccountId, draftBody())
      if (!response.success) throw new Error(response.error)
      setTrial({ matchedFriends: response.data.matchedFriends, estimatedTotalMiles: response.data.estimatedTotalMiles })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      setTrial(null)
      { if (!fieldFailure)
      setTrialError(describeApiFailure(caught, '試算')) }
    } finally {
      setTrialBusy(false)
    }
  }

  const conflictTitle = conflict?.who
    ? `${conflict.who}さんが${conflict.at ? ` ${conflict.at} に` : ''}この決めごとを保存しました`
    : `ほかの人が${conflict?.at ? ` ${conflict.at} に` : ''}この決めごとを保存しました`
  const conflictBand = conflict ? (
    <SaveConflictBand title={conflictTitle} description={conflict.who ? `このまま保存すると、${conflict.who}さんの変更が消えます` : 'このまま保存すると、先に保存された変更が消えます'} compareHref={LIST_HREF} reloadHref={LIST_HREF} />
  ) : null

  const trialValue = (filled: string) => (trialBusy ? '数えています…' : trial ? filled : emptyValue('unknown'))
  const preview = (
    <div className={styles.side}>
      <Card variant="aside" aria-labelledby="er-new-trial">
        <div className={styles.sideHead}>
          <h2 className={styles.sideTitle} id="er-new-trial">この設定だとこう貯まります</h2>
          <Button variant="text" onClick={() => void runTrial()} disabled={trialBusy}>
            {trialBusy ? '数えています' : '試算する'}
          </Button>
        </div>
        <p className={styles.sideNote}>この30日にあてはめた見込み</p>
        {trialError ? <Notice tone="danger" message={trialError} /> : null}
        <dl className={styles.trialRows}>
          <div className={styles.trialRow}>
            <dt>当てはまる人</dt>
            <dd>{trialValue(`${miles(trial?.matchedFriends)} 人`)}</dd>
          </div>
          <div className={styles.trialRow}>
            <dt>付くマイル</dt>
            <dd>{trialValue(miles(trial?.estimatedTotalMiles))}</dd>
          </div>
          <div className={styles.trialRow}>
            <dt>
              1人あたり
              {/* 倍率の注は絵に無い。効くタグがあるときだけ「？」の中で知らせる。 */}
              {multiplierTags.length > 0 && !ignoreMultiplier ? (
                <HelpTip label="倍率の説明">倍率はタグ側の設定で決まります。優先度がいちばん高いタグ1枚だけが効きます。</HelpTip>
              ) : null}
            </dt>
            <dd>{`${validAmount ? miles(value) : emptyValue('unknown')}${dailyCap ? `（1日${dailyCap}回まで）` : ''}`}</dd>
          </div>
        </dl>
      </Card>
      <Card variant="aside" aria-labelledby="er-new-caution">
        <h2 className={styles.sideTitle} id="er-new-caution">気をつけること</h2>
        <p className={styles.caution}>
          ・付けたマイルはあとから消せません（減らすで取り消しの明細を足します）
          <br />
          ・確定待ちは、確定の日まで残高に入りません
        </p>
      </Card>
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId={conflict ? 'BnrQp' : 'ctLwT'}
      title="たまる決めごとを作る"
      help="どの行動で・何マイル・だれに付けるかを決めます。作った日からの行動に付きます（さかのぼらない）。"
      notice={conflictBand}
      previewLabel="試算を見る"
      previewTitle="マイルの試算"
      preview={preview}
      hidePreviewWhenNarrow
      footerActions={(
        <>
          <Button href={LIST_HREF}>キャンセル</Button>
          <Button onClick={() => void save(true)} disabled={saving} busy={saving} busyLabel="保存しています">
            保存して続けて作る
          </Button>
          <Button variant="primary" onClick={() => void save(false)} disabled={saving} busy={saving} busyLabel="保存しています">
            <Check size={16} aria-hidden="true" />{conflict ? '比べてから保存' : isActive ? '保存して動かす' : '停止して保存'}
          </Button>
        </>
      )} dirty={false}
    >
      {saveError ? <Notice tone="danger" message={saveError} onClose={() => setSaveError('')} /> : null}

      <Card variant="form" aria-labelledby="er-new-rule">
        <CardHeader size="stacked" titleId="er-new-rule" title="どのルールか" meta="きっかけになる行動を選びます" />
        <Field requirement={FIELD_REQUIREMENTS.name} label="名前" htmlFor="er-name" error={errorOf('er-name')}>
          <SaveErrorField names={["name"]}><TextField ref={nameRef} id="er-name" aria-label="名前" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：リンクをクリック" /></SaveErrorField>
        </Field>
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.pickLabel}>きっかけ</span>
              <HelpTip label="きっかけの説明">{selected.note}</HelpTip>
            </span>
            <SaveErrorField names={["eventType","event_type"]}><Select
              aria-label="きっかけ"
              value={eventType}
              onChange={(next) => {
                setEventType(next)
                setSource('')
              }}
              options={EVENT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              size="full"
            /></SaveErrorField>
          </div>
          <div className={styles.field}>
            <span className={styles.pickLabel}>行動の出どころ</span>
            <SaveErrorField names={["source"]}><Select
              aria-label="行動の出どころ"
              value={source}
              onChange={(next) => setSource(next)}
              size="full"
              options={selected.sources.map(([optionValue, label]) => ({ value: optionValue, label }))}
            /></SaveErrorField>
          </div>
        </SettingsFormRow>
        <button type="button" className={styles.linkButton} onClick={() => setShowConditions((v) => !v)} aria-expanded={showConditions}>
          ＋ 条件を足す（タグ・友だち情報など）
        </button>
        {showConditions ? (
          <div className={styles.conditionBox}>
            <ConditionBuilder value={targetConditions} onChange={setTargetConditions} label="利用対象の条件" />
            <p className={styles.cardNote}>条件を付けない場合は全員が対象です。</p>
          </div>
        ) : null}
      </Card>

      <Card variant="form" aria-labelledby="er-new-amount">
        <CardHeader size="stacked" titleId="er-new-amount" title="何マイル付けるか" />
          <div className={styles.field}>
            <Field required label="マイル" htmlFor="er-amount" note="付け方：決まった数" error={errorOf('er-amount')}>
              <SaveErrorField names={["amount"]}><NumberInput id="er-amount" type="number" min={1} aria-label="マイル" value={amount} onChange={(e) => setAmount(e.target.value)} /></SaveErrorField>
            </Field>
          </div>
      </Card>

      <Card variant="form" aria-labelledby="er-new-who">
        <CardHeader size="stacked" titleId="er-new-who" title="受け取る人・使えるまで" />
        <SaveErrorField names={["beneficiary"]}><RadioCardGroup legend="受け取る人" className={styles.choiceRow}>
          <RadioCard name="beneficiary" value="actor" checked={beneficiary === 'actor'} onChange={() => setBeneficiary('actor')}
            icon={<User size={16} />} title="行動した本人" note="そのまま本人の残高に" />
          <RadioCard name="beneficiary" value="referrer" checked={beneficiary === 'referrer'} onChange={() => setBeneficiary('referrer')}
            icon={<Share2 size={16} />} title="紹介した人" note="この人を紹介した相手に" />
        </RadioCardGroup></SaveErrorField>
        <SaveErrorField names={["initial-status","initialStatus"]}><RadioCardGroup legend="使えるまで" className={styles.choiceRow}>
          <RadioCard name="initial-status" value="available" checked={initialStatus === 'available'} onChange={() => setInitialStatus('available')}
            icon={<Zap size={16} />} title="すぐ使える" note="その場で残高に入る" />
          <RadioCard name="initial-status" value="pending" checked={initialStatus === 'pending'} onChange={() => setInitialStatus('pending')}
            icon={<Hourglass size={16} />} title="確定待ち" note="確定するまで使えない" />
        </RadioCardGroup></SaveErrorField>
      </Card>

      <Card variant="form" aria-labelledby="er-new-limit">
        <CardHeader size="stacked" titleId="er-new-limit" title="付けすぎを防ぐ" />
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <span className={styles.pickLabel}>1日に数える回数</span>
            <SaveErrorField names={["dailyCap","daily_cap"]}><Select
              aria-label="1日に数える回数"
              value={dailyCap}
              onChange={(next) => setDailyCap(next)}
              size="full"
              options={DAILY_CAPS.map(([optionValue, label]) => ({ value: optionValue, label }))}
            /></SaveErrorField>
          </div>
          <div className={styles.field}>
            <span className={styles.pickLabel}>同じ対象の数えかた</span>
            <SaveErrorField names={["uniqueMode","unique_mode"]}><Select
              aria-label="同じ対象の数えかた"
              value={uniqueMode}
              onChange={(next) => setUniqueMode(next as typeof uniqueMode)}
              size="full"
              options={[
                { value: '', label: '何度でも数える' },
                { value: 'subject', label: '同じ対象は1回' },
                { value: 'subjectPerDay', label: '同じ URL は1回' },
              ]}
            /></SaveErrorField>
          </div>
        </SettingsFormRow>
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <span className={styles.label}>開始日</span>
            <SaveErrorField names={["validFrom","valid_from"]}><DateField value={validFrom} onChange={setValidFrom} aria-label="開始日" /></SaveErrorField>
          </div>
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.label}>終了日</span>
              <span className={styles.optional}>任意</span>
            </span>
            <SaveErrorField names={["validUntil","valid_until"]}><DateField id="er-until" value={validUntil} onChange={setValidUntil} aria-label="終了日" placeholder="なし" invalid={Boolean(errorOf('er-until'))} aria-describedby={errorOf('er-until') ? 'er-until-error' : undefined} /></SaveErrorField>
            {errorOf('er-until') ? <p id="er-until-error" className={styles.error} role="alert">{errorOf('er-until')}</p> : null}
          </div>
        </SettingsFormRow>
        {/* 絵には無いが、倍率・期限・取り消し・通知・すぐ動かすの欄は落とさない（段の最後に畳んで置く）。 */}
        <Disclosure title="詳しい設定（倍率・通知・取り消し・公開）" size="compact">
          <div className={styles.detailsBody}>
            <Field label="付いたマイルの有効期限" htmlFor="er-expiry" error={errorOf('er-expiry')}>
              <span className={styles.inlineRow}>
                <SaveErrorField names={["expiresAfterDays","expires_after_days"]}><NumberInput id="er-expiry" type="number" min={1} max={3650} value={expiresAfterDays} onChange={(e) => setExpiresAfterDays(e.target.value)} aria-label="有効期限の日数" /></SaveErrorField>
                <span className={styles.cardNote}>日後（空欄なら期限なし）</span>
              </span>
            </Field>
            <SaveErrorField names={["ignoreMultiplier","ignore_multiplier"]}><ToggleField checked={ignoreMultiplier} onChange={setIgnoreMultiplier} description="誰でも同じ額にしたいときに選びます。">
              会員ランクの倍率をかけない
            </ToggleField></SaveErrorField>
            {cancellationEvent ? (
              <SaveErrorField names={["reverseOnCancellation","reverse_on_cancellation"]}><ToggleField
                checked={reverseOnCancellation}
                onChange={setReverseOnCancellation}
                description={`${eventType === 'booking_created' ? '予約の取り消し' : '注文の取り消し'}を同じ記録から追跡します。`}
              >
                取り消されたら、付けたぶんを引く
              </ToggleField></SaveErrorField>
            ) : null}
            <SaveErrorField names={["notifyFriend","enabled","notify_friend"]}><ToggleField checked={notifyFriend} onChange={setNotifyFriend}>
              マイルが付いたら、この内容を自動で知らせる
            </ToggleField></SaveErrorField>
            <SaveErrorField names={["isActive","is_active"]}><ToggleField checked={isActive} onChange={setIsActive} description="オフにすると停止中で保存します。">
              作成したらすぐ動かす
            </ToggleField></SaveErrorField>
          </div>
        </Disclosure>
      </Card>

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した決めごと" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </CreatePage></SaveErrorScope>
  )
}
