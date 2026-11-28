'use client'

import { useEffect, useState } from 'react'
import { bookingApi } from '@/lib/api'
import { formatDay } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import TextLink from '@/components/shared/text-link'
import { fetchAllPages } from '../lib/fetch-all-pages'
import { addDaysStr } from './shared'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day
}

function parseUtcDate(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('予約開始時刻を確認できませんでした')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('予約開始時刻を確認できませんでした')
  const normalized =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) throw new Error('予約開始時刻を確認できませんでした')
  return parsed
}

/** 休業の編集で選んだ日の予約だけを数える。変更・取消の口は呼ばない。 */
export default function HolidayBookings({ accountId, date }: { accountId: string; date: string }) {
  const [result, setResult] = useState<{ key: string; count: number | null } | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const validDate = isValidIsoDate(date)
  const key = `${accountId}:${date}`
  useEffect(() => {
    if (!validDate) return
    let active = true
    setResult(null)
    void fetchAllPages(
      (offset) => bookingApi.listRequests(accountId, 'all', {
        from: new Date(`${date}T00:00:00+09:00`).toISOString(),
        to: new Date(`${addDaysStr(date, 1)}T00:00:00+09:00`).toISOString(),
        limit: 100, offset,
      }),
      100, () => active,
    ).then((rows) => {
      if (!active) return
      if (!rows) {
        setResult({ key, count: null })
        return
      }
      let count = 0
      for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('予約データを確認できませんでした')
        if (row.status !== 'requested' && row.status !== 'confirmed') continue
        if (jstDate(parseUtcDate(row.starts_at)) === date) count += 1
      }
      setResult({ key, count })
    }).catch(() => { if (active) setResult({ key, count: null }) })
    return () => { active = false }
  }, [accountId, date, key, retryCount, validDate])
  if (!validDate) return null
  const current = result?.key === key ? result : null
  const failed = current?.count === null
  return <Notice
    marker="dot"
    tone={failed ? 'danger' : 'info'}
    heading={failed ? '失敗：既存予約を読み込めませんでした' : undefined}
    action={failed ? (
      <Button
        variant="text"
        size="inline"
        data-notice-inline-action
        type="button"
        onClick={() => setRetryCount((value) => value + 1)}
      >
        もう一度読み込む
      </Button>
    ) : undefined}
  >
    <p>{formatDay(date)}の既存予約{typeof current?.count === 'number' ? `：${current.count.toLocaleString('ja-JP')}件` : failed ? 'は読み込めていないため件数は分かりません' : 'を確認しています'}。予約は自動で取り消しません。</p>
    <TextLink href={`/booking/bookings?view=list&status=all&range=date&date=${date}`}>この日の予約へ</TextLink>
  </Notice>
}
