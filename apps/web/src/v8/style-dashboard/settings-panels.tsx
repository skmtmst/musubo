'use client'
import { ClosureOverlapStep,type OverlapRow } from '@/components/shared/booking-confirm-dialogs'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import Dialog from '@/components/shared/dialog'
import Drawer from '@/components/shared/drawer'
import FilterChip from '@/components/shared/filter-chip'
import { Field } from '@/components/shared/form-controls'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import IconButton from '@/components/shared/icon-button'
import SegmentedControl from '@/components/shared/segmented'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import TimeFieldV8 from '@/components/shared/time-field-v8'
import Toggle from '@/components/shared/toggle'
import { Steps } from '@/components/templates/steps'
import { ArrowDown,ArrowUp,CalendarX2,Info,Lock,RotateCcw,Scissors,Shapes } from 'lucide-react'
import { useEffect,useRef,useState } from 'react'
import type { StyleClosureInput,StyleLayout,StyleLayoutItem,StyleKpi,IndustryStyle } from './model'
import styles from './style-dashboard.module.css'
import { metricOptions } from './metric-selection'
import { formatNumber } from '@/lib/format'

/*
 * ［表示を変える］の引き出し（wFmQa・ 追記 7・8・ の 7）：
 * 数の帯（5 つまで）と横のカードの出し入れ・上下の入れ替え・型に戻す・カードを足す。
 * 接続の異常の帯は隠せない（必ず出る）。
 */
export function ViewDrawer({ open, layout, industry, defaultMetrics = [], busy, onClose, onSave, onReset, onChangeStyle }: {
  open: boolean
  layout: StyleLayout | null
  industry: IndustryStyle
  defaultMetrics?: StyleKpi[]
  busy: boolean
  onClose: () => void
  onSave: (next: StyleLayoutItem[], metricIds?: string[]) => void
  onReset: () => void
  /** ［型を変える］（ 追記 6）：業種の型を選び直す。データはそのまま。 */
  onChangeStyle: (style: 'restaurant' | 'salon' | 'consult' | 'lesson' | 'standard') => void
}) {
  const [picking, setPicking] = useState(false)
  const [nextStyle, setNextStyle] = useState<'restaurant' | 'salon' | 'consult' | 'lesson' | 'standard'>('salon')
  const [cards, setCards] = useState<StyleLayoutItem[]>([])
  const [metricIds, setMetricIds] = useState<string[]>([])
  const defaultIdsKey = JSON.stringify(defaultMetrics.map(item => item.metricId ?? item.id))
  const initialIdsKey = layout?.metricsCustomized === true ? JSON.stringify(layout.metricIds ?? []) : defaultIdsKey
  const metricsReady = typeof layout?.metricsCustomized === 'boolean' && Array.isArray(layout.metricIds) && (layout.metricsCustomized || defaultMetrics.length > 0)
  useEffect(() => { if (open && layout) { setCards(layout.cards); setMetricIds(JSON.parse(initialIdsKey) as string[]) } }, [open, layout, initialIdsKey])
  const metricsDirty = metricsReady && JSON.stringify(metricIds) !== initialIdsKey
  const defaultIds = JSON.parse(defaultIdsKey) as string[]
  const metricChanges = layout?.metricsCustomized === true ? Array.from({ length: Math.max(layout.metricIds?.length ?? 0, defaultIds.length) }, (_, index) => layout.metricIds?.[index] !== defaultIds[index]).filter(Boolean).length : 0
  const dirty = Boolean(layout) && (JSON.stringify(cards) !== JSON.stringify(layout?.cards) || metricsDirty)
  const availableMetrics = metricOptions(defaultMetrics, industry)
  const orderedMetrics = [...metricIds.map(id => availableMetrics.find(option => option.id === id) ?? { id, label: '表示できない項目' }), ...availableMetrics.filter(option => !metricIds.includes(option.id))]
  const moveMetric = (index: number, step: -1 | 1) => setMetricIds(list => { const next = [...list]; const [item] = next.splice(index, 1); next.splice(index + step, 0, item); return next })
  const move = (index: number, step: -1 | 1) => setCards((list) => { const next = [...list]; const [item] = next.splice(index, 1); next.splice(index + step, 0, item); return next })
  const shown = cards.filter((c) => !c.locked)
  return (
    <Drawer open={open} title="表示を変える" titleAccessory={<HelpTip label="表示を変えるの説明">ダッシュボードに出すカードを選び、上下を入れ替えます。業種の型は初期の組みです。いつでも型に戻せます。</HelpTip>} closeAppearance="box" dirty={dirty} busy={busy} onClose={onClose}
      footer={<div className={styles.drawerFoot}><Button onClick={onClose}>キャンセル</Button><Button variant="primary" busy={busy} busyLabel="保存しています" disabled={!dirty} onClick={() => onSave(cards, metricsDirty ? metricIds : undefined)}>保存する</Button></div>}>
      {layout ? (
        <div className={styles.drawerBody}>
          <div className={styles.drawerBase}>
            <Scissors size={16} aria-hidden="true" />
            <span className={styles.drawerBaseText}><strong>いまの型：{layout.base}</strong><span className={styles.cellMuted}>{layout.changed + metricChanges}か所を変えています</span></span>
            <span className={styles.grow} />
            <Button size="compact" onClick={() => setPicking(!picking)} aria-expanded={picking}><Shapes size={16} aria-hidden="true" />型を変える</Button>
            <Button size="compact" onClick={onReset} disabled={busy}><RotateCcw size={16} aria-hidden="true" />型に戻す</Button>
          </div>
          {picking ? (
            <div className={styles.drawerPick}>
              <SaveErrorField names={['style']}><Select aria-label="型" value={nextStyle} onChange={(v: string) => setNextStyle(v as typeof nextStyle)} options={[{ value: 'restaurant', label: '飲食店' }, { value: 'salon', label: 'サロン' }, { value: 'consult', label: '面談・相談' }, { value: 'lesson', label: '教室・レッスン' }, { value: 'standard', label: '標準' }]} /></SaveErrorField>
              <Button size="compact" variant="primary" disabled={busy} onClick={() => onChangeStyle(nextStyle)}>この型にする</Button>
              <span className={styles.cellMuted}>予約や友だちのデータはそのまま使えます</span>
            </div>
          ) : null}
          <section className={styles.drawerSection} aria-label="数の帯">
            <div className={styles.drawerSectionHead}><h3>数の帯</h3><HelpTip label="数の帯の説明">表示する数と順番を選びます。取得できない値は「—」で表示します。</HelpTip><span className={styles.grow} /><span className={styles.cellMuted}>5つまで</span></div>
            {!metricsReady ? <Notice tone="info">数の表示設定を確認できないため、変更できません。読み直してください。</Notice> : null}
            {metricsReady ? orderedMetrics.map(item => {
              const index = metricIds.indexOf(item.id), checked = index >= 0
              return <div key={item.id} className={styles.drawerRow}>
                <SaveErrorField names={['metricIds']}><Toggle checked={checked} label={`数の帯：${item.label}`} disabled={busy || !metricsReady || (!checked && metricIds.length >= 5)} onChange={on => setMetricIds(list => on ? [...list, item.id] : list.filter(id => id !== item.id))} /></SaveErrorField>
                <span className={styles.drawerLabel}>{item.label}</span><span className={styles.grow} />
                {checked ? <><IconButton size="row" aria-label={`数の帯：${item.label}を上へ`} disabled={busy || !metricsReady || index <= 0} onClick={() => moveMetric(index, -1)}><ArrowUp size={16} /></IconButton><IconButton size="row" aria-label={`数の帯：${item.label}を下へ`} disabled={busy || !metricsReady || index === metricIds.length - 1} onClick={() => moveMetric(index, 1)}><ArrowDown size={16} /></IconButton></> : null}
              </div>
            }) : null}
          </section>
          <section className={styles.drawerSection} aria-label="カード">
            <div className={styles.drawerSectionHead}><h3>カード</h3><HelpTip label="カードの説明">ダッシュボードのタブとカードです。上下だけ入れ替えられます。</HelpTip><span className={styles.grow} /><span className={styles.cellMuted}>上下だけ入れ替え</span></div>
            {shown.map((item) => {
              const i = cards.indexOf(item)
              return (
                <div key={item.id} className={styles.drawerRow}>
                  <SaveErrorField names={[`cards.${item.id}`, `cards[${i}]`, `cards.${i}.visible`]}><Toggle checked={item.on} label={item.label} onChange={(on) => setCards((list) => list.map((x) => (x.id === item.id ? { ...x, on } : x)))} /></SaveErrorField>
                  <span className={styles.drawerLabel}>{item.label}</span>
                  <span className={styles.grow} />
                  <IconButton size="row" aria-label={`${item.label}を上へ`} disabled={i <= 0 || cards[i - 1]?.locked} onClick={() => move(i, -1)}><ArrowUp size={16} /></IconButton>
                  <IconButton size="row" aria-label={`${item.label}を下へ`} disabled={i === cards.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} /></IconButton>
                </div>
              )
            })}
          </section>
          {cards.filter((c) => c.locked).map((c) => (
            <div key={c.id} className={styles.drawerLocked}><Lock size={16} aria-hidden="true" /><span className={styles.drawerBaseText}><strong>{c.label}</strong><span className={styles.cellMuted}>異常・知らせがある時だけ必ず出ます（隠せません）</span></span></div>
          ))}
        </div>
      ) : null}
    </Drawer>
  )
}

/*
 * ［休みを入れる］の窓（wXOm6・ の 4・飲食店の臨時休業と同じ決まり）。
 * 日付・時間帯（終日／時間を決める）・対象（店全体／担当者／卓）・理由（お客さまには出さない）。
 * 既存の予約は取り消さず、連絡は次の画面で選ぶ。
 */
export function ClosureDialog({ open, date, targets, seatNoun, busy, error, affectedNote, onClose, onSave, preview, mediaNote, accountId, store }: {
  open: boolean
  date: string
  targets: { staff: { id: string; name: string }[]; seats: { id: string; name: string }[] }
  seatNoun: '卓' | '担当者' | '講師'
  busy: boolean
  error?: string
  affectedNote?: string | null
  onClose: () => void
  onSave: (input: StyleClosureInput) => void | Promise<void>
  /** 重なる予約を読む（飲食は既存の口の preview、ほかは画面の予約から）。重なりがあれば 2 段目（s8BwT8）。 */
  preview?: (input: StyleClosureInput) => Promise<OverlapRow[] | { rows: OverlapRow[]; snapshot: string }>
  mediaNote?: string | null
  accountId?: string | null
  store?: { id: string; name?: string | null }
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [overlap, setOverlap] = useState<OverlapRow[]>([])
  const [checking, setChecking] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [confirmedInput, setConfirmedInput] = useState<StyleClosureInput | null>(null)
  const savingRef = useRef(false)
  const previewGeneration = useRef(0)
  const [day, setDay] = useState(date)
  const [allDay, setAllDay] = useState<'all' | 'time'>('time')
  const [from, setFrom] = useState('19:00')
  const [to, setTo] = useState('22:00')
  const [target, setTarget] = useState<StyleClosureInput['target']>(seatNoun === '卓' ? 'seat' : 'staff')
  const [ids, setIds] = useState<string[]>([])
  const [reason, setReason] = useState('貸切')
  useEffect(() => { previewGeneration.current += 1; if (open) { setDay(date); setStep(1); setOverlap([]); setPreviewError(''); setConfirmedInput(null) }; return () => { previewGeneration.current += 1 } }, [open, date])
  const choices = target === 'seat' ? targets.seats : target === 'staff' ? targets.staff : []
  const current = (): StyleClosureInput => ({ date: day, allDay: allDay === 'all', from: allDay === 'time' ? from : undefined, to: allDay === 'time' ? to : undefined, target, ids: target === 'store' ? [] : ids, reason })
  const currentRef = useRef(current())
  currentRef.current = current()
  const confirmClosure = async () => {
    const input = current()
    const save = async (value: StyleClosureInput) => {
      if (savingRef.current) return
      savingRef.current = true
      try { await onSave(value) } finally { savingRef.current = false }
    }
    if (step === 2) { if (confirmedInput) await save(confirmedInput); return }
    if (!preview) { await save(input); return }
    const generation = ++previewGeneration.current
    setChecking(true); setPreviewError('')
    try {
      const result = await preview(input)
      if (generation !== previewGeneration.current || JSON.stringify(currentRef.current) !== JSON.stringify(input)) return
      const rows = Array.isArray(result) ? result : result.rows
      if (!Array.isArray(result) && (typeof result.snapshot !== 'string' || !result.snapshot)) throw new Error('invalid_confirmation')
      const fixed = Array.isArray(result) ? input : { ...input, expectedSnapshot: result.snapshot }
      if (rows.length) { setOverlap(rows); setConfirmedInput(fixed); setStep(2) } else await save(fixed)
    } catch { if (generation === previewGeneration.current) setPreviewError('予約を確認できませんでした。読み直してから、もう一度お試しください。') }
    finally { if (generation === previewGeneration.current) setChecking(false) }
  }
  useEffect(() => { if (open) setIds(choices[0] ? [choices[0].id] : []) }, [open, target]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} designWidth={step === 2 ? 540 : 480} titleHelp={<HelpTip label="休みを入れるの説明">臨時休業・貸切・急な休みを入れます。入れた時間は予約を受け付けません。</HelpTip>} busy={busy || checking} error={error || previewError} confirmLabel="休みを入れる" confirmIcon={<CalendarX2 size={16} aria-hidden="true" />} busyLabel="入れています" onCancel={() => (step === 2 ? setStep(1) : onClose())} cancelLabel={step === 2 ? '戻る' : 'キャンセル'} footerAlign="center"
      title={step === 2 ? `重なる予約が ${formatNumber(overlap.length)}件あります` : '休みを入れる'} description={step === 2 ? `${day} を休みにします` : undefined}
      confirmDisabled={target !== 'store' && ids.length === 0} confirmDisabledReason="対象を選んでください" dirty={false}
      onConfirm={() => void confirmClosure()}
      steps={overlap.length ? <Steps label="休みを入れる手順" currentKey={String(step)} steps={[{ key: '1', label: '日と時間', state: step > 1 ? 'done' : 'todo' }, { key: '2', label: '重なる予約', state: 'todo' }]} /> : undefined} stepKey={step}
      footerLead={overlap.length ? <span className={styles.cellMuted}>手順 {step} / 2</span> : undefined}>
      <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} store={store} />
      {step === 2 ? <ClosureOverlapStep rows={overlap} mediaNote={mediaNote} /> : <div className={styles.dialogBody}>
        <Field label="日付" optional={false}><DateField value={day} onChange={setDay} displayFormat="full" /></Field>
        <Field label="時間帯" optional={false}>
          <div className={styles.dialogInline}>
            <SegmentedControl aria-label="時間帯" appearance="choices" value={allDay} onChange={setAllDay} options={[{ value: 'all', label: '終日' }, { value: 'time', label: '時間を決める' }]} />
            {allDay === 'time' ? <><TimeFieldV8 aria-label="始まり" value={from} onChange={setFrom} minuteStep={30} /><span aria-hidden="true">〜</span><TimeFieldV8 aria-label="終わり" value={to} onChange={setTo} minuteStep={30} allowEndOfDay /></> : null}
          </div>
        </Field>
        <Field label="対象" optional={false}>
          <SegmentedControl aria-label="対象" appearance="choices" value={target} onChange={setTarget} options={[{ value: 'store', label: '店全体' }, { value: 'staff', label: '担当者' }, ...(seatNoun === '卓' ? [{ value: 'seat' as const, label: '卓' }] : [])]} />
          {choices.length ? (
            <div className={styles.chipRow}>
              {choices.map((c) => <FilterChip key={c.id} selected={ids.includes(c.id)} onChange={(on: boolean) => setIds((now) => (on ? [...now, c.id] : now.filter((x) => x !== c.id)))}>{c.name}</FilterChip>)}
            </div>
          ) : null}
        </Field>
        <Field label="理由（お客さまには出ません）" optional={false}>
          <Select size="full" aria-label="理由" value={reason} onChange={(v: string) => setReason(v)} options={['貸切', '臨時休業', '急な休み', '研修', 'そのほか'].map((v) => ({ value: v, label: v }))} />
        </Field>
        {affectedNote ? <Notice tone="info" icon={<Info size={16} aria-hidden="true" />}>
          {affectedNote}
        </Notice> : null}
      </div>}
    </Dialog>
  )
}
