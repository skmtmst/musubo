'use client'
import { getApiErrorCode } from '@/lib/api'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { eventsApi, type EventBookingSummary, type EventDetail, type EventLifecycleStatus, type EventSlot } from '@/lib/api'
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
  const [event, setEvent] = useState<EventDetail | null>(null)
  const [summary, setSummary] = useState<EventBookingSummary | null>(null)
  const [slots, setSlots] = useState<EventSlot[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const requests = useBookingRequests(JSON.stringify([accountId, eventId, refreshKey, reloadSeq]))
  useEffect(() => {
    const request = requests.start('status', true)
    if (!request) return
    setLoading(true); setLoadError(false); setEvent(null); setSummary(null); setSlots(null)
    void Promise.allSettled([
      eventsApi.getEvent(accountId, eventId),
      eventsApi.getBookingSummary(accountId, eventId),
      eventsApi.listSlots(accountId, eventId),
    ]).then(([detail, counts, occurrences]) => {
      if (!request.isCurrent()) return
      if (detail.status === 'fulfilled') setEvent(detail.value)
      if (counts.status === 'fulfilled') setSummary(counts.value)
      if (occurrences.status === 'fulfilled') setSlots(occurrences.value.items)
      setLoadError([detail, counts, occurrences].some((result) => result.status === 'rejected'))
      setLoading(false)
    }).finally(() => { request.finish() })
  }, [accountId, eventId, requests])
  const lifecycle = event?.lifecycle_status ?? (event?.is_published === 1 ? 'published' : 'draft')
  const hasFuture = slots === null ? null : slots.some((slot) => slot.is_active === 1 && Date.parse(slot.starts_at) >= Date.now())
  const label = lifecycle === 'published' && hasFuture === false ? '終了' : LABELS[lifecycle]
  return <>
    {loadError ? <Notice tone="warn" message="一部を読み込めませんでした。読み込めなかった数は「—」で表示しています。"
      action={<Button onClick={() => setReloadSeq((value) => value + 1)}>読み直す</Button>} /> : null}
    <KpiBand>
      <KpiCard title="予約 / 定員" value={summary?.confirmedSeats ?? summary?.confirmed} valueText={!loading && summary ? `${summary.confirmedSeats ?? summary.confirmed} / ${summary.totalCapacity ?? '—'}` : undefined} unit="人" detail={event ? <StatusBadge tone={lifecycle === 'published' ? 'success' : 'neutral'}>{label}</StatusBadge> : '公開状態は未取得'} loading={loading} />
      <KpiCard title="承認待ち" value={summary?.requested} unit="件" detail="申請した時点から席を使います" loading={loading} />
      <KpiCard title="キャンセル待ち" value={summary?.waitlist} unit="件" detail="空きが出たら順に案内します" loading={loading} />
      <KpiCard title="キャンセル" value={summary?.cancelled} unit="件" detail="申込の履歴は残ります" loading={loading} />
    </KpiBand>
  </>
}

function LifecycleSection({ accountId, eventId, onChanged }: { accountId: string; eventId: string; onChanged: () => void }) {
  const saveErrors = useSaveFormErrors()
  const [lifecycle, setLifecycle] = useState<EventLifecycleStatus | null>(null)
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
    setLifecycle(null); setLoadFailed(false)
    void eventsApi.getEvent(accountId, eventId).then((detail) => {
      if (request.isCurrent()) setLifecycle(detail.lifecycle_status ?? (detail.is_published === 1 ? 'published' : 'draft'))
    }).catch(() => { if (request.isCurrent()) setLoadFailed(true) }).finally(() => { request.finish() })
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
  return <SaveErrorScope errors={saveErrors}><FormSection id="ev-edit-lifecycle" title="公開の状態" action={<>
    {(lifecycle ? NEXT_LIFECYCLE[lifecycle] : []).map((option) => <Button key={option.to} disabled={busy} onClick={() => { setReason(''); setError(''); setPending(option) }}>{option.label}</Button>)}
  </>}>
    {lifecycle === null ? loadFailed ? <Notice tone="warn" message="公開の状態を読み込めませんでした。"
      action={<Button onClick={() => setLoadSeq((value) => value + 1)}>読み直す</Button>} /> : <ListState kind="loading" title="状態を読み込んでいます…" /> : null}
    <ConfirmDialog open={pending !== null} title={`このイベントを${pending?.label ?? '変える'}？`}
      description={pending?.to === 'cancelled' ? '中止にすると申込の受付は止まり、申込の履歴は残ります。元に戻すことはできません。' : pending?.to === 'paused' ? '一時停止中はお客様の画面から申込ができなくなります。申込の履歴は残ります。' : '状態を変えます。'}
      destructive={pending?.to === 'cancelled'} confirmLabel={pending?.label ?? '変える'} busy={busy} error={error}
      confirmDisabled={Boolean(pending?.needsReason && reason.trim() === '')} onConfirm={runSwitch}
      onCancel={() => { if (!busy) { setPending(null); setReason(''); setError('') } }}>
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      {pending?.needsReason ? <Field label="理由（必須・変更の記録に残ります）" required><SaveErrorField names={["reason"]}><TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="例：台風のため今週の受付を止めます" /></SaveErrorField></Field> : null}
    </ConfirmDialog>
  </FormSection></SaveErrorScope>
}

/** 題の後ろ半分（絵 XFRyO：「イベント予約 › 朝ヨガ」）。読めないときは「イベントの編集」。 */
function EventName({ accountId, eventId }: { accountId: string; eventId: string }) {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => eventsApi.getEvent(accountId, eventId)).then((detail) => { if (alive) setName(detail?.name || null) }).catch(() => {})
    return () => { alive = false }
  }, [accountId, eventId])
  return <>{name ?? 'イベントの編集'}</>
}

function EditEntry() {
  const id = useSearchParams().get('id')
  const { selectedAccountId } = useAccount()
  const [statusSeq, setStatusSeq] = useState(0)
  if (!id) return <TargetMissing kind="unspecified" title="編集するイベントが指定されていません" description="一覧から、編集するイベントを選び直してください。" backHref="/events" backLabel="イベント一覧へ戻る" />
  if (!selectedAccountId) return <ListState kind="empty" title="アカウントを選択してください。" />
  const scope = JSON.stringify([selectedAccountId, id])
  return <DetailPage title={<span className={styles.title}><span className={styles.titleParent}>イベント予約 ›</span><EventName accountId={selectedAccountId} eventId={id} /></span>}
    help={<>イベント・クラスの中身と予約枠、公開、お支払いの方法を決めます。</>}
    summary={<div className={styles.side}>
      <PaymentSideCard title="決済をつないでいない店のとき">「お支払い」の段は出さず、「先払いを受けるには お支払いをつなぐ →」の 1 行だけ出します（押せない形にしない）。</PaymentSideCard>
      <PaymentSideCard title="キャンセルと返金">開始前のキャンセルの期限までの取り消しは自動で返金します。過ぎた取り消しは返金しません（予約設定 › 予約のルール）。</PaymentSideCard>
    </div>}
    layout="record-detail" summaryLabel="お支払いの説明" summaryPreview={{ label: "お支払いの説明を見る", title: "お支払いの説明" }}
    actions={<><Button href={`/events/change-review?id=${id}`}>変更の影響を確認</Button><Button href={`/events/preview?id=${id}`}>お客様表示を確認</Button><Button href={`/events/bookings?id=${id}`}>申込の一覧を見る</Button></>}
    stats={<BookingStatus key={scope} accountId={selectedAccountId} eventId={id} refreshKey={statusSeq} />}>
    <LifecycleSection key={scope} accountId={selectedAccountId} eventId={id} onChanged={() => setStatusSeq((value) => value + 1)} />
    <EventForm key={`form:${scope}`} accountId={selectedAccountId} eventId={id} />
    <FormSection id="ev-edit-notes" title="気をつけること">
      <p className="text-body">承認制の申込は承認待ちの時点から残席を使います。承認・拒否・期限切れで確定または解放されます。</p>
      <p className="text-body">定員に達するとキャンセル待ちに切り替わります。</p>
      <p className="text-body">公開後に定員を減らしても、すでに確定した申込は取り消されません。</p>
    </FormSection>
  </DetailPage>
}

export default function EventEditV8() {
  usePageTitle('イベントの編集')
  usePageCrumbs([{ label: 'イベント予約', href: '/events' }, { label: '編集' }])
  return <Suspense fallback={<ListState kind="loading" />}><EditEntry /></Suspense>
}
