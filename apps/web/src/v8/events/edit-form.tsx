'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { jstDate } from '@/lib/jst-datetime';
import { RowActions } from '@/components/shared/row-actions';
import { RowMenu } from '@/components/shared/row-actions';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import StickyBar from '@/components/shared/sticky-bar';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, EventSlotsPartialError, eventsApi, type EventDetail, type EventSlot, type EventSlotInput } from '@/lib/api';
import ImageUploader from '@/components/shared/image-uploader';
import OgEditor from '@/components/shared/og-editor';
import { useAccount } from '@/contexts/account-context';
import { BULK_SLOT_LIMIT, generateBulkSlots, type BulkSlotInput } from '@/components/events/bulk-slot-generator';
import { splitBand } from '@/components/events/jst';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import Dialog from '@/components/shared/dialog';
import Button from '@/components/shared/button';
import CopyTextButton from '@/components/shared/copy-text-button';
import SelectionButton from '@/components/shared/selection-button';
import { X } from 'lucide-react';
import Notice from '@/components/shared/notice';
import { notifyToast } from '@/components/shared/toast';
import Select from '@/components/shared/select';
import { Field, TextInput } from '@/components/shared/form-controls';
import EventQuestionsEditor from '@/components/events/event-questions-editor';
import DateField from '@/components/shared/date-field';
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { TimeField } from '@/components/shared/date-time-field';
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import { MenuPaymentCard, PaymentConflictError, useMenuPayment } from '@/v8/booking-payments/public/menu-payment/index'
import FormSection from '@/components/shared/form-section';
import ListState from '@/components/shared/list-state';
import { Tabs } from '@/components/shared/tabs';
import { TextArea } from '@/components/shared/text-field';
import { EVENT_CANCEL_DEADLINE_OPTIONS, EVENT_DEFAULT_DRAFT, EVENT_DESCRIPTION_MAX_LENGTH, EVENT_ENTRY_CUTOFF_OPTIONS, EVENT_NAME_MAX_LENGTH, deadlineOptionsWithSaved, deadlineSelectValue, parseDeadlineSelect } from '@/components/events/event-draft-shared';
import { eventOperationAccounts } from '@/components/events/event-draft-shared';

import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import { AddSlotDialog, EditSlotDialog } from "./edit-form-gap-parts"
// #740: 下書きの初期値と字数上限は作成画面と共有する。片方だけ変えないこと。

import { formatJpDateTime, formatJpSlotRange, toEventDraft } from './edit-format'
import { formatNumber } from '@/lib/format'
import { ToggleField } from '@/components/shared/toggle'
import { MakeupRuleSection } from './makeup-rule-section'
export { formatJpDateTime, formatJpSlotRange, toEventDraft } from './edit-format'

type Tab = 'overview' | 'slots' | 'publish'

const TABS: Array<{ key: Tab; label: string; saveLabel: string }> = [
  { key: 'overview', label: '1. 概要', saveLabel: '概要を保存する' },
  { key: 'slots', label: '2. 予約枠', saveLabel: '' },
  { key: 'publish', label: '3. 公開設定', saveLabel: '公開設定を保存する' },
]

const DEFAULT_DRAFT: EventDetail = EVENT_DEFAULT_DRAFT
const APPROVAL_DEADLINE_OPTIONS = [
  { value: '2', label: '申込から2時間' },
  { value: '24', label: '申込から24時間' },
  { value: '72', label: '申込から72時間' },
]

export interface EventFormProps {
  accountId: string
  eventId: string | null
}

export default function EventForm({ accountId, eventId }: EventFormProps) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { selectedAccount, accounts } = useAccount()
  const [tab, setTab] = useState<Tab>('overview')
  const [draft, setDraft] = useState<EventDetail>(DEFAULT_DRAFT)
  /* 保存済みの写し。draft との差が「書きかけ」。枠タブの操作は
     その場でサーバへ送る即時型なので番兵の対象外。 */
  const [savedDraft, setSavedDraft] = useState<EventDetail>(DEFAULT_DRAFT)
  const [slots, setSlots] = useState<EventSlot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const role = useStaffRole()
  const canDuplicate = role === null || canManageRole(role)
  const [loading, setLoading] = useState(true)

  /* クラスのお支払い（ 追記 3・絵 XFRyO）。保存は「概要を保存する」と一緒。 */
  const eventPayment = useMenuPayment('event', accountId, eventId)
  /* 下の帯の左端に［削除する］（絵 XFRyO）。権限と断りの文は一覧の削除と同じ。 */
  const canDelete = canManageRole(role)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  async function removeEvent() {
    if (!eventId || deleteBusy) return
    setDeleteBusy(true); setDeleteError('')
    try {
      await eventsApi.deleteEvent(accountId, eventId)
      setDeleteOpen(false)
      notifyToast('イベントを削除しました')
      router.push('/events')
    } catch (cause) {
      setDeleteError(cause instanceof ApiError && (cause.code === 'event_has_active_bookings' || cause.status === 409)
        ? '申込中・確定済みの予約、またはキャンセル待ちの人がいるため削除できません。先に申込者への対応を終えてください。'
        : '削除できませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      setDeleteBusy(false)
    }
  }
  const [makeupEditState, setMakeupEditState] = useState({ dirty: false, busy: false })
  const dirty = makeupEditState.dirty || eventPayment.dirty || JSON.stringify(draft) !== JSON.stringify(savedDraft)
  const { leaveTarget, confirmLeave, cancelLeave, guarded } = useUnsavedGuard({ dirty, busy: saving || duplicating || makeupEditState.busy })

  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  async function duplicateSaved() {
    if (!eventId || !canDuplicate || saving || duplicating || loading) return
    const expectedVersion = savedDraft.version
    if (typeof expectedVersion !== 'number') { setError('保存済みの版を読み直してから複製してください。'); return }
    setDuplicating(true); setError(null)
    try {
      const response = await eventsApi.duplicate(accountId, eventId, expectedVersion)
      notifyToast('複製した下書きを追加しました')
      router.push(`/events?highlight=${encodeURIComponent(response.id)}`)
    } catch (caught) {
      saveErrors.capture(caught)
      setError(caught instanceof ApiError && caught.status === 409
        ? '別の人が変更しました。読み直してから複製してください。' : '複製できませんでした。もう一度お試しください。')
    } finally { setDuplicating(false) }
  }

  const liffId = selectedAccount?.liffId ?? null
  // single mode の公開 URL。Worker `/o` は ref 解決・追跡なしで liffId を直接
  // 受けるため、LINE 内配信も SNS 配信もこの 1 本で完結する。`liff.line.me`
  // 直貼りは OpenChat / IG DM 等で削除されるが、`/o` 経由なら通る。
  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const liffUrl = eventId && liffId && workerBase
    ? `${workerBase}/o?liffId=${encodeURIComponent(liffId)}&page=event&id=${encodeURIComponent(eventId)}`
    : null

  // 公開対象のプルダウンに出すタグ。新規作成のときも要るので、
  // イベントの読み込みとは分けて取る。
  // R23横展開: 候補はこのイベントのアカウントだけ。切替で取り直す。
  useEffect(() => {
    let cancelled = false
    void api.tags
      .list(accountId ? { accountId } : undefined)
      .then((res) => {
        if (!cancelled && res.success) setTags(res.data.map((t) => ({ id: t.id, name: t.name })))
      })
      .catch(() => {
        // タグが取れなくてもフォームは使える。公開対象が「友だち全員」だけになる。
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!eventId) {
        setLoading(false)
        return
      }
      try {
        const [ev, slotsRes] = await Promise.all([
          eventsApi.getEvent(accountId, eventId),
          eventsApi.listSlots(accountId, eventId),
        ])
        if (cancelled) return
        // Worker は質問定義を questions_json の文字列で返す。フォームは
        // 配列で触るので、ここでほぐしてから draft に載せる。
        // 読み直しは書きかけの起点にもなるので写しも揃える。
        setDraft(toEventDraft(ev))
        setSavedDraft(toEventDraft(ev))
        setSlots(slotsRes.items)
      } catch (e) {
        // 生の `API error: 404` を主文にしない。消えたものと通信の失敗を言い分ける。
        if (!cancelled) {
          setError(e instanceof ApiError && e.status === 404
            ? 'このイベントは見つかりません。削除されたか、リンクが古くなっています。一覧から選び直してください。'
            : 'イベントを読み込めませんでした。通信の状態を確認して、もう一度読み込んでください。')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [accountId, eventId])

  function update<K extends keyof EventDetail>(key: K, value: EventDetail[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      if (!draft.name.trim()) throw new Error('イベント名は必須です')
      if (draft.name.length > EVENT_NAME_MAX_LENGTH) throw new Error('イベント名は255字以内で入力してください')
      if (draft.description && draft.description.length > EVENT_DESCRIPTION_MAX_LENGTH) {
        throw new Error('詳細は20000字以内で入力してください')
      }
      const targetType = draft.target_type ?? 'single'
      let accountIdsArr: string[] = Array.isArray(draft.account_ids)
        ? draft.account_ids
        : typeof draft.account_ids === 'string'
          ? (() => { try { return JSON.parse(draft.account_ids) as string[] } catch { return [] } })()
          : []
      // 現在ログイン中のアカウントは常に含める。保存後 redirect 先 (この
      // accountId scope) で 404 にならないための保証。チェックボックス側でも
      // 外せないが、stale draft 等の保険として save 時にも強制注入する。
      if (targetType === 'multi-account-dedup' && accountId && !accountIdsArr.includes(accountId)) {
        accountIdsArr = [accountId, ...accountIdsArr]
      }
      if (targetType === 'multi-account-dedup' && accountIdsArr.length === 0) {
        throw new Error('複数アカウント横断の場合は対象アカウントを 1 件以上選んでください')
      }
      const payload: Partial<EventDetail> = {
        name: draft.name,
        venue_name: draft.venue_name,
        venue_address: draft.venue_address,
        venue_url: draft.venue_url,
        image_url: draft.image_url,
        description: draft.description,
        description_centered: draft.description_centered,
        max_bookings_per_friend: draft.max_bookings_per_friend,
        requires_approval: draft.requires_approval,
        approval_deadline_hours: draft.approval_deadline_hours,
        cancel_deadline_hours_before: draft.cancel_deadline_hours_before,
        reminder_day_before_enabled: draft.reminder_day_before_enabled,
        reminder_hours_before: draft.reminder_hours_before,
        is_published: draft.is_published,
        sort_order: draft.sort_order,
        confirmation_message_extra: draft.confirmation_message_extra,
        reminder_message_extra: draft.reminder_message_extra,
        og_title: draft.og_title,
        og_description: draft.og_description,
        og_image_url: draft.og_image_url,
        visible_tag_id: draft.visible_tag_id ?? null,
        waitlist_enabled: draft.waitlist_enabled ?? 0,
        entry_cutoff_hours_before: draft.entry_cutoff_hours_before ?? null,
        target_type: targetType,
        // Worker は account_ids を配列で受け取って内部で JSON.stringify するので、
        // ここでは配列のまま送る (Partial<EventDetail> の union 型を許容)
        account_ids: targetType === 'multi-account-dedup'
          ? (accountIdsArr as unknown as EventDetail['account_ids'])
          : null,
        // 申込時の質問 (#841)。配列のまま送り、Worker が questions_json に
        // 正規化して保存する。null を送ると定義ごと消える。
        questions: draft.questions ?? null,
      }
      if (eventId) {
        const updated = await eventsApi.updateEvent(accountId, eventId, payload, draft.version ?? 1)
        // 応答は questions_json の文字列で返る。ほぐさず載せると次の保存で
        // questions:null を送り、質問を消してしまう（R82）。
        // 保存後は書きかけを解くので写しも揃える。
        setDraft(toEventDraft(updated))
        setSavedDraft(toEventDraft(updated))
        /* お支払い・1回の値段は中身を保存したあとに書く（409 は比べる窓。中身の保存は済んでいる）。 */
        await eventPayment.save(eventId)
        notifyToast('保存しました')
      } else {
        const created = await eventsApi.createEvent(accountId, payload)
        notifyToast('イベントを作成しました。続けて予約枠を追加してください。')
        router.replace(`/events/edit?id=${created.id}`)
      }
    } catch (e) {
      /* お支払い・1回の値段の版が古い（409）ときは、共通の帯と比べる窓（お支払いの段）で選んでもらう。 */
      if (e instanceof PaymentConflictError) return
      saveErrors.capture(e)
      setError(
        e instanceof ApiError && e.status === 409 && e.code === 'version_conflict'
          ? '別の画面でイベントが更新されました。開き直してからもう一度保存してください。'
          : describeApiFailure(e, '保存'),
      )
    } finally {
      setSaving(false)
    }
  }

  const reservationUrls = eventId && savedDraft.is_published === 1 ? (() => {
      const targetType = savedDraft.target_type ?? 'single'
      const accountIdsArr: string[] = Array.isArray(savedDraft.account_ids)
        ? savedDraft.account_ids
        : typeof savedDraft.account_ids === 'string'
          ? (() => { try { return JSON.parse(savedDraft.account_ids) as string[] } catch { return [] } })()
          : []
      if (targetType === 'multi-account-dedup') {
        const templateUrl = `https://liff.line.me/{{liff_id}}/?page=event&id=${eventId}&liffId={{liff_id}}`
        const targetAccounts = accounts.filter((account) => accountIdsArr.includes(account.id))
        return <>
          <Field label="broadcast 用テンプレ URL" help="{{liff_id}} は配信時に各友だちのアカウントに対応した値に置換されます。" note="broadcast 編集で「リンクするイベント」から選ぶと自動挿入。">
            <TextInput readOnly value={templateUrl} onFocus={(event) => event.currentTarget.select()} />
            <CopyTextButton value={templateUrl} aria-label="配信用 URL をコピー" variant="secondary" />
          </Field>
          {targetAccounts.length === 0 ? <Notice tone="warn" message="対象アカウントが選ばれていません" /> : null}
          {targetAccounts.map((account) => {
            const acct = account as unknown as { liffId?: string | null; name: string; country: string | null }
            const name = `${acct.country ? acct.country + ' ' : ''}${acct.name}`
            if (!acct.liffId) return <Notice key={account.id} tone="warn" action={canManageRole(role) ? <Button variant="text" size="inline" href={`/accounts/detail?id=${encodeURIComponent(account.id)}`}>アカウント設定へ →</Button> : undefined} message={`${name}: LIFF ID 未設定`} />
            const url = `https://liff.line.me/${acct.liffId}/?page=event&id=${eventId}&liffId=${acct.liffId}`
            return <Field key={account.id} label={`${name}の固定 URL（QR・LP 直貼り用）`}>
              <TextInput readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
              <CopyTextButton value={url} aria-label={`${name}の URL をコピー`} variant="secondary" />
            </Field>
          })}
        </>
      }
      if (liffUrl) return <>
        <Field label="予約 URL"><TextInput readOnly value={liffUrl} onFocus={(event) => event.currentTarget.select()} />
          <CopyTextButton value={liffUrl} aria-label="予約 URL をコピー" variant="secondary" />
        </Field>
      </>
      return <Field label="予約 URL"><Notice tone="warn" action={canManageRole(role) ? <Button variant="text" size="inline" href={`/accounts/detail?id=${encodeURIComponent(accountId)}`}>アカウント設定へ →</Button> : undefined} message="LIFF ID が未設定のため予約 URL を生成できません。LINE アカウント設定で LIFF ID を登録してください。" /></Field>
  })() : <Field label="予約 URL"><p>公開して保存すると、ここに URL が出ます</p></Field>


  if (loading) return <ListState kind="loading" title="読み込んでいます…" />

  return <SaveErrorScope errors={saveErrors}><>
    <FormSection id="ev-form-record" title={eventId ? draft.name || 'イベント編集' : '新規イベント作成'}
      description={eventId ? 'タブで各項目を編集できます' : 'まず「概要」を保存するとイベントが作成されます'}
      action={<>
        {!eventId ? <Button href="/events">イベント一覧</Button> : null}
        {eventId && canDuplicate ? <RowMenu label="イベントの操作" triggerProps={{ disabled: saving || duplicating }} items={[{ id: 'duplicate', label: '複製する', onSelect: () => guarded(() => void duplicateSaved()) }]} /> : null}
        {eventId ? <Button href={`/events/bookings?id=${eventId}`}>予約を確認</Button> : null}
      </>}>{null}</FormSection>
    {error ? <Notice tone="danger" message={error} /> : null}
    <Tabs label="イベントの編集" items={TABS.map((item) => ({
      label: item.label, current: tab === item.key, disabled: item.key !== 'overview' && !eventId,
      onClick: () => { if (item.key === 'overview' || eventId) setTab(item.key) },
    }))} />
    {tab === 'overview' ? <OverviewTab draft={draft} update={update} accounts={accounts} currentAccountId={accountId}
      afterBasics={eventId ? <><MenuPaymentCard state={eventPayment} name="event" price={null} priceField unit="名" />
        <MakeupRuleSection onEditState={setMakeupEditState} accountId={accountId} event={draft} busy={saving || duplicating} onSaved={(rule, revision, previousRevision) => {
          const updateRule = (value: EventDetail) => ({ ...value, makeup_rule_json: JSON.stringify(rule), version: value.version === previousRevision ? revision : value.version })
          setDraft(updateRule)
          setSavedDraft(updateRule)
          if (draft.version !== previousRevision) setError('振替の決まりは保存しました。クラスの概要はほかの人が更新しています。概要の入力を控えて開き直してから保存してください。')
        }} />
      </> : null} /> : null}
    {tab === 'slots' ? <SlotsTab accountId={accountId} eventId={eventId} slots={slots} setSlots={setSlots} operationAccounts={eventOperationAccounts(savedDraft, accountId)} /> : null}
    {tab === 'publish' ? <PublishTab draft={draft} update={update} tags={tags} reservationUrls={reservationUrls} /> : null}
    {tab !== 'slots' ? <StickyBar destructive={tab === 'overview' && eventId && canDelete ? <Button variant="text" textTone="danger" onClick={() => { setDeleteError(''); setDeleteOpen(true) }} disabled={saving}>削除する</Button> : undefined} status={tab === 'overview'
      /* 変更のときは左端に［削除する］が入り幅が足りないので、説明の文は出さない（ボタンの名前で分かる）。 */
      ? eventId ? undefined : '保存するとイベントが作成され、予約枠タブに進みます'
      : undefined} actions={<>
        <Button variant="primary" onClick={() => save()} disabled={saving} busy={saving} busyLabel="保存中…">
          {tab === 'overview' && !eventId ? 'イベントを作る' : TABS.find((item) => item.key === tab)?.saveLabel ?? '保存する'}
        </Button>
      </>} /> : null}
 <ConfirmDialog open={deleteOpen} title={`「${draft.name || 'このイベント'}」を削除しますか？`} description="削除すると元に戻せません。申込中・確定済みの予約やキャンセル待ちがあるときは削除できません。"
      confirmLabel="削除する" destructive busy={deleteBusy} error={deleteError || undefined} onCancel={() => { if (!deleteBusy) setDeleteOpen(false) }} onConfirm={() => void removeEvent()}><OperationTargetSummary showAccountCount accounts={eventOperationAccounts(savedDraft, accountId)} /></ConfirmDialog>
    <UnsavedLeaveDialog open={leaveTarget !== null} subject="イベントへの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
  </></SaveErrorScope>
}

// ----------------------------------------------------------------
// Tab 1: Overview
// ----------------------------------------------------------------

function OverviewTab({
  draft,
  update,
  accounts,
  currentAccountId,
  afterBasics,
}: {
  draft: EventDetail
  update: <K extends keyof EventDetail>(k: K, v: EventDetail[K]) => void
  accounts: Array<{ id: string; name: string; country: string | null; isActive: boolean }>
  currentAccountId: string
  /** 絵 XFRyO：「基本」のすぐ下に置く段（お支払い）。 */
  afterBasics?: React.ReactNode
}) {
  const descLen = (draft.description ?? '').length
  /* 保存前に欄を離れたとき出す直し方（文は保存時と同じ）。 */
  const [nameError, setNameError] = useState<string | null>(null)
  function checkName(value: string): string | null {
    if (!value.trim()) return 'イベント名は必須です'
    if (value.length > EVENT_NAME_MAX_LENGTH) return 'イベント名は255字以内で入力してください'
    return null
  }
  const targetType = draft.target_type ?? 'single'
  const accountIds: string[] = Array.isArray(draft.account_ids)
    ? draft.account_ids
    : typeof draft.account_ids === 'string'
      ? (() => { try { return JSON.parse(draft.account_ids) as string[] } catch { return [] } })()
      : []
  const activeAccounts = accounts.filter((a) => a.isActive)
  return (
    <>
      <FormSection id="ev-form-overview" title="基本">
      <Field label="イベント名" required error={nameError}>
        <SaveErrorField names={["name"]}><TextInput
          type="text"
          value={draft.name}
          onChange={(e) => {
            update('name', e.target.value)
            if (nameError !== null) setNameError(checkName(e.target.value))
          }}
          onBlur={() => setNameError(checkName(draft.name))}
          maxLength={EVENT_NAME_MAX_LENGTH}
          placeholder="例: 第1回 AAA 説明会"
        /></SaveErrorField>
      </Field>
        <Field label="開催場所">
          <SaveErrorField names={["venue_name"]}><TextInput
            type="text"
            value={draft.venue_name ?? ''}
            onChange={(e) => update('venue_name', e.target.value || null)}
            placeholder="例: 渋谷ベース 3F"
          /></SaveErrorField>
        </Field>
        <Field label="会場 URL">
          <SaveErrorField names={["venue_url"]}><TextInput
            type="url"
            value={draft.venue_url ?? ''}
            onChange={(e) => update('venue_url', e.target.value || null)}
            placeholder="https://..."
          /></SaveErrorField>
        </Field>
      <Field label="会場の住所"><SaveErrorField names={["venue_address"]}><TextInput value={draft.venue_address ?? ''} maxLength={1000} onChange={(e) => update('venue_address', e.target.value || null)} /></SaveErrorField></Field>
        <ImageUploader
          mode="url"
          value={draft.image_url ? { mode: 'url', url: draft.image_url } : null}
          onChange={(v) => update('image_url', v?.mode === 'url' ? v.url : null)}
          label="イベント画像"
          title="イベント画像を追加"
        />
      <Field label="イベント詳細" count={{ value: descLen, max: EVENT_DESCRIPTION_MAX_LENGTH }}>
        <SaveErrorField names={["description"]}><TextArea
          value={draft.description ?? ''}
          onChange={(e) => update('description', e.target.value || null)}
          rows={8}
          placeholder="開催趣旨、注意事項、持ち物などを記載…"
        /></SaveErrorField>
      </Field>
        <ToggleField
          checked={draft.description_centered === 1}
          onChange={(checked) => update('description_centered', checked ? 1 : 0)}
        >
          詳細を中央揃えで表示
        </ToggleField>
      </FormSection>
      {afterBasics}
      <FormSection id="ev-form-questions" title="申し込みのときに聞くこと" description="予約フォームに質問を追加できます。回答は申込の一覧で確認できます。">
        <EventQuestionsEditor
          questions={draft.questions ?? []}
          onChange={(next) => update('questions', next)}
        />
      </FormSection>

      <FormSection id="ev-form-target" title="公開対象">
      <Field label="1 人あたり予約回数">
        <SaveErrorField names={["max_bookings_per_friend"]}><Select
          aria-label="1 人あたり予約回数"
          value={draft.max_bookings_per_friend == null ? 'unlimited' : String(draft.max_bookings_per_friend)}
          onChange={(value) =>
            update(
              'max_bookings_per_friend',
              value === 'unlimited' ? null : Number(value),
            )
          }
          options={[
            { value: 'unlimited', label: '制限なし' },
            { value: '1', label: '1 回まで' },
            { value: '2', label: '2 回まで' },
            { value: '3', label: '3 回まで' },
            { value: '5', label: '5 回まで' },
          ]}
        /></SaveErrorField>
      </Field>

        <RadioCardGroup legend="公開するアカウント">
          <RadioCard name="event-target-type" value="single" checked={targetType === 'single'} onChange={() => update('target_type', 'single')} title="単一アカウント" note="1 つの LINE アカウントで運用" />
          <RadioCard name="event-target-type" value="multi-account-dedup" checked={targetType === 'multi-account-dedup'} title="複数アカウント横断" note="重複なし配信に対応"
            onChange={() => {
              update('target_type', 'multi-account-dedup')
              // single → multi 切替時: 編集中の admin account を account_ids[0]
              // sentinel として自動セット。active 一覧の先頭ではなく実際に
              // 編集している admin の account にしないと、保存後にその admin
              // が自分のイベントを見られなくなる (404)。
              if (accountIds.length === 0) {
                const seed = currentAccountId || activeAccounts[0]?.id || ''
                if (seed) {
                  update('account_ids', [seed] as unknown as EventDetail['account_ids'])
                }
              }
            }}
          />
        </RadioCardGroup>

        {targetType === 'multi-account-dedup' && (
          <Field label="対象アカウント（重複なし配信）" note={`${formatNumber(accountIds.length)} 件選択中`}>
            {activeAccounts.length === 0 && (
              <Notice tone="info" message="アクティブなアカウントがありません" />
            )}
            <EntitySelect aria-label="対象アカウント（重複なし配信）" noun="アカウント" values={[...new Set([...accountIds, ...(currentAccountId ? [currentAccountId] : [])])]} onChange={(ids) => update('account_ids', [...new Set([...ids, ...(currentAccountId ? [currentAccountId] : [])])] as unknown as EventDetail['account_ids'])} options={activeAccounts.map((a) => ({ value: a.id, label: `${a.country ? a.country + ' ' : ''}${a.name}`, locked: a.id === currentAccountId, description: a.id === currentAccountId ? '今のアカウント・必須' : undefined }))} />
          </Field>
        )}
      </FormSection>
    </>
  )
}

// ----------------------------------------------------------------
// Tab 2: Slots
// ----------------------------------------------------------------

/** 予約枠の一覧（試験から直接描けるよう名前付きで出す）。 */
export function SlotsTab({
  accountId,
  eventId,
  slots,
  setSlots,
  operationAccounts,
}: {
  accountId: string
  eventId: string | null
  slots: EventSlot[]
  setSlots: (s: EventSlot[]) => void
  operationAccounts?: Array<{ id: string }>
}) {
  const saveErrors = useSaveFormErrors()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  /*
    確認は設計の窓で出す。**ブラウザの `confirm` を使わない。**
    何件できるのか・何が消えるのかを本文で読ませられず、画像比較にも写らない。
  */
  const [deleteSlotTarget, setDeleteSlotTarget] = useState<EventSlot | null>(null)
  const [deletingSlot, setDeletingSlot] = useState(false)
  const [deleteSlotError, setDeleteSlotError] = useState('')
  /*
    入口29: 既存の枠の日時・定員を直す窓。口（PUT /slots/:slotId）は
    もうあるので、画面には入口と入力窓だけを足す。予約が入っている枠は
    定員を今の予約数より下げられない（口側の409と同じ決めごと）。
  */
  const [editSlotTarget, setEditSlotTarget] = useState<EventSlot | null>(null)
  /*
    まとめて作る枠の下見。作る前に件数と最初・最後を読ませる。
    #1000 DETAIL-11: 下見の時点で操作IDと枠ごとの再送防止キー
    (client_key)を確定し、失敗後は残りだけを同じキーで再送する。
    bulkDone はこの下見のうち作成が確認できた件数。
  */
  const [bulkPreview, setBulkPreview] = useState<
    { operationId: string; slots: Array<EventSlotInput & { client_key: string }> } | null
  >(null)
  const [bulkDone, setBulkDone] = useState(0)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState('')

  if (!eventId) {
    return (
      <ListState kind="empty" title="まず「概要」タブで保存してから予約枠を追加してください。" />
    )
  }

  async function refresh() {
    if (!eventId) return
    const res = await eventsApi.listSlots(accountId, eventId)
    setSlots(res.items)
  }

  /*
    予約が入っている枠は、そもそもボタンを押せないようにしてある
    （`disabled={busy || (s.active_count ?? 0) > 0}`）。ここまで来るのは
    予約が0件の枠だけ。サーバー側でも同じ判定をしているので、行き違いで
    断られたときは窓の中に運用者の言葉で出す。
  */
  async function deleteSlot() {
    if (!deleteSlotTarget || !eventId || deletingSlot) return
    setDeletingSlot(true)
    setDeleteSlotError('')
    setErr(null)
    try {
      await eventsApi.deleteSlot(accountId, eventId, deleteSlotTarget.id)
      setDeleteSlotTarget(null)
      await refresh()
    } catch {
      setDeleteSlotError('枠を削除できませんでした。あとから予約が入った可能性があります。読み直してから、もう一度お試しください。')
    } finally {
      setDeletingSlot(false)
    }
  }

  async function createBulkSlots() {
    if (!bulkPreview || !eventId || bulkBusy) return
    setBulkBusy(true)
    setBulkError('')
    try {
      /*
        確定済みの分は送り直さない(DETAIL-11)。残りは同じ client_key を
        持つので、応答喪失で画面の件数と実際がずれていても
        サーバー側が既存枠へ解決し、総数は増えない。
      */
      const remaining = bulkPreview.slots.slice(bulkDone)
      if (remaining.length === 0) {
        setBulkPreview(null)
        setBulkDone(0)
        await refresh()
        setShowBulk(false)
        return
      }
      await eventsApi.createSlots(accountId, eventId, remaining)
      setBulkPreview(null)
      setBulkDone(0)
      await refresh()
      setShowBulk(false)
    } catch (e) {
      saveErrors.capture(e)
      // 400件ずつ送るので、途中で切れると一部だけ作られたまま残る。
      // 作成が確認できた件数を数え、残りだけを次の送信対象にする。
      const completed = e instanceof EventSlotsPartialError ? e.completed.length : 0
      const done = bulkDone + completed
      setBulkDone(done)
      setBulkError(
        done > 0
          ? `${done}件は追加済みです。残り${bulkPreview.slots.length - done}件は、もう一度「まとめて作る」を押すと続きから再開します。`
          : '枠を作りきれませんでした。途中まで作られていることがあります。一覧を読み直して、足りない分だけ追加してください。',
      )
      await refresh()
    } finally {
      setBulkBusy(false)
    }
  }

  /*
    m26g R577: 枠の切替・編集は期待版つきで送る。古い画面からの操作は
    409 になり、敗者側は一覧を読み直して最新の差分を見せる。
  */
  function slotConflictMessage(e: ApiError): string {
    const current = (e.data as { current?: EventSlot } | undefined)?.current
    const detail = current
      ? `最新の枠は定員${current.capacity ?? '無制限'}・${current.is_active === 1 ? '有効' : '停止'}です。`
      : ''
    return `ほかの画面でこの枠が更新されました。一覧を読み直しました。${detail}最新の内容を確認してから、もう一度お試しください。`
  }

  async function updateSlotWithConflictRefresh(
    slot: EventSlot,
    body: Partial<EventSlot>,
  ): Promise<void> {
    if (!eventId) return
    try {
      await eventsApi.updateSlot(accountId, eventId, slot.id, body, slot.version ?? 1)
    } catch (e) {
      saveErrors.capture(e)
      if (e instanceof ApiError && e.status === 409 && e.code === 'version_conflict') {
        await refresh()
        throw new ApiError(409, slotConflictMessage(e), e.code, e.data)
      }
      throw e
    }
  }

  async function toggleActive(s: EventSlot) {
    if (!eventId) return
    setBusy(true)
    setErr(null)
    try {
      await updateSlotWithConflictRefresh(s, { is_active: s.is_active === 1 ? 0 : 1 })
      await refresh()
    } catch (e) {
      setErr(describeApiFailure(e, '保存'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><FormSection id="ev-form-slots" title="予約枠" description={`${formatNumber(slots.length)} 件の予約枠`} action={<>
          <Button onClick={() => setShowAdd(true)}>
            ＋ 枠を追加する
          </Button>
          <Button onClick={() => setShowBulk(true)}>
            一括追加する
          </Button>
        </>}>
      {err ? <Notice tone="danger" message={err} /> : null}
      {slots.length === 0 ? (
        <ListState kind="empty" title="予約枠がありません。" description="「＋ 枠を追加」または「一括追加」から作成してください。" />
      ) : (
        <DataTable>
            <thead>
              <TableHeadRow>
                <Th style={{ width: '30%' }}>日時</Th>
                <Th style={{ width: '14%' }}>定員</Th>
                <Th style={{ width: '14%' }}>予約数</Th>
                <Th style={{ width: '16%' }}>状態</Th>
                <Th style={{ width: '26%' }} align="right">操作</Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {slots.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    {formatJpSlotRange(s.starts_at, s.ends_at)}
                  </Td>
                  <Td>{s.capacity ?? '無制限'}</Td>
                  <Td>{s.active_count ?? 0}</Td>
                  <Td>
                    <Button
                      onClick={() => toggleActive(s)}
                      disabled={busy}
                    >
                      {s.is_active === 1 ? '有効' : '停止'}
                    </Button>
                  </Td>
                  <ActionCell>
                      {/* 行の右は「…」に1つ。削除は区切りの下・赤で最後（持ち主 RowActions が決める）。 */}
                      <RowActions
                        edit={{ onClick: () => setEditSlotTarget(s), disabled: busy }}
                        destructiveItem={{
                          id: 'delete-slot', label: '削除する',
                          disabled: busy || (s.active_count ?? 0) > 0,
                          disabledReason: (s.active_count ?? 0) > 0 ? '既存予約があるため削除できません' : busy ? '処理を反映しています' : undefined,
                          onSelect: () => { setDeleteSlotError(''); setDeleteSlotTarget(s) },
                        }}
                        subjectName={formatJpSlotRange(s.starts_at, s.ends_at)}
                      />
                  </ActionCell>
                </Tr>
              ))}
            </tbody>
        </DataTable>
      )}

      {showAdd && (
        <AddSlotDialog
          onClose={() => setShowAdd(false)}
          onSubmit={async (s) => {
            await eventsApi.createSlots(accountId, eventId, [s])
            await refresh()
            setShowAdd(false)
          }}
        />
      )}
      {editSlotTarget && (
        <EditSlotDialog
          slot={editSlotTarget}
          onClose={() => setEditSlotTarget(null)}
          onSubmit={async (next) => {
            await updateSlotWithConflictRefresh(editSlotTarget, next)
            await refresh()
            setEditSlotTarget(null)
          }}
        />
      )}
      {showBulk && (
        <BulkSlotDialog
          onClose={() => setShowBulk(false)}
          onSubmit={async (input) => {
            /*
              作る前に**下見を出す**。件数が0でも `alert` は使わず、
              同じ窓で理由を読ませて、作るボタンを出さない。
              生成は501件目で打ち切られる(DETAIL-12)。上限超過は
              例外として投げ、入力窓の中で理由を読ませる。
            */
            const generated = generateBulkSlots(input)
            if (generated.length > BULK_SLOT_LIMIT) {
              throw new Error('500件を超える一括作成はできません。期間や曜日を分けて追加してください')
            }
            const operationId = crypto.randomUUID()
            setBulkError('')
            setBulkDone(0)
            setBulkPreview({
              operationId,
              slots: generated.map((slot, index) => ({
                ...slot,
                client_key: `${operationId}:${index}`,
              })),
            })
          }}
        />
      )}

      <ConfirmDialog
        open={deleteSlotTarget !== null}
        title="この予約枠を削除しますか？"
        description={`${deleteSlotTarget ? formatJpDateTime(deleteSlotTarget.starts_at) : ''}の枠を削除します。この枠はもう予約できなくなります。いま予約は入っていません。ほかの枠とイベント本体、これまでの予約の記録は残ります。この操作は元に戻せません。`}
        confirmLabel="削除する"
        destructive
        busy={deletingSlot}
        error={deleteSlotError}
        onConfirm={deleteSlot}
        onCancel={() => {
          if (deletingSlot) return
          setDeleteSlotError('')
          setDeleteSlotTarget(null)
        }}
      ><OperationTargetSummary showAccountCount accounts={operationAccounts ?? [{ id: '' }]} /></ConfirmDialog>

      <ConfirmDialog
        open={bulkPreview !== null}
        title={bulkPreview && bulkPreview.slots.length === 0
          ? '作られる枠が0件です'
          : bulkDone > 0
            ? `残り${(bulkPreview?.slots.length ?? 0) - bulkDone}件の予約枠を作りますか？`
            : `${bulkPreview?.slots.length ?? 0}件の予約枠を作りますか？`}
        description={bulkPreview && bulkPreview.slots.length === 0
          ? '入れた条件では枠が1つも作られません。期間・曜日・時間帯を見直してから、もう一度お試しください。まだ何も作っていません。'
          : `${bulkPreview && bulkPreview.slots.length > 0 ? formatJpDateTime(bulkPreview.slots[0].starts_at) : ''}から${bulkPreview && bulkPreview.slots.length > 0 ? formatJpDateTime(bulkPreview.slots[bulkPreview.slots.length - 1].starts_at) : ''}までの枠をまとめて作ります。いまある枠は消えません。作った枠は1件ずつ削除できます（予約が入ったあとは削除できません）。${bulkDone > 0 ? `${bulkDone}件は追加済みで、再送しても二重にはなりません。` : ''}`}
        confirmLabel="まとめて作る"
        cancelLabel={bulkPreview && bulkPreview.slots.length === 0 ? '条件を直す' : 'キャンセル'}
        busy={bulkBusy}
        error={bulkError}
        onConfirm={bulkPreview && bulkPreview.slots.length > 0 ? createBulkSlots : undefined}
        onCancel={() => {
          if (bulkBusy) return
          setBulkError('')
          setBulkDone(0)
          setBulkPreview(null)
        }}
      ><OperationTargetSummary showAccountCount accounts={operationAccounts ?? [{ id: '' }]} /></ConfirmDialog>
    </FormSection></SaveErrorScope>
  )
}


/*
 * R84: 予約枠の一括追加の窓は共通 Dialog を使う。
 * 以前は手作りの fixed  overlay で、入力欄が増えると窓が画面より高くなり、
 * 閉じる・生成・キャンセルが画面外へ出た。Escape でも閉じなかった。
 * 共通 Dialog は overlay のスクロール・Escape・フォーカス閉じ込めを持つ。
 */
export function BulkSlotDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (input: BulkSlotInput) => Promise<void>
}) {
  const saveErrors = useSaveFormErrors()
  const todayJst = jstDate()
  const [start, setStart] = useState(todayJst)
  const [end, setEnd] = useState(todayJst)
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [patterns, setPatterns] = useState([{ start: '10:00', end: '11:00' }])
  const [divideBand, setDivideBand] = useState(false)
  const [bandStart, setBandStart] = useState('14:00')
  const [bandEnd, setBandEnd] = useState('17:00')
  const [slotMinutes, setSlotMinutes] = useState(90)
  const [capacity, setCapacity] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toggleWeekday(d: number) {
    setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]))
  }

  const submitLock = useRef(false)

  async function submit() {
    if (submitLock.current) return
    submitLock.current = true
    setBusy(true)
    setErr(null)
    try {
      const cap = capacity === '' ? null : Number(capacity)
      if (cap != null && (!Number.isInteger(cap) || cap < 1)) throw new Error('定員は1以上の整数')
      const timePatterns = divideBand ? splitBand(bandStart, bandEnd, slotMinutes) : patterns.filter((pattern) => pattern.start && pattern.end && pattern.start < pattern.end)
      if (divideBand && timePatterns.length === 0) throw new Error('時間帯と1枠の長さが合いません。長さを短くするか時間帯を広げてください')
      await onSubmit({
        start_date: start,
        end_date: end,
        weekdays,
        time_patterns: timePatterns,
        capacity: cap,
      })
    } catch (e) {
      saveErrors.capture(e)
      setErr(describeApiFailure(e, '保存'))
    } finally {
      submitLock.current = false
      setBusy(false)
    }
  }

  return <SaveErrorScope errors={saveErrors}><Dialog open title="予約枠の一括追加" onCancel={onClose} onConfirm={submit} confirmLabel="生成" cancelLabel="キャンセル" busy={busy} error={err ?? undefined}>
    <Field label="開始日"><SaveErrorField names={["start","start_date"]}><DateField value={start} onChange={setStart} aria-label="開始日" /></SaveErrorField></Field>
    <Field label="終了日"><SaveErrorField names={["end","end_date"]}><DateField value={end} onChange={setEnd} aria-label="終了日" /></SaveErrorField></Field>
    <Field label="曜日">
      <div role="group" aria-label="枠を作る曜日">
        {['日', '月', '火', '水', '木', '金', '土'].map((day, index) => <SelectionButton key={index}
          selected={weekdays.includes(index)} onClick={() => toggleWeekday(index)}>{day}</SelectionButton>)}
      </div>
    </Field>
    <ToggleField checked={divideBand} onChange={setDivideBand}>時間帯を同じ長さの枠に分ける</ToggleField>
    {divideBand ? <FormSection id="ev-form-time-band" title="同じ長さの枠">
      <Field label="時間帯の開始"><SaveErrorField names={["bandStart","band_start"]}><TimeField value={bandStart} onChange={setBandStart} aria-label="時間帯の開始" /></SaveErrorField></Field>
      <Field label="時間帯の終了"><SaveErrorField names={["bandEnd","band_end"]}><TimeField value={bandEnd} onChange={setBandEnd} aria-label="時間帯の終了" /></SaveErrorField></Field>
      <Field label="1枠の長さ"><Select aria-label="1枠の長さ" value={String(slotMinutes)} onChange={(value) => setSlotMinutes(Number(value))}
        options={[30, 45, 60, 90, 120].map((minutes) => ({ value: String(minutes), label: `${minutes}分` }))} /></Field>
    </FormSection> : <>
    {patterns.map((pattern, index) => <FormSection key={index} id={`ev-form-pattern-${index}`} title={`${index + 1}件目の時刻パターン`}
      action={patterns.length > 1 ? <Button variant="text" textTone="danger" aria-label={`${index + 1}件目のパターンを削除`} title={`${index + 1}件目のパターンを削除`} onClick={() => setPatterns((items) => items.filter((_, position) => position !== index))}><X size={16} aria-hidden="true" /></Button> : null}>
      <Field label="開始"><TimeField value={pattern.start} aria-label={`${index + 1}件目の開始`} onChange={(value) => setPatterns((items) => items.map((item, position) => position === index ? { ...item, start: value } : item))} /></Field>
      <Field label="終了"><TimeField value={pattern.end} aria-label={`${index + 1}件目の終了`} onChange={(value) => setPatterns((items) => items.map((item, position) => position === index ? { ...item, end: value } : item))} /></Field>
    </FormSection>)}
    <Button onClick={() => setPatterns((items) => [...items, { start: '14:00', end: '15:00' }])}>＋ パターンを追加する</Button>
    </>}
    <Field label="定員（各枠共通・空欄=無制限）"><SaveErrorField names={["capacity"]}><TextInput type="number" min={1} value={capacity} onChange={(event) => setCapacity(event.target.value)} /></SaveErrorField></Field>
  </Dialog></SaveErrorScope>
}

// ----------------------------------------------------------------
// Tab 3: Publish settings
// ----------------------------------------------------------------

function PublishTab({
  draft,
  update,
  tags,
  reservationUrls,
}: {
  draft: EventDetail
  update: <K extends keyof EventDetail>(k: K, v: EventDetail[K]) => void
  tags: Array<{ id: string; name: string }>
  reservationUrls: React.ReactNode
}) {
  // R23横展開(m18hと同じ形): 新しい候補にない公開対象タグは外して知らせる。
  const [tagPruned, setTagPruned] = useState(false)
  useEffect(() => {
    if (tags.length === 0 || draft.visible_tag_id == null) return
    if (!tags.some((t) => t.id === draft.visible_tag_id)) {
      update('visible_tag_id', null)
      setTagPruned(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags])
  return <>
    <FormSection id="ev-form-publish" title="公開設定">
      <ToggleField checked={draft.requires_approval === 1} onChange={(checked) => update('requires_approval', checked ? 1 : 0)}
        description={<>ON: 友だちが予約しても運営が「承認」するまで未確定（承認待ちの分も残席を使います）<br />OFF: 定員空きがあれば即時確定</>}>承認制</ToggleField>
      <Field label="承認の期限" htmlFor="ev-approval-deadline" note="期限を過ぎた申請は自動で期限切れになり、席を戻します。">
        <SaveErrorField names={["approval_deadline_hours"]}><Select id="ev-approval-deadline" aria-label="承認の期限" value={String(draft.approval_deadline_hours)} disabled={draft.requires_approval !== 1}
          onChange={(value) => update('approval_deadline_hours', Number(value))} options={APPROVAL_DEADLINE_OPTIONS} size="full" /></SaveErrorField>
      </Field>
      <ToggleField checked={draft.waitlist_enabled === 1} onChange={(checked) => update('waitlist_enabled', checked ? 1 : 0)}
        description={<>ON: 定員に達したあとも申込を受け、待ちとして記録する<br />OFF: 定員に達したら締め切る<br />待ちの人は予約の件数に入りません。空きが出たら待ちの先頭へ自動で案内が送られ、本人が期限内に承諾すると確定します。申込者の画面から手動で次の方へ案内することもできます。</>}>キャンセル待ちを受ける</ToggleField>
      {tagPruned ? <Notice tone="warn" message="選んでいたタグは、今のアカウントにないため外しました。選び直してください。" onClose={() => setTagPruned(false)} /> : null}
      <Field label="公開対象" htmlFor="ev-visible-tag" note="絞ると、タグを持たない人にはイベントが存在しないものとして扱われます。URL を直接開いても表示されません。">
        <SaveErrorField names={["visible_tag_id"]}><EntitySelect kind="tag" aria-label="公開対象" id="ev-visible-tag" value={draft.visible_tag_id ?? ''} onChange={(value) => update('visible_tag_id', value === '' ? null : value)}
          options={[{ value: '', label: '友だち全員' }, ...tags.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: `${tag.name} を持つ人だけ` }))]} /></SaveErrorField>
      </Field>
      <Field label="申込の締め切り" htmlFor="ev-entry-cutoff">
        <SaveErrorField names={["entry_cutoff_hours_before"]}><Select aria-label="申込の締め切り" id="ev-entry-cutoff" value={deadlineSelectValue(draft.entry_cutoff_hours_before)}
          onChange={(value) => update('entry_cutoff_hours_before', parseDeadlineSelect(value))} options={deadlineOptionsWithSaved(EVENT_ENTRY_CUTOFF_OPTIONS, draft.entry_cutoff_hours_before)} /></SaveErrorField>
      </Field>
      <Field label="キャンセル期限（友だち側）">
        <SaveErrorField names={["cancel_deadline_hours_before"]}><Select aria-label="キャンセル期限（友だち側）" value={deadlineSelectValue(draft.cancel_deadline_hours_before)}
          onChange={(value) => update('cancel_deadline_hours_before', parseDeadlineSelect(value))} options={deadlineOptionsWithSaved(EVENT_CANCEL_DEADLINE_OPTIONS, draft.cancel_deadline_hours_before)} /></SaveErrorField>
      </Field>
      <ToggleField checked={draft.reminder_day_before_enabled === 1} onChange={(checked) => update('reminder_day_before_enabled', checked ? 1 : 0)} description="前日 18:00 JST に LINE で通知">前日リマインダ</ToggleField>
      <Field label="開始 N 時間前リマインダ">
        <SaveErrorField names={["reminder_hours_before"]}><Select aria-label="開始 N 時間前リマインダ" value={draft.reminder_hours_before == null ? 'off' : String(draft.reminder_hours_before)}
          onChange={(value) => update('reminder_hours_before', value === 'off' ? null : Number(value))}
          options={[{ value: 'off', label: '送信しない' }, { value: '1', label: '1 時間前' }, { value: '2', label: '2 時間前' }, { value: '3', label: '3 時間前' }, { value: '6', label: '6 時間前' }, { value: '24', label: '24 時間前' }]} /></SaveErrorField>
      </Field>
    </FormSection>
    <FormSection id="ev-form-messages" title="予約者向けカスタムメッセージ" description="予約者だけに届く LINE 通知の末尾に追加されます（Zoom URL など）。空欄ならデフォルト文言のみ。">
      <Field label="予約確定メッセージへの追記" count={{ value: (draft.confirmation_message_extra ?? '').length, max: 2000 }} note="確定通知（即時 / 後追い承認）の末尾に追加">
        <SaveErrorField names={["confirmation_message_extra"]}><TextArea value={draft.confirmation_message_extra ?? ''} onChange={(event) => update('confirmation_message_extra', event.target.value || null)} rows={3} maxLength={2000} placeholder="例: 当日の Zoom URL: https://us02web.zoom.us/j/…" /></SaveErrorField>
      </Field>
      <Field label="リマインドメッセージへの追記" count={{ value: (draft.reminder_message_extra ?? '').length, max: 2000 }} note="前日 / N 時間前のリマインド末尾に追加">
        <SaveErrorField names={["reminder_message_extra"]}><TextArea value={draft.reminder_message_extra ?? ''} onChange={(event) => update('reminder_message_extra', event.target.value || null)} rows={3} maxLength={2000} placeholder="例: 開始 10 分前に同じ URL からご入室ください" /></SaveErrorField>
      </Field>
    </FormSection>
    <FormSection id="ev-form-publication" title="公開状態">
      <RadioCardGroup legend="公開状態">
        <RadioCard name="event-publish-state" value="draft" checked={draft.is_published === 0} onChange={() => update('is_published', 0)} title="下書き" note="友だちには見えない" />
        <RadioCard name="event-publish-state" value="published" checked={draft.is_published === 1} onChange={() => update('is_published', 1)} title="公開する" note="予約 URL が有効になる" />
      </RadioCardGroup>
      {reservationUrls}
      <OgEditor value={{ ogTitle: draft.og_title, ogDescription: draft.og_description, ogImageUrl: draft.og_image_url }}
        onChange={(value) => { update('og_title', value.ogTitle); update('og_description', value.ogDescription); update('og_image_url', value.ogImageUrl) }}
        autoTitle={draft.name || undefined} autoDescription={draft.description ?? undefined} autoImageUrl={draft.image_url ?? undefined} />
    </FormSection>
  </>
}
