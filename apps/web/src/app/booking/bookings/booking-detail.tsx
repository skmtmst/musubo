import { knownValue } from '@/lib/known-value'
import { formatYen } from '@line-crm/shared';
import { useEffect, useState } from 'react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { bookingApi, type BookingAdminDetail, type BookingRequest } from '@/lib/api'
import { formatDateTime, formatTime, formatNumber } from '@/lib/format'
import type { AccountStyle } from '@line-crm/shared'
import { bookingWords } from '@/v8/booking-bookings/public/words/index'
import { BookingGapSections } from '@/v8/booking-gap/public/booking-gap-sections/index'
import { withHonorific } from '@line-crm/shared'

/*
 * ★V8-B 予約の詳細（`AjZhH`）。台帳の行から開く小窓。
 * 中身は引き出し（`TnDbq`）と同じ予約。差し替えるのは見た目だけ。
 * 卓・人数・アレルギーは予約のデータに無いので出さない。
 * 管理画面 の引き出しは残し、V8 の表示 のときだけ使う。
 */

/** 予約経路の言葉。台帳の絞り込み（`SOURCE_FILTERS`）と同じ語彙。 */
const SOURCE_LABEL: Record<string, string> = {
  liff: 'LINE',
  phone: '電話',
  counter: '店頭',
  operator: 'スタッフ入力',
  import: '取り込み',
}

/** 不正な日時が来たら Invalid Date を出さず「—」に逃がす。 */
function safeDateTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return '—'
  return formatDateTime(iso)
}

function safeTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return '—'
  return formatTime(iso)
}

export default function BookingDetailV8({
  booking: b,
  usageStyle,
  accountId,
  canOperate,
  onClose,
  onCancel,
  detailHref,
}: {
  usageStyle?: AccountStyle
  booking: BookingRequest
  accountId: string | null
  /** N-401: 閲覧のみの人には変更・取消の入口を出さない。 */
  canOperate: boolean
  onClose: () => void
  onCancel: () => void
  detailHref: string
}) {
  const [historyTotal, setHistoryTotal] = useState<number | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [historySeq, setHistorySeq] = useState(0)
  const words = bookingWords(usageStyle)
  const name = b.friend_name ?? words.person

  useEffect(() => {
    if (!accountId) return
    let active = true
    setHistoryError(false)
    void bookingApi
      .getBooking(accountId, b.id)
      .then((response: { booking: BookingAdminDetail }) => {
        if (active) setHistoryTotal(response.booking.historyTotal)
      })
      .catch(() => {
        if (active) setHistoryError(true)
      })
    return () => {
      active = false
    }
  }, [accountId, b.id, historySeq])

  return (
    <Dialog
      open
      designNode="AjZhH"
      title={`${withHonorific(name)}`}
      onCancel={onClose}
      footer={canOperate ? (
        <DialogActions>
              <Button variant="secondary" onClick={onCancel}>
                取り消す
              </Button>
              <Button variant="primary" href={detailHref}>
                変更する
              </Button>
        </DialogActions>
      ) : undefined}
    >
      {accountId ? <div className="mb-4 flex flex-col gap-4"><BookingGapSections accountId={accountId} bookingId={b.id} seriesId={(b as { series_id?: string | null }).series_id ?? null} customerName={name} menuName={b.menu_name} startsAt={b.starts_at} canOperate={canOperate} onChanged={() => setHistorySeq((n) => n + 1)} /></div> : null}
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-ink-faint text-xs">日時</dt>
          <dd className="text-ink mt-0.5">
            {safeDateTime(b.starts_at)}〜{safeTime(b.ends_at)}・{words.staff} {b.staff_name}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint text-xs">{words.menu}</dt>
          <dd className="text-ink mt-0.5">
            {b.menu_name} <span className="tabular-nums">{formatYen(b.price_at_booking)}</span> ・
            {knownValue(SOURCE_LABEL, b.source, b.source)}から
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint text-xs">{usageStyle === 'consult' || usageStyle === 'lesson' ? words.history : 'これまでの来店'}</dt>
          <dd className="text-ink mt-0.5" aria-busy={historyTotal === null && !historyError}>
            {historyError ? (
              <>
                {words.history}を読み込めませんでした
                <button type="button" onClick={() => setHistorySeq((n) => n + 1)} className="text-action ml-2 font-medium underline">
                  もう一度読み込む
                </button>
              </>
            ) : (
              <DelayedSkeleton loading={historyTotal === null} skeleton={<Skeleton width={48} />}>
                {historyTotal === null ? null : `${formatNumber(historyTotal)}回`}
              </DelayedSkeleton>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint text-xs">{`${words.person}からのご希望`}</dt>
          <dd className="text-ink mt-0.5">{b.customer_note ?? '記入なし'}</dd>
        </div>
      </dl>
    </Dialog>
  )
}
