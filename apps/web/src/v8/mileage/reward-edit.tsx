'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import Card, { CardHeader } from '@/components/shared/card'
import { useStaffRole, canManageRole } from '@/lib/staff-role'

import { Field as SharedField } from '@/components/shared/form-controls'
import { notifySaved } from '@/components/shared/toast'
import { createPageReturnHref } from '@/components/shared/create-page'
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Check, FlaskConical, Plus } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import ConditionBuilder, { pruneCondition } from '@/components/shared/condition-builder'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DateTimeField from '@/components/shared/date-time-field'
import { Field, OptionalBadge } from '@/components/shared/form-controls'
import { TextArea, TextField } from '@/components/shared/text-field'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import { useAccount } from '@/contexts/account-context'
import {
  api,
  ApiError,
  type MileageRewardDraftInput,
  type MileageRewardFailurePolicy,
  type MileageRewardKind,
  type MileageRewardSummary,
  type MileageRewardTestResult,
} from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { localDateTime, utcDateTime } from '@/lib/presentation'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { LIMIT_FIELD_ERRORS, normalizeDigits, optionalInteger, validateReward, rewardNameRequirement, rewardMilesRequirement, rewardActionRequirement, type FormState } from './reward-form'
import { focusMileageField } from './form-validation'
import styles from './reward-edit.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import SaveFeedback, { useSaveFeedback } from '@/components/shared/save-feedback'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

/*
 * ★V8 マイル「使い道を作る・編集する」（板 ）。
 *
 * app/mileage/rewards/edit/v8-reward-edit.tsx から動きを写し、作る型（CreatePage）で組み直した。
 * 左に「基本・渡すもの・だれが交換できるか・出す数と期間」の段、右にお客さまの画面での
 * 見え方と出す前の交換テスト、下に追従の帯（キャンセル・下書きを保存・保存して出す）。
 * 欄は1つも落とさない。絵に無い欄（説明・交換したときの案内・交換後に使える日数・種類ごとの説明）は
 * 最後の「そのほか（任意）」の段にまとめ、欄の説明は「？」へ入れる。
 */

type CommonActionOption = { id: string; label: string }

const KINDS: ReadonlyArray<{ value: MileageRewardKind; label: string; note: string }> = [
  { value: 'handgift', label: '手渡し（お店で渡す）', note: '交換後、お店で景品をお渡しします。' },
  { value: 'coupon', label: 'クーポンを渡す', note: '引換コードを配ります。交換後の動きを選ばなくても出せます' },
  { value: 'tag', label: 'タグを付ける', note: '付けたタグで、配信や絞り込みにつなげます' },
  { value: 'scenario', label: 'シナリオを始める', note: '交換した人だけに、続きの案内を流します' },
  { value: 'template', label: 'メッセージを送る', note: 'ひな形をそのまま1通送ります' },
  { value: 'early_access', label: '先にお知らせする', note: '一般より早く案内します' },
  { value: 'rank', label: 'ランクを上げる', note: 'ブロンズ・シルバーなどの段を上げます' },
]

const FAILURE_POLICIES: ReadonlyArray<{ value: MileageRewardFailurePolicy; label: string }> = [
  { value: 'retry', label: 'もう一度試す（おすすめ）' },
  { value: 'refund', label: 'マイルを返す' },
  { value: 'manual', label: '担当者が手で対応する' },
]

const EMPTY: FormState = {
  name: '',
  description: '',
  rewardKind: 'coupon',
  requiredMiles: '',
  stockLimit: '',
  perFriendLimit: '',
  startsAt: '',
  endsAt: '',
  benefitExpiresDays: '',
  commonActionVersionId: '',
  targetConditions: null,
  failurePolicy: 'retry',
  customerMessage: '',
}

function formOf(reward: MileageRewardSummary): FormState {
  const version = reward.currentVersion
  return {
    name: reward.name,
    description: reward.description ?? '',
    rewardKind: reward.rewardKind,
    requiredMiles: version ? String(version.requiredMiles) : '',
    stockLimit: version?.stockLimit == null ? '' : String(version.stockLimit),
    perFriendLimit: version?.perFriendLimit == null ? '' : String(version.perFriendLimit),
    startsAt: localDateTime(version?.startsAt),
    endsAt: localDateTime(version?.endsAt),
    benefitExpiresDays: version?.benefitExpiresDays == null ? '' : String(version.benefitExpiresDays),
    commonActionVersionId: version?.commonActionVersionId ?? '',
    targetConditions: version?.targetConditions ?? null,
    failurePolicy: version?.failurePolicy ?? 'retry',
    customerMessage: version?.customerMessage ?? '',
  }
}

function isMileageRewardSummary(value: unknown): value is MileageRewardSummary {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MileageRewardSummary>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.rewardKind === 'string'
    && typeof candidate.status === 'string'
    && (candidate.currentVersion === null || typeof candidate.currentVersion === 'object')
}

function numberOrNull(value: string): number | null {
  const parsed = optionalInteger(value)
  if (parsed === undefined) throw new Error('数の限り・上限・日数の入力を確認してください')
  return parsed
}

function draftOf(form: FormState): MileageRewardDraftInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    rewardKind: form.rewardKind,
    requiredMiles: Number(form.requiredMiles),
    stockLimit: numberOrNull(form.stockLimit),
    perFriendLimit: numberOrNull(form.perFriendLimit),
    startsAt: utcDateTime(form.startsAt),
    endsAt: utcDateTime(form.endsAt),
    benefitExpiresDays: numberOrNull(form.benefitExpiresDays),
    commonActionVersionId: form.commonActionVersionId.trim() || null,
    targetConditions: pruneCondition(form.targetConditions),
    failurePolicy: form.failurePolicy,
    customerMessage: form.customerMessage.trim(),
  }
}

/** 選ぶ欄（絵：ラベルは 12px・入れ物との間 6）。説明は「？」へ。 */
function SelectField({ label, htmlFor, help, error, requirement, children }: { label: string; htmlFor: string; help?: string; error?: string; requirement?: { required: boolean }; children: ReactNode }) {
  return <SharedField label={label} htmlFor={htmlFor} help={help} error={error} requirement={requirement}>{children}</SharedField>
}

function RewardEditorInner() {
  const saveErrors = useSaveFormErrors()
  const feedback = useSaveFeedback()
  const retryPublish = useRef(false)
  const completedDraft = useRef<{ accountId: string; form: string; reward: MileageRewardSummary } | null>(null)
  usePageTitle('使い道を作る')
  /* 板の頭の「← 〇〇へ」は 2026-10-08 に無くした。一覧へは上の帯のパンくずで戻る。 */
  usePageCrumbs([{ label: 'マイル', href: '/mileage?tab=rewards' }])
  const router = useRouter()
  const rewardId = useSearchParams().get('id')
  const editing = Boolean(rewardId)
  const { selectedAccountId } = useAccount()
  const scope = useRef({ id: selectedAccountId, generation: 0 })
  if (scope.current.id !== selectedAccountId) scope.current = { id: selectedAccountId, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [form, setForm] = useState<FormState>(EMPTY)
  const [reward, setReward] = useState<MileageRewardSummary | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>(editing ? 'loading' : 'ready')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<MileageRewardTestResult | null>(null)
  const [publishTarget, setPublishTarget] = useState<{ accountId: string; generation: number } | null>(null)
  const [failure, setFailure] = useState('')
  const [commonActions, setCommonActions] = useState<CommonActionOption[]>([])
  const [commonActionsFailed, setCommonActionsFailed] = useState(false)
  const [touched, setTouched] = useState(false)
  const [audience, setAudience] = useState<'all' | 'conditioned'>('all')
  const [baseline, setBaseline] = useState(() => JSON.stringify(EMPTY))

  const load = useCallback(async () => {
    if (!rewardId || !selectedAccountId) return
    const requestScope = scope.current.generation
    setState('loading')
    try {
      const [detail, overview] = await Promise.all([
        api.mileage.reward(rewardId, selectedAccountId).catch(() => null),
        api.mileage.rewards(selectedAccountId).catch(() => null),
      ])
      if (!alive.current || requestScope !== scope.current.generation) return
      const fallback = overview?.success ? overview.data.rewards.find((item) => item.id === rewardId) : undefined
      const found = detail?.success && isMileageRewardSummary(detail.data) ? detail.data : fallback
      if (!found) throw new Error('failed')
      setReward(found)
      loadedScope.current = requestScope
      const loaded = formOf(found)
      setForm(loaded)
      setAudience(loaded.targetConditions ? 'conditioned' : 'all')
      setBaseline(JSON.stringify(loaded))
      setState('ready')
    } catch (err) {
      if (!alive.current || requestScope !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setState(err instanceof ApiError && err.status === 403 ? 'forbidden' : 'error')
    }
  }
  }, [rewardId, selectedAccountId, saveErrors])

  useEffect(() => {
    if (!selectedAccountId) {
      setCommonActions([])
      return
    }
    let cancelled = false
    setCommonActionsFailed(false)
    void api.commonActions.resources(selectedAccountId).then((response) => {
      if (!response.success) throw new Error(response.error)
      if (!cancelled) setCommonActions(response.data.commonActions.map((item) => ({
        id: item.currentPublishedVersionId,
        label: `${item.name}（公開中の第${item.version}版）`,
      })))
    }).catch(() => {
      if (!cancelled) setCommonActionsFailed(true)
    })
    return () => { cancelled = true }
  }, [selectedAccountId])

  useEffect(() => {
    if (!editing) { setState('ready'); return }
    void load()
  }, [editing, load])

  const errors = validateReward(form)
  const validateInputs = () => {
    setTouched(true)
    const fields = [
      ['reward-name', '使い道の名前を入力してください'],
      ['reward-miles', '必要マイルは1以上の整数で入力してください'],
      ['reward-action', '交換後に渡すものを選んでください'],
      ['reward-stock', LIMIT_FIELD_ERRORS.stockLimit],
      ['reward-per-friend', LIMIT_FIELD_ERRORS.perFriendLimit],
      ['reward-ends', '交換終了は交換開始より後にしてください'],
      ['reward-expires', LIMIT_FIELD_ERRORS.benefitExpiresDays],
    ]
    const first = fields.find(([, message]) => errors.includes(message))
    if (first) {
      setFailure('')
      focusMileageField(first[0])
      return false
    }
    if (!selectedAccountId) {
      setFailure('LINEアカウントを選択してください')
      return false
    }
    return true
  }
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((now) => ({ ...now, [key]: value, ...(key === 'rewardKind' && value === 'handgift' ? { commonActionVersionId: '' } : {}) }))
    setFailure('')
    setTestResult(null)
  }

  const persistDraft = async (isCurrent: () => boolean = () => true) => {
    if (!selectedAccountId) throw new Error('account-required')
    const formKey = JSON.stringify(form)
    if (completedDraft.current?.accountId === selectedAccountId && completedDraft.current.form === formKey) return completedDraft.current.reward
    const draft = draftOf(form)
    let saved
    const savedId = (completedDraft.current?.accountId === selectedAccountId ? completedDraft.current.reward.id : null) ?? reward?.id ?? rewardId
    if (savedId) {
      const currentReward = completedDraft.current?.accountId === selectedAccountId ? completedDraft.current.reward : reward
      let expectedVersionId = currentReward?.currentDraftVersionId
      let expectedRevision = currentReward?.currentVersion?.revision
      if (!expectedVersionId || expectedRevision == null) {
        const createdDraft = await api.mileage.createRewardDraft(savedId, selectedAccountId)
        if (!isCurrent()) throw new Error('scope-changed')
        if (!createdDraft.success || !createdDraft.data.currentDraftVersionId) throw new Error('failed')
        completedDraft.current = { accountId: selectedAccountId, form: "", reward: createdDraft.data }
        setReward(createdDraft.data)
        expectedVersionId = createdDraft.data.currentDraftVersionId
        expectedRevision = createdDraft.data.currentVersion?.revision
      }
      if (expectedRevision == null) throw new Error('failed')
      saved = await api.mileage.saveRewardDraft(savedId, selectedAccountId, expectedVersionId, expectedRevision, draft)
    } else {
      saved = await api.mileage.createReward(selectedAccountId, draft)
    }
    if (!isCurrent()) throw new Error('scope-changed')
    if (!saved.success) throw new Error('failed')
    completedDraft.current = { accountId: selectedAccountId, form: formKey, reward: saved.data }
    setReward(saved.data)
    setBaseline(JSON.stringify(form))

    return saved.data
  }

  const save = async (thenPublish: boolean, target = publishTarget) => {
    const current = () => alive.current && !!target && target.accountId === scope.current.id && target.generation === scope.current.generation
    if (thenPublish && !current()) return
    if (!validateInputs() || !selectedAccountId) return
    if (!feedback.begin('マイルの使い道')) return
    retryPublish.current = thenPublish
    setSaving(true)
    setFailure('')
    let savedDraft = false
    try {
      const saved = await persistDraft(thenPublish ? current : undefined)
      savedDraft = true
      if (thenPublish) {
        if (!current()) throw new Error('scope-changed')
        const published = await api.mileage.publishReward(
          saved.id,
          selectedAccountId,
          saved.currentDraftVersionId ?? saved.currentVersion?.id,
          saved.currentVersion?.revision,
        )
        if (!published.success) throw new Error('failed')
        completedDraft.current = { accountId: selectedAccountId, form: "", reward: published.data }
        setReward(published.data)
      }
      feedback.success(thenPublish ? 'マイルの使い道と公開設定' : 'マイルの使い道の下書き')
      setPublishTarget(null)
      notifySaved(thenPublish ? '公開しました' : '下書きを保存しました')
      if (!editing) router.push(createPageReturnHref('/mileage?tab=rewards', saved.id))
    } catch (err) {
      if (thenPublish && !current()) {
        feedback.failure('アカウントが切り替わったため公開を中止しました。保存状況は元のアカウントで確認してください。')
        return
      }
      feedback.failure(describeApiFailure(err, '保存'), savedDraft ? ['マイルの使い道の下書き'] : [], savedDraft ? ['公開'] : ['マイルの使い道の保存'])
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setFailure(
        describeApiFailure(err, '保存'),
      ) }
    } finally {
      setSaving(false)
    }
  }

  const testExchange = async () => {
    if (!validateInputs() || !selectedAccountId) return
    feedback.reset()
    setTesting(true)
    setFailure('')
    setTestResult(null)
    try {
      const saved = await persistDraft()
      const tested = await api.mileage.testReward(saved.id, selectedAccountId)
      if (!tested.success) throw new Error('failed')
      setTestResult(tested.data)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setFailure(
        describeApiFailure(err, '交換テスト'),
      ) }
    } finally {
      setTesting(false)
    }
  }

  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: JSON.stringify(form) !== baseline,
    busy: saving || testing,
  })

  if (state === 'loading') {
    return <SaveErrorScope errors={saveErrors}><div data-design-node="L2Bzp"><ListState kind="loading" title="使い道を読み込んでいます" /></div></SaveErrorScope>
  }
  if (state === 'forbidden') {
    return (
      <SaveErrorScope errors={saveErrors}><div data-design-node="L2Bzp">
        <ListState kind="forbidden" title="使い道を編集する権限がありません" description="このLINEアカウントの使い道は、オーナーか管理者だけが扱えます。" />
      </div></SaveErrorScope>
    )
  }
  if (state === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}><div data-design-node="L2Bzp">
        <ListState kind="error" title="使い道を表示できませんでした" description="再読み込みしても直らない場合はエラー報告へ。" onRetry={() => void load()} />
      </div></SaveErrorScope>
    )
  }

  const published = reward?.status === 'published'
  const requestPublish = () => {
    if (!validateInputs()) return
    if (editing && loadedScope.current !== scope.current.generation) return
    if (selectedAccountId) setPublishTarget({ accountId: selectedAccountId, generation: scope.current.generation })
  }
  const kindNote = KINDS.find((kind) => kind.value === form.rewardKind)?.note ?? ''
  const kindLocked = (kind: MileageRewardKind) => Boolean(reward && ((reward.rewardKind === 'handgift') !== (kind === 'handgift')))
  const requiredMiles = Number(form.requiredMiles)
  const perFriend = form.perFriendLimit.trim() === '' ? '何回でも' : `${form.perFriendLimit} 回まで`
  const errorOf = (message: string) => (touched && errors.includes(message) ? message : undefined)

  const preview = (
    <div className={styles.aside}>
      <Card variant="aside" aria-label="お客さまの画面での見え方">
        <h2 className={styles.sideTitle}>お客さまの画面での見え方</h2>
        <p className={styles.sideNote}>LINE のマイルの画面</p>
        <Card variant="aside" surface="muted">
          <span className={styles.phoneName}>{form.name.trim() || '（名前を入力）'}</span>
          <span className={styles.phoneMiles}>{Number.isInteger(requiredMiles) && requiredMiles > 0 ? `${formatNumber(requiredMiles)} マイルで交換` : emptyValue('unknown')}</span>
          <span className={styles.phoneSub}>{`${form.benefitExpiresDays.trim() ? `交換後${form.benefitExpiresDays}日間` : '期限なし'}・お一人さま${perFriend}`}</span>
        </Card>
      </Card>
      <Card variant="aside" aria-label="出す前に">
        <h2 className={styles.sideTitle}>出す前に</h2>
        <div>
          <Button onClick={() => void testExchange()} disabled={saving || testing} busy={testing} busyLabel="交換テスト中">
            <FlaskConical size={16} aria-hidden="true" /> 自分で交換をテスト
          </Button>
        </div>
        <p className={styles.sideNote}>残高と在庫は動きません。</p>
      </Card>
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="L2Bzp"
      title="使い道を作る"
      help="マイルと交換できる特典を決めます。出すと、お客さまの LINE（マイルの画面）に並びます。"
      previewLabel="お客さまの見え方を見る"
      previewTitle="お客さまの見え方"
      preview={preview}
      hidePreviewWhenNarrow
      footerActions={<>
        <Button variant="secondary" href="/mileage?tab=rewards">キャンセル</Button>
        <Button onClick={() => void save(false)} disabled={saving || testing} busy={saving} busyLabel="保存しています…">
          下書きを保存
        </Button>
        <Button variant="primary" onClick={requestPublish} disabled={saving || testing}>
          <Check size={16} aria-hidden="true" /> 保存して出す
        </Button>
      </>} dirty={false}
    >
      {failure && feedback.state.kind === 'idle' ? <Notice tone="danger" message={failure} /> : null}
      <SaveFeedback state={feedback.state} onRetry={() => { if (retryPublish.current && !publishTarget) requestPublish(); else void save(retryPublish.current) }} />
      {testResult ? (
        <Notice tone={testResult.canDeliver ? 'success' : 'warn'}>
          {testResult.canDeliver
            ? `交換テストに合格しました。${formatNumber(testResult.requiredMiles)}マイルで受け渡せます。残高と在庫は動かしていません。`
            : `交換テストで確認が必要です。${testResult.warning ?? '受け渡す内容を確認してください'}。残高と在庫は動かしていません。`}
        </Notice>
      ) : null}
      {published ? (
        <Notice tone="info">いま出している内容はそのままです。保存すると下書きになり、「出す」を押すまでお客様の見え方は変わりません。</Notice>
      ) : null}

      <Card variant="form" aria-label="基本">
        <CardHeader size="stacked" title="基本" />
        <SettingsFormRow layout="columns">
          <Field requirement={rewardNameRequirement} label="名前" htmlFor="reward-name" error={touched ? rewardNameRequirement.check(form.name) : undefined}>
            <SaveErrorField names={["name","form.name"]}><TextField id="reward-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="例：送料無料クーポン" /></SaveErrorField>
          </Field>
          <Field requirement={rewardMilesRequirement} label="必要マイル" htmlFor="reward-miles" error={errorOf('必要マイルは1以上の整数で入力してください')}>
            <SaveErrorField names={["requiredMiles","form.requiredMiles","required_miles","form.required_miles"]}><NumberInput numericText id="reward-miles" inputMode="numeric" value={form.requiredMiles} onChange={(e) => set('requiredMiles', e.target.value)} placeholder="例：500" /></SaveErrorField>
          </Field>
        </SettingsFormRow>
      </Card>

      <Card variant="form" aria-label="渡すもの">
        <CardHeader size="stacked" title="渡すもの" />
        <SettingsFormRow layout="columns">
          {form.rewardKind !== 'handgift' ? <SelectField label="交換後に渡すもの" htmlFor="reward-action" requirement={rewardActionRequirement(form.rewardKind)}
            help={form.rewardKind === 'coupon' ? 'クーポンは引換コードで渡すので、選ばなくても出せます' : '共通アクションの版を指定します'}
          >
            <SaveErrorField names={["commonActionVersionId","form.commonActionVersionId","common_action_version_id","form.common_action_version_id"]}><EntitySelect kind="common_action"
              id="reward-action"
              error={errorOf('交換後に渡すものを選んでください')}
              aria-label="交換後に渡すもの"
              size="full"
              value={form.commonActionVersionId}
              onChange={(next) => set('commonActionVersionId', next)}
              options={[
                { value: '', label: commonActionsFailed ? '公開版を読み込めませんでした' : '公開中の共通アクションを選ぶ' },
                ...(form.commonActionVersionId && !commonActions.some((item) => item.id === form.commonActionVersionId)
                  ? [{ value: form.commonActionVersionId, label: '現在選択中の公開版' }]
                  : []),
                ...commonActions.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.label })),
              ]}
              disabled={commonActionsFailed}
            /></SaveErrorField>
          </SelectField> : null}
          <SelectField label="渡すものの種類" htmlFor="reward-kind" help={kindNote}>
            <SaveErrorField names={["rewardKind","form.rewardKind","reward_kind","form.reward_kind"]}><Select
              id="reward-kind"
              aria-label="渡すものの種類"
              size="full"
              value={form.rewardKind}
              onChange={(next) => set('rewardKind', next as MileageRewardKind)}
              options={KINDS.map((kind) => ({ value: kind.value, label: kind.label, disabled: kindLocked(kind.value) }))}
            /></SaveErrorField>
          </SelectField>
        </SettingsFormRow>
        <SelectField label="渡せなかったとき" htmlFor="reward-failure" help="マイルは交換の時点で引かれます。渡せなかったときの決めごとがないと、引かれたまま何も届きません">
          <SaveErrorField names={["failurePolicy","form.failurePolicy","failure_policy","form.failure_policy"]}><Select
            id="reward-failure"
            aria-label="渡せなかったときにどうするか"
            size="full"
            value={form.failurePolicy}
            onChange={(next) => set('failurePolicy', next as MileageRewardFailurePolicy)}
            options={FAILURE_POLICIES.map((item) => ({ value: item.value, label: item.label }))}
          /></SaveErrorField>
        </SelectField>
      </Card>

      <Card variant="form" aria-label="だれが交換できるか">
        <CardHeader size="stacked" title="だれが交換できるか" />
        <SelectField label="交換できる人" htmlFor="reward-audience">
          <SaveErrorField names={["audience"]}><Select
            id="reward-audience"
            aria-label="交換できる人"
            size="full"
            value={audience}
            onChange={(next) => {
              const value = next as 'all' | 'conditioned'
              setAudience(value)
              if (value === 'all') set('targetConditions', null)
            }}
            options={[
              { value: 'all', label: 'すべての友だち' },
              { value: 'conditioned', label: '条件で絞る（タグ・会員ランクなど）' },
            ]}
          /></SaveErrorField>
        </SelectField>
        {audience === 'conditioned' ? (
          <Card variant="aside" surface="muted">
            <ConditionBuilder value={form.targetConditions} onChange={(next) => set('targetConditions', next)} label="交換対象の条件" />
          </Card>
        ) : (
          <Button variant="text" onClick={() => setAudience('conditioned')}>
            <Plus size={16} aria-hidden="true" />条件を足す（タグ・会員ランクなど）
          </Button>
        )}
      </Card>

      <Card variant="form" aria-label="出す数と期間">
        <CardHeader size="stacked" title="出す数と期間" />
        <SettingsFormRow layout="columns">
          <div className={styles.field}><Field label="出す数" htmlFor="reward-stock"><SaveErrorField names={["stockLimit","form.stockLimit","stock_limit","form.stock_limit"]}><NumberInput numericText id="reward-stock" invalid={Boolean(errorOf(LIMIT_FIELD_ERRORS.stockLimit))} aria-describedby={errorOf(LIMIT_FIELD_ERRORS.stockLimit) ? 'reward-stock-error' : undefined} inputMode="numeric" title="空欄なら限りなし。0 と書くと品切れ（交換できません）" value={form.stockLimit} onChange={(e) => set('stockLimit', normalizeDigits(e.target.value))} placeholder="制限なし" /></SaveErrorField>
{errorOf(LIMIT_FIELD_ERRORS.stockLimit) ? <p id="reward-stock-error" className={styles.error} role="alert">{LIMIT_FIELD_ERRORS.stockLimit}</p> : null}</Field></div>
          <div className={styles.field}><Field label="1人あたり" htmlFor="reward-per-friend"><SaveErrorField names={["perFriendLimit","form.perFriendLimit","per_friend_limit","form.per_friend_limit"]}><NumberInput numericText id="reward-per-friend" invalid={Boolean(errorOf(LIMIT_FIELD_ERRORS.perFriendLimit))} aria-describedby={errorOf(LIMIT_FIELD_ERRORS.perFriendLimit) ? 'reward-per-friend-error' : undefined} inputMode="numeric" title="空欄なら何回でも" value={form.perFriendLimit} onChange={(e) => set('perFriendLimit', normalizeDigits(e.target.value))} placeholder="1回まで" /></SaveErrorField>
{errorOf(LIMIT_FIELD_ERRORS.perFriendLimit) ? <p id="reward-per-friend-error" className={styles.error} role="alert">{LIMIT_FIELD_ERRORS.perFriendLimit}</p> : null}</Field></div>
        </SettingsFormRow>
        <SettingsFormRow layout="columns">
          <div className={styles.field}><Field label="交換開始" htmlFor="reward-starts"><SaveErrorField names={["startsAt","form.startsAt","starts_at","form.starts_at"]}><DateTimeField id="reward-starts" aria-label="交換開始" value={form.startsAt} onChange={(v) => set('startsAt', v)} /></SaveErrorField></Field></div>
          <div className={styles.field}><Field label="交換終了" htmlFor="reward-ends"><SaveErrorField names={["endsAt","form.endsAt","ends_at","form.ends_at"]}><DateTimeField id="reward-ends" aria-label="交換終了" value={form.endsAt} onChange={(v) => set('endsAt', v)} invalid={Boolean(errorOf('交換終了は交換開始より後にしてください'))} aria-describedby={errorOf('交換終了は交換開始より後にしてください') ? 'reward-ends-error' : undefined} placeholder="期限なし" /></SaveErrorField>
{errorOf('交換終了は交換開始より後にしてください') ? <p id="reward-ends-error" className={styles.error} role="alert">交換終了は交換開始より後にしてください</p> : null}</Field></div>
        </SettingsFormRow>
      </Card>

      <Card variant="form" aria-labelledby="mileage-reward-extra">
        <CardHeader size="stacked" titleId="mileage-reward-extra" title={<>そのほか <OptionalBadge /></>} />
        <SettingsFormRow layout="columns">
          <Field label="交換後に使える日数" htmlFor="reward-expires" help="空欄なら期限なし" error={errorOf(LIMIT_FIELD_ERRORS.benefitExpiresDays)}>
            <SaveErrorField names={["benefitExpiresDays","form.benefitExpiresDays","benefit_expires_days","form.benefit_expires_days"]}><NumberInput numericText id="reward-expires" inputMode="numeric" value={form.benefitExpiresDays} onChange={(e) => set('benefitExpiresDays', normalizeDigits(e.target.value))} placeholder="期限なし" /></SaveErrorField>
          </Field>
          <div />
        </SettingsFormRow>
        <Field label="説明" htmlFor="reward-description" help="一覧と交換の画面に出ます。空でも出せます">
          <SaveErrorField names={["description","form.description"]}><TextArea id="reward-description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></SaveErrorField>
        </Field>
        <Field label="交換したときの案内" htmlFor="reward-message" help="お客様に届く文です。空なら既定の文を送ります">
          <SaveErrorField names={["customerMessage","form.customerMessage","customer_message","form.customer_message"]}><TextArea id="reward-message" rows={2} value={form.customerMessage} onChange={(e) => set('customerMessage', e.target.value)} /></SaveErrorField>
        </Field>
        <SaveErrorField names={["reward-kind-cards","value","kind.value","rewardKind","form.rewardKind"]}><RadioCardGroup legend="種類ごとの説明（選ぶと種類が変わります）" className={styles.grid2}>
          {KINDS.map((kind) => (
            <RadioCard
              key={kind.value}
              name="reward-kind-cards"
              value={kind.value}
              checked={form.rewardKind === kind.value}
              disabled={kindLocked(kind.value)}
              disabledReason={kindLocked(kind.value) ? '作成後は手渡しと他の種類を切り替えられません' : undefined}
              onChange={() => set('rewardKind', kind.value)}
              title={kind.label}
              note={kind.note}
            />
          ))}
        </RadioCardGroup></SaveErrorField>
      </Card>

      <ConfirmDialog
        open={publishTarget !== null && publishTarget.generation === scope.current.generation}
        title="この使い道を公開しますか？"
        description="公開すると、お客様がマイルを交換できるようになります。内容と必要マイルを確認してください。"
        confirmLabel="使い道を公開"
        busy={saving}
        error={failure || undefined}
        onCancel={() => setPublishTarget(null)}
        onConfirm={() => save(true, publishTarget)}
      >{publishTarget ? <OperationTargetSummary accounts={[{ id: publishTarget.accountId }]} /> : null}</ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した使い道" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </CreatePage></SaveErrorScope>
  )
}

function RewardEditorAccess() {
  const canManage = canManageRole(useStaffRole())
  usePageTitle('使い道を作る')
  usePageCrumbs([{ label: 'マイル', href: '/mileage?tab=rewards' }])
  if (!canManage) return <CreatePage boardId="L2Bzp" title="使い道を作る" readOnly dirty={false}
    footerActions={<Button href="/mileage?tab=rewards">一覧へ戻る</Button>}>{null}</CreatePage>
  return <RewardEditorInner />
}

export default function RewardEditV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <RewardEditorAccess />
    </Suspense>
  )
}
