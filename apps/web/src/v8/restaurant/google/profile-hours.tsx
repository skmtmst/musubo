'use client'
import { useGooglePermission } from './use-google-permission'
import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import DateField from '@/components/shared/date-field'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import Select from '@/components/shared/select'
import StickyBar from '@/components/shared/sticky-bar'
import { Tabs } from '@/components/shared/tabs'
import { TextArea } from '@/components/shared/text-field'
import { ApiError } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { restaurantGoogleApi, type GoogleDayHours, type GoogleHoursPeriod, type GoogleHoursProposal, type GoogleProfileData, type GoogleWeekday, type GoogleWeeklyHours } from '@/lib/restaurant-google-api'
import { errorMessage, formatPeriods, formatYmdShort, weekdayOf, TIME_OPTIONS, WEEKDAYS, WEEKDAY_JA } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { ToggleField } from '@/components/shared/toggle'


export type HoursMode = 'text' | 'calendar' | 'weekly'
const samePeriods = (a: GoogleHoursPeriod[], b: GoogleHoursPeriod[]) => formatPeriods(a, '-') === formatPeriods(b, '-')
function addDays(date: string, days: number) { return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10) }

function periodsProblem(periods: GoogleHoursPeriod[]): string | null {
  if (periods.length > 3) return '1日の枠は3つまでです'
  const min = (v: string) => Number.parseInt(v.slice(0, 2), 10) * 60 + Number.parseInt(v.slice(3, 5), 10)
  const sorted = [...periods].sort((a, b) => min(a.open) - min(b.open))
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i]
    if (cur.open === cur.close) return '開始と終了が同じ時刻です'
    const close = cur.close === '00:00' ? 24 * 60 : min(cur.close)
    const overnight = close <= min(cur.open)
    if (overnight && i !== sorted.length - 1) return '翌日にまたぐ枠は、その日の最後の枠にしてください'
    const next = sorted[i + 1]
    if (next && !overnight && min(next.open) < close) return '枠が重なっています'
  }
  return null
}

/** 変更前後の枠を比べ、枠数が同じなら変わった枠だけを「17:00–22:00 → 17:00–23:00」の形で返す。 */
function periodDiff(before: GoogleHoursPeriod[], after: GoogleHoursPeriod[]): [string, string] {
  if (before.length === after.length && before.length > 0) {
    const changed = before.map((p, i) => [p, after[i]] as const).filter(([b, a]) => b.open !== a.open || b.close !== a.close)
    if (changed.length > 0) return [formatPeriods(changed.map(([b]) => b)), formatPeriods(changed.map(([, a]) => a))]
  }
  return [formatPeriods(before, '定休日'), formatPeriods(after, '定休日')]
}

export function HoursEditor({ accountId, mode, initialDate, go }: { accountId: string; mode: HoursMode; initialDate?: string | null; go: GoogleNav }) {
  const saveErrors = useSaveFormErrors()
  const { allowed: canEdit, lockedReason } = useGooglePermission('manager')
  const submitLock = useRef(false)
  const [data, setData] = useState<GoogleProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [text, setText] = useState('')
  const [question, setQuestion] = useState('')
  const [days, setDays] = useState<Record<string, GoogleDayHours>>({})
  const [selectedDate, setSelectedDate] = useState<string>(initialDate ?? '')
  const [weekly, setWeekly] = useState<GoogleWeeklyHours | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    restaurantGoogleApi.profile(accountId)
      .then((response) => {
        if (!alive) return
        setData(response)
        setWeekly(response.profile.regularHours)
        const start = initialDate && initialDate >= response.today.date ? initialDate : response.today.date
        setSelectedDate(start)
      })
      .catch((err) => { if (alive) setLoadError(errorMessage(err, 'プロフィールを読み込めませんでした。')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [accountId, initialDate])

  const weeklyChanged = useMemo(() => (data && weekly ? WEEKDAYS.filter((d) => !samePeriods(weekly[d] ?? [], data.profile.regularHours[d] ?? [])) : []), [data, weekly])
  const dirty = mode === 'text' ? text.trim().length > 0 : mode === 'calendar' ? Object.keys(days).length > 0 : weeklyChanged.length > 0
  const { leaveTarget, confirmLeave, cancelLeave, guarded, disarm } = useUnsavedGuard({ dirty, busy })

  const clear = () => {
    setText('')
    setQuestion('')
    setDays({})
    setActionError('')
    if (data) setWeekly(data.profile.regularHours)
  }

  const submit = async () => {
    if (!data || submitLock.current || !canEdit || data.closed || !dirty || (mode === 'text' && !data.aiAvailable)) return
    let proposal: GoogleHoursProposal
    if (mode === 'text') proposal = { source: 'text', text: text.trim() }
    else if (mode === 'calendar') {
      const list = Object.values(days)
      const bad = list.map((d) => (d.remove || d.closed ? null : d.periods.length === 0 ? '営業する日は枠を1つ以上入れてください' : periodsProblem(d.periods))).find(Boolean)
      if (bad) { setActionError(bad); return }
      proposal = { source: 'calendar', days: list }
    } else {
      const bad = WEEKDAYS.map((d) => { const p = periodsProblem(weekly![d] ?? []); return p ? `${WEEKDAY_JA[d]}曜：${p}` : null }).find(Boolean)
      if (bad) { setActionError(bad); return }
      proposal = { source: 'weekly', weekly: weekly! }
    }
    submitLock.current = true
    setBusy(true)
    setActionError('')
    setQuestion('')
    try {
      const response = await restaurantGoogleApi.proposeHours(accountId, proposal)
      if (response.change) {
        setDays({}); setText(''); if (data) setWeekly(data.profile.regularHours)
        disarm()
        go({ tab: 'profile', view: 'confirm', id: response.change.id })
      } else setQuestion(response.question ?? 'もう少し具体的に教えてください。')
    } catch (err) {
      saveErrors.capture(err)
      setActionError(err instanceof ApiError && err.code === 'unchanged' ? 'すでにその営業時間になっています。' : errorMessage(err, '変更案を作れませんでした。'))
    } finally {
      submitLock.current = false
      setBusy(false)
    }
  }

  if (loading) return <ListState kind="loading" title="営業時間を読み込んでいます" />
  if (loadError || !data || !weekly) return <ListState kind="error" title="営業時間を表示できませんでした" description={loadError} onRetry={() => go({ tab: 'profile', view: 'hours', mode })} />

  const { profile, today, timeZone } = data
  const storeName = profile.title ?? data.store.name
  const canSubmit = canEdit && !busy && dirty && !data.closed && (mode !== 'text' || data.aiAvailable)

  const editable = canEdit && !busy && !data.closed
  const editedDates = Object.keys(days).sort()
  const regularFor = (date: string): GoogleDayHours => ({ date, closed: (profile.regularHours[weekdayOf(date)] ?? []).length === 0, periods: profile.regularHours[weekdayOf(date)] ?? [] })
  const originalFor = (date: string): GoogleDayHours => {
    const special = profile.specialHours.find((item) => item.date === date)
    return special ? { ...special, special: true } : { ...regularFor(date), special: false }
  }
  const original = selectedDate ? originalFor(selectedDate) : null
  const edited = selectedDate ? days[selectedDate] ?? original : null
  const setDay = (day: GoogleDayHours) => setDays((values) => ({ ...values, [day.date]: day }))
  const undoDay = (date: string) => setDays((values) => { const next = { ...values }; delete next[date]; return next })
  const describeDay = (day: GoogleDayHours) => day.remove ? `特別営業時間を外す → 通常 ${formatPeriods(regularFor(day.date).periods, '定休日')}` : day.closed ? (day.special ? '休業（特別営業時間）' : '定休日') : formatPeriods(day.periods)

  return (
    <SaveErrorScope errors={saveErrors}><>
      <SectionHeader title="営業時間を変更" description={`対象店舗：${storeName} / 基準日：${formatYmdShort(today.date)} / ${timeZone}`} />
      <Tabs size="compact" label="営業時間の変更方式" items={([
        ['text', 'かんたん入力'], ['calendar', 'カレンダーで指定'], ['weekly', '毎週の営業時間'],
      ] as const).map(([key, label]) => ({ label, current: mode === key, onClick: () => guarded(() => go({ tab: 'profile', view: 'hours', mode: key })) }))} />
      {data.closed ? <Notice tone="danger">Google側で「臨時休業」または「閉業」になっているため、営業時間は変更できません。</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {mode === 'text' ? <>
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
          <SectionHeader size="small" title="いつ、何時に変更しますか？" />
          <Field label="文章で入力" htmlFor="gb-hours-text"><SaveErrorField names={["text"]}><TextArea id="gb-hours-text" value={text} onChange={(event) => { setText(event.target.value); setQuestion('') }} rows={4} maxLength={500} placeholder="例：今週の金曜日は9:00から17:00オープンにして" disabled={!editable || !data.aiAvailable} /></SaveErrorField></Field>
          <div className={styles.buttonRow}>
            <Button lockedReason={lockedReason} onClick={() => { if (!canEdit) return; setText('今日を休みにして'); setQuestion('') }} disabled={!editable || !data.aiAvailable}>今日を休みにして</Button>
            <Button lockedReason={lockedReason} onClick={() => { if (!canEdit) return; setText('明日は20時に閉店'); setQuestion('') }} disabled={!editable || !data.aiAvailable}>明日は20時に閉店</Button>
          </div>
          {!data.aiAvailable ? <Notice tone="warn">この環境ではかんたん入力（AI）は使えません。「カレンダーで指定」または「毎週の営業時間」から変更してください。</Notice> : null}
          {question ? <Notice tone="warn">{question}</Notice> : null}
          <Notice tone="info">AIは変更案を作成するだけです。この画面ではGoogleの営業時間は変わりません。日付があいまいな場合は対象の日付を確認します。</Notice>
        </Card>
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label="変更対象の確認">
          <SectionHeader size="small" title={`現在の${WEEKDAY_JA[today.weekday]}曜日`} />
          <p className={styles.todayHours}>{formatPeriods(profile.regularHours[today.weekday] ?? [], '定休日')}</p>
          <p className={styles.muted}>文章から「いつ・何時に」を読み取り、1日だけの特別営業時間または毎週の営業時間の変更案を作ります。毎週変えたい場合は「毎週の営業時間」から設定してください。</p>
        </Card>
      </> : mode === 'calendar' ? <>
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
          <SectionHeader size="small" title="日付を選んで、その日の営業時間を決めます" />
          <Field label="変更する日" htmlFor="gb-hours-day"><SaveErrorField names={["selectedDate","selected_date"]}><DateField id="gb-hours-day" aria-label="変更する日" value={selectedDate} onChange={setSelectedDate} min={today.date} max={addDays(today.date, 366)} /></SaveErrorField></Field>
          {profile.specialHours.length ? <dl className={styles.facts} aria-label="登録済みの特別営業時間">{profile.specialHours.map((day) => <div key={day.date} className={styles.factRow}>
            <dt className={styles.factKey}><Button variant="text" textTone="ink" disabled={day.date < today.date || day.date > addDays(today.date, 366)} onClick={() => setSelectedDate(day.date)}>{formatYmdShort(day.date)}</Button></dt>
            <dd className={styles.factValue}>{day.closed ? '休業' : formatPeriods(day.periods)}</dd>
          </div>)}</dl> : null}
        </Card>
        {edited && original ? <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label={`${formatYmdShort(edited.date)}の営業時間`}>
          <SectionHeader size="small" title={`${formatYmdShort(edited.date)}の営業時間`} />
          <p className={styles.muted}>現在：{describeDay(original)}{original.special ? '（特別営業時間として登録済み）' : ''}</p>
          {edited.remove ? <Notice tone="warn" action={<Button variant="text" onClick={() => undoDay(edited.date)} disabled={!editable}>外すのをやめる</Button>}>この日の特別営業時間を外し、通常の営業時間（{formatPeriods(regularFor(edited.date).periods, '定休日')}）に戻します。</Notice> : <>
            <ToggleField lockedReason={lockedReason} checked={edited.closed} disabled={!editable} onChange={(next) => setDay({ ...edited, closed: next, periods: next ? [] : (profile.regularHours[weekdayOf(edited.date)] ?? []) })}>この日は休業にする</ToggleField>
            {!edited.closed ? <HoursPeriods periods={edited.periods} label="" disabled={!editable} readOnly={!canEdit} onChange={(periods) => setDay({ ...edited, periods })} /> : null}
            {!edited.closed && edited.periods.length === 0 ? <Notice tone="warn">営業する日は枠を1つ以上入れてください（休業なら上の「この日は休業にする」にチェックを入れてください）。</Notice> : null}
            {original.special ? <Button lockedReason={lockedReason} disabled={!editable} onClick={() => setDay({ ...regularFor(edited.date), remove: true })}>特別営業時間を外す（通常の営業時間に戻す）</Button> : null}
          </>}
        </Card> : null}
        {editedDates.length ? <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label="変更する日の一覧">
          <SectionHeader size="small" title={`変更する日（${editedDates.length}日）`} />
          {editedDates.map((date) => <div key={date} className={styles.buttonRow}>
            <Button variant="text" textTone="ink" onClick={() => setSelectedDate(date)}>{formatYmdShort(date)}</Button>
            <span className={styles.muted}>{describeDay(originalFor(date))} → {describeDay(days[date])}</span>
            <Button disabled={busy} onClick={() => undoDay(date)}>この日の変更を取り消す</Button>
          </div>)}
        </Card> : null}
        <Notice tone="info">ここで決めた内容は、その日だけの特別営業時間になります。「変更案を確認する」を押すまでGoogleの営業時間は変わりません。</Notice>
      </> : <>
        <SectionHeader size="small" title="毎週の営業時間（通常の営業時間）を決めます" />
        {WEEKDAYS.map((day) => {
          const periods = weekly[day] ?? []
          const setPeriods = (values: GoogleHoursPeriod[]) => setWeekly({ ...weekly, [day]: values })
          return <Card key={day} appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label={`${WEEKDAY_JA[day]}曜の営業時間`}>
            <SectionHeader size="small" title={`${WEEKDAY_JA[day]}曜${weeklyChanged.includes(day) ? '（変更）' : ''}`} />
            {/* 保存（確かめて送る）してから効くのでチェック（決まり14：スイッチはその場で効く物だけ）。 */}
            <ToggleField lockedReason={lockedReason} checked={periods.length === 0} disabled={!editable} onChange={(next) => setPeriods(next ? [] : (profile.regularHours[day]?.length ? profile.regularHours[day] : [{ open: '11:00', close: '22:00' }]))}>{`${WEEKDAY_JA[day]}曜を定休日にする`}</ToggleField>
            {periods.length ? <HoursPeriods periods={periods} label={`${WEEKDAY_JA[day]}曜 `} disabled={!editable} readOnly={!canEdit} removeLastOnly onChange={setPeriods} /> : <p className={styles.muted}>定休日</p>}
          </Card>
        })}
        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label="変更した曜日">
          <SectionHeader size="small" title={`変更した曜日（${weeklyChanged.length}）`} />
          {weeklyChanged.length ? weeklyChanged.map((day) => { const [before, after] = periodDiff(profile.regularHours[day] ?? [], weekly[day] ?? []); return <p key={day} className={styles.muted}>{WEEKDAY_JA[day]}曜：{before} → {after}</p> }) : <p className={styles.muted}>まだ変更はありません。</p>}
          <p className={styles.muted}>変えていない曜日はそのままです。特定の日だけ変えたい場合は「カレンダーで指定」から設定してください。</p>
        </Card>
        <Notice tone="info">ここで変えた曜日は、毎週その時間になります。「変更案を確認する」を押すまでGoogleの営業時間は変わりません。特別営業時間が設定されている日は、そちらが優先されます。</Notice>
      </>}
      {mode !== 'text' ? <p className={styles.muted}>15分刻みで選べます。翌日にまたぐ時間（例：18:00 – 02:00）はそのまま入力できます。</p> : null}
      <StickyBar actions={<><Button lockedReason={lockedReason} onClick={clear} disabled={!canEdit || busy || !dirty}>入力をクリア</Button><Button lockedReason={lockedReason} variant="primary" onClick={() => void submit()} disabled={!canSubmit} busy={busy} busyLabel="確認中…">変更案を確認する</Button></>} />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した営業時間の変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}

function HoursPeriods({ periods, label, disabled, readOnly = false, removeLastOnly = false, onChange }: { periods: GoogleHoursPeriod[]; label: string; disabled: boolean; readOnly?: boolean; removeLastOnly?: boolean; onChange: (periods: GoogleHoursPeriod[]) => void }) {
  const { allowed, lockedReason } = useGooglePermission('manager')
  const problem = periodsProblem(periods)
  return <>
    {periods.map((period, index) => <Card key={index} appearance="outlined" layout="vertical" padding="compact" gap="normal">
      {(['open', 'close'] as const).map((kind) => <Field key={kind} label={`${label}枠${index + 1}の${kind === 'open' ? '開始' : '終了'}`}>
        <Select size="full" aria-label={`${label}枠${index + 1}の${kind === 'open' ? '開始' : '終了'}`} value={period[kind]} disabled={disabled || readOnly || !allowed} options={TIME_OPTIONS.map((time) => ({ value: time, label: kind === 'close' && time === '00:00' ? '24:00' : time }))} onChange={(value) => onChange(periods.map((item, at) => at === index ? { ...item, [kind]: value } : item))} />
      </Field>)}
      {(!removeLastOnly || (periods.length > 1 && index === periods.length - 1)) ? <Button lockedReason={lockedReason} disabled={disabled || readOnly || !allowed} onClick={() => { if (!disabled && !readOnly && allowed) onChange(periods.filter((_, at) => at !== index)) }} aria-label={`${label}枠${index + 1}を削除`}>枠を削除する</Button> : null}
    </Card>)}
    {problem ? <Notice tone="warn">{problem}</Notice> : null}
    <Button lockedReason={lockedReason} disabled={disabled || readOnly || !allowed || periods.length >= 3} onClick={() => { if (!disabled && !readOnly && allowed) onChange([...periods, { open: periods[periods.length - 1]?.close ?? '11:00', close: '22:00' }]) }}>枠を追加（1日3枠まで）</Button>
  </>
}
