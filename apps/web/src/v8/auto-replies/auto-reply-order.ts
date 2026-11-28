/**
 * R28: 判定順（Worker と同じ）を一覧側で扱うための小さな関数群。
 *
 * 判定順は `priority` の小さい順・同じなら作った順（Worker の ORDER BY と
 * 同じ）。順番は一覧で上下を入れ替えて決め、窓の中では数字を打たせない。
 * 入れ替えは隣り合う2件の数字の交換だけで行い、同点のときだけ動かす側を
 * 1ずらす。上下の端で詰まった同点のときだけ全件を振り直す。
 */

export interface OrderedRule {
  id: string
  priority: number
  createdAt: string
}

/** Worker の受け付け範囲（`readPriority` と同じ）。 */
export const PRIORITY_MIN = -9999
export const PRIORITY_MAX = 9999

function isValidPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PRIORITY_MIN && value <= PRIORITY_MAX
}

function sortablePriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function sortableCreatedAt(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Worker の ORDER BY と同じ：小さいほど先・同じなら作った順。 */
export function inEvaluationOrder<T extends OrderedRule>(rules: T[]): T[] {
  if (!Array.isArray(rules)) return []
  return rules
    .filter((rule): rule is T => Boolean(rule) && typeof rule === 'object')
    .sort(
      (a, b) =>
        sortablePriority(a.priority) - sortablePriority(b.priority) ||
        sortableCreatedAt(a.createdAt).localeCompare(sortableCreatedAt(b.createdAt)),
    )
}

export interface PriorityUpdate {
  id: string
  priority: number
}

/**
 * 隣との入れ替えに要る `priority` の更新だけを返す。
 *
 * `ordered` は `inEvaluationOrder` 済みの並び。動かせない位置・無い id の
 * ときは null。数字が違う2件は交換し、同点のときは動かす側を1ずらす。
 */
export function movePriorityUpdates(
  ordered: OrderedRule[],
  id: string,
  delta: -1 | 1,
): PriorityUpdate[] | null {
  if (!Array.isArray(ordered) || !id) return null
  const index = ordered.findIndex((rule) => rule && rule.id === id)
  const nextIndex = index + delta
  if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return null
  const current = ordered[index]
  const neighbor = ordered[nextIndex]
  if (!current || !neighbor) return null
  if (isValidPriority(current.priority) && isValidPriority(neighbor.priority)) {
    if (current.priority !== neighbor.priority) {
      return [
        { id: current.id, priority: neighbor.priority },
        { id: neighbor.id, priority: current.priority },
      ]
    }
    const moved = current.priority + delta
    if (moved >= PRIORITY_MIN && moved <= PRIORITY_MAX) {
      return [{ id: current.id, priority: moved }]
    }
  }
  // 端で詰まった同点や不正な優先度値：順序だけ変えて全件を安全範囲で振り直す（変わる行だけ返す）。
  const reordered = [...ordered]
  const [picked] = reordered.splice(index, 1)
  reordered.splice(nextIndex, 0, picked)
  const updates: PriorityUpdate[] = []
  reordered.forEach((rule, position) => {
    if (!rule || typeof rule.id !== 'string' || !rule.id) return
    const nextPriority = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, position))
    if (rule.priority !== nextPriority) updates.push({ id: rule.id, priority: nextPriority })
  })
  return updates
}
