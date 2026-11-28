export type TargetingOrderItem = {
  id: string
  targetingPriority: number
  createdAt: string
}

const priorityOf = (value: number) => (Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER)

export function compareTargetingGroups(
  a: TargetingOrderItem,
  b: TargetingOrderItem,
): number {
  return priorityOf(a.targetingPriority) - priorityOf(b.targetingPriority) || a.createdAt.localeCompare(b.createdAt)
}

/** Workerが友だちへ出すメニューを選ぶ順番と同じ並び。 */
export function orderTargetingGroups<T extends TargetingOrderItem>(groups: T[]): T[] {
  return [...groups].sort(compareTargetingGroups)
}

/**
 * 1件を上下へ動かし、古い同順位データも含めて0,1,2…へ正規化する。
 * 範囲外へ動かそうとした場合は、書き込みを起こさないためnullを返す。
 */
export function moveTargetingGroup<T extends TargetingOrderItem>(
  groups: T[],
  groupId: string,
  delta: -1 | 1,
): Array<{ id: string; priority: number }> | null {
  const reordered = orderTargetingGroups(groups)
  const index = reordered.findIndex((group) => group.id === groupId)
  const nextIndex = index + delta
  if (index < 0 || nextIndex < 0 || nextIndex >= reordered.length) return null

  ;[reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]]
  return reordered.map((group, priority) => ({ id: group.id, priority }))
}

/**
 * 保存を待たずに画面へ出す並び。IDの順に並べ替え、順番の番号を
 * 0,1,2…に振り直す。知らないIDは飛ばす（消さない）。
 */
export function withNormalizedPriority<T extends TargetingOrderItem>(
  groups: T[],
  orderedIds: string[],
): T[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const seen = new Set<string>()
  const next: T[] = []
  for (const id of orderedIds) {
    if (seen.has(id)) continue
    const group = byId.get(id)
    if (!group) continue
    seen.add(id)
    next.push({ ...group, targetingPriority: next.length })
  }
  return next
}
