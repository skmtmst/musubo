'use client'

import { csvCell } from '@/lib/presentation'
import { terms } from '@/lib/terms'

import { useCallback, useEffect, useState } from 'react'
import { useResponseGate } from '@/lib/use-response-gate'
import { api, type BroadcastRecipientRow, type BroadcastRecipientsSummary } from '@/lib/api'
import Button from '@/components/shared/button'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import { formatNumber } from '@/lib/format'

const RESULT_OPTIONS = [
  { value: 'all', label: 'すべて' },
  { value: 'delivered', label: terms.W07 },
  { value: 'temporary', label: '一時的（送り直せる）' },
  { value: 'permanent', label: '届けられなかった' },
  { value: 'unknown', label: '送達不明' },
  { value: 'inflight', label: '送信中・送る前' },
] as const

/* 宛先の結果の色は共通の状態の札だけで分ける（画面で色を書かない）。 */
const GROUP_TONE: Record<BroadcastRecipientRow['group'], StatusBadgeTone> = {
  delivered: 'success',
  failed_temporary: 'warning',
  failed_permanent: 'danger',
  unknown: 'neutral',
  inflight: 'info',
}

/** このgroupは送信台帳のsent由来。お客さまへの到達確認ではない。 */
function recipientResultLabel(row: BroadcastRecipientRow): string {
  return row.group === 'delivered' ? terms.W07 : row.label
}

export function recipientCsv(rows: BroadcastRecipientRow[]): string {
  const lines = [
    ['名前', '結果', '理由', 'LINEの要求ID', '送った時刻', '結果が決まった時刻'],
    ...rows.map((row) => [
      row.displayName, recipientResultLabel(row), row.detail, row.lineRequestId, row.dispatchedAt, row.settledAt,
    ]),
  ]
  return `\uFEFF${lines.map((line) => line.map(value => csvCell(value ?? '—')).join(',')).join('\r\n')}\r\n`
}

/** CSV は 100件ずつ読む。これを超えて続きが残るときは、書き出さずに知らせる（ROOT29）。 */
export const RECIPIENT_CSV_MAX_PAGES = 1000

/**
 * 宛先のタブ（C-2）。誰に送ったか。
 *
 * LINEが受け付けた・失敗の理由・送る前の件数を札で出し、宛先ごとに行に並べる。
 * 一時的な失敗だけを送り直せる。CSVに書き出せる。
 * 旧配信は集約だけ（行は捏造しない）。
 */
export default function BroadcastRecipients({
  broadcastId,
  total,
  version,
}: {
  broadcastId: string
  total: number
  /** 楽観ロックの版。再送・停止の競合を防ぐ。 */
  version: number
}) {
  const [result, setResult] = useState<string>('all')
  const [rows, setRows] = useState<BroadcastRecipientRow[] | null>(null)
  const [summary, setSummary] = useState<BroadcastRecipientsSummary | null>(null)
  const [aggregate, setAggregate] = useState<{ only: boolean; reason: 'all' | 'legacy' | null; legacySuccess: number | null }>({
    only: false, reason: null, legacySuccess: null,
  })
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retryBusy, setRetryBusy] = useState(false)
  const [retryMessage, setRetryMessage] = useState<string | null>(null)
  const [csvBusy, setCsvBusy] = useState(false)
  /* ROOT29：最初の50件のあとの続き。null なら続きは無い。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState(false)
  /* ROOT30：絞り込みを変えたら、前の絞り込みの遅い応答を捨てる。 */
  const gate = useResponseGate()

  const load = useCallback(async (options?: { keepMessage?: boolean }) => {
    const token = gate.begin()
    setState('loading')
    setNextCursor(null)
    setMoreError(false)
    // 新しい読込は、進行中の「続きを読み込む」を古い扱いにする。古い方の finally は
    // もう解除しないので、ここで「読み込み中」を戻す（戻さないと続きのボタンが押せないまま残る）。
    setMoreBusy(false)
    // ROOT31：再送の成功の知らせは、読み直しで消さない。
    if (!options?.keepMessage) setRetryMessage(null)
    try {
      const res = await api.broadcasts.recipients(broadcastId, { result, limit: 50 })
      if (!gate.current(token)) return
      if (!res.success || !res.data) {
        setState('error')
        return
      }
      setRows(res.data.rows)
      setSummary(res.data.summary)
      setAggregate({
        only: res.data.aggregateOnly,
        reason: res.data.aggregateReason,
        legacySuccess: res.data.legacySuccessCount,
      })
      setNextCursor(res.pagination?.nextCursor ?? null)
      setState('ready')
    } catch {
      if (!gate.current(token)) return
      setState('error')
    }
  }, [broadcastId, result, gate])

  const loadMore = useCallback(async () => {
    if (!nextCursor || moreBusy) return
    const token = gate.begin()
    setMoreBusy(true)
    setMoreError(false)
    try {
      const res = await api.broadcasts.recipients(broadcastId, { result, cursor: nextCursor, limit: 50 })
      if (!gate.current(token)) return
      if (!res.success || !res.data) {
        setMoreError(true)
        return
      }
      const added = res.data.rows
      setRows((current) => [...(current ?? []), ...added])
      setNextCursor(res.pagination?.nextCursor ?? null)
    } catch {
      if (gate.current(token)) setMoreError(true)
    } finally {
      if (gate.current(token)) setMoreBusy(false)
    }
  }, [broadcastId, gate, moreBusy, nextCursor, result])

  useEffect(() => {
    void load()
  }, [load])

  const handleRetry = useCallback(async () => {
    if (retryBusy) return
    setRetryBusy(true)
    setRetryMessage(null)
    try {
      const res = await api.broadcasts.retryFailed(broadcastId, version)
      if (!res.success) {
        setRetryMessage(res.error ?? '送り直せませんでした。')
        return
      }
      setRetryMessage(`${res.retryTargets ?? 0}人に送り直しを始めました。`)
      await load({ keepMessage: true })
    } catch {
      setRetryMessage('送り直せませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      setRetryBusy(false)
    }
  }, [broadcastId, load, retryBusy, version])

  const handleCsv = useCallback(async () => {
    if (csvBusy) return
    setCsvBusy(true)
    try {
      // いまの絞り込みの全件を取る（100件ずつ、続きが無くなるまで）。
      // ROOT29：途中で打ち切ったものを全件のように書き出さない。
      const all: BroadcastRecipientRow[] = []
      let cursor: string | undefined
      let complete = false
      for (let page = 0; page < RECIPIENT_CSV_MAX_PAGES; page += 1) {
        const res = await api.broadcasts.recipients(broadcastId, { result, cursor, limit: 100 })
        if (!res.success || !res.data) throw new Error('csv')
        all.push(...res.data.rows)
        if (!res.pagination?.nextCursor) {
          complete = true
          break
        }
        cursor = res.pagination.nextCursor
      }
      if (!complete) {
        setRetryMessage(`宛先が多すぎるため、CSVに書き出せませんでした（${formatNumber(all.length)}件より先があります）。絞り込んでからもう一度お試しください。`)
        return
      }
      const url = URL.createObjectURL(new Blob([recipientCsv(all)], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `宛先-${broadcastId}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setRetryMessage('CSVに書き出せませんでした。')
    } finally {
      setCsvBusy(false)
    }
  }, [broadcastId, csvBusy, result])

  if (state === 'error') {
    return <ListState kind="error" title="宛先を表示できませんでした" onRetry={() => void load()} />
  }
  if (state === 'loading' || rows === null || summary === null) {
    return <ListState kind="loading" title="宛先を読み込んでいます" />
  }

  if (aggregate.only) {
    return (
      <section aria-label="宛先" className="bg-canvas rounded-card border-hairline border p-5">
        <p className="text-ink text-sm font-semibold">宛先ごとの結果はありません</p>
        <p className="text-ink-secondary mt-1 text-xs leading-relaxed">
          {aggregate.reason === 'all'
            ? '全員への配信は宛先の一覧を持ちません。'
            : `この配信は集約だけの古い記録です${aggregate.legacySuccess != null ? `（成功の記録 ${formatNumber(aggregate.legacySuccess)}人）` : ''}。お客さまに届いたかは確認できません。`}
        </p>
      </section>
    )
  }

  const pending = summary.pending
  return (
    <section aria-label="宛先" className="bg-canvas rounded-card content-card space-y-4 border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="success">{`${terms.W07}：${formatNumber(summary.sent)}人`}</StatusBadge>
        <StatusBadge tone="danger">{`失敗 ${formatNumber(summary.failedTemporary + summary.failedPermanent)}`}</StatusBadge>
        <StatusBadge tone="neutral">{`送る前 ${formatNumber(pending ?? 0)}`}</StatusBadge>
        <HelpTip label="宛先の数の説明">
          LINEが受け付けた数・失敗・送る前は宛先の台帳の数です。お客さまに届いたかは確認できません。送る前には、まだ記録がない相手と、再送できる未送信の相手が含まれます。
        </HelpTip>
      </div>

      {rows.length === 0 && result === 'all' ? (
        <ListState kind="empty" emptyPreset="readonly" title="宛先の結果はまだありません" />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="text-ink-faint text-xs">
              絞り込み
              <span className="mt-1 block">
                <Select
                  aria-label="宛先の絞り込み"
                  label="結果"
                  value={result}
                  onChange={(value) => setResult(value)}
                  options={RESULT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                />
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={handleRetry} disabled={retryBusy || summary.retryableCount === 0}>
                再送できる {formatNumber(summary.retryableCount)}件を再送
              </Button>
              <Button variant="secondary" onClick={handleCsv} disabled={csvBusy}>
                CSVに書き出す
              </Button>
            </div>
          </div>
          {retryMessage ? <p className="text-ink-secondary text-xs">{retryMessage}</p> : null}
          {rows.length === 0 ? (
            <ListState kind="empty" emptyPreset="readonly" title="この絞り込みの宛先はありません" />
          ) : (
            <ul className="border-hairline divide-hairline divide-y rounded-control border">
              {rows.map((row) => (
                <li key={row.friendId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <p className="text-ink truncate text-sm font-medium" title={row.displayName}>
                    {row.displayName}
                  </p>
                  <span className="flex shrink-0 items-center gap-2">
                    {row.settledAt
                      ? <time dateTime={row.settledAt} className="text-ink-faint text-xs tabular-nums">{formatTime(row.settledAt)}</time>
                      : <span className="text-ink-faint text-xs">—</span>}
                    <StatusBadge tone={GROUP_TONE[row.group]}>{recipientResultLabel(row)}</StatusBadge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {nextCursor ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => void loadMore()} disabled={moreBusy} busy={moreBusy} busyLabel="読み込み中…">
                続きを読み込む
              </Button>
              <span className="text-ink-faint text-xs">{formatNumber(rows.length)}件を表示中</span>
              {moreError ? <span className="text-danger text-xs">続きを読み込めませんでした。もう一度お試しください。</span> : null}
            </div>
          ) : null}
          <p className="text-ink-faint text-xs">
            {total > 0 ? `対象 ${formatNumber(total)}人` : null}
            {pending != null && pending > 0 ? `・送る前 ${formatNumber(pending)}人` : null}
          </p>
        </>
      )}
    </section>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}
