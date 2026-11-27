'use client'
import { notifySaved } from '@/components/shared/toast'

import { useEffect, useRef, useState } from 'react'
import { CalendarDays, IdCard, Ticket } from 'lucide-react'
import type { FriendField, ReminderDraftSettings, ReminderDraftStep, ReminderTriggerType } from '@line-crm/shared'
import { api, eventsApi, type EventListItem } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import FolderSelect, { folderById, folderCreator } from '@/components/shared/folder-select'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { TextArea, TextField } from '@/components/shared/text-field'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import Card, { CardHeader } from '@/components/shared/card'
import { ChoiceCardV8 } from './ui'
import styles from './edit.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

/*
 * ★V8 リマインダ手順1「基本設定」の入力部分（板 ・競合 ）。
 * /reminders/edit?stage=basics（保存済みの基本設定を直す）で使う。
 * 合格した /reminders/new（app/reminders/basics-form-v8.tsx）を写した。
 * src/v8 からは @/app を読めないため、同じ動き・同じ値で持つ。
 */

export interface BasicsValue {
  name: string
  description: string
  folderId: string
  triggerType: ReminderTriggerType
  triggerFieldId: string
  triggerEventId: string
  repeatYearly: boolean
  /** N-068: 2月29日が基準日のときの平年の扱い。 */
  leapYearPolicy: 'feb28' | 'mar1' | 'skip'
}

export const EMPTY_BASICS: BasicsValue = {
  name: '',
  description: '',
  folderId: '',
  triggerType: 'booking',
  triggerFieldId: '',
  triggerEventId: '',
  repeatYearly: false,
  leapYearPolicy: 'feb28',
}

/** 保存済みの下書きを基本設定フォームの値へ戻す（stage=basics で使う）。 */
export function basicsFromDraft(settings: ReminderDraftSettings): BasicsValue {
  return {
    name: settings.name,
    description: settings.description ?? '',
    folderId: settings.folderId ?? '',
    triggerType: settings.triggerType,
    triggerFieldId: settings.triggerFieldId ?? '',
    triggerEventId: settings.triggerEventId ?? '',
    repeatYearly: Boolean(settings.repeatYearly),
    leapYearPolicy: settings.leapYearPolicy ?? 'feb28',
  }
}

/** フォームの値を下書き設定へ反映する（他の設定はそのまま残す）。 */
export function basicsToDraft(settings: ReminderDraftSettings, value: BasicsValue): ReminderDraftSettings {
  return {
    ...settings,
    name: value.name.trim(),
    description: value.description.trim() || null,
    folderId: value.folderId || null,
    triggerType: value.triggerType,
    triggerFieldId: value.triggerType === 'friend_field' ? value.triggerFieldId || null : null,
    triggerEventId: value.triggerType === 'event' ? value.triggerEventId || null : null,
    repeatYearly: value.triggerType === 'friend_field' ? value.repeatYearly : false,
    leapYearPolicy: value.leapYearPolicy,
  }
}

/** 基準日の要約（右欄・確認画面に出す言葉）。 */
export function basicsBaseSummary(value: BasicsValue, fields: FriendField[], events: EventListItem[]): string {
  if (value.triggerType === 'booking') return '予約日時'
  if (value.triggerType === 'event') {
    const event = events.find((item) => item.id === value.triggerEventId)
    return event ? `イベントの予約日時（${event.name}）` : 'イベントの予約日時'
  }
  const field = fields.find((item) => item.id === value.triggerFieldId)
  return field ? `友だち情報欄の日付（${field.name}）` : '友だち情報欄の日付'
}

/*
 * #996 DEEP-06/07: ひな形。選んだときだけ用途に合う基準日・タイミング・
 * 本文をまとめて入れる。fieldNameMatch は friend_field 起点のとき、
 * 候補の名前に含まれていればその情報欄を自動で選ぶ目印（例：「誕生日」）。
 */
export interface ReminderTemplateV8 {
  id: string
  title: string
  note: string
  baseLabel: string
  timingLabel: string
  triggerType: ReminderTriggerType
  fieldNameMatch?: string
  repeatYearly?: boolean
  step: Pick<ReminderDraftStep, 'offsetDays' | 'offsetMinutes' | 'sendAtTime' | 'messageContent'>
}

export const reminderTemplatesV8: ReminderTemplateV8[] = [
  {
    id: 'booking-day-before',
    title: '予約の前日案内',
    note: '無断キャンセルを減らす',
    baseLabel: '予約日時',
    timingLabel: '1日前 18:00',
    triggerType: 'booking',
    step: { offsetDays: -1, offsetMinutes: 0, sendAtTime: '18:00', messageContent: '明日のGoogle Meet相談のご案内です。' },
  },
  {
    id: 'booking-just-before',
    title: '予約の直前',
    note: '開始前に気づいてもらう',
    baseLabel: '予約日時',
    timingLabel: '1時間前',
    triggerType: 'booking',
    step: { offsetDays: null, offsetMinutes: -60, sendAtTime: null, messageContent: 'まもなくご予約のお時間です。' },
  },
  {
    id: 'contract-renewal',
    title: '契約更新のお知らせ',
    note: '更新の検討時間をつくる',
    baseLabel: '契約終了日（友だち情報欄）',
    timingLabel: '30日前 10:00',
    triggerType: 'friend_field',
    fieldNameMatch: '契約',
    step: { offsetDays: -30, offsetMinutes: 0, sendAtTime: '10:00', messageContent: '契約更新の時期が近づいています。引き続きのご利用についてご案内します。' },
  },
  {
    id: 'birthday',
    title: '誕生日のお祝い',
    note: '来店・購入のきっかけに',
    baseLabel: '誕生日（友だち情報欄）',
    timingLabel: '当日 10:00',
    triggerType: 'friend_field',
    fieldNameMatch: '誕生日',
    repeatYearly: true,
    step: { offsetDays: 0, offsetMinutes: 0, sendAtTime: '10:00', messageContent: 'お誕生日おめでとうございます。いつもありがとうございます。' },
  },
]

export function ReminderBasicsFormV8({
  value,
  fieldError,
  onChange,
  appliedTemplateId,
  onRequestTemplate,
  pendingFieldMatch,
  onFieldMatchHandled,
  onFieldsReady,
  onEventsReady,
}: {
  value: BasicsValue
  fieldError?: { key: 'name' | 'triggerFieldId' | 'triggerEventId'; message: string } | null
  onChange: (next: BasicsValue) => void
  /** 適用中のひな形。手で起点を選び直したら外れる。 */
  appliedTemplateId: string | null
  /** ひな形のカードを押したとき。置き換え確認は呼び出し側が持つ。 */
  onRequestTemplate: (template: ReminderTemplateV8) => void
  /** friend_field 起点のひな形が指す情報欄名（自動選択の目印）。 */
  pendingFieldMatch: string | null
  onFieldMatchHandled: () => void
  /** 候補の読み込み結果を親へ渡す（右欄の要約・「次へ」の可否に使う）。 */
  onFieldsReady: (fields: FriendField[], state: 'loading' | 'ready' | 'error') => void
  onEventsReady: (events: EventListItem[], state: 'loading' | 'ready' | 'error') => void
}) {
  const { selectedAccountId } = useAccount()
  const staffRole = useStaffRole()
  const canCreateFolder = canManageRole(staffRole)
  const [dateFields, setDateFields] = useState<FriendField[]>([])
  const [fieldsLoadState, setFieldsLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [events, setEvents] = useState<EventListItem[]>([])
  const [eventsLoadState, setEventsLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [folders, setFolders] = useState<import('@line-crm/shared').Folder[]>([])
  const [foldersLoadState, setFoldersLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [foldersReloadToken, setFoldersReloadToken] = useState(0)

  const latestValue = useRef(value)
  latestValue.current = value
  const latestOnChange = useRef(onChange)
  latestOnChange.current = onChange

  // DEEP-05: 応答が届いた時点でアカウントが変わっていたら、その応答は捨てる。
  const folderScope = useRef({ accountId: selectedAccountId, generation: 0, mounted: true })
  if (folderScope.current.accountId !== selectedAccountId) folderScope.current = { ...folderScope.current, accountId: selectedAccountId, generation: folderScope.current.generation + 1 }
  const folderGeneration = folderScope.current.generation
  useEffect(() => { folderScope.current.mounted = true; return () => { folderScope.current.mounted = false } }, [])
  const accountRef = useRef(selectedAccountId)

  useEffect(() => {
    let active = true
    setFoldersLoadState('loading')
    void api.folders.list('reminder').then((res) => {
      if (!active) return
      if (!res.success) return setFoldersLoadState('error')
      setFolders(res.data)
      setFoldersLoadState('ready')
      const booking = res.data.find((folder) => folder.name.includes('予約'))
      if (booking && !latestValue.current.folderId) latestOnChange.current({ ...latestValue.current, folderId: booking.id })
    }).catch(() => { if (active) setFoldersLoadState('error') })
    return () => { active = false }
  }, [foldersReloadToken])

  // アカウントが切り替わったら候補一覧・選択ID・取得状態を捨てて取り直す。
  useEffect(() => {
    if (accountRef.current === selectedAccountId) return
    accountRef.current = selectedAccountId
    setDateFields([])
    setFieldsLoadState('idle')
    setEvents([])
    setEventsLoadState('idle')
    if (value.triggerFieldId || value.triggerEventId) {
      onChange({ ...value, triggerFieldId: '', triggerEventId: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId])

  // 起点の候補は、その種類が必要になってから読む。
  useEffect(() => {
    if (value.triggerType !== 'friend_field' || !selectedAccountId || fieldsLoadState !== 'idle') return
    const accountId = selectedAccountId
    setFieldsLoadState('loading')
    void api.friendFields.list(accountId).then((res) => {
      if (accountRef.current !== accountId) return
      if (!res.success) return setFieldsLoadState('error')
      setDateFields(res.data.filter((field) => field.type === 'date' || field.type === 'datetime'))
      setFieldsLoadState('ready')
    }).catch(() => { if (accountRef.current === accountId) setFieldsLoadState('error') })
  }, [value.triggerType, selectedAccountId, fieldsLoadState])

  useEffect(() => {
    if (value.triggerType !== 'event' || !selectedAccountId || eventsLoadState !== 'idle') return
    const accountId = selectedAccountId
    setEventsLoadState('loading')
    void eventsApi.listEvents(accountId, { filter: 'all', limit: 100, sort: 'name' }).then((res) => {
      if (accountRef.current !== accountId) return
      setEvents(res.items)
      setEventsLoadState('ready')
    }).catch(() => { if (accountRef.current === accountId) setEventsLoadState('error') })
  }, [value.triggerType, selectedAccountId, eventsLoadState])

  // ひな形が指す情報欄がこのアカウントの候補にあれば自動で選ぶ。
  useEffect(() => {
    if (!pendingFieldMatch || fieldsLoadState !== 'ready') return
    const match = dateFields.find((field) => field.name.includes(pendingFieldMatch))
    if (match) onChange({ ...value, triggerFieldId: match.id })
    onFieldMatchHandled()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFieldMatch, dateFields, fieldsLoadState])

  // 候補の読み込み状態を親へ伝える。
  const fieldsStateForParent = value.triggerType === 'friend_field' ? (fieldsLoadState === 'idle' ? 'loading' : fieldsLoadState) : 'ready'
  const eventsStateForParent = value.triggerType === 'event' ? (eventsLoadState === 'idle' ? 'loading' : eventsLoadState) : 'ready'
  useEffect(() => { onFieldsReady(dateFields, fieldsStateForParent) }, [dateFields, fieldsStateForParent, onFieldsReady])
  useEffect(() => { onEventsReady(events, eventsStateForParent) }, [events, eventsStateForParent, onEventsReady])

  const patch = (partial: Partial<BasicsValue>) => onChange({ ...value, ...partial })

  return (
    <>
      <Card variant="form" gap="normal">
        <CardHeader size="stacked" title={<>名前とフォルダ</>} meta={<>一覧に出る名前です。友だちには見えません。</>} />
        <SettingsFormRow layout="name-folder">
          <div className={styles.field}><Field label="リマインダ名（60文字まで）" htmlFor="v8-reminder-name" required><SaveErrorField names={["name","value.name"]}><TextField
              id="v8-reminder-name"
              invalid={fieldError?.key === 'name'}
              aria-describedby={fieldError?.key === 'name' ? 'v8-reminder-name-error' : undefined}
              value={value.name}
              maxLength={60}
              placeholder="例：予約前日のご案内"
              onChange={(event) => patch({ name: event.target.value })}
            /></SaveErrorField>
{fieldError?.key === 'name' ? <p id="v8-reminder-name-error" className={styles.fieldError} role="alert">{fieldError.message}</p> : null}</Field></div>
          <div className={styles.field}>
            <Field label="フォルダ">
            <div className={styles.testRow}>
              <SaveErrorField names={["folderId","value.folderId","folder_id","value.folder_id"]}><FolderSelect
                key={selectedAccountId ?? 'no-account'}
                value={value.folderId}
                onChange={(next) => patch({ folderId: next })}
                disabled={foldersLoadState !== 'ready'}
                aria-label="フォルダ"
                size="full"
                unfiled={{ value: '', label: foldersLoadState === 'loading' ? 'フォルダを読み込み中' : foldersLoadState === 'error' ? 'フォルダを読み込めませんでした' : '未分類' }}
                folders={folders.map(folderById)}
                // 一覧の左の列の「フォルダを追加」と同じ口（リマインダのフォルダは共有）。
                onCreate={canCreateFolder
                  ? folderCreator(async (name, color) => { const result = await api.folders.create({ kind: 'reminder', name, color, accountId: selectedAccountId }); if (!folderScope.current.mounted || folderScope.current.generation !== folderGeneration) throw new Error('アカウントが切り替わりました。'); return result }, folderById, (created) => { setFolders((current) => [...current, created]); notifySaved('リマインダのフォルダを作りました。') })
                  : undefined}
              /></SaveErrorField>
              {foldersLoadState === 'error' ? (
                <Button onClick={() => setFoldersReloadToken((current) => current + 1)}>もう一度読み込む</Button>
              ) : null}
            </div>
            </Field>
          </div>
        </SettingsFormRow>
          <div className={styles.field}><Field label="社内メモ" htmlFor="v8-reminder-memo">{value.description.includes('\n') ? (
              <SaveErrorField names={["description","value.description"]}><TextArea id="v8-reminder-memo" rows={3} value={value.description}
                placeholder="運用の目的や注意点" onChange={(event) => patch({ description: event.target.value })} /></SaveErrorField>
            ) : (
              <SaveErrorField names={["description","value.description"]}><TextField id="v8-reminder-memo" value={value.description}
                placeholder="運用の目的や注意点" onChange={(event) => patch({ description: event.target.value })} /></SaveErrorField>
            )}</Field></div>
      </Card>

      <Card variant="form" gap="normal">
        <CardHeader size="stacked" title={<>基準日</>} meta={<>この日時の前や後に送ります</>} />
        <div className={styles.choiceGrid} role="radiogroup" aria-label="基準日">
          <SaveErrorField names={["reminder-v8-trigger","triggerType","value.triggerType"]}><ChoiceCardV8
            name="reminder-v8-trigger"
            value="booking"
            checked={value.triggerType === 'booking'}
            onChange={() => patch({ triggerType: 'booking' })}
            icon={<CalendarDays size={20} />}
            title="予約日時"
            note="予約・Google Meet の日時"
          /></SaveErrorField>
          <SaveErrorField names={["reminder-v8-trigger","triggerType","value.triggerType"]}><ChoiceCardV8
            name="reminder-v8-trigger"
            value="friend_field"
            checked={value.triggerType === 'friend_field'}
            onChange={() => patch({ triggerType: 'friend_field' })}
            icon={<IdCard size={20} />}
            title="友だち情報欄の日付"
            note="誕生日・契約終了日など"
          /></SaveErrorField>
          <SaveErrorField names={["reminder-v8-trigger","triggerType","value.triggerType"]}><ChoiceCardV8
            name="reminder-v8-trigger"
            value="event"
            checked={value.triggerType === 'event'}
            onChange={() => patch({ triggerType: 'event' })}
            icon={<Ticket size={20} />}
            title="イベントの予約日時"
            note="イベントの開始日時"
          /></SaveErrorField>
        </div>

        {value.triggerType === 'friend_field' ? (
          <div className={styles.field}>
            <span className={styles.label}>基準日に使う情報欄</span>
            <div className={styles.testRow}>
              <SaveErrorField names={["triggerFieldId","value.triggerFieldId","trigger_field_id","value.trigger_field_id"]}><EntitySelect
                error={fieldError?.key === 'triggerFieldId' ? fieldError.message : undefined}
                value={value.triggerFieldId}
                onChange={(next) => patch({ triggerFieldId: next })}
                disabled={fieldsLoadState !== 'ready'}
                aria-label="基準日に使う情報欄"
                size="full"
                options={[
                  { value: '', label: fieldsLoadState === 'loading' || fieldsLoadState === 'idle' ? '情報欄を読み込み中' : fieldsLoadState === 'error' ? '情報欄を読み込めませんでした' : '選んでください' },
                  ...dateFields.map((field) => ({ ...entityOptionMetadata(field), value: field.id, label: field.name })),
                ]}
              /></SaveErrorField>
              {fieldsLoadState === 'error' ? <Button onClick={() => setFieldsLoadState('idle')}>もう一度読み込む</Button> : null}
            </div>
            {fieldsLoadState === 'ready' && dateFields.length === 0 ? (
              <p className={styles.fieldNote}>このアカウントに日付型の情報欄がまだありません。友だち情報欄から追加してください。</p>
            ) : null}
            <div className={styles.field}>
              <SaveErrorField names={["repeatYearly","value.repeatYearly","repeat_yearly","value.repeat_yearly"]}><Checkbox checked={value.repeatYearly} onCheckedChange={(next) => patch({ repeatYearly: next })} aria-label="毎年くり返す">
                毎年くり返す（誕生日・契約更新日など）
              </Checkbox></SaveErrorField>
              {value.repeatYearly ? (
                <div className={styles.field}>
                  <span className={styles.label}>2月29日が基準日のとき</span>
                  <SaveErrorField names={["leapYearPolicy","value.leapYearPolicy","leap_year_policy","value.leap_year_policy"]}><Select
                    value={value.leapYearPolicy}
                    onChange={(next) => patch({ leapYearPolicy: next as BasicsValue['leapYearPolicy'] })}
                    aria-label="2月29日が基準日のとき"
                    options={[
                      { value: 'feb28', label: '2月28日に届ける' },
                      { value: 'mar1', label: '3月1日に届ける' },
                      { value: 'skip', label: 'その年は届けない' },
                    ]}
                  /></SaveErrorField>
                  <p className={styles.fieldNote}>うるう年は2月29日に届きます。平年の扱いを選んでください。</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {value.triggerType === 'event' ? (
          <div className={styles.field}>
            <span className={styles.label}>基準日にするイベント</span>
            <div className={styles.testRow}>
              <div className="min-w-0 flex-1">
                <SaveErrorField names={["triggerEventId","value.triggerEventId"]}><EntityKindField
                  kind="event"
                  label="基準日にするイベント"
                  options={events}
                  value={value.triggerEventId}
                  onChange={(next) => patch({ triggerEventId: next })}
                  disabled={eventsLoadState !== 'ready'}
                  invalid={fieldError?.key === 'triggerEventId'}
                  placeholder={eventsLoadState === 'loading' || eventsLoadState === 'idle' ? '（イベントを読み込み中）' : eventsLoadState === 'error' ? '（イベントを読み込めませんでした）' : '（選んでください）'}
                /></SaveErrorField>
                {fieldError?.key === 'triggerEventId' ? <p className={styles.fieldError} role="alert">{fieldError.message}</p> : null}
              </div>
              {eventsLoadState === 'error' ? <Button onClick={() => setEventsLoadState('idle')}>もう一度読み込む</Button> : null}
            </div>
            <p className={styles.fieldNote}>このイベントへの予約の開始日時を起点にします</p>
          </div>
        ) : null}
      </Card>

      <Card variant="form" gap="normal">
        <CardHeader size="stacked" title="ひな形から作る" optional meta={<>基準日・送るタイミング・本文がまとめて入ります</>} />
        <div className={styles.tplGrid}>
          {reminderTemplatesV8.map((template) => (
            <Card key={template.id} padding="default" layout="vertical" className={styles.templateCard}>
              <p className={styles.tplName} title={template.title}>{template.title}</p>
              <p className={styles.tplMeta} title={`${template.baseLabel}・${template.timingLabel}`}>{template.baseLabel.replace('（友だち情報欄）', '')}・{template.timingLabel}</p>
              <p className={styles.tplNote}>{template.note}</p>
              <div className={styles.tplFoot}>
                <Button
                  type="button"
                  variant="secondary"
                  size="field"
                  onClick={() => onRequestTemplate(template)}
                  disabled={appliedTemplateId === template.id}
                >
                  {appliedTemplateId === template.id ? '入れました' : 'このひな形を使う'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </Card>
    </>
  )
}
