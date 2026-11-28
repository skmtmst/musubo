'use client'
import SharedButton from '@/components/shared/button'
import { formatYen as yen } from '@line-crm/shared';

import Notice from '@/components/shared/notice'

import { DataTable, Tr, Th, Td } from '@/components/shared/table'

import { useEffect, useState } from 'react'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { notifySaved } from '@/components/shared/toast'
import Checkbox from '@/components/shared/checkbox'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { bookingSeriesApi } from '@/lib/api/helpers/gap2'
import { bookingAdvancedApi } from '@/lib/api/helpers/booking-advanced'
type SeriesImpactItem = Awaited<ReturnType<typeof bookingAdvancedApi.impact>>['data']['items'][number]
import type { Gap2Booking } from '@line-crm/shared'
import { dayOf, dayWithWeekday, hm } from './series-model'
import styles from './series-scope-dialog.module.css'
import { formatNumber } from '@/lib/format'
import { withHonorific } from '@line-crm/shared'

export type SeriesTarget = {
  seriesId: string
  customerName: string
  /** 「毎週金曜 14:00」。 */
  ruleText: string
  menuName: string
  /** この回（4 回目）。 */
  index: number
  bookingId: string
  startsAt: string
}


/*
 * 繰り返しの予約を変える・取り消す確かめの窓（B4-2・i1NoP と YoXiY）。
 * 「この回だけ」「この回から後ぜんぶ（N 件）」を選ぶと、対象の日の表を中に出す。
 * 口は変えられなかった回（conflicts）を前のまま残して返すので、その件数は結果の知らせに出す。
 * キャンセル料・変わる日時・埋まっている回は、同じ範囲と版の見込みを確認してから実行する。
 */
export default function SeriesScopeDialog({ open, mode, accountId, target, newStartsAt, onClose, onDone }: {
  open: boolean
  mode: 'change' | 'cancel'
  accountId: string
  target: SeriesTarget
  /** 変えるときの新しい開始（この回）。 */
  newStartsAt?: string
  onClose: () => void
  onDone: (result: { count: number }) => void
}) {
  const [all, setAll] = useState<Gap2Booking[] | null>(null)
  /* 前もっての見込み。取得不能は「かかりません」と表示しない。 */
  const [impact, setImpact] = useState<Record<string, SeriesImpactItem> | null>(null)
  const preparing = usePreparingDialog()
  const [version, setVersion] = useState(0)
  const [scope, setScope] = useState<'this' | 'following'>('following')
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => { if (open) { setScope('following'); setError(''); setAll(null) } }, [open])
  useEffect(() => {
    if (!open) return
    let current = true
    setAll(null); setImpact(null); setLoadError(false)
    void bookingSeriesApi.get(accountId, target.seriesId)
      .then(async (res) => {
        const preview = await bookingAdvancedApi.impact(accountId, target.seriesId, { scope, fromBookingId: target.bookingId, expectedVersion: res.data.series.version, change: mode === 'change' && newStartsAt ? { startsAt: newStartsAt } : undefined })
        if (!current) return
        const from = res.data.bookings.find((b) => b.id === target.bookingId)?.series_index ?? target.index
        const candidates = res.data.bookings.filter((b) => (b.series_index ?? 0) >= from && !['cancelled', 'rejected', 'expired'].includes(b.status)).sort((a, b) => (a.series_index ?? 0) - (b.series_index ?? 0))
        const selected = scope === 'this' ? candidates.slice(0, 1) : candidates
        if (selected.some((b) => !preview.data.items.some((item) => item.bookingId === b.id))) throw new Error('見込みの一部を確認できませんでした。時間をおいて、もう一度お試しください。')
        setVersion(res.data.series.version)
        setImpact(Object.fromEntries(preview.data.items.map((item) => [item.bookingId, item])))
        setAll(candidates)
      })
      .catch(() => { if (current) setLoadError(true) })
    return () => { current = false }
  }, [open, accountId, target.seriesId, target.bookingId, target.index, retry, scope, newStartsAt, mode])
  const items = all ? (scope === 'this' ? all.slice(0, 1) : all) : null

  const changing = mode === 'change'
  const blockedIds = new Set(Object.values(impact ?? {}).filter((i) => i.blocked).map((i) => i.bookingId))
  const count = (items ?? []).filter((i) => !blockedIds.has(i.id)).length
  const last = items?.length ? items[items.length - 1].starts_at : target.startsAt
  const newTime = newStartsAt ? hm(newStartsAt) : ''

  async function run() {
    if (!items || !impact || count === 0 || (changing && !newStartsAt)) return
    setBusy(true); setError('')
    try {
      if (changing && newStartsAt) {
        const res = await bookingSeriesApi.change(accountId, target.seriesId, { scope, fromBookingId: target.bookingId, change: { startsAt: newStartsAt }, expectedVersion: version })
        const { changed, conflicts } = res.data
        notifySaved(conflicts.length ? `${formatNumber(changed.length)} 件を変えました（${formatNumber(conflicts.length)} 件は埋まっていて前のままです）` : `${formatNumber(changed.length)} 件を変えました`)
        onDone({ count: changed.length })
      } else {
        const res = await bookingSeriesApi.cancel(accountId, target.seriesId, { scope, fromBookingId: target.bookingId, expectedVersion: version })
        const fee = res.data.fees.reduce((n, f) => n + f.feeNow, 0)
        notifySaved(fee > 0 ? `${formatNumber(res.data.cancelled.length)} 件を取り消しました（キャンセル料の見込み ${yen(fee)}）` : `${formatNumber(res.data.cancelled.length)} 件を取り消しました`)
        onDone({ count: res.data.cancelled.length })
      }
    } catch {
      setError(changing ? '変えられませんでした。画面を読み直してからもう一度お試しください。' : '取り消せませんでした。画面を読み直してからもう一度お試しください。')
    } finally { setBusy(false) }
  }

  return (
    <Dialog
      open={open}
      size="medium"
      designWidth={560}
      designTop={170}
      title={changing ? '繰り返しの予約を変えますか？' : '繰り返しの予約を取り消しますか？'}
      description={`${withHonorific(target.customerName, 'さん', { space: true })}・${target.ruleText}・${target.menuName}・${target.index} 回目 ${dayOf(target.startsAt)}`}
      tone={changing ? 'default' : 'destructive'}
      confirmation
      confirmLabel={`${formatNumber(count)} 件を${changing ? '変更する' : '取り消す'}`}
      busyLabel={changing ? '変えています…' : '取り消しています…'}
      confirmDisabled={!items || !impact || count === 0 || (changing && !newStartsAt)}
      footerAlign="center"
      busy={busy}
      error={error || undefined}
      onConfirm={run}
      onCancel={onClose}
    >
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      <div className={styles.body}>
        <RadioCardGroup legend="どこまで" columns={2}>
          <RadioCard name="series-scope" value="this" checked={scope === 'this'} onChange={() => setScope('this')} title="この回だけ"
            note={changing ? `${dayWithWeekday(target.startsAt)}だけ ${newTime} に変える` : `${dayWithWeekday(target.startsAt)}だけ取り消す。${all && all.length > 1 ? `${dayOf(all[all.length - 1].starts_at)} までの ${all.length - 1} 件は続く` : ''}`} />
          <RadioCard name="series-scope" value="following" checked={scope === 'following'} onChange={() => setScope('following')} title={`この回から後ぜんぶ（${all ? all.length : '…'} 件）`}
            note={changing ? `${dayOf(target.startsAt)} から ${dayOf(last)} まで ${newTime} に変える。埋まっている回は前のまま` : `${dayOf(target.startsAt)} から ${dayOf(last)} まで取り消す。繰り返しはここで終わる`} />
        </RadioCardGroup>
        <h3 className={styles.heading}>{changing ? (items && count !== items.length ? `変わる日（${formatNumber(items.length)} 件のうち ${formatNumber(count)} 件）` : `変わる日（${items?.length ?? '…'} 件）`) : `取り消す日（${items?.length ?? '…'} 件）`}</h3>
        {loadError ? <Notice tone="danger">対象の日とキャンセル料の見込みを確認できませんでした。<SharedButton variant="text" size="inline" data-notice-inline-action type="button" onClick={() => setRetry((n) => n + 1)}>もう一度</SharedButton></Notice> : null}
        {!loadError ? <DataTable aria-busy={!items}>
          <thead><Tr><Th>日</Th><Th>{changing ? '前' : '時間'}</Th><Th>{changing ? '後' : 'キャンセル料'}</Th></Tr></thead>
          <tbody>
            {(items ?? []).map((item) => (
              <Tr key={item.id} data-blocked={(changing && blockedIds.has(item.id)) || undefined}>
                <Td>{dayWithWeekday(item.starts_at)}</Td>
                <Td>{hm(item.starts_at)}</Td>
                <Td><span className={(changing ? blockedIds.has(item.id) : impact?.[item.id]?.fee) ? styles.feeNotice : undefined}>
                  {changing ? (blockedIds.has(item.id) ? `埋まっています・${hm(item.starts_at)} のまま` : impact?.[item.id]?.after ? hm(impact[item.id].after!) : newTime)
                    : impact ? (impact[item.id]?.fee ? `${yen(impact[item.id].fee!.amount)}（${impact[item.id].fee!.percent}%・${impact[item.id].fee!.reason}）` : 'かかりません')
                    : '確認できません'}
                </span></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable> : null}
        {changing || impact ? null : <p className={styles.note}>取り消すと元に戻せません。キャンセル料は期限を過ぎた回だけに掛かり、取り消しの結果の知らせに見込みの金額が出ます（請求は予約の詳細の「お支払い」から）。</p>}
        <Checkbox checked={false} onCheckedChange={() => preparing.open('LINE でのお知らせ')}>{withHonorific(target.customerName, 'さん', { space: true })}に LINE で知らせる（{changing ? '変わった日と時間' : '取り消した日'}）</Checkbox>
        {preparing.dialog}
      </div>
    </Dialog>
  )
}
