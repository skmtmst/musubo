'use client'
import Card, { CardHeader } from '@/components/shared/card'

import { api, type CommonActionResources } from '@/lib/api';
import Toggle from '@/components/shared/toggle';
import { notifySaved } from '@/components/shared/toast'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Plus, Send } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { useTestRecipients } from './use-test-recipients'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import { RowMenu } from '@/components/shared/row-actions'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { TimeField } from '@/components/shared/date-time-field'
import { TextField } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import { webinarErrorText } from '@/components/webinars/webinar-error-text'
import { useAccount } from '@/contexts/account-context'
import {
  webinarApi,
  type WebinarAction,
  type WebinarEditor,
  type WebinarNotificationOverview,
  type WebinarNotificationSettings,
  type WebinarNotificationSettingsInput,
} from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { ReadValue } from './parts'
import type { EditContext, PaneSaveProps, WizardChrome } from './types'
import form from './form.module.css'
import styles from './notifications.module.css'
import { audienceText, NotificationStateBadge, notificationRowState, deliveryTimingSummary, missedNoticeSummary, completedNoticeSummary } from './notification-summary'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ActionList from '@/components/shared/action-list'
import { EntityPickerField } from '@/components/shared/entity-picker'
import EntityRemoteField, { type RemoteEntityKind } from '@/components/shared/entity-remote-field'

/*
 * ★V8 ウェビナーの ④通知（Pencil ）。
 * 通知とリマインド（送った数・6つの通知の入／切と時刻）→ 視聴後にすること（3つの場合・本文・取れないとき）。
 * 右は LINE での見え方（選んだ通知の本文）。
 * 口・保存の順（通知の設定 → 版のある設定）・テスト送信は BEHAVIOR.md。
 */

const SETTINGS_KEYS = [
  'registrationEnabled', 'dayBeforeEnabled', 'dayBeforeTime',
  'hourBeforeEnabled', 'hourBeforeMinutes', 'startEnabled',
  'missedEnabled', 'missedTime', 'missedWindowDays', 'completedEnabled',
] as const

/* 設定がまだ無いときの始まり。勝手に入れない（全部切って始める）。 */
const emptySettings = (webinarId: string): WebinarNotificationSettings => ({
  webinarId, version: 0,
  registrationEnabled: false, dayBeforeEnabled: false, dayBeforeTime: '18:00',
  hourBeforeEnabled: false, hourBeforeMinutes: 60, startEnabled: false,
  missedEnabled: false, missedTime: '20:00', missedWindowDays: 7, completedEnabled: false,
  updatedAt: '',
})

const HOUR_OPTIONS = [15, 30, 60, 120].map((minutes) => ({ value: String(minutes), label: String(minutes) }))
const WINDOW_OPTIONS = Array.from({ length: 30 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))

type RowKey = 'registration' | 'dayBefore' | 'hourBefore' | 'start' | 'missed' | 'completed'

const TRIGGERS: Array<{ key: WebinarAction['trigger']; label: string }> = [
  { key: 'completed', label: '視聴完了' },
  { key: 'cta_clicked', label: '案内ボタンを押した' },
  { key: 'unviewed', label: '未視聴' },
]
const ACTION_LABEL: Record<WebinarAction['actionType'], string> = {
  add_tag: 'タグを付ける', remove_tag: 'タグを外す', start_scenario: 'シナリオを始める', stop_scenario: 'シナリオを止める',
  resume_scenario: 'シナリオを再開する', send_message: 'メッセージを送る', send_webhook: 'Webhookを送る',
  switch_rich_menu: 'リッチメニューを変える', remove_rich_menu: 'リッチメニューを外す',
}
function referenceKey(type: WebinarAction['actionType']): string | null {
  if (type === 'add_tag' || type === 'remove_tag') return 'tagId'
  if (type === 'start_scenario' || type === 'stop_scenario' || type === 'resume_scenario') return 'scenarioId'
  if (type === 'send_message') return 'templateId'
  if (type === 'send_webhook') return 'webhookId'
  if (type === 'switch_rich_menu') return 'richMenuPageId'
  return null
}

export default function NotificationsPane({ ctx, chrome, onDirtyChange, registerSave }: { ctx: EditContext; chrome: WizardChrome } & PaneSaveProps) {
  const saveErrors = useSaveFormErrors()

  const { webinar, editor, readOnly } = ctx
  const webinarId = webinar.id
  const { accounts } = useAccount()
  const account = accounts.find((item) => item.id === webinar.accountId)
  const accountName = account?.displayName ?? account?.name ?? '公式アカウント'

  /* ===== 通知の設定 ===== */
  const [settings, setSettings] = useState<WebinarNotificationSettings | null>(null)
  const [baseline, setBaseline] = useState<WebinarNotificationSettings | null>(null)
  const [overview, setOverview] = useState<WebinarNotificationOverview | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const generation = useRef(0)
  const load = useCallback(async (overviewOnly = false) => {
    const request = ++generation.current
    if (!overviewOnly) setLoadState('loading')
    try {
      const res = await webinarApi.notifications(webinarId)
      if (!res.data || typeof res.data !== 'object') throw new Error('shape')
      if (request !== generation.current) return
      if (!overviewOnly) {
        setSettings(res.data.settings)
        setBaseline(res.data.settings)
        setLoadState('ready')
      }
      setOverview(res.data.overview ?? null)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (request === generation.current) { if (overviewOnly) setOverview(null); else if (!fieldFailure) setLoadState('error')
    }
  }
  }, [webinarId, saveErrors])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])
  const patch = (next: Partial<WebinarNotificationSettingsInput>) => setSettings((prev) => (prev ? { ...prev, ...next } : prev))
  const notificationDirty = settings !== null && baseline !== null && (baseline.version === 0 || SETTINGS_KEYS.some((key) => settings[key] !== baseline[key]))

  /* ===== 視聴後にすること ===== */
  const [actionAttempt, setActionAttempt] = useState(0)
  const [actionsBase, setActionsBase] = useState<WebinarAction[] | null>(null)
  const [resourceAttempt, setResourceAttempt] = useState(0)
  const [actionResources, setActionResources] = useState<CommonActionResources | null>(null)
  const [resourcesError, setResourcesError] = useState(false)
  const actionAccountId = webinar.accountId
  useEffect(() => {
    setActionResources(null); setResourcesError(false)
    if (!actionAccountId || readOnly) return
    let active = true
    Promise.resolve().then(() => api.commonActions.resources(actionAccountId))
      .then(res => { if (!res.success) throw new Error('resources'); if (active) setActionResources(res.data) })
      .catch(() => { if (active) setResourcesError(true) })
    return () => { active = false }
  }, [actionAccountId, readOnly, resourceAttempt])
  const [actions, setActions] = useState<WebinarAction[] | null>(null)
  const [actionError, setActionError] = useState(false)
  useEffect(() => {
    let active = true
    setActions(null)
    setActionError(false)
    webinarApi.actions(webinarId).then((res) => { if (active) { setActions(res.data); setActionsBase(res.data) } }).catch(() => { if (active) setActionError(true) })
    return () => { active = false }
  }, [webinarId, actionAttempt])
  const [templateBody, setTemplateBody] = useState(editor.actionPolicy?.templateBody ?? '')
  const [policy, setPolicy] = useState<WebinarEditor['actionPolicy']['missingResultPolicy']>(editor.actionPolicy?.missingResultPolicy ?? 'escalate')
  const [policyBase, setPolicyBase] = useState({ templateBody: editor.actionPolicy?.templateBody ?? '', policy: editor.actionPolicy?.missingResultPolicy ?? 'escalate' })
  const policyDirty = templateBody !== policyBase.templateBody || policy !== policyBase.policy
  useEffect(() => {
    if (policyDirty) return
    const next = { templateBody: editor.actionPolicy?.templateBody ?? '', policy: editor.actionPolicy?.missingResultPolicy ?? 'escalate' }
    setTemplateBody(next.templateBody)
    setPolicy(next.policy)
    setPolicyBase(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.actionPolicy?.templateBody, editor.actionPolicy?.missingResultPolicy])

  const actionsDirty = actions !== null && actionsBase !== null && JSON.stringify(actions) !== JSON.stringify(actionsBase)
  const [editorRefreshPending, setEditorRefreshPending] = useState(false)
  const refreshPending = useRef(false)
  const editorVersion = useRef(editor.version)
  useEffect(() => { editorVersion.current = editor.version }, [editor.version])
  const dirty = notificationDirty || policyDirty || actionsDirty || editorRefreshPending
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)
  const [error, setError] = useState('')
  const save = async (): Promise<boolean> => {
    if (saveLock.current || readOnly) return false
    saveLock.current = true
    setSaving(true)
    setError('')
    try {
      let version = editorVersion.current
      if (notificationDirty && settings) {
        const input: WebinarNotificationSettingsInput = {
          registrationEnabled: settings.registrationEnabled,
          dayBeforeEnabled: settings.dayBeforeEnabled,
          dayBeforeTime: settings.dayBeforeTime,
          hourBeforeEnabled: settings.hourBeforeEnabled,
          hourBeforeMinutes: settings.hourBeforeMinutes,
          startEnabled: settings.startEnabled,
          missedEnabled: settings.missedEnabled,
          missedTime: settings.missedTime,
          missedWindowDays: settings.missedWindowDays ?? 7,
          completedEnabled: settings.completedEnabled,
        }
        try {
          const res = await webinarApi.saveNotifications(webinarId, input)
          setSettings(res.data.settings)
          setBaseline(res.data.settings)
          refreshPending.current = true
          setEditorRefreshPending(true)
          notifySaved(`保存しました。${res.data.queued}件を予定に入れ、${res.data.cancelled}件を取り消しました。`)
        } catch (saveFailure) {
          const fieldFailure = saveErrors.capture(saveFailure)

          { if (!fieldFailure)

          setError('通知の設定を保存できませんでした。入力を残しました。もう一度お試しください。') }
          return false
        }
        // 件数は読み直す。保存後に入力した内容や保存済みの基準は上書きしない。
        void load(true)
      }
      if (refreshPending.current) {
        const refreshed = await webinarApi.editor(webinarId)
        version = refreshed.data.version
        editorVersion.current = version
        ctx.onEditorChange(refreshed.data)
        refreshPending.current = false
        setEditorRefreshPending(false)
      }
      if (policyDirty) {
        const res = await webinarApi.saveEditor(webinarId, { expectedVersion: version, actionTemplateBody: templateBody, missingResultPolicy: policy })
        setPolicyBase({ templateBody, policy })
        editorVersion.current = res.data.version
        ctx.onEditorChange(res.data)
      }
      if (actionsDirty && actions) {
        const res = await webinarApi.saveActions(webinarId, actions)
        setActions(res.data); setActionsBase(res.data)
      }
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(webinarErrorText(cause, '保存できませんでした。入力を残しました。もう一度お試しください。')) }
      return false
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (readOnly) { registerSave(null); return }
    registerSave(() => saveRef.current())
    return () => registerSave(null)
  }, [registerSave, readOnly])

  /* ===== テスト送信 ===== */
  const [testOpen, setTestOpen] = useState(false)
  const testRecipients = useTestRecipients(webinarId, testOpen)
  const [testing, setTesting] = useState(false)
  const testLock = useRef(false)
  const [testResult, setTestResult] = useState('')
  const [testRefreshError, setTestRefreshError] = useState(false)
  const refreshTestResult = async () => {
    try {
      const refreshed = await webinarApi.editor(webinarId)
      ctx.onEditorChange(refreshed.data)
      setTestRefreshError(false)
    } catch { setTestRefreshError(true) }
  }
  const retryTestResult = async () => {
    if (testLock.current || readOnly) return
    testLock.current = true
    setTesting(true)
    try { await refreshTestResult() }
    finally { testLock.current = false; setTesting(false) }
  }
  const runTest = async () => {
    if (testLock.current || testRefreshError || readOnly || !settings || !testOpen || !testRecipients.preview) return
    testLock.current = true
    setTesting(true)
    setTestResult('')
    try {
      if (dirty && !(await saveRef.current())) return
      if (!testRecipients.isCurrent() || !testRecipients.preview) return
      const res = await webinarApi.testNotifications(webinarId, testRecipients.preview.token, testRecipients.preview.confirmationId)
      setTestResult(`テスト送信しました。成功 ${formatNumber(res.data.sent)} 件・失敗 ${formatNumber(res.data.failed)} 件`)
      setTestOpen(false)
      void refreshTestResult()
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setTestResult(webinarErrorText(cause, 'テスト送信できませんでした。時間をおいてもう一度お試しください。')) }
      return false
    } finally {
      testLock.current = false
      setTesting(false)
    }
  }
  const testDone = !dirty && editor.notificationTest?.status === 'passed'

  /* ===== 視聴後の動きを変える窓 ===== */

  /* ===== 見え方 ===== */
  const [previewKey, setPreviewKey] = useState<RowKey>('dayBefore')

  const available = overview !== null
  const count = (value: number | undefined) => (available && typeof value === 'number' ? formatNumber(value) : emptyValue('unknown'))
  const countWithUnit = (value: number | undefined) => (available && typeof value === 'number' ? `${count(value)}件` : count(value))

  const timeBox = (value: string, label: string, onChange: (next: string) => void) => (readOnly
    ? <ReadValue compact label={label}>{value}</ReadValue>
    : <SaveErrorField names={["value"]}><TimeField className={styles.time} value={value} aria-label={label} disabled={saving} onChange={(next) => { if (next) onChange(next) }} /></SaveErrorField>
  )
  const smallSelect = (value: string, label: string, options: Array<{ value: string; label: string }>, onChange: (next: string) => void) => (readOnly
    ? <ReadValue compact label={label}>{options.find((option) => option.value === value)?.label ?? value}</ReadValue>
    : <div className={styles.small}><SaveErrorField names={["value"]}><Select aria-label={label} size="full" value={value} disabled={saving} onChange={onChange} options={options} /></SaveErrorField></div>
  )

  const rows: Array<{ key: RowKey; label: string; on: boolean; toggle: () => void; extra: ReactNode; caption: string }> = settings ? [
    { key: 'registration', label: '申込のお礼', on: settings.registrationEnabled, toggle: () => patch({ registrationEnabled: !settings.registrationEnabled }), extra: <span className={styles.rowText}>申し込んだらすぐ</span>, caption: '申込のすぐあと' },
    { key: 'dayBefore', label: '前日のご案内', on: settings.dayBeforeEnabled, toggle: () => patch({ dayBeforeEnabled: !settings.dayBeforeEnabled }), extra: <><span className={styles.rowText}>前日の</span>{timeBox(settings.dayBeforeTime, '前日のご案内を送る時刻', (next) => patch({ dayBeforeTime: next }))}</>, caption: `開始の前日 ${settings.dayBeforeTime}` },
    { key: 'hourBefore', label: '開始前のお知らせ', on: settings.hourBeforeEnabled, toggle: () => patch({ hourBeforeEnabled: !settings.hourBeforeEnabled }), extra: <><span className={styles.rowText}>開始の</span>{smallSelect(String(settings.hourBeforeMinutes), '開始前のお知らせを送るのは何分前か', HOUR_OPTIONS, (value) => patch({ hourBeforeMinutes: Number(value) }))}<span className={styles.rowText}>分前</span></>, caption: `開始の ${settings.hourBeforeMinutes} 分前` },
    { key: 'start', label: '開始のお知らせ', on: settings.startEnabled, toggle: () => patch({ startEnabled: !settings.startEnabled }), extra: <span className={styles.rowText}>開始したとき</span>, caption: '開始したとき' },
    { key: 'missed', label: '見逃した人への案内', on: settings.missedEnabled, toggle: () => patch({ missedEnabled: !settings.missedEnabled }), extra: <><span className={styles.rowText}>翌日の</span>{timeBox(settings.missedTime, '見逃した人への案内を送る時刻', (next) => patch({ missedTime: next }))}<span className={styles.rowText}>・見られる期限</span>{smallSelect(String(settings.missedWindowDays ?? 7), '見逃した人が見られる期限（日数）', WINDOW_OPTIONS, (value) => patch({ missedWindowDays: Number(value) }))}<span className={styles.rowText}>日</span></>, caption: `翌日 ${settings.missedTime}` },
    { key: 'completed', label: '見終わった人へのお礼', on: settings.completedEnabled, toggle: () => patch({ completedEnabled: !settings.completedEnabled }), extra: <span className={styles.rowText}>見終わったら</span>, caption: '見終わったら' },
  ] : []
  const previewRow = rows.find((row) => row.key === previewKey) ?? rows[0]
  const previewText = (editor.notificationMessages?.[previewKey] ?? '').trim()

  let notificationBody: ReactNode
  if (loadState === 'loading') notificationBody = <ListState kind="loading" />
  else if (loadState === 'error') notificationBody = <ListState kind="error" title="通知の設定を読み込めませんでした" description="通信を確認して、もう一度読み込んでください。" onRetry={() => void load()} />
  else if (!settings) {
    notificationBody = <ListState kind="empty" title="通知の設定がまだありません" description="届けるものを決めて保存すると、申込・前日・開始前の通知が届くようになります。最初は全部オフから始めます。" action={readOnly ? undefined : <Button onClick={() => { const initial = emptySettings(webinarId); setSettings(initial); setBaseline(initial) }}>通知の設定を入力する</Button>} />
  } else {
    notificationBody = <>
      <dl className={styles.counts}>
        {([['送った', overview?.sent], ['届かなかった', overview?.failed], ['見送り', overview?.skipped]] as const).map(([label, value]) => (
          <div key={label} className={styles.countItem}><dt className={styles.countLabel}>{label}</dt><dd className={styles.countValue}>{count(value)}</dd></div>
        ))}
      </dl>
      <ul className={styles.rows}>
        {rows.map((row, saveFieldIndex) => (
          <li key={row.key} className={styles.row} data-selected={row.key === previewKey || undefined}>
            <button type="button" className={styles.rowLabel} onClick={() => setPreviewKey(row.key)} title="右の見え方に出す" >{row.label}</button>
            <div className={styles.rowExtra}>{row.extra}</div>
            {readOnly
              ? <span className={styles.state}>{row.on ? '送る' : '送らない'}</span>
              : <SaveErrorField names={[`rows.${saveFieldIndex}.on`,"on","row.on"]}><Toggle checked={row.on} onChange={row.toggle} label={row.label} /></SaveErrorField>}
          </li>
        ))}
      </ul>
      {available && (overview?.skippedReasons?.length ?? 0) > 0 ? (
        <ul className={styles.reasons} aria-label="見送りの内訳">
          {overview!.skippedReasons.map((reason) => <li key={reason.code ?? 'unknown'}><span>{reason.label}</span><span>{formatNumber(reason.count)} 件</span></li>)}
        </ul>
      ) : null}
      {readOnly ? null : (
        <div><Button onClick={() => { setTestResult(''); setTestOpen(true) }} disabled={testRefreshError || testing || saving || testDone} title={testRefreshError ? '送信済みの結果を読み直してください' : testDone ? 'テスト済みです' : undefined}  busy={testing} busyLabel="送信中…"><Send size={16} aria-hidden="true" />{testDone ? 'テスト送信済み（全部）' : 'テストを送る（全部）'}</Button></div>
      )}
    </>
  }

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage dirty={false}
      hidePreviewWhenNarrow
      boardId="E7iAYs"
      title={chrome.title}
      actions={chrome.actions}
      identity={chrome.identity}
      steps={chrome.steps}
      help="いつ LINE で知らせるかと、見た人・見なかった人に何をするかを決めます。"
      footerActions={chrome.footerActions}
      status={chrome.status}
      preview={<>
        <LinePreview accountName={accountName} caption={previewRow?.caption ?? '今日'}>
          {previewText
            ? <LinePreviewMessage accountName={accountName} avatar={accountName.trim().charAt(0) || 'L'} time="">{previewText}</LinePreviewMessage>
            : <p className={styles.previewEmpty}>{`「${previewRow?.label ?? '通知'}」の本文はまだありません。送るときに決まった文面を使います。`}</p>}
        </LinePreview>
        <div className={form.previewActions}>
          {readOnly ? null : <Button onClick={() => { setTestResult(''); setTestOpen(true) }} disabled={testRefreshError || testing || saving || testDone || !settings} title={testRefreshError ? '送信済みの結果を読み直してください' : testDone ? 'テスト済みです' : saving ? '保存しています' : !settings ? '通知の設定を読み込んでください' : undefined} busy={testing} busyLabel="送信中…">{testDone ? 'テスト送信済み' : 'テストを送る'}</Button>}
          {ctx.canOpenPublicPage && ctx.publicUrl ? <Button external href={ctx.publicUrl}  >公開ページを見る</Button> : null}
        </div>
        {!ctx.canOpenPublicPage && ctx.publicPageReason ? <p className={form.previewNote}>{ctx.publicPageReason}</p> : null}
      </>}
    >
      <Card variant="form" gap="normal" aria-labelledby="webinar-notify-title" data-wc-pane="notifications">
        <CardHeader size="stacked" titleId="webinar-notify-title" title="通知とリマインド" action={<HelpTip label="送った数と通知の対象">{`予定 ${countWithUnit(overview?.pending)}・取消 ${countWithUnit(overview?.cancelled)}・合計 ${countWithUnit(overview?.total)}。通知の対象：${audienceText(overview?.audience)}`}<br /><NotificationStateBadge state={notificationRowState(settings ? SETTINGS_KEYS.filter(key => key.endsWith("Enabled")).some(key => Boolean(settings[key])) : undefined, loadState !== 'loading', loadState === 'error')} /><br />{deliveryTimingSummary(settings, loadState !== 'loading', loadState === 'error')}<br />{missedNoticeSummary(settings, loadState !== 'loading', loadState === 'error')}<br />{completedNoticeSummary(settings, loadState !== 'loading', loadState === 'error')}</HelpTip>} />
        <p className={styles.desc}>LINE で送るお知らせです。テストは全部をまとめて自分に送ります。</p>
        {notificationBody}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="webinar-after-title">
        <CardHeader size="stacked" titleId="webinar-after-title" title="視聴後にすること" />
        <p className={styles.desc}>見たかどうかで、タグを付けたりシナリオを始めたりします。</p>
        {actionError ? (
          <Notice tone="info" action={<Button onClick={() => setActionAttempt((value) => value + 1)}>もう一度読み込む</Button>}>視聴後の設定を読み込めませんでした。</Notice>
        ) : (
          <div>
            {resourcesError ? <Notice tone="danger" action={<Button onClick={() => setResourceAttempt(n => n + 1)}>もう一度読み込む</Button>}>動きの対象を読み込めませんでした。</Notice> : null}
            {TRIGGERS.map(trigger => <div key ={trigger.key}>
              <CardHeader size="stacked" headingLevel={3} title={trigger.label} />
              { actions === null? <ListState kind="loading" /> : <ActionList<WebinarAction> value={actions.filter(action => action.trigger === trigger.key)} readOnly={readOnly || saving}
                onChange={next => setActions(current => [...(current ?? []).filter(action => action.trigger !== trigger.key), ...next])}
                idOf={(action, index) => action.id ?? String(index)} titleOf={action =>{
                  const items = webinarActionItems(action.actionType, actionResources)
                  const key = referenceKey(action.actionType)
                  return key ? items.find(item => item. id === action.config[key])?.name ?? '未設定': ACTION_LABEL[action.actionType]
                }} kindOf={action => ACTION_LABEL[action.actionType]}
                choices={Object.entries(ACTION_LABEL).map(([id, label]) => {
                  const type = id as WebinarAction['actionType']
                  const key = referenceKey(type)
                  return { id, label, disabled: Boolean(key && !actionResources), disabledReason: resourcesError ? '候補を読み直してください' : '候補を読み込んでいます', make: () =>({ trigger:trigger.key, actionType: type, config: { } }), picker: key ? {
                    title: `${label}対象を選ぶ`, items: webinarActionItems(type, actionResources), apply: (action, ids) => ({ ...action, config: { [key]: ids[0] } }),
                  } : undefined }
                })}
                renderEditor={(action, update) => {
                  const key = referenceKey(action.actionType)
                  return key ? <EntityPickerField label="操作の対象" noun="対象" items={webinarActionItems(action.actionType, actionResources)} value={String(action.config[key] ?? '')} onChange={id => update({ ...action, config: { ...action.config, [key]: id } })}
                      /> : <p>ほかに決めることはありません</p>
                }} />}
                    </div>
                  )}
                </div>
        )}
        <div className={form.field}>< label className={form.label} htmlFor="webinar-action-message">視聴完了のメッセージ</label><SaveErrorField names={["templateBody","actionTemplateBody","template_body"]}><TextField id="webinar-action-message" aria-label="視聴完了メッセージ本文" value={templateBody} readOnly={readOnly} disabled={saving} onChange={(event) => setTemplateBody(event.target.value)} /></SaveErrorField></div>
        <div className={form.field}>< label className={form.labelSmall} htmlFor="webinar-missing-policy">結果が取れないとき</label><div className={styles.policy}>
            {readOnly
              ? <ReadValue label="視聴結果を取得できない場合">{policy === 'escalate' ? '要対応へ追加' : '翌日に取り直す'}</ReadValue>
              : <SaveErrorField names={["policy","missingResultPolicy"]}><Select id="webinar-missing-policy" aria-label="視聴結果を取得できない場合" size="full" value={policy} disabled={saving} onChange={(value) => setPolicy(value as typeof policy)} options={[{ value: 'escalate', label: '要対応へ追加' }, { value: 'retry_next_day', label: '翌日に取り直す' }]} /></SaveErrorField>}
          </div></div>
      </Card>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {testRefreshError ? <Notice tone="info" action={readOnly ? undefined : <Button onClick={() => void retryTestResult()} disabled={testing} busy={testing}>送信結果を読み直す</Button>}>テスト送信の結果は受け取りましたが、確認状態を読み込めませんでした。再送せずに結果を読み直してください。</Notice> : null}
      {testResult ? <p role="status" className={form.previewNote}>{testResult}</p> : null}

      <ConfirmDialog open={testOpen} title="通知をテスト送信しますか？" description="アカウント設定で登録したテスト受信者へ、実際のLINEメッセージを送ります。申込者全員には届きません。" confirmLabel="テストを送る" confirmDisabled={!testRecipients.preview || testRecipients.preview.count === 0} busy={testing} onCancel={() => { if (!testing) setTestOpen(false) }} error={testResult || undefined} onSuccess={() => setTestOpen(false)} onConfirm={() => runTest()}>
        <OperationTargetSummary accounts={[{ id: webinar.accountId ?? '' }]} />
        <p>{testRecipients.preview ? `テスト受信者 ${testRecipients.preview.count} 人：${testRecipients.preview.recipients.map(person => person.displayName || '名前未設定').join('、')}` : testRecipients.error ? 'テスト受信者を確認できません。設定を確かめて開き直してください。' : 'テスト受信者を確認しています。'}</p>
        <p className={form.cardNote}>{dirty ? '保存していない設定を保存してから送ります。' : ''}{`対象：「${webinar.title}」の入っている通知。本文は設定済みのものを送ります。`}</p>
      </ConfirmDialog>
    </CreatePage></SaveErrorScope>
  )
}
function webinarActionItems(type: WebinarAction['actionType'], resources: CommonActionResources | null): Array <{ id: string; name: string}>{
  if( !resources) return []
  if (type=== 'add_tag' || type=== 'remove_tag'
  ) return resources.tags
  if (type === 'start_scenario' || type === 'stop_scenario' || type === 'resume_scenario') return resources.scenarios
  if (type === 'send_message') return resources.templates
  if (type === 'send_webhook') return resources.webhooks
  if (type === 'switch_rich_menu') return resources.richMenus
  return []
}
