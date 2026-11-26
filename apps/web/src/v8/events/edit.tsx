'use client'
import { getApiErrorCode } from '@/lib/api'
import { requestUnsavedAction } from '@/lib/unsaved-action'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { eventsApi, type EventBookingSummary, type EventLifecycleStatus } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { DetailPage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import FormSection from '@/components/shared/form-section'
import { Field } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { RowMenu } from '@/components/shared/row-actions'
import TargetMissing from '@/components/shared/target-missing'
import EventForm from '@/v8/events/edit-form'
import { useBookingRequests } from './booking-requests'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { PaymentSideCard } from '@/v8/booking-payments/public/menu-payment/index'
import styles from './edit.module.css'


const NEXT_LIFECYCLE: Record<EventLifecycleStatus, Array<{ to: EventLifecycleStatus; label: string; needsReason: boolean }>> = {
  draft: [{ to: 'published', label: '公開する', needsReason: false }],
  published: [
    { to: 'paused', label: '一時停止する', needsReason: true },
    { to: 'ended', label: '終了する', needsReason: false },
    { to: 'cancelled', label: '中止する', needsReason: true },
  ],
  paused: [
    { to: 'published', label: '再開する', needsReason: false },
    { to: 'ended', label: '終了する', needsReason: false },
    { to: 'cancelled', label: '中止する', needsReason: true },
  ],
  ended: [], cancelled: [],
}
const LABELS: Record<EventLifecycleStatus, string> = {
  draft: '下書き', published: '公開中', paused: '一時停止', ended: '終了', cancelled: '中止',
}

function BookingStatus({ accountId, eventId, refreshKey }: { accountId: string; eventId: string; refreshKey: number }) {
  const [summary, setSummary] = useState<EventBookingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const requests = useBookingRequests(JSON.stringify([accountId, eventId, refreshKey, reloadSeq]))
  useEffect(() => {
    const request = requests.start('status', true)
    if (!request) return
    setLoading(true); setLoadError(false); setSummary(null)
    void Promise.allSettled([
      eventsApi.getBookingSummary(accountId, eventId),
    ]).then(([counts]) => {
      if (!request.isCurrent()) return
      if (counts.status === 'fulfilled') setSummary(counts.value)
      setLoadError(counts.status === 'rejected')
      setLoading(false)
    }).finally(() => { request.finish() })
  }, [accountId, eventId, requests])
  return <>
    {loadError ? <Notice tone="warn" message="一部を読み込めませんでした。読み込めなかった数は「—」で表示しています。"
      action={<Button onClick={() => setReloadSeq((value) => value + 1)}>読み直す</Button>} /> : null}
    <KpiBand>
      <KpiCard title="予約 / 定員" value={summary?.confirmedSeats ?? summary?.confirmed} valueText={!loading && summary ? `${summary.confirmedSeats ?? summary.confirmed ?? '—'} / ${summary.totalCapacity ?? '—'}` : undefined} unit="人" detail={null} loading={loading} />
      <KpiCard title="承認待ち" value={summary?.requested} unit="件" detail="申請した時点から席を使います" loading={loading} />
      <KpiCard title="キャンセル待ち" value={summary?.waitlist} unit="件" detail="空きが出たら順に案内します" loading={loading} />
      <KpiCard title="キャンセル" value={summary?.cancelled} unit="件" detail="申込の履歴は残ります" loading={loading} />
    </KpiBand>
  </>
}

function LifecycleSection({ accountId, eventId, onChanged }: { accountId: string; eventId: string; onChanged: () => void }) {
  const saveErrors = useSaveFormErrors()
  const [lifecycle, setLifecycle] = useState<EventLifecycleStatus | null>(null)
  const [hasFuture, setHasFuture] = useState<boolean | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadSeq, setLoadSeq] = useState(0)
  const [pending, setPending] = useState<(typeof NEXT_LIFECYCLE)['draft'][number] | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const idempotencyKeyRef = useRef(crypto.randomUUID())
  const requests = useBookingRequests(JSON.stringify([accountId, eventId]))
  useEffect(() => {
    const request = requests.start('lifecycle', true)
    if (!request) return
    setLifecycle(null); setHasFuture(null); setLoadFailed(false)
    void eventsApi.getEvent(accountId, eventId).then(detail => {
      if (request.isCurrent()) setLifecycle(detail.lifecycle_status ?? (detail.is_published === 1 ? 'published' : 'draft'))
    }).catch(() => { if (request.isCurrent()) setLoadFailed(true) }).finally(() => { request.finish() })
    const slotsRequest = requests.start('lifecycle-slots', true)
    if (slotsRequest) void eventsApi.listSlots(accountId, eventId).then(({ items }) => {
      if (slotsRequest.isCurrent()) setHasFuture(items.some(slot => slot.is_active === 1 && Date.parse(slot.starts_at) >= Date.now()))
    }).catch(() => {}).finally(() => { slotsRequest.finish() })
  }, [accountId, eventId, loadSeq, requests])
  async function runSwitch() {
    if (!pending || busy || (pending.needsReason && reason.trim() === '')) return
    const request = requests.start('switch')
    if (!request) return
    setBusy(true); setError('')
    try {
      const result = await eventsApi.setEventLifecycle(accountId, eventId, {
        to: pending.to, reason: reason.trim() || undefined, idempotency_key: idempotencyKeyRef.current,
      })
      if (!request.isCurrent()) return
      idempotencyKeyRef.current = crypto.randomUUID()
      setLifecycle(result.lifecycle_status); setPending(null); setReason('')
      onChanged()
    } catch (failure) {
      if (!request.isCurrent()) return
      saveErrors.capture(failure)
      const code = getApiErrorCode(failure)
      setError(code === 'lifecycle_transition_invalid'
        ? 'いまの状態からは変えられません。開き直して最新の状態で、もう一度お試しください。'
        : '変えられませんでした。時間をおいて、もう一度お試しください。')
    } finally { if (request.isCurrent()) setBusy(false); request.finish() }
  }
  const pastPublished = lifecycle === 'published' && hasFuture === false
  const displayLifecycle = pastPublished ? 'ended' : lifecycle
  const actions = lifecycle ? (pastPublished ? NEXT_LIFECYCLE.published.filter(option => option.to !== 'paused') : NEXT_LIFECYCLE[lifecycle]) : []
  const choose = (option: (typeof NEXT_LIFECYCLE)['draft'][number]) => requestUnsavedAction(() => { setReason(''); setError(''); setPending(option) })
  return <SaveErrorScope errors={saveErrors}><span className={styles.lifecycle}>
    {displayLifecycle ? <StatusBadge tone={displayLifecycle === 'published' ? 'success' : 'neutral'}>{LABELS[displayLifecycle]}</StatusBadge> : null}
    {actions[0] ? <Button variant={pastPublished ? 'primary' : 'secondary'} disabled={busy} onClick={() => choose(actions[0])}>{actions[0].label}</Button> : null}
    {actions.length > 1 ? <RowMenu label="公開状態の操作" items={actions.slice(1).map(option => ({ id: option.to, label: option.label, disabled: busy, onSelect: () => choose(option) }))} /> : null}
    {lifecycle === null ? loadFailed ? <><Notice tone="danger" message="公開の状態を読み込めませんでした。" /><Button onClick={() => setLoadSeq((value) => value + 1)}>読み直す</Button></> : <span role="status">状態を読み込んでいます…</span> : null}
    <ConfirmDialog open={pending !== null} title={`このイベントを${pending?.label ?? '変える'}？`}
      description={pending?.to === 'cancelled' ? '中止にすると申込の受付は止まり、申込の履歴は残ります。元に戻すことはできません。' : pending?.to === 'paused' ? '一時停止中はお客様の画面から申込ができなくなります。申込の履歴は残ります。' : '状態を変えます。'}
      destructive={pending?.to === 'cancelled'} confirmLabel={pending?.label ?? '変更する'} busy={busy} error={error}
      confirmDisabled={Boolean(pending?.needsReason && reason.trim() === '')} onConfirm={runSwitch}
      onCancel={() => { if (!busy) { setPending(null); setReason(''); setError('') } }}>
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      {pending?.needsReason ? <Field label="理由（必須・変更の記録に残ります）" required><SaveErrorField names={["reason"]}><TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="例：台風のため今週の受付を止めます" /></SaveErrorField></Field> : null}
    </ConfirmDialog>
  </span></SaveErrorScope>
}

function EditEntry() {
  const id = useSearchParams().get('id')
  const { selectedAccountId } = useAccount()
  const [statusSeq, setStatusSeq] = useState(0)
  const [name, setName] = useState<string | null>(null)
  usePageTitle(name || 'イベントの編集')
  usePageCrumbs([{ label: 'イベント予約', href: '/events' }])
  useEffect(() => {
    let active = true
    setName(null)
    if (selectedAccountId && id) void eventsApi.getEvent(selectedAccountId, id).then(detail => { if (active) setName(detail.name || null) }).catch(() => {})
    return () => { active = false }
  }, [selectedAccountId, id])
  if (!id) return <TargetMissing kind="unspecified" title="編集するイベントが指定されていません" description="一覧から、編集するイベントを選び直してください。" backHref="/events" backLabel="イベント一覧へ戻る" />
  if (!selectedAccountId) return <ListState kind="empty" title="アカウントを選択してください。" />
  const scope = JSON.stringify([selectedAccountId, id])
  return <DetailPage title={name || 'イベントの編集'}
    help={<>イベント・クラスの中身と予約枠、公開、お支払いの方法を決めます。</>}
    summary={<div className={styles.side}>
      <PaymentSideCard title="決済をつないでいない店のとき">「お支払い」の段は出さず、「先払いを受けるには お支払いをつなぐ →」の 1 行だけ出します（押せない形にしない）。</PaymentSideCard>
      <PaymentSideCard title="キャンセルと返金">開始前のキャンセルの期限までの取り消しは自動で返金します。過ぎた取り消しは返金しません（予約設定 › 予約のルール）。</PaymentSideCard>
    </div>}
    layout="record-detail" separators="none" summaryLabel="お支払いの説明" summaryPreview={{ label: "お支払いの説明を見る", title: "お支払いの説明" }}
    actions={<><LifecycleSection key={scope} accountId={selectedAccountId} eventId={id} onChanged={() => setStatusSeq((value) => value + 1)} /><Button href={`/events/change-review?id=${id}`}>変更の影響を確認</Button><Button href={`/events/preview?id=${id}`}>お客様表示を確認</Button><Button href={`/events/bookings?id=${id}`}>申込の一覧を見る</Button></>}
    stats={<BookingStatus key={scope} accountId={selectedAccountId} eventId={id} refreshKey={statusSeq} />}>
    <EventForm key={`form:${scope}:${statusSeq}`} accountId={selectedAccountId} eventId={id} />
    <FormSection id="ev-edit-notes" title="気をつけること">
      <p>承認制の申込は承認待ちの時点から残席を使います。承認・拒否・期限切れで確定または解放されます。</p>
      <p>定員に達するとキャンセル待ちに切り替わります。</p>
      <p>公開後に定員を減らしても、すでに確定した申込は取り消されません。</p>
    </FormSection>
  </DetailPage>
}

export default function EventEditV8() {
  return <Suspense fallback={<ListState kind="loading" />}><EditEntry /></Suspense>
}
