'use client'

import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import { isConflictResponse } from '@/components/shared/save-conflict'

import { Field } from '@/components/shared/form-controls'

import Notice from '@/components/shared/notice'

import { DataTable, Tr, Th, Td } from '@/components/shared/table'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarX2 } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Drawer from '@/components/shared/drawer'
import Dialog from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import SegmentedControl from '@/components/shared/segmented'
import Toggle from '@/components/shared/toggle'
import NumberField from '@/components/shared/number-field'
import { Skeleton } from '@/components/shared/skeleton'
import { notifySaved } from '@/components/shared/toast'
import { bookingSeriesApi } from '@/lib/api/helpers/gap2'
import type { RecurrenceFrequency as SeriesFreq, SeriesOccurrence } from '@line-crm/shared'
import { reasonText, createdCount, dayOf, dayWithWeekday, FREQ_OPTIONS, hm, initialPick, ruleLabel, weekdayOf, type Pick } from './series-model'
import styles from './series-drawer.module.css'
import { formatNumber } from '@/lib/format'
import { withHonorific } from '@line-crm/shared'

export type SeriesDrawerSummary = {
  customerName: string
  friendId: string
  menuId: string
  menuName: string
  durationMin: number
  staffId: string | null
  staffName: string
  startsAt: string
  endsAt: string
  timeZone?: string
}

const MIN = 2
const MAX = 52

/*
 * 予約管理 › 予約を入れる（引き出し）の「繰り返す」段（B4-1・Oo8mZ）。
 * 保存の前に必ず「取れない回」を見せ、回ごとに［別の時間］［飛ばす］を選ばせる。取れない回を黙って作らない。
 * 保存は全部か無し：その間に埋まった回があれば何も作らず、表を出し直す（B4-03）。動きは BEHAVIOR.md。
 */
export default function SeriesBookingDrawer({ open, accountId, summary, onClose, onCreated }: {
  open: boolean
  accountId: string
  summary: SeriesDrawerSummary
  onClose: () => void
  onCreated: (result: { seriesId: string; created: number }) => void
}) {
  const saveErrors = useSaveFormErrors()
  const [on, setOn] = useState(true)
  const [freq, setFreq] = useState<SeriesFreq>('weekly')
  const [countText, setCountText] = useState('8')
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [list, setList] = useState<SeriesOccurrence[]>([])
  const [unreadable, setUnreadable] = useState(false)
  const [unavailableDismissed, setUnavailableDismissed] = useState(false)
  const [picks, setPicks] = useState<Record<number, Pick>>({})
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const key = useRef(crypto.randomUUID())

  const count = /^\d+$/.test(countText) ? Number(countText) : NaN
  const countOk = Number.isInteger(count) && count >= MIN && count <= MAX

  useEffect(() => {
    if (!open) return
    setUnavailableDismissed(false); setOn(true); setFreq('weekly'); setCountText('8'); setPicks({}); setConflict(false); setError(''); key.current = crypto.randomUUID()
  }, [open])

  /* 確かめ直す：入力が止まってから。古い返事は捨てる。 */
  useEffect(() => {
    if (!open || !on || !countOk) { setState('idle'); setList([]); return }
    let current = true
    setState('loading')
    const timer = setTimeout(() => {
      void bookingSeriesApi.preview(accountId, {
        menuId: summary.menuId,
        friendId: summary.friendId,
        staffId: summary.staffId,
        startsAt: summary.startsAt,
        rule: { freq, weekday: weekdayOf(summary.startsAt, summary.timeZone), count },
      }).then((res) => {
        if (!current) return
        setList(res.data.occurrences)
        setUnavailableDismissed(false)
        setUnreadable(res.data.occurrences.some((o) => !o.available && (o.reason === 'calendar_unreadable' || o.reason === 'calendar_unavailable')))
        setPicks(Object.fromEntries(res.data.occurrences.map((o) => [o.index, initialPick(o)])))
        setState('ready')
      }).catch(() => { if (current) setState('error') })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [open, on, countOk, count, freq, accountId, summary.menuId, summary.staffId, summary.friendId, summary.startsAt, summary.timeZone, retry])

  const blocked = useMemo(() => list.filter((o) => !o.available), [list])
  const made = createdCount(list, picks)
  const skipped = list.filter((o) => !o.available && (picks[o.index] ?? 'skip') === 'skip')
  const canSave = !on ? false : state === 'ready' && made > 0 && !busy

  async function save() {
    if (!canSave) return
    setBusy(true); setError(''); setConflict(false)
    try {
      const res = await bookingSeriesApi.create(accountId, {
        menuId: summary.menuId, staffId: summary.staffId, friendId: summary.friendId, startsAt: summary.startsAt,
        rule: { freq, weekday: weekdayOf(summary.startsAt, summary.timeZone), count },
        /* 口の選択は「そのまま」と「飛ばす」。別の時間は、その回の keep に新しい開始を添える。 */
        choices: list.map((o) => {
          const pick = picks[o.index] ?? 'skip'
          if (pick === 'alternative' && o.alternatives[0]) return { index: o.index, action: 'keep' as const, alternativeStartsAt: o.alternatives[0] }
          return { index: o.index, action: pick === 'skip' ? 'skip' as const : 'keep' as const }
        }),
      }, key.current)
      notifySaved(`${formatNumber(res.data.bookings.length)} 件の予約を入れました`)
      onCreated({ seriesId: res.data.series.id, created: res.data.bookings.length })
    } catch (e) {
      saveErrors.capture(e)
      /* 保存の間に埋まった回があれば口は何も作らず 409 を返す（全部か無し）。表を確かめ直す。 */
      if (isConflictResponse(e)) { setConflict(true); setRetry((n) => n + 1) }
      else setError('予約を入れられませんでした。もう一度お試しください。')
    } finally { setBusy(false) }
  }

  const last = list.length ? list[list.length - 1].startsAt : summary.startsAt

  return (<SaveErrorScope errors={saveErrors}>{(
    <>
    <FormLeaveGuard dirty={open && on && state !== 'idle'} busy={busy} />
    <Drawer
      open={open}
      title="予約を入れる"
      description={`${withHonorific(summary.customerName, 'さん', { space: true })}・${summary.menuName} ${summary.durationMin} 分`}
      closeAppearance="box"
      width="editor"
      heightMode="viewport"
      busy={busy}
      error={error || undefined}
      dirty={on && state !== 'idle'}
      showDirtyIndicator={false}
      onClose={onClose}
      footer={<div className={styles.footer}>
        <Button variant="secondary" onClick={onClose} disabled={busy}>キャンセル</Button>
        <Button variant="primary" onClick={save} busy={busy} disabled={!canSave} busyLabel="入れています…">{on ? `${made} 件を入れる` : '予約を入れる'}</Button>
      </div>}
    >
      <div className={styles.body}>
        <Card as="section" className={styles.summaryFrame} padding="default" gap="tight" aria-label="予約の概要">
          <dl className={styles.summary}>
            <div><dt>日時</dt><dd>{dayWithWeekday(summary.startsAt, summary.timeZone)} {hm(summary.startsAt, summary.timeZone)}〜{hm(summary.endsAt, summary.timeZone)}</dd></div>
            <div><dt>担当</dt><dd>{summary.staffName}</dd></div>
          </dl>
        </Card>
        <Card as="section" className={styles.card} padding="default" gap="normal" aria-label="繰り返す">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>繰り返す<HelpTip label="繰り返すの説明">毎週・隔週・毎月の同じ曜日・同じ時間で、まとめて予約を入れます。取れない回は保存の前に表で選びます。</HelpTip></h3>
            <Toggle label="繰り返す" checked={on} onChange={setOn} />
          </div>
          {on ? <>
            <div className={styles.controls}>
              <SegmentedControl aria-label="繰り返しの間隔" size="booking" options={FREQ_OPTIONS} value={freq} onChange={setFreq} />
              <Field label="回数">
                <SaveErrorField names={["count","rule.count"]}><NumberField numericText unit="回" value={countText} onChange={(event) => setCountText(event.target.value)} aria-label="回数" invalid={countText !== '' && !countOk} /></SaveErrorField>
              </Field>
            </div>
            {!countOk ? <Notice tone="warn" role="alert">回数は {MIN} 回から {MAX} 回までです。</Notice> : null}
            {countOk && state !== 'idle' ? <p className={styles.range}>{dayOf(summary.startsAt, summary.timeZone)} から {state === 'ready' ? dayOf(last, summary.timeZone) : '…'} まで、{ruleLabel(freq, summary.startsAt, summary.timeZone)}（{formatNumber(count)} 回）</p> : null}
            {state === 'loading' ? <Skeleton height={48} /> : null}
            {state === 'error' ? <Notice tone="danger">空きを確かめられませんでした。<Button variant="text" onClick={() => setRetry((n) => n + 1)}>もう一度</Button></Notice> : null}
            {state === 'ready' && unreadable ? <p className={styles.range}>空きを確かめられない回があります。その回は作りません。</p> : null}
            {state === 'ready' && conflict ? <Notice tone="warn" role="alert">その間に埋まった回があります。表を確かめ直してください。</Notice> : null}
            {state === 'ready' && blocked.length === 0 && !unreadable ? <p className={styles.allOk}>{formatNumber(list.length)} 回すべて取れます</p> : null}
            {state === 'ready' && blocked.length > 0 ? <>
              <span className={styles.badge}><CalendarX2 aria-hidden="true" size={16} />取れない回 {formatNumber(blocked.length)} 件</span>
              <DataTable>
                <thead><Tr><Th>日</Th><Th>理由</Th><Th>どうするか</Th></Tr></thead>
                <tbody>
                  {blocked.map((o) => {
                    const alt = o.alternatives[0]
                    const pick = picks[o.index] ?? 'skip'
                    return (
                      <Tr key={o.index}>
                        <Td>{dayWithWeekday(o.startsAt, summary.timeZone)}</Td>
                        <Td><div className={styles.reason}><span>{reasonText(o.reason)}</span><span className={alt ? styles.alt : styles.sub}>{alt ? `→ ${hm(alt, summary.timeZone)} にする` : 'この回は作りません'}</span></div></Td>
                        <Td>
                          <SegmentedControl aria-label={`${dayOf(o.startsAt, summary.timeZone)} の回`} size="compact" value={pick === 'skip' || !alt ? 'skip' : 'alternative'}
                            options={[{ value: 'alternative', label: '別の時間' }, { value: 'skip', label: '飛ばす' }]}
                            onChange={(next) => { if (next === 'alternative' && !alt) return; setPicks((p) => ({ ...p, [o.index]: next })) }} />
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataTable>
            </> : null}
          </> : null}
        </Card>
        {on && state === 'ready' ? <p className={styles.note}>{formatNumber(list.length)} 回のうち {made} 件を入れます{skipped.length ? `（${skipped.map((o) => dayOf(o.startsAt, summary.timeZone)).join('・')} は飛ばす）` : ''}。保存の直前に空きを確かめ直します。</p> : null}
      </div>
    </Drawer>
    <Dialog open={open && state === 'ready' && unreadable && !unavailableDismissed} title="この回は予約できません" size="small" contentLayout="form"
      description="担当者の予定を確認できないため、空きを確かめられません。"
      cancelLabel="キャンセル" confirmLabel="別の日時を選ぶ" onCancel={() => setUnavailableDismissed(true)} onConfirm={onClose}>
      {list.filter(item => !item.available && (item.reason === 'calendar_unavailable' || item.reason === 'calendar_unreadable')).map(item => <p key={item.index}>{dayWithWeekday(item.startsAt, summary.timeZone)} {hm(item.startsAt, summary.timeZone)}　確認できません</p>)}
    </Dialog>
    </>
  )}</SaveErrorScope>)
}
