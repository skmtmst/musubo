import type { GoogleSheetsSyncRun } from '@/lib/api'
import { formatNumber } from '@/lib/format'

export const RUN_KIND_LABEL: Record<GoogleSheetsSyncRun['kind'], string> = { manual: '手動', scheduled: '定期' }
const RUN_DATA_LABEL: Record<GoogleSheetsSyncRun['dataType'], string> = { friends: '友だち', form_answers: 'フォーム回答' }
export const RUN_STATUS_LABEL: Record<GoogleSheetsSyncRun['status'], string> = { running: '実行中', ok: '完了', partial: '一部だけ完了', error: '失敗' }

function label(table: object, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table as Record<string, string>)[key] : fallback
}
export const runKindLabel = (kind: string): string => label(RUN_KIND_LABEL, kind, '種類を確認できません')
export const runStatusLabel = (status: string): string => label(RUN_STATUS_LABEL, status, '状態を確認できません')

/** 30分以上「実行中」のままの記録は止まったものとみなす（管理画面 と同じ）。 */
export const STALE_RUN_MS = 30 * 60 * 1000

type RunGroup = { key: string; startedAt: string; kind: GoogleSheetsSyncRun['kind']; parts: string[]; status: GoogleSheetsSyncRun['status'] }

/* 同じ開始時刻の行を束ねて表の1行にする。失敗で0件の行は「書き出したもの」に数えない。 */
export function groupRuns(runs: GoogleSheetsSyncRun[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const run of runs) {
    const content = run.status === 'error' && run.rowsWritten === 0
      ? null
      : `${label(RUN_DATA_LABEL, run.dataType, '内容を確認できません')} ${formatNumber(run.rowsWritten)}`
    const existing = groups.get(run.startedAt)
    if (!existing) {
      groups.set(run.startedAt, { key: run.startedAt, startedAt: run.startedAt, kind: run.kind, parts: content ? [content] : [], status: run.status })
      continue
    }
    if (content) existing.parts.push(content)
    if (run.status === 'error' || (run.status === 'partial' && existing.status === 'ok') || (run.status === 'running' && existing.status !== 'error') || (!Object.hasOwn(RUN_STATUS_LABEL, run.status) && existing.status === 'ok')) {
      existing.status = run.status
    }
  }
  return [...groups.values()]
}

/** WEB233：同期の結果（HTTP 200）から、運用者へ出す失敗の理由。問題が無ければ null。 */
export function syncResultProblem(data: { status: string; results?: Array<{ status: string; error?: string | null }> } | null | undefined): string | null {
  if (!data) return '同期の結果を確認できません。記録を確かめてください。'
  const reason = Array.isArray(data.results) ? data.results.find((result) => result?.error)?.error ?? null : null
  if (data.status === 'error') return reason ? `同期できませんでした（${reason}）` : '同期できませんでした。時間をおいて、もう一度お試しください。'
  if (data.status === 'partial') return reason ? `一部だけ書き出しました（${reason}）` : '一部だけ書き出しました。記録で失敗した内容を確かめてください。'
  if (data.status === 'already_running') return 'いま同期しています。終わってから、もう一度お試しください。'
  return data.status === 'ok' ? null : '同期の結果を確認できません。記録を確かめてください。'
}
