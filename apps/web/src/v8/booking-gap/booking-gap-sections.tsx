'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Gap2Booking, Gap2Series } from '@line-crm/shared'
import { bookingSeriesApi } from '@/lib/api/helpers/gap2'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'

import { BookingGroupSection } from '@/v8/booking-payments/public/booking-group/index'
import SeriesPanelSection from './series-panel-section'

/*
 * 予約の詳細パネルに足す段（繰り返し）。繰り返しの 1 回でない予約には何も出さない。
 * 読めないときは繰り返し情報を読み直せるようにする。
 * 同伴の組は共通の段から読み、取消後はこの予約も読み直す。
 */
export default function BookingGapSections({ accountId, bookingId, seriesId, customerName, menuName, startsAt, canOperate, onChanged }: {
  accountId: string
  bookingId: string
  /** 予約の series_id（無ければ繰り返しではない）。 */
  seriesId: string | null
  customerName: string
  menuName: string
  startsAt: string
  canOperate: boolean
  onChanged: () => void
}) {
  const [result, setResult] = useState<{ scope: string; data: { series: Gap2Series; bookings: Gap2Booking[] } | null; failed: boolean } | null>(null)
  const [tick, setTick] = useState(0)
  const [retry, setRetry] = useState(0)
  const scope = JSON.stringify([accountId, bookingId, seriesId])
  useEffect(() => {
    let current = true
    setResult(null)
    if (!seriesId) return
    void Promise.resolve().then(() => bookingSeriesApi.get(accountId, seriesId)).then((r) => { if (current) setResult({ scope, data: r.data, failed: false }) }).catch(() => { if (current) setResult({ scope, data: null, failed: true }) })
    return () => { current = false }
  }, [accountId, bookingId, seriesId, scope, tick, retry])
  const changed = useCallback(() => { setTick((n) => n + 1); onChanged() }, [onChanged])
  const current = result?.scope === scope ? result : null
  return <>
    <BookingGroupSection key={`${accountId}:${bookingId}:${tick}`} accountId={accountId} bookingId={bookingId} canOperate={canOperate} onChanged={changed} />
    {current?.failed ? <><Notice tone="warn">繰り返し予約の情報を読み込めませんでした。</Notice><Button type="button" variant="secondary" onClick={() => setRetry(value => value + 1)}>繰り返し予約を読み直す</Button></> : null}
    {current?.data ? <SeriesPanelSection series={current.data.series} bookings={current.data.bookings} accountId={accountId} customerName={customerName} menuName={menuName} bookingId={bookingId} startsAt={startsAt} canOperate={canOperate} onChanged={changed} /> : null}
  </>
}
