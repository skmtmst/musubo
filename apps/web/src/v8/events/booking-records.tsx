'use client'
import { knownValue } from '@/lib/known-value'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { eventsApi, type EventBookingItem, type EventBookingSummary } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { parseEventQuestions } from '@/components/events/event-questions-editor'
import Button from '@/components/shared/button'
import Disclosure from '@/components/shared/disclosure'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { EventRosterTable, EventRosterRow } from '@/components/shared/event-roster'
import { useBookingRequests } from './booking-requests'
import { describeBookingCapacity } from './attention'
import styles from './bookings.module.css'

import { DEFAULT_PAGE_SIZE as PAGE_SIZE } from '@/components/shared/page-size-options'
const STATUS_LABELS: Record<string, string> = {
  all: '全件', requested: '承認待ち', confirmed: '確定', rejected: '拒否',
  cancelled: 'キャンセル', expired: '期限切れ', attended: '参加済', no_show: '無断',
}
const REMINDER_KIND_LABELS: Record<string, string> = {
  day_before: '前日のお知らせ', hours_before: '開始前のお知らせ',
}
const REMINDER_STATUS_LABELS: Record<string, string> = {
  pending: '送信予定', sent: '送信済み', cancelled: '停止済み', failed: '失敗', failed_permanent: '失敗',
}

export const bookingStatusWord = (status: string) => knownValue(STATUS_LABELS, status, '状態は未取得')
export const bookingReminderKindWord = (kind: string) => knownValue(REMINDER_KIND_LABELS, kind, '通知')
export const bookingReminderStatusWord = (status: string) => knownValue(REMINDER_STATUS_LABELS, status, '状態を確認できません')

function formatJp(value: string | null | undefined, fallback = '日時未取得') {
  return formatDateTime(value, fallback)
}

type Props = { accountId: string; eventId: string; occurrenceId: string; questionsJson?: string | null; revision?: string; children?: ReactNode; renderActions?: (booking: EventBookingItem) => ReactNode }

/** 申込時の記録と通知結果。通常の開催回の表は変えず、必要なときだけ開いて読む。 */
export default function BookingRecords(props: Props) {
  const [open, setOpen] = useState(false)
  return <Disclosure title="申込記録・回答・通知予定" hint="参加済・取消を含む記録" onToggle={setOpen}>
    {open ? <><RecordSummary key={JSON.stringify([props.accountId, props.eventId])} accountId={props.accountId} eventId={props.eventId} revision={props.revision} />{props.children}<Records key={JSON.stringify([props.accountId, props.eventId, props.occurrenceId])} {...props} /></> : null}
  </Disclosure>
}

function RecordSummary({ accountId, eventId, revision }: Pick<Props, 'accountId' | 'eventId' | 'revision'>) {
  const [summary, setSummary] = useState<EventBookingSummary | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const requests = useBookingRequests(JSON.stringify([accountId, eventId, revision, retry]))
  useEffect(() => {
    const request = requests.start('summary', true)
    if (!request) return
    setSummary(null)
    setStatus('loading')
    void eventsApi.getBookingSummary(accountId, eventId).then((data) => {
      if (!request.isCurrent()) return
      if (!data || !Number.isFinite(data.requested) || !Number.isFinite(data.confirmed)) throw new Error('malformed_summary')
      setSummary(data)
      setStatus('ready')
    }).catch(() => { if (request.isCurrent()) setStatus('error') }).finally(() => { request.finish() })
  }, [accountId, eventId, requests])
  if (status === 'loading') return <ListState kind="loading" />
  if (status === 'error' || !summary) return <ListState kind="error" description="全開催回の件数を読み込めませんでした。予約の記録は消えていません。"
    action={<Button onClick={() => setRetry((value) => value + 1)}>件数を読み直す</Button>} />
  const activeSeats = summary.activeSeats ?? (summary.confirmedSeats ?? summary.confirmed) + (summary.requestedSeats ?? summary.requested) + (summary.offeredSeats ?? 0)
  return <>
    <p>{`全開催回：承認待ち ${summary.requested}件・確定 ${summary.confirmed}件・拒否 ${summary.rejected ?? '—'}件・キャンセル ${summary.cancelled ?? '—'}件・期限切れ ${summary.expired ?? '—'}件・参加済 ${summary.attended ?? '—'}件・無断 ${summary.noShow ?? '—'}件`}</p>
    <p>{describeBookingCapacity(activeSeats, summary.totalCapacity ?? null)}</p>
    <p>{summary.requested > 0 ? `対応が必要：${summary.requested}件を確認してください` : '確認待ちはありません'}。{summary.cancelled > 0 ? '空いた枠を確認してください' : 'キャンセルはありません'}。</p>
  </>
}

function Records({ accountId, eventId, occurrenceId, questionsJson, revision, renderActions }: Props) {
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rows, setRows] = useState<EventBookingItem[]>([])
  const [total, setTotal] = useState(0)
  const requests = useBookingRequests(JSON.stringify([accountId, eventId, occurrenceId, filter, page, revision, retry]))
  useEffect(() => {
    const request = requests.start('records', true)
    if (!request) return
    setStatus('loading')
    setRows([])
    setTotal(0)
    void eventsApi.listBookings(accountId, eventId, {
      slot_id: occurrenceId, status: filter === 'all' ? undefined : filter, page, limit: PAGE_SIZE,
    }).then((result) => {
      if (!request.isCurrent()) return
      if (!Array.isArray(result?.items) || !Number.isFinite(result.total) || result.total < 0) throw new Error('malformed_bookings')
      setRows(result.items)
      setTotal(result.total)
      setStatus('ready')
    }).catch(() => {
      if (request.isCurrent()) setStatus('error')
    }).finally(() => { request.finish() })
  }, [accountId, eventId, occurrenceId, filter, page, requests])

  const labels = new Map((parseEventQuestions(questionsJson) ?? []).map((question) => [question.id, question.label]))
  return <>
    <Select aria-label="申込記録の状態" value={filter} onChange={(value) => { setPage(1); setFilter(value) }}
      options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
    {status === 'loading' ? <ListState kind="loading" /> : status === 'error' ?
      <ListState kind="error" description="申込記録を読み込めませんでした。開き直してもう一度お試しください。"
        action={<Button onClick={() => setRetry((value) => value + 1)}>開き直す</Button>} /> : rows.length === 0 ?
      <ListState kind="empty" title="この状態の申込記録はありません" /> : <>
        <EventRosterTable kind="records" label="申込記録" headings={['友だち・回答', '状態', '受付日時', '開催回・通知予定', '個別トーク・操作']}>
          {rows.map((booking) => {
            let answers: Array<[string, unknown]> = []
            try {
              const parsed: unknown = JSON.parse(booking.answer_snapshot_json ?? 'null')
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = Object.entries(parsed)
            } catch { /* 過去の壊れた回答だけを省き、予約と通知結果は残す。 */ }
            return <EventRosterRow key={booking.id}>
              <span role="cell" className={styles.person}>
                <span className={styles.personName} title={booking.friend_display_name ?? booking.friend_name ?? '友だちは未取得'}>{booking.friend_display_name ?? booking.friend_name ?? '友だちは未取得'}</span>
                <span className={styles.personSub}>{booking.line_account_name ?? 'アカウントは未取得'}</span>
                <span className={styles.personSub}>{booking.is_first_time == null ? '来店情報は未接続' : booking.is_first_time === 1 ? 'はじめての方です' : '来店履歴があります'}</span>
                {answers.length ? <dl>{answers.map(([id, answer]) => <div key={id}><dt>{labels.get(id) ?? id}</dt><dd>{Array.isArray(answer) ? answer.join('、') : String(answer)}</dd></div>)}</dl> : null}
                {booking.customer_note ? <span>備考：{booking.customer_note}</span> : null}
                {booking.companion_note ? <span>同行者：{booking.companion_note}</span> : null}
              </span>
              <span role="cell"><StatusBadge tone={booking.status === 'no_show' ? 'danger' : booking.status === 'confirmed' || booking.status === 'attended' ? 'success' : 'neutral'}>{bookingStatusWord(booking.status)}</StatusBadge></span>
              <span role="cell" className={styles.cellText}>{formatJp(booking.requested_at ?? booking.created_at)}</span>
              <span role="cell">
                {formatJp(booking.slot_starts_at)}
                {(booking.reminders ?? []).length ? <ul data-booking-reminders={booking.id}>
                  {(booking.reminders ?? []).map((reminder, index) => <li key={`${reminder.kind}:${reminder.scheduled_at}:${index}`}>
                    {bookingReminderKindWord(reminder.kind)}{' '}{formatJp(reminder.scheduled_at)}{' '}{bookingReminderStatusWord(reminder.status)}
                  </li>)}
                </ul> : null}
              </span>
              <span role="cell"><Link href={`/chats?friend=${encodeURIComponent(booking.friend_id)}`}>個別トーク</Link>{renderActions?.(booking)}</span>
            </EventRosterRow>
          })}
        </EventRosterTable>
        <p>{(page - 1) * PAGE_SIZE + 1}〜{Math.min(page * PAGE_SIZE, total)}件 / 全{formatNumber(total)}件</p>
        <Pagination page={page} pageCount={Math.ceil(total / PAGE_SIZE)} onPageChange={setPage} ariaLabel="申込記録のページ送り" />
      </>}
  </>
}
