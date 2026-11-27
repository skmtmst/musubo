import type { ReminderDraftSettings } from '@line-crm/shared'

/**
 * リマインダの編集競合（409）の「違いを比べる」で出す差分。
 *
 * 自分の下書きと、相手が保存した最新の版を手順ごとに比べる。
 * 版の履歴APIは無いので、読み直す前に最新を1回取ってその場で比べる。
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    )
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function trimmedName(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 変わった手順の名前を順に返す。同じなら空。 */
export function describeReminderDiff(
  mine: ReminderDraftSettings,
  incoming: ReminderDraftSettings,
): string[] {
  const lines: string[] = []
  const mineName = trimmedName(mine.name)
  const incomingName = trimmedName(incoming.name)
  if (mineName !== incomingName) {
    lines.push(
      `リマインダ名が違います（最新「${incomingName || '（無題）'}」／あなた「${mineName || '（無題）'}」）`,
    )
  } else if (
    mine.description !== incoming.description ||
    (mine.folderId ?? '') !== (incoming.folderId ?? '')
  ) {
    lines.push('基本設定（説明・フォルダ）が違います')
  }
  if (
    !sameJson(
      { targetTagId: mine.targetTagId, targetCondition: mine.targetCondition, stopConditions: mine.stopConditions },
      { targetTagId: incoming.targetTagId, targetCondition: incoming.targetCondition, stopConditions: incoming.stopConditions },
    )
  ) {
    lines.push('「対象者と止める条件」が違います')
  }
  if (!sameJson(mine.steps, incoming.steps)) {
    lines.push('「通知の中身」（手順）が違います')
  }
  if (
    !sameJson(
      {
        triggerType: mine.triggerType,
        deliveryMode: mine.deliveryMode,
        triggerFieldId: mine.triggerFieldId,
        triggerEventId: mine.triggerEventId,
        repeatYearly: mine.repeatYearly,
        triggerOffsetMinutes: mine.triggerOffsetMinutes,
        sendAtTime: mine.sendAtTime,
      },
      {
        triggerType: incoming.triggerType,
        deliveryMode: incoming.deliveryMode,
        triggerFieldId: incoming.triggerFieldId,
        triggerEventId: incoming.triggerEventId,
        repeatYearly: incoming.repeatYearly,
        triggerOffsetMinutes: incoming.triggerOffsetMinutes,
        sendAtTime: incoming.sendAtTime,
      },
    )
  ) {
    lines.push('基準日・配信のタイミングが違います')
  }
  return lines
}
