'use client'
import { DetailContent, DetailField, DetailNumber, DetailSection, DetailSectionTitle } from '@/components/shared/detail-content'

import { jstDateOffset } from '@/lib/jst-datetime'

import { TrendLineChart } from '@/components/shared/charts'

/*
 * ★V8-B 健康日記 30日のまとめ。一覧の上に右から出る引き出し（幅 600）。
 * 注意書き → 数（記録・体重・呼吸数・心拍数）→ 体重の30日の棒 → 記録の表 → 印刷・PDF に保存する。
 * 引き出しの枠は共通の Drawer。診察時に獣医師へ見せる前提なので、記録の事実だけを並べ、判断は書かない。
 * 印刷面（SummarySheet）は画面に出ず、印刷のときだけ紙になる（今の画面と同じ data-print-sheet）。
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Button from '@/components/shared/button'
import Drawer from '@/components/shared/drawer'
import ListState from '@/components/shared/list-state'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import { formatDay } from '@/lib/format'
import { petAnimalTypeLabel, type NenHealthSummaryData } from '@/lib/nen-pets-api'
import { SKIN_LABELS, TEAR_LABELS, countText, md } from './parts'
import styles from './health.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import Notice from '@/components/shared/notice'
import { withHonorific } from '@line-crm/shared'

type Logs = NenHealthSummaryData['summary']['logs']

/** 記録の表の涙やけは列が狭いので短い言葉。印刷面は今までどおり長い言葉。 */
const TEAR_SHORT: Record<string, string> = { normal: 'なし', mild: '少し', concern: '気になる' }
/** 「気になる変化」の便・食いつきに数える値以外（問題なし・良い・ふつう）は注意の色で出す。 */
const STOOL_OK = new Set(['normal'])
const APPETITE_OK = new Set(['normal', 'good'])

/** 「こむぎ（犬・柴・4歳）・見本 太郎さん・9/1〜9/30」。 */
function petLine(summary: NenHealthSummaryData): string {
  const kind = petAnimalTypeLabel(summary.pet.animalType)
  const parts = [kind, summary.pet.breed, summary.pet.ageLabel === '—' ? '' : summary.pet.ageLabel].filter(Boolean).join('・')
  const end = new Date(summary.generatedAt)
  const start = new Date(end.getTime() - (summary.summary.days - 1) * 86_400_000)
  const range = Number.isNaN(end.getTime()) ? '' : `・${polishFormatDate(start, { style: 'list-day' })}〜${polishFormatDate(end, { style: 'list-day' })}`
  return `${summary.pet.name || summary.pet.callName}（${parts}）・${withHonorific(summary.owner.name)}${range}`
}

function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits)
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
}

export default function SummaryDrawerV8({
  status,
  summary,
  weightWarn = false,
  error,
  onClose,
  onRetry,
  onPrint,
}: {
  status: 'loading' | 'ready' | 'error'
  summary: NenHealthSummaryData | null
  /** 一覧の「気になる変化」で体重が当たっているとき、30日の増減を注意の色にする。 */
  weightWarn?: boolean
  error?: unknown
  onClose: () => void
  onRetry: () => void
  onPrint: () => void
}) {
  const s = summary?.summary
  const weightDelta = s?.weight ? s.weight.last - s.weight.first : null
  const weightPercent = s?.weight && s.weight.first !== 0 && weightDelta !== null ? Math.round((weightDelta / s.weight.first) * 100) : null
  const notes = new Map((s?.notes ?? []).map((note) => [note.loggedOn, note.note]))

  return (
    <Drawer
      width="editor" heightMode="viewport"
      open
      title="健康日記 30日のまとめ"
      description={status === 'ready' && summary ? petLine(summary) : 'まとめを作っています'}
      onClose={onClose}
     actions={{primary: ((!(status === 'loading')) && (!(status === 'error' || !summary || !s)) ? <Button variant="primary" type="button" onClick={onPrint} title="ブラウザの印刷で PDF に保存します">
                印刷・PDF に保存する
              </Button> : null)}}>
<DetailContent>
      <div className={styles.summaryBody} data-design-node="BVuYh">
        {status === 'loading' ? (
          <ListState kind="loading" title="まとめを作っています" />
        ) : status === 'error' || !summary || !s ? (
          <ListState
            kind="error"
            title="まとめを作れませんでした"
            description={isForbiddenOrRateLimited(error) ? undefined : '通信の状態を確認して、もう一度お試しください。'}
            error={error ?? undefined}
            onRetry={onRetry}
          />
        ) : (
          <>
                <Notice tone="info">
                  お客さまがマイページで付けた記録をまとめたものです。診断や治療の判断は含みません。
                </Notice>
            <DetailSection>
              <DetailField label="記録" note={null}><DetailNumber value={s.records} unit="日" /></DetailField>
              <DetailField label="体重" note={null}><DetailNumber value={null} range={{ from: s.weight?.first, to: s.weight?.last }} unit="kg" /></DetailField>
              <DetailField label="呼吸数（平均）" note={null}><DetailNumber value={s.respiratoryRateAvg} unit="回／分" /></DetailField>
              <DetailField label="心拍数（平均）" note={null}><DetailNumber value={s.heartRateAvg} unit="回／分" /></DetailField>
            </DetailSection>
            <section className={styles.chart} aria-label="体重の30日の推移">
              <div className={styles.chartHead}>
                <DetailSectionTitle>体重</DetailSectionTitle>
                {weightDelta !== null && weightPercent !== null ? (
                  <p className={styles.chartCaption} data-tone={weightWarn ? 'warn' : undefined}>{`30日で ${signed(weightDelta, 1)}kg（${signed(weightPercent, 0)}%）`}</p>
                ) : null}
              </div>
              <WeightChart30d logs={s.logs} generatedAt={summary.generatedAt} />
            </section>
            {s.logs.length > 0 ? (
              <DataTable label="記録の表" grid={{
                columns: 'var(--tpl-nph-lcol-date) var(--tpl-nph-lcol-weight) minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)) minmax(0, 1.5fr)',
                padding: 'var(--tpl-nph-log-row-pad)', headPadding: 'var(--tpl-nph-log-head-pad)',
                gap: 'var(--tpl-nph-pair-gap)', headTextSize: 'var(--text-micro)', bodyTextSize: 'var(--text-caption)',
              }}>
                <thead><TableHeadRow>
                  {['日付', '体重', '便', '食いつき', '皮膚', '涙やけ', 'メモ'].map(label => <Th key={label} truncate>{label}</Th>)}
                </TableHeadRow></thead>
                <tbody>{s.logs.map(log => (
                  <Tr key={log.loggedOn}>
                    <Td><TruncatedText value={md(log.loggedOn)} /></Td>
                    <Td><TruncatedText value={log.weightKg == null ? emptyValue('unknown') : `${log.weightKg}kg`} /></Td>
                    <Td><TruncatedText tone={STOOL_OK.has(log.stool) ? undefined : 'warning'} value={summary.labels.stool[log.stool] ?? log.stool} /></Td>
                    <Td><TruncatedText tone={APPETITE_OK.has(log.appetite) ? undefined : 'warning'} value={summary.labels.appetite[log.appetite] ?? log.appetite} /></Td>
                    <Td><TruncatedText value={log.skin ? SKIN_LABELS[log.skin] ?? log.skin : emptyValue('unknown')} /></Td>
                    <Td><TruncatedText value={log.tearStain ? TEAR_SHORT[log.tearStain] ?? log.tearStain : emptyValue('unknown')} /></Td>
                    <Td><TruncatedText value={notes.get(log.loggedOn) ?? emptyValue('unknown')} /></Td>
                  </Tr>
                ))}</tbody>
              </DataTable>
            ) : (
              <p className={styles.summaryEmpty}>この30日の記録はありません。</p>
            )}

          </>
        )}
      </div>

</DetailContent>
</Drawer>
  )
}

/**
 * 体重の30日の線。記録のある日の体重を線でつなぎ、縦は 0kg から 5kg 刻み。
 * 横は30日の位置（記録の無い日は点を置かない）。
 */
function WeightChart30d({ logs, generatedAt }: { logs: Logs; generatedAt: string }) {
  const byDay = new Map<string, number>()
  for (const log of logs) {
    if (log.weightKg != null && !byDay.has(log.loggedOn)) byDay.set(log.loggedOn, log.weightKg)
  }
  const base = new Date(generatedAt)
  const end = Number.isNaN(base.getTime()) ? new Date() : base
  const days: Array<{ key: string; value: number | null }> = []
  for (let i = 29; i >= 0; i--) {
    const key = jstDateOffset(-i, end)
    days.push({ key, value: byDay.get(key) ?? null })
  }
  const known = days.map((d) => d.value).filter((v): v is number => v != null)
  const label = known.length >= 2 ? `${known[0]}kg → ${known[known.length - 1]}kg` : known.length === 1 ? `${known[0]}kg` : '記録なし'
  const top = Math.max(5, Math.ceil(Math.max(0, ...known) / 5) * 5)
  const points = days.flatMap((day, index) => day.value == null ? [] : [{ x: index, value: day.value, label: md(day.key) }])
  // 軸の名前は4日ごと＋最後の日。最後の日に近すぎる名前は重なるので出さない（絵の 9/1・9/5 … 9/25・9/30）。
  const axisLabels = days.flatMap((day, index) => (index % 4 === 0 && days.length - 1 - index >= 3) || index === days.length - 1 ? [{ x: index, label: md(day.key) }] : [])
  return <TrendLineChart label={`体重の推移（30日）：${label}`} unit="kg" maxX={days.length - 1} maxY={top} points={points} axisLabels={axisLabels} />
}

/**
 * 印刷面。「獣医師向け PDF を書き出す」＝ブラウザの印刷（PDFに保存）。
 * 画面には出ず、印刷時だけこの面が紙になる。body 直下へ描く（今の画面と同じ data-print-sheet）。
 */
export function SummarySheet({ summary }: { summary: NenHealthSummaryData }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) return null
  const s = summary.summary
  // #999 DEEP-24: 「その他」を犬へ変換して印刷しない（共通の動物種別ラベル）。
  const kind = petAnimalTypeLabel(summary.pet.animalType)
  return createPortal(
    <div data-print-sheet="" className={styles.printSheet} aria-hidden="true">
      <p><strong>健康日記 30日のまとめ</strong></p>
      <p>{summary.pet.callName || summary.pet.name}（{kind}{summary.pet.breed ? `・${summary.pet.breed}` : ''}・{summary.pet.ageLabel}）／飼い主 {summary.owner.name}／作成 {formatDay(summary.generatedAt)}</p>
      <p>
        記録 {s.records} 件／{s.days}日。
        体重 {s.weight ? `${s.weight.first}kg → ${s.weight.last}kg（最小 ${s.weight.min}・最大 ${s.weight.max}）` : '記録なし'}。
        心拍数 平均 {s.heartRateAvg == null ? emptyValue('unknown') : `${s.heartRateAvg}回／分`}。呼吸数 平均 {s.respiratoryRateAvg == null ? emptyValue('unknown') : `${s.respiratoryRateAvg}回／分`}。
      </p>
      <p>便：{countText(s.stool, summary.labels.stool)}／食いつき：{countText(s.appetite, summary.labels.appetite)}／皮膚：{countText(s.skin, SKIN_LABELS)}／涙やけ：{countText(s.tearStain, TEAR_LABELS)}</p>
      <table>
        <tbody>
          <tr><td>日付</td><td>体重</td><td>心拍</td><td>呼吸</td><td>便</td><td>食いつき</td><td>皮膚</td><td>涙やけ</td></tr>
          {s.logs.map((log) => (
            <tr key={log.loggedOn}>
              <td>{log.loggedOn}</td>
              <td>{log.weightKg == null ? '' : `${log.weightKg}kg`}</td>
              <td>{log.heartRateBpm ?? ''}</td>
              <td>{log.respiratoryRateBpm ?? ''}</td>
              <td>{summary.labels.stool[log.stool] ?? log.stool}</td>
              <td>{summary.labels.appetite[log.appetite] ?? log.appetite}</td>
              <td>{log.skin ? SKIN_LABELS[log.skin] ?? log.skin : ''}</td>
              <td>{log.tearStain ? TEAR_LABELS[log.tearStain] ?? log.tearStain : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.notes.length ? (
        <>
          <p>メモ</p>
          <ul>{s.notes.map((note) => <li key={note.loggedOn}>{note.loggedOn}：{note.note}</li>)}</ul>
        </>
      ) : null}
      <p>お客様がマイページで付けた記録をまとめたものです。診断や治療の判断は含みません。</p>
    </div>,
    document.body,
  )
}
