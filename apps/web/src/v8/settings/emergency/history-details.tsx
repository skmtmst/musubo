'use client'

import { knownValue } from '@/lib/known-value'

import { useEffect, useState } from 'react'
import { api, type OperationHistoryEntry } from '@/lib/api'
import { CAPABILITY_LABEL } from '@/lib/operation-restore'
import { collectRecentUpdates, RECENT_UPDATES_LIMIT, type UpdateRelease } from '@/lib/operation-updates'
import { formatOperationDate } from '@/lib/operation-status'
import { formatMinutesRough } from '@/lib/format-duration'
import releaseLog from '@/generated/release-log-summary.json'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import { downloadCsv as saveCsvFile } from '@/components/shared/csv-download'
import Select from '@/components/shared/select'
import { Field } from '@/components/shared/form-controls'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import TruncatedText from '@/components/shared/truncated-text'
import { formatNumber } from '@/lib/format'

export type HistoryDetail = 'incidents' | 'updates' | null
const HISTORY_FETCH_LIMIT = 200
const DAY = 24 * 60 * 60 * 1000

/** 自由文が表計算の式にならないよう、旧のCSVの守りを引き継ぐ。 */
export function operationHistoryCsv(entries: OperationHistoryEntry[]) {
  const quote = (value: unknown) => {
    const raw = String(value ?? '')
    const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replaceAll('"', '""')}"`
  }
  const rows = entries.map((item) => [item.createdAt, item.actorId,
    item.capabilities.map((capability) => knownValue(CAPABILITY_LABEL, capability, '対象を確認できません')).join('・'),
    item.lineAccountId ?? 'すべてのアカウント', item.reason, item.resolvedAt ?? ''])
  return `\uFEFF${[['いつ・だれが', '担当者', '止めたもの', '対象', '理由', '戻した'], ...rows].map((row) => row.map(quote).join(',')).join('\n')}`
}

/** 通常の版の表を保ち、旧側だけにあった期間・CSV・変更内容を共通の窓で確認する。 */
export default function HistoryDetails({ panel, onClose }: { panel: HistoryDetail; onClose: () => void }) {
  const [history, setHistory] = useState<OperationHistoryEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [period, setPeriod] = useState<'year' | '30days'>('year')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!panel) return
    let cancelled = false
    setHistory([])
    setState('loading')
    api.operations.history(HISTORY_FETCH_LIMIT).then((response) => {
      if (cancelled) return
      if (response.success && Array.isArray(response.data)) { setHistory(response.data); setState('ready') }
      else setState('error')
    }).catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [panel, revision])

  const cutoff = Date.now() - (period === '30days' ? 30 : 365) * DAY
  const operations = history.filter((item) => item.historyKind !== 'deployment')
  const unreadableEntries = operations.filter((item) => Number.isNaN(Date.parse(item.createdAt)))
  const entries = operations.filter((item) => Date.parse(item.createdAt) >= cutoff)
  const truncated = history.length >= HISTORY_FETCH_LIMIT
  const longestMinutes = entries.reduce((longest, item) => {
    if (!item.stoppedAt || !item.resolvedAt) return longest
    const minutes = Math.round((Date.parse(item.resolvedAt) - Date.parse(item.stoppedAt)) / 60_000)
    return Number.isFinite(minutes) ? Math.max(longest, minutes) : longest
  }, 0)
  const releases = (releaseLog as { releases?: UpdateRelease[] }).releases ?? []
  const deployments = history.filter((item) => item.historyKind === 'deployment' && item.deployment)
  const { updates, pendingCount, totalCount } = collectRecentUpdates(deployments, releases)
  const recentUpdates = updates.slice(0, RECENT_UPDATES_LIMIT)
  const hiddenCount = totalCount - recentUpdates.length
  const ready = state === 'ready'
  const downloadCsv = () => {
    if (!ready) return
    saveCsvFile(operationHistoryCsv(entries), 'operation-history.csv')
  }
  return <Dialog open={panel !== null} title={panel === 'incidents' ? '止めた・戻した記録' : '管理画面の更新内容'}
    description={panel === 'incidents' ? '選んだ期間の一覧・回数・最長停止を確認します。' : `新しい${RECENT_UPDATES_LIMIT}件を表示します。まだ画面に入っていない変更は行に混ぜません。`}
    onCancel={onClose} cancelLabel="閉じる" size="wide"
    footer={panel === 'incidents' ? <DialogActions><Button variant="secondary" disabled={!ready} onClick={downloadCsv}>CSVで書き出す</Button></DialogActions> : undefined}>
    {state === 'error' ? <ListState kind="error" title="運用履歴を読み込めませんでした" description="履歴なしとは扱いません。もう一度読み直してください。" action={<Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>もう一度読み込む</Button>} /> : null}
    {panel === 'incidents' ? <>
      <Field label="表示期間"><Select aria-label="表示期間" size="full" value={period} onChange={(value) => setPeriod(value as 'year' | '30days')} options={[{ value: 'year', label: 'この1年' }, { value: '30days', label: '過去30日' }]} /></Field>
      <KpiBand>
        <KpiCard title="止めた回数" value={null} valueText={ready ? `${formatNumber(entries.length)}回${truncated ? '以上' : ''}` : '—'} unit="" detail={period === '30days' ? '過去30日' : 'この1年'} />
        <KpiCard title="いちばん長かった停止" value={null} valueText={ready && longestMinutes > 0 ? formatMinutesRough(longestMinutes) : '—'} unit="" detail={truncated ? '直近の記録から' : period === '30days' ? '過去30日' : 'この1年'} />
      </KpiBand>
      {unreadableEntries.length > 0 ? <Notice tone="warn">日付を読み取れない記録が{formatNumber(unreadableEntries.length)}件あります。期間の絞り込みから外しています。</Notice> : null}
      {state === 'loading' ? <ListState kind="loading" title="記録を読み込んでいます" /> : ready && entries.length === 0 ? <ListState kind="empty" title="この期間の記録はありません" /> : ready ?
        <GridTable label="止めた・戻した記録の一覧" design={{ columns: 'repeat(5, minmax(0, 1fr))', gap: 'var(--tpl-rest3-uh-gap)', rowPadding: 'var(--tpl-rest3-uh-row-pad)', fontSize: 'var(--tpl-rest3-em-body)' }}>
          <GridHeadRow>{['いつ・だれが', '止めたもの', '対象', '理由', '戻した'].map((label) => <GridCell key={label} role="columnheader">{label}</GridCell>)}</GridHeadRow>
          {entries.map((entry) => <GridRow key={entry.id}>
            <GridCell role="cell" title={`${formatOperationDate(entry.createdAt)} · ${entry.actorId}`}><TruncatedText value={`${formatOperationDate(entry.createdAt)} · ${entry.actorId}`} /></GridCell>
            <GridCell role="cell"><TruncatedText value={entry.capabilities.map((capability) => knownValue(CAPABILITY_LABEL, capability, '対象を確認できません')).join('・')} /></GridCell>
            <GridCell role="cell"><TruncatedText value={entry.lineAccountId ?? 'すべてのアカウント'} /></GridCell>
            <GridCell role="cell" title={`${entry.reason}${entry.detail ? ` · ${entry.detail}` : ''}`}><TruncatedText value={`${entry.reason}${entry.detail ? ` · ${entry.detail}` : ''}`} /></GridCell>
            <GridCell role="cell"><TruncatedText value={entry.resolvedAt ? formatOperationDate(entry.resolvedAt) : entry.status === 'failed' ? '失敗' : '停止中'} /></GridCell>
          </GridRow>)}
        </GridTable> : null}
    </> : <>
      {recentUpdates.length === 0 ? (ready ? <ListState kind="empty" title="更新の記録はありません" /> : state === 'loading' ? <ListState kind="loading" title="更新の記録を読み込んでいます" /> : null) :
        <GridTable label="管理画面の更新内容の一覧" design={{ columns: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)', gap: 'var(--tpl-rest3-uh-gap)', rowPadding: 'var(--tpl-rest3-uh-row-pad)', fontSize: 'var(--tpl-rest3-em-body)' }}>
          <GridHeadRow>{['いつ', '変更内容', '担当・PR'].map((label) => <GridCell key={label} role="columnheader">{label}</GridCell>)}</GridHeadRow>
          {recentUpdates.map((entry, index) => <GridRow key={`${entry.version}|${entry.pr ?? index}|${entry.at ?? index}`}>
            <GridCell role="cell"><TruncatedText value={`${formatOperationDate(entry.at ?? entry.released)} · ${entry.version}`} /></GridCell>
            <GridCell role="cell" title={entry.text}><TruncatedText value={entry.text} /></GridCell>
            <GridCell role="cell"><TruncatedText value={`${entry.by ?? '自動'}${entry.pr ? ` #${entry.pr}` : ''}`} /></GridCell>
          </GridRow>)}
        </GridTable>}
      {hiddenCount > 0 ? <p>続きが{formatNumber(hiddenCount)}件あります。</p> : null}
      {pendingCount > 0 ? <p>まだ画面に入っていない変更が{formatNumber(pendingCount)}件あります。</p> : null}
    </>}
  </Dialog>
}
