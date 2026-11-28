import type {
  AutoReplyConflict,
  AutoReplyDryRunResult,
  AutoReplyValidationResult,
} from '@line-crm/shared'
import { formatNumber } from '@/lib/format'

export type PublishStage = 'conflicts' | 'test' | 'confirm' | 'done'

export type GateState = 'ok' | 'blocked' | 'unknown'

export type PublishGate = {
  label: string
  state: GateState
  detail: string
}

/**
 * 公開までの4段（設計 `U9hzqH` → `g46ja` → `Yj6CQ` → `e6iJG`）。
 *
 * **本番のルールを書き換える手前の画面なので、押せる条件を明示する。**
 * 契約（#595）は「競合を全件確認し、試験で下書き自身が勝つまで公開しない」。
 * 画面もそれをそのまま出す。
 */
function isValidConflictItem(value: unknown): value is AutoReplyConflict {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { autoReplyId?: unknown }).autoReplyId === 'string'
    && (value as { autoReplyId: string }).autoReplyId.trim() !== '',
  )
}

export function publishGates(
  validation: AutoReplyValidationResult | null,
  dryRun: AutoReplyDryRunResult | null,
  acknowledged: Set<string>,
): PublishGate[] {
  const ackSet = acknowledged instanceof Set ? acknowledged : new Set<string>()
  const hasValidErrors = validation !== null
    && typeof validation === 'object'
    && Array.isArray(validation.errors)
    && validation.errors.every((item) => typeof item === 'string')
  const hasValidConflicts = validation !== null
    && typeof validation === 'object'
    && Array.isArray(validation.conflicts)
    && validation.conflicts.every(isValidConflictItem)
  const hasValidDryRun = dryRun !== null
    && typeof dryRun === 'object'
    && typeof dryRun.draftWon === 'boolean'
  const errors = hasValidErrors ? validation.errors : []
  const conflicts = hasValidConflicts ? validation.conflicts : []
  const unacknowledged = conflicts.filter((c) => !ackSet.has(c.autoReplyId))

  return [
    {
      label: '動くきっかけが決まっています',
      state: !hasValidErrors ? 'unknown' : errors.length === 0 ? 'ok' : 'blocked',
      detail:
        !hasValidErrors
          ? '—（未取得）確認できていません'
          : errors.length === 0
            ? '反応する言葉・時間・対象が決まっています'
            : errors.join(' / '),
    },
    {
      label: '返す内容とアクションが決まっています',
      state: !hasValidErrors ? 'unknown' : errors.length === 0 ? 'ok' : 'blocked',
      detail:
        !hasValidErrors
          ? '—（未取得）確認できていません'
          : errors.length === 0
            ? '返信と、そのあとにすることが決まっています'
            : errors.join(' / '),
    },
    {
      label: 'テストが完了しています',
      state: !hasValidDryRun ? 'unknown' : dryRun.draftWon ? 'ok' : 'blocked',
      detail:
        !hasValidDryRun
          ? '—（未取得）まだ試していません'
          : dryRun.draftWon
            ? '実際の評価順で、この下書きが選ばれました'
            : `いまは「${dryRun.winner?.name ?? '別の自動応答'}」が先に返します`,
    },
    {
      label: '競合とループ防止を確認しました',
      state: !hasValidConflicts ? 'unknown' : unacknowledged.length === 0 ? 'ok' : 'blocked',
      detail:
        !hasValidConflicts
          ? '—（未取得）競合を読み込めていません'
          : conflicts.length === 0
            ? '重なる自動応答はありません'
            : unacknowledged.length === 0
              ? `${formatNumber(conflicts.length)}件を確認しました`
              : `${formatNumber(unacknowledged.length)}件が未確認です`,
    },
  ]
}

/**
 * 公開してよいか。**1つでも `ok` でなければ押させない。**
 * `unknown`（確かめられていない）も押させない——**確かめていないものを
 * 確かめたように扱わない。**
 */
export function canPublish(gates: PublishGate[]): boolean {
  return Array.isArray(gates) && gates.length > 0 && gates.every((g) => Boolean(g) && g.state === 'ok')
}

/** 競合の重さ。**「たぶん当たる」も落とさず、確かなものと分ける。** */
export function conflictTone(conflict: AutoReplyConflict, draftId: string): {
  label: string
  losing: boolean
} {
  const losing = !draftId || typeof conflict?.winnerAutoReplyId !== 'string' || conflict.winnerAutoReplyId !== draftId
  return {
    label: conflict?.certainty === 'certain' ? '必ず重なります' : '重なることがあります',
    losing,
  }
}
