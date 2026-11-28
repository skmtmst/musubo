import type { UidMigrationRun } from '@/lib/api'
/** 長い UID は頭4字…末3字で見せる（全文は title）。 */
export function shortUid(uid: string): string {
  return uid.length > 10 ? `${uid.slice(0, 4)}…${uid.slice(-3)}` : uid
}

export function historyBadge(run: UidMigrationRun): { tone: 'ok' | 'muted' | 'danger' | 'warn'; label: string } {
  if (run.status === 'completed') return { tone: 'ok', label: '本移行済み' }
  if (run.status === 'rolled_back') return { tone: 'muted', label: '切り戻し済み' }
  if (run.status === 'failed') return { tone: 'danger', label: run.counts.applied > 0 ? '一部失敗' : '失敗' }
  if (run.status === 'executing') return { tone: 'warn', label: '実行中' }
  if (run.status === 'ready') return { tone: 'ok', label: '確認完了' }
  if (run.status === 'dry_run' || run.status === 'review') return { tone: 'muted', label: 'テスト移行' }
  return { tone: 'warn', label: '状態を確認できません' }
}
