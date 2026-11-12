'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'

import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { notifySaved } from '@/components/shared/toast'
import { useEffect, useRef, useState } from 'react'
import { CalendarClock, ClipboardList, Coins, Package, Save, Send } from 'lucide-react'
import { checkNenCampaignBodyLength, NEN_CAMPAIGN_BODY_MAX_LENGTH } from '@line-crm/shared'
import { ApiError, api, describeSaveFailure, type NenCampaignAfterAction, type NenCampaignSetting } from '@/lib/api'
import { CreatePage } from '@/components/templates'
import Card, { CardHeader } from '@/components/shared/card'
import Button from '@/components/shared/button'
import Drawer from '@/components/shared/drawer'
import Dialog from '@/components/shared/dialog'
import NumberInput from '@/components/shared/number-field'
import Checkbox from '@/components/shared/checkbox'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Radio from '@/components/shared/radio'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import TimeField from '@/components/shared/time-field-v8'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { MessageBody } from '@/components/shared/message-insert-row'
import InsertToolbar from '@/components/scenarios/insert-toolbar'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { formatNumber } from '@/lib/format'
import { formatCampaignTiming } from './display'
import styles from './form.module.css'
import { FieldError, Field, OptionalBadge } from '@/components/shared/form-controls'
import { useFieldValidation } from '@/lib/use-field-validation'
import InsertTextField, { type InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import { tapActionLiffUrl } from '@/lib/tap-actions'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

/*
 * ★V8-B 配信を直す（、例：口コミのお願い）。
 *
 * 取得・保存・版つき競合・テスト送信の決めごとを保持する現役の編集。
 * ・節は 配信フロー・いつ送りますか・送るもの・押されたあとにすること。
 * ・きっかけからの日数・送る時刻・つなぐ回答フォーム・付けるマイルは、どれも「選ぶ欄」で選ぶ。
 * ・差し込みの道具・残りの字数は、欄の横の小さな押し口から開く／足りないときだけ出す。
 * ・右に LINE での見え方・気をつけること・この画面でできないこと・自分にテストを送る。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

/** きっかけの短い言い方（配信フローの札・日数の選ぶ欄）。 */
const TRIGGER_SHORT: Record<string, string> = {
  'ec.order.confirmed': '注文を受け付けた',
  'ec.order.shipped': '商品を発送した',
  'ec.shipping.shipped': '商品を発送した',
  'ec.order.delivered': '注文が届いた',
  'ec.order.arrived': '注文が届いた',
  'pet.birthday': 'ペットの誕生日',
}

const DELAY_CHOICES = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90]
const MILEAGE_CHOICES = [50, 100, 200, 300, 500, 1000]
const BODY_NOTICE_REMAINING = 300

type FormOption = { id: string; name: string; description: string | null; isActive: boolean }
type Candidate = { id: string; displayName: string | null }

function triggerShort(setting: NenCampaignSetting): string {
  if (setting.campaignKey === 'birthday_coupon') return 'ペットの誕生日'
  if (!setting.triggerEvent) return '手動で送る'
  return TRIGGER_SHORT[setting.triggerEvent] ?? '登録済みのきっかけ'
}

function withCurrent(choices: number[], current: number): number[] {
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
}

function previewBody(value: string): string {
  return value
    .replaceAll('{{pet_name}}', 'ももちゃん')
    .replaceAll('{{ペットの名前}}', 'もも')
    .replaceAll('{{商品名}}', 'フード')
    .replaceAll('{{name}}', '見本 16')
}

function openFormUrl(liffId: string | null | undefined, formId: string): string | null {
  if (!liffId) return null
  // 回答フォームの LIFF の URL は lib/tap-actions.ts の1か所で組み立てる（押したらの欄と同じ形）。
  return tapActionLiffUrl(liffId, 'form', formId)
}

/** 選べない値（誕生日の固定・閲覧のみの人）は、押せない部品を置かずに箱で見せる。 */
function StaticBox({ label, value }: { label: string; value: string }) {
  return <span className={styles.staticBox} role="note" aria-label={`${label}：${value}`}>{value}</span>
}

/** 版（updatedAt）を除いた中身。直しかけの判定に使う（WEB230）。 */
export function withoutVersion<T extends object | null>(value: T): Omit<NonNullable<T>, 'updatedAt'> | null {
  if (!value) return null
  const { updatedAt: _updatedAt, ...rest } = value as T & { updatedAt?: unknown }
  void _updatedAt
  return rest as Omit<NonNullable<T>, 'updatedAt'>
}

export default function CampaignEdit({ campaignKey }: { campaignKey: string }) {
  const saveErrors = useSaveFormErrors()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [setting, setSetting] = useState<NenCampaignSetting | null>(null)
  const [draft, setDraft] = useState<Partial<NenCampaignSetting>>({})
  const [forms, setForms] = useState<FormOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [validationSubmitted, setValidationSubmitted] = useState(false)
  const [notice, setNotice] = useState('')
  const [testSearch, setTestSearch] = useState('')
  const [testCandidates, setTestCandidates] = useState<Candidate[]>([])
  const [testLoginUsers, setTestLoginUsers] = useState<Array<{ id: string; displayName: string }>>([])
  const [testTarget, setTestTarget] = useState('')
  const [testing, setTesting] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [customMileageOpen, setCustomMileageOpen] = useState(false)
  const [customMileage, setCustomMileage] = useState('')
  const [customMileageError, setCustomMileageError] = useState('')
  const bodyRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)
  const { selectedAccountId, selectedAccount } = useAccount()
  const tokenNames = useInsertTokenNames(selectedAccountId)
  const staffRole = useStaffRole()
  const canEdit = canManageRole(staffRole)

  useEffect(() => { setCustomMileageOpen(false) }, [campaignKey, selectedAccountId, canEdit])

  useEffect(() => {
    if (!selectedAccountId) {
      setLoading(false)
      setError('LINEアカウントを選んでください')
      return
    }
    let cancelled = false
    setLoading(true)
    void Promise.all([
      api.nenCampaigns.settings(selectedAccountId),
      api.forms.list(selectedAccountId),
    ]).then(([settingsResponse, formsResponse]) => {
      if (cancelled) return
      if (settingsResponse.success) {
        const found = settingsResponse.data.find((item) => item.campaignKey === campaignKey) ?? null
        setSetting(found)
        if (found) setDraft(found)
        else setError('この配信が見つかりませんでした')
      }
      if (formsResponse.success) setForms(formsResponse.data)
    }).catch(() => {
      if (!cancelled) setError('読み込みに失敗しました。もう一度読み込んでください。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    void api.nenCampaigns.overview(selectedAccountId)
      .then((res) => {
        if (!cancelled && res.success) setPendingCount(res.data.jobs.pendingByCampaign?.[campaignKey] ?? 0)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [campaignKey, selectedAccountId])

  // テスト送信の相手の候補。はじめは、このアカウントのテスト送信先に登録したログインユーザー。
  useEffect(() => {
    setTestLoginUsers([])
    setTestCandidates([])
    setTestTarget('')
    if (!selectedAccountId) return
    let cancelled = false
    void api.accountSettings.getTestRecipientLoginUsers(selectedAccountId)
      .then((response) => {
        if (cancelled || !response.success) return
        const candidates = response.data
          .filter((candidate) => candidate.sameAccount)
          .map((candidate) => ({ id: candidate.id, displayName: candidate.staffName }))
        setTestLoginUsers(candidates)
        setTestCandidates(candidates)
        setTestTarget(candidates[0]?.id ?? '')
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedAccountId])

  const contextRef = useRef({ accountId: selectedAccountId, campaignKey })
  contextRef.current = { accountId: selectedAccountId, campaignKey }
  const latestSetting = async () => {
    const context = contextRef.current
    if (!context.accountId) return null
    const response = await api.nenCampaigns.settings(context.accountId)
    if (context !== contextRef.current && (context.accountId !== contextRef.current.accountId || context.campaignKey !== contextRef.current.campaignKey)) return null
    return response.success ? response.data.find((item) => item.campaignKey === context.campaignKey) ?? null : null
  }
  const saveConflict = useSaveConflict<NenCampaignSetting>({
    fetchLatest: latestSetting,
    reload: async () => {
      const latest = await latestSetting()
      if (!latest) { setError('最新の内容を読み込めませんでした。もう一度お試しください。'); return }
      setSetting(latest); setDraft(latest); setError(''); saveConflict.clear()
    },
  })
  useEffect(() => { saveConflict.clear() }, [campaignKey, selectedAccountId, saveConflict.clear])

  const merged = { ...setting, ...draft } as NenCampaignSetting
  /*
   * WEB230：保存できると setting の版（updatedAt）だけが新しくなり、入力（draft）は前の版のまま。
   * 版の違いで「直しかけ」と言わない。比べるのは直せる中身だけ。
   */
  const dirty = setting !== null && JSON.stringify(withoutVersion(draft)) !== JSON.stringify(withoutVersion(setting))
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })
  const actions = merged.afterActions ?? []
  const formAction = actions.find((action) => action.kind === 'open_form')
  const mileageAction = actions.find((action) => action.kind === 'award_mileage')
  const isBirthday = merged.campaignKey === 'birthday_coupon'
  const selectedForm = formAction ? forms.find((form) => form.id === formAction.formId) : undefined
  const formIssueMessage = formAction
    ? (!selectedForm
        ? 'つなぐ回答フォームが見つかりません（削除されたか、別のLINEアカウント専用の可能性があります）'
        : !selectedForm.isActive
          ? 'つなぐ回答フォームは公開されていません'
          : null)
    : null
  const formIssueBanner = setting?.formIssue
    ? setting.formIssue === 'form_unselected'
      ? '設定不足：つなぐ回答フォームが選ばれていません。この間、新しい配信は予約されません。フォームを選んで保存してください。'
      : '設定不足：つなぐ回答フォームが使えなくなっています。この間、新しい配信は予約されません。フォームを選び直して保存してください。'
    : null

  const setActions = (afterActions: NenCampaignAfterAction[]) => setDraft((previous) => ({ ...previous, afterActions }))

  const chooseForm = (formId: string) => {
    if (!formId) {
      setActions(actions.filter((action) => action.kind !== 'open_form'))
      return
    }
    const form = forms.find((candidate) => candidate.id === formId)
    if (!form || !form.isActive) return
    const next: NenCampaignAfterAction = { kind: 'open_form', formId: form.id, formName: form.name, buttonLabel: '感想を書く（30秒）' }
    setDraft((previous) => ({
      ...previous,
      afterActions: [...actions.filter((action) => action.kind !== 'open_form'), next],
      buttonLabel: next.buttonLabel,
      buttonUrl: openFormUrl(selectedAccount?.liffId, form.id) ?? merged.buttonUrl,
    }))
  }

  const chooseMileage = (value: string) => {
    if (value === 'custom') {
      setCustomMileage(mileageAction?.kind === 'award_mileage' ? String(mileageAction.amount) : '')
      setCustomMileageError('')
      setCustomMileageOpen(true)
      return
    }
    const others = actions.filter((action) => action.kind !== 'award_mileage')
    if (!value) { setActions(others); return }
    setActions([...others, { kind: 'award_mileage', amount: Number(value), trigger: 'form_submitted' }])
  }

  const searchFriends = async () => {
    const query = testSearch.trim()
    setNotice('')
    try {
      const response = await api.friends.list({ search: query, accountId: selectedAccountId ?? undefined, limit: 5 })
      if (!response.success) throw new Error('failed')
      const loginUsers = testLoginUsers.filter((candidate) => candidate.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      const friends = response.data.items.map((friend) => ({ id: friend.id, displayName: friend.displayName }))
      const next = [...new Map([...loginUsers, ...friends].map((candidate) => [candidate.id, candidate])).values()]
      setTestCandidates(next)
      setTestTarget(next[0]?.id ?? '')
      if (next.length === 0) setNotice('その名前の相手は見つかりませんでした。')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setNotice('相手を探せませんでした。通信を確認してもう一度お試しください。') }
    }
  }

  const sendTest = async () => {
    if (!selectedAccountId || !testTarget)


 return
    setTesting(true)
    setError('')
    setNotice('')
    try {
      await api.nenCampaigns.testSend({
        campaignKey, accountId: selectedAccountId, friendId: testTarget,
        draft: {
          title: merged.title, bodyText: merged.bodyText,
          buttonLabel: merged.buttonLabel ?? '', buttonUrl: merged.buttonUrl ?? '', imageUrl: merged.imageUrl ?? '',
        },
      })
      setNotice('テスト送信しました')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('テスト送信できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setTesting(false)
    }
  }

  const bodyCheck = checkNenCampaignBodyLength(merged.bodyText ?? '')
  const bodyLimitLabel = formatNumber(NEN_CAMPAIGN_BODY_MAX_LENGTH)
  const bodyRemaining = NEN_CAMPAIGN_BODY_MAX_LENGTH - bodyCheck.length

  const bodyError = !merged.bodyText?.trim() ? '本文を入力してください'
    : !bodyCheck.fits ? `${bodyLimitLabel}字を超えています（現在${formatNumber(bodyCheck.length)}字）。短くしてください。` : undefined
  const mileageError = mileageAction && (!Number.isInteger(mileageAction.amount) || mileageAction.amount < 1 || mileageAction.amount > 1_000_000)
    ? '付けるマイルは1〜1,000,000の整数で入力してください' : undefined
  const fields = useFieldValidation([
    ...(bodyError ? [{ id: 'nen-edit-body', message: bodyError }] : []),
    ...(formIssueMessage ? [{ id: 'nen-edit-form', message: formIssueMessage }] : []),
    ...(mileageError ? [{ id: 'nen-edit-mileage', message: mileageError }] : []),
  ])

  const save = async () => {
    if (!setting || !selectedAccountId) return
    setError('')
    setValidationSubmitted(true)
    if (!fields.submit()) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await api.nenCampaigns.updateSetting(selectedAccountId, setting.campaignKey, {
        isEnabled: merged.isEnabled,
        title: merged.title,
        bodyText: merged.bodyText,
        delayDays: merged.delayDays,
        deliveryTime: merged.deliveryTime,
        buttonLabel: formAction?.buttonLabel ?? merged.buttonLabel,
        buttonUrl: formAction ? openFormUrl(selectedAccount?.liffId, formAction.formId) ?? merged.buttonUrl : merged.buttonUrl,
        imageUrl: merged.imageUrl,
        dedupWindowDays: merged.dedupWindowDays,
        excludeFormRespondents: Boolean(formAction) && merged.excludeFormRespondents,
        afterActions: actions,
        expectedUpdatedAt: setting.updatedAt,
      })
      if (!response.success) {
        setError('保存に失敗しました。通信を確かめて、もう一度お試しください。')
        return
      }
      saveConflict.clear()
      notifySaved('配信内容を保存しました')
      setSetting({ ...merged, updatedAt: response.data?.updatedAt ?? merged.updatedAt })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409 && caught.code === 'VERSION_CONFLICT') {
        saveConflict.mark();

        setError('');

        return
      }
      { if (!fieldFailure)
      setError(withPermissionFailure(caught, describeSaveFailure(caught), 'store')) }
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="NEN配信を読み込んでいます" /></SaveErrorScope>
  if (!setting) return <SaveErrorScope errors={saveErrors}><ListState kind="error" title={error || 'この配信が見つかりませんでした'} /></SaveErrorScope>

  const time = merged.deliveryTime.slice(0, 5)
  const timing = `${formatCampaignTiming({ campaignKey, delayDays: merged.delayDays, deliveryTime: time })} に届きます`
  const trigger = triggerShort(setting)
  const accountName = selectedAccount?.displayName || selectedAccount?.name || '公式アカウント'
  const kindIsRich = Boolean(merged.imageUrl)
  // 下の帯の左は短く（長いと折り返して帯が高くなる）。くわしい決めごとは見出しの説明に書く。
  const status = merged.isEnabled
    ? pendingCount !== null && pendingCount > 0 ? `動いています・配信待ち ${formatNumber(pendingCount)} 通は前の中身のまま` : '動いています'
    : '停止中です（保存しても送り始めません）'

  const preview = (
    <div className={styles.side}>
      <LinePreview accountName={accountName} caption={timing}>
        <LinePreviewMessage accountName={accountName} avatar={accountName.slice(0, 1)} time={isBirthday ? '10:00' : time}>
          <span className={styles.bubbleText}>{`${previewBody(merged.bodyText)}${merged.buttonLabel ? `\n▶ ${merged.buttonLabel}` : ''}`}</span>
        </LinePreviewMessage>
      </LinePreview>
      <Card role="region" layout="vertical" padding="compact" surface="standard" spacing="tight" aria-labelledby="nen-edit-tips">
        <h2 className={styles.sideTitle} id="nen-edit-tips">気をつけること（一般的な目安）</h2>
        <ul className={styles.sideText}>
          <li>・吹き出しは少なめが安心です</li>
          <li>・届く時間は「配信の反応」で確かめられます</li>
          <li>・誕生日配信は 10:00 に固定です</li>
        </ul>
      </Card>
      <Card role="region" layout="vertical" padding="compact" surface="standard" spacing="tight" aria-labelledby="nen-edit-cannot">
        <h2 className={styles.sideTitle} id="nen-edit-cannot">この画面でできないこと</h2>
        <p className={`${styles.sideText} ${styles.sideTextTight}`}>記事の本文を書く（外部サイトで書きます）・出しかたの細かい設定（一斉配信と同じ）</p>
      </Card>
      {canEdit ? (
        <Card role="region" layout="vertical" padding="compact" surface="standard" spacing="controls" aria-labelledby="nen-edit-test">
          <h2 className={`${styles.sideTitle} ${styles.sideTitleSmall}`} id="nen-edit-test">自分にテストを送る</h2>
          <SearchField
            aria-label="テスト送信の相手を名前で探す"
            placeholder="テスト送信の相手を名前で探す"
            value={testSearch}
            onChange={setTestSearch}
            onClear={() => setTestSearch('')}
            onKeyDown={(event) => { if (event.key === 'Enter') void searchFriends() }}
          />
          <span className={styles.fullButton}>
            <Button type="button" disabled={testing || !testTarget} busy={testing} busyLabel="送っています…" title={testTarget ? undefined : '先に相手を名前で探してください'}  onClick={() => void sendTest()}>
              <Send size={16} aria-hidden="true" />{testCandidates.length === 1 ? `${testCandidates[0].displayName ?? '名前なし'}へテストを送る` : 'テストを送る'}
            </Button>
          </span>
          {/* 相手が2人以上いるときだけ、送る相手を選ぶ欄を出す（ボタンの下：上の並びを動かさない）。 */}
          {testCandidates.length > 1 ? (
            <SaveErrorField names={["testTarget","friendId","test_target"]}><EntitySelect aria-label="テスト送信の相手" size="full" value={testTarget} onChange={setTestTarget} options={testCandidates.map((candidate) => ({ ...entityOptionMetadata(candidate), value: candidate.id, label: `送る相手：${candidate.displayName ?? '名前なし'}` }))} /></SaveErrorField>
          ) : null}
        </Card>
      ) : null}
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="w5pwG"
      title={`${setting.label}（配信を直す）`}
      help={`${timing}。保存した新しい中身は次のきっかけから使われ、すでに配信待ちの分は予約したときの中身のまま届きます。`}
      preview={previewOpen ? undefined : preview}
      hidePreviewWhenNarrow
      readOnly={!canEdit}
      previewToggle={<Button type="button" onClick={() => setPreviewOpen(true)}>プレビューを見る</Button>}
      status={status}
      footerActions={canEdit ? (
        <>
          <Button href="/nen-campaigns">キャンセル</Button>
          <Button type="button" variant="primary" onClick={() => void save()} disabled={saving || !bodyCheck.fits} busy={saving} busyLabel="保存しています…"><Save size={16} aria-hidden="true" />配信内容を保存する</Button>
        </>
      ) : <></>} dirty={false}
    >
      {saveConflict.conflict ? <SaveConflictBand title="ほかの担当者が先に保存しました" onCompare={() => void saveConflict.compare()} compareBusy={saveConflict.compareBusy} onReload={() => void saveConflict.reloadLatest()} /> : null}
      <SaveConflictCompareDialog open={saveConflict.compareOpen} busy={saveConflict.compareBusy} error={saveConflict.compareError} onCancel={saveConflict.closeCompare} onReload={() => void saveConflict.reloadLatest()} lines={saveConflict.latest ? Object.entries(withoutVersion(merged) ?? {}).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((saveConflict.latest as unknown as Record<string, unknown>)[key])).map(([key, value]) => ({ text: `${key === 'bodyText' ? '本文' : key === 'title' ? 'タイトル' : key === 'deliveryTime' ? '配信時刻' : '設定'}：入力 ${typeof value === 'string' ? value : JSON.stringify(value)} ／ 最新 ${JSON.stringify((saveConflict.latest as unknown as Record<string, unknown>)[key])}`, kind: 'change' as const })) : null} />
      {error ? <Notice tone="danger" message={error} /> : null}
      {notice ? <Notice tone="success" message={notice} /> : null}

      <Card variant="form" gap="normal" aria-labelledby="nen-edit-flow">
        <CardHeader size="stacked" titleId="nen-edit-flow" title="配信フロー" meta={formAction && mileageAction ? '回答フォームへの送信をきっかけにマイルを付けます' : 'きっかけから届くまでの流れです'} />
        <ol className={styles.flow} aria-label="配信フロー">
          <li className={styles.flowStep}><Package size={16} aria-hidden="true" />{trigger}</li>
          <li className={styles.flowStep}><CalendarClock size={16} aria-hidden="true" />{isBirthday ? '3日前 10:00' : `${merged.delayDays}日後 ${time}`}</li>
          <li className={styles.flowStep} data-current=""><Send size={16} aria-hidden="true" />{setting.label}</li>
          {formAction ? <li className={styles.flowStep}><ClipboardList size={16} aria-hidden="true" />フォームに答えた</li> : null}
          {mileageAction?.kind === 'award_mileage' ? <li className={styles.flowStep}><Coins size={16} aria-hidden="true" />{`${formatNumber(mileageAction.amount)} マイル`}</li> : null}
        </ol>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="nen-edit-when">
        <CardHeader size="stacked" titleId="nen-edit-when" title="いつ送りますか" meta="このアカウントでの反応がいい時間帯は、分析の「配信の反応」で見られます" />
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <span className={styles.labelSmall}>きっかけ</span>
            {isBirthday ? (
              <StaticBox label="きっかけ" value="ペットの誕生日の3日前" />
            ) : !canEdit ? (
              <StaticBox label="きっかけ" value={merged.delayDays === 0 ? `${trigger}日（当日）` : `${trigger}日から ${merged.delayDays} 日後`} />
            ) : (
              <SaveErrorField names={["delayDays","merged.delayDays","draft","delay_days","merged.delay_days"]}><Select
                aria-label="きっかけからの日数"
                size="full"
                value={String(merged.delayDays)}
                onChange={(value) => setDraft((previous) => ({ ...previous, delayDays: Number(value) }))}
                options={withCurrent(DELAY_CHOICES, merged.delayDays).map((days) => ({ value: String(days), label: days === 0 ? `${trigger}日（当日）` : `${trigger}日から ${days} 日後` }))}
              /></SaveErrorField>
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.labelSmall}>送る時刻</span>
            {isBirthday ? (
              <StaticBox label="送る時刻" value="10:00（固定）" />
            ) : !canEdit ? (
              <StaticBox label="送る時刻" value={time} />
            ) : (
              <SaveErrorField names={["time","draft","deliveryTime"]}><TimeField aria-label="送る時刻" value={time} minuteStep={30} onChange={(value) => setDraft((previous) => ({ ...previous, deliveryTime: value }))} /></SaveErrorField>
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.labelSmall}>届かない日</span>
            {/* 届かない日を決める口はまだ無い。毎日送る（今の作りのまま）。 */}
            <StaticBox label="届かない日" value="なし（毎日送る）" />
          </div>
        </SettingsFormRow>
        {isBirthday ? (
          <p className={styles.cardNote}>誕生日のきっかけ・日時は配信の実行処理で固定されています。</p>
        ) : (
          <div className={styles.checks}>
            {canEdit ? <>
              <SaveErrorField names={["dedupWindowDays","merged.dedupWindowDays","draft","dedup_window_days","merged.dedup_window_days"]}><Checkbox checked={merged.dedupWindowDays > 0} onCheckedChange={(checked) => setDraft((previous) => ({ ...previous, dedupWindowDays: checked ? 30 : 0 }))}>
                同じ人に何度も送らない（30日のあいだに1回だけ）
              </Checkbox></SaveErrorField>
              {merged.campaignKey === 'review_request' ? (
                <SaveErrorField names={["formAction","excludeFormRespondents","merged.excludeFormRespondents","draft","form_action","exclude_form_respondents","merged.exclude_form_respondents"]}><Checkbox checked={Boolean(formAction) && merged.excludeFormRespondents} disabled={!formAction} title={formAction ? undefined : '回答フォームをつなぐと選べます'} onCheckedChange={(checked) => setDraft((previous) => ({ ...previous, excludeFormRespondents: checked }))}>
                  すでに口コミを書いた人には送らない
                </Checkbox></SaveErrorField>
              ) : null}
            </> : <>
              {/* 閲覧のみ：チェックは置かず、いまの設定を文字で見せる（2026-10-06 オーナー決定）。 */}
              <StaticBox label="同じ人に何度も送らない" value={merged.dedupWindowDays > 0 ? '同じ人に何度も送らない（30日のあいだに1回だけ）' : '同じ人にも毎回送る'} />
              {merged.campaignKey === 'review_request' ? (
                <StaticBox label="すでに口コミを書いた人" value={Boolean(formAction) && merged.excludeFormRespondents ? 'すでに口コミを書いた人には送らない' : 'すでに口コミを書いた人にも送る'} />
              ) : null}
            </>}
          </div>
        )}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="nen-edit-what">
        <CardHeader size="stacked" titleId="nen-edit-what" title="送るもの" meta="この配信は1通で届きます" />
        {/* 届く形を選ぶ口はまだ無い。画像があればリッチメッセージ、無ければ文字だけで届く（今の作りのまま）。 */}
        <div className={styles.radios} role="radiogroup" aria-label="届く形">
          <SaveErrorField names={["nen-message-kind","kindIsRich"]}><Radio name="nen-message-kind" checked={kindIsRich} readOnly disabled={!kindIsRich} title={kindIsRich ? undefined : '画像のある配信だけがリッチメッセージになります'}>リッチメッセージ</Radio></SaveErrorField>
          <SaveErrorField names={["nen-message-kind"]}><Radio name="nen-message-kind" checked={!kindIsRich} readOnly disabled={kindIsRich}>文字だけ</Radio></SaveErrorField>
        </div>
        <div className={styles.field}>
          <Field required label="配信本文" htmlFor="nen-edit-body"><MessageBody><SaveErrorField names={["bodyText","merged.bodyText","draft","body_text","merged.body_text"]}><InsertTextField tokenNames={tokenNames}
            id="nen-edit-body"
            aria-required="true"
            aria-invalid={Boolean((validationSubmitted || !bodyCheck.fits) && bodyError)}
            aria-describedby={(validationSubmitted || !bodyCheck.fits) && bodyError ? 'nen-edit-body-error' : undefined}
            ref={bodyRef}
            value={merged.bodyText}
            readOnly={!canEdit}
            onValueChange={(next) => setDraft((previous) => ({ ...previous, bodyText: next }))}
            aria-label="配信本文"
            compact
          /></SaveErrorField>
          {canEdit ? (
            <InsertToolbar targetRef={bodyRef} value={merged.bodyText} count={`${formatNumber(merged.bodyText.length)} / ${bodyLimitLabel}`} onChange={(bodyText) => setDraft((previous) => ({ ...previous, bodyText }))} />
          ) : null}
          </MessageBody></Field>
          <FieldError id="nen-edit-body-error">{(validationSubmitted || !bodyCheck.fits) ? bodyError : undefined}</FieldError>
          {!bodyError && bodyRemaining <= BODY_NOTICE_REMAINING ? (
            <p className={styles.muted}>あと{formatNumber(bodyRemaining)}字（上限{bodyLimitLabel}字。長すぎるとLINEで送れません）</p>
          ) : null}
        </div>
        <Notice tone="warn">差し込む名前が長いと、送るときに長すぎる場合があります。1回にたくさんの吹き出しを送るとブロックされやすい傾向があります（一般的な目安）。</Notice>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="nen-edit-after">
        <CardHeader size="stacked" titleId="nen-edit-after" title="押されたあとにすること" meta={`メッセージの「${merged.buttonLabel?.replace(/（.*?）/, '') || 'ボタン'}」を押した人に何をするかです`} />
        <SettingsFormRow layout="columns">
          <div className={styles.field}>
            <span className={styles.labelSmall}>回答フォームを開かせる <OptionalBadge /></span>
            {!canEdit ? <StaticBox label="回答フォーム" value={formAction?.formName ?? '開かせない'} /> : <>
              <SaveErrorField names={["formId","formAction?.formId"]}><EntityKindField
                id="nen-edit-form"
                kind="form"
                label="回答フォームを開かせる"
                options={forms.map((form) => ({ ...form, disabled: !form.isActive }))}
                meta={(row) => (row.isActive === false ? '公開されていないため選べません' : undefined)}
                placeholder="（開かせない）"
                clearable
                invalid={Boolean(formIssueMessage)}
                value={formAction?.formId ?? ''}
                onChange={chooseForm}
              /></SaveErrorField>
              {formIssueMessage ? <Notice tone="danger" >{formIssueMessage}</Notice> : null}
            </>}
            {formIssueBanner ? <p className={styles.muted}>{formIssueBanner}</p> : null}
          </div>
          <div className={styles.field}>
            <span className={styles.labelSmall}>回答後にマイルを付ける</span>
            {!canEdit ? <StaticBox label="回答後のマイル" value={mileageAction?.kind === 'award_mileage' ? `${formatNumber(mileageAction.amount)} マイル` : '付けない'} /> : <SaveErrorField names={["amount","mileageAction.amount","mileage_action.amount"]}><Select
              id="nen-edit-mileage"
              error={fields.error('nen-edit-mileage')}
              aria-label="回答後にマイルを付ける"
              size="full"
              value={mileageAction?.kind === 'award_mileage' ? String(mileageAction.amount) : ''}
              onChange={chooseMileage}
              options={[
                { value: '', label: '付けない' },
                ...withCurrent(MILEAGE_CHOICES, mileageAction?.kind === 'award_mileage' ? mileageAction.amount : MILEAGE_CHOICES[0]).map((amount) => ({ value: String(amount), label: `${formatNumber(amount)} マイル` })),
                { value: 'custom', label: 'ほかの数を入れる' },
              ]}
            /></SaveErrorField>}
          </div>
        </SettingsFormRow>
        <p className={styles.chain}>つながる先：→ 回答フォーム　→ マイル　→ EC連携　→ タグ</p>
      </Card>
      <Drawer open={previewOpen} title="配信のプレビュー" width="narrow" onClose={() => setPreviewOpen(false)}>{preview}</Drawer>
      <Dialog open={customMileageOpen} title="回答後に付けるマイル" confirmLabel="この数にする" onCancel={() => setCustomMileageOpen(false)} error={customMileageError || undefined} onConfirm={() => {
        const amount = Number(customMileage)
        if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
          setCustomMileageError('付けるマイルは1〜1,000,000の整数で入力してください')
          return
        }
        chooseMileage(String(amount))
        setCustomMileageOpen(false)
      }}>
        <Field label="回答後に付けるマイル"><NumberInput unit="マイル" aria-label="回答後に付けるマイル" min={1} max={1_000_000} step={1} value={customMileage} onChange={(event) => { setCustomMileage(event.target.value); setCustomMileageError('') }} /></Field>
      </Dialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </CreatePage></SaveErrorScope>
  )
}
