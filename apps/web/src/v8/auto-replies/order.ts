/**
 * R28: 判定順（Worker と同じ）を一覧側で扱うための小さな関数群。
 *
 * 個別ルールを共通ルールより先に、優先順位・キーワード・作成日時で評価する。
 * 隣との入れ替えは、更新後の実行順が希望の順番になるか確かめる。
 * 数字の交換や±1で同点の別の行を飛び越すときは、全体の順位を振り直す。
 */

export interface OrderedRule {
  id: string
  priority: number
  createdAt: string
  lineAccountId?: string | null
  respondToAll?: boolean
}

/** Worker の受け付け範囲（`readPriority` と同じ）。 */
export const PRIORITY_MIN = -9999
export const PRIORITY_MAX = 9999

/** Worker の ORDER BY と同じ：小さいほど先・同じなら作った順。 */
export function inEvaluationOrder<T extends OrderedRule>(rules: T[]): T[] {
  return [...rules].sort(
    compareEvaluationOrder,
  )
}

function isValidPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PRIORITY_MIN && value <= PRIORITY_MAX
}

function sortablePriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : PRIORITY_MAX + 1
}

/** 実行側と同じ：個別・優先順位・キーワード・作った日時。 */
export function compareEvaluationOrder(a: OrderedRule, b: OrderedRule): number {
  const ca = typeof a.createdAt === 'string' ? a.createdAt : ''
  const cb = typeof b.createdAt === 'string' ? b.createdAt : ''
  return Number(!a.lineAccountId) - Number(!b.lineAccountId)
    || sortablePriority(a.priority) - sortablePriority(b.priority)
    || Number(Boolean(a.respondToAll)) - Number(Boolean(b.respondToAll))
    || ca.localeCompare(cb)
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
  if (!Array.isArray(ordered)) return null
  const index = ordered.findIndex((rule) => rule.id === id)
  const nextIndex = index + delta
  if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return null
  const current = ordered[index]
  const neighbor = ordered[nextIndex]
  if (Boolean(current.lineAccountId) !== Boolean(neighbor.lineAccountId)) return null
  const desired = ordered.map(rule => rule.id)
  ;[desired[index], desired[nextIndex]] = [desired[nextIndex], desired[index]]
  if (isValidPriority(current.priority) && isValidPriority(neighbor.priority) && current.priority !== neighbor.priority) {
    const swaps = [{ id: current.id, priority: neighbor.priority }, { id: neighbor.id, priority: current.priority }]
    const priorities = new Map(swaps.map(update => [update.id, update.priority]))
    if (inEvaluationOrder(ordered.map(rule => ({...rule, priority: priorities.get(rule.id) ?? rule.priority})))
      .every((rule, position) => rule.id === desired[position])) return swaps
  }
  const moved = isValidPriority(current.priority) ? current.priority + delta : Number.NaN
  if (isValidPriority(current.priority) && current.priority === neighbor.priority && moved >= PRIORITY_MIN && moved <= PRIORITY_MAX) {
    const trial = ordered.map(rule => rule.id === id ? { ...rule, priority: moved } : rule)
    if (inEvaluationOrder(trial).every((rule, position) => rule.id === desired[position])) {
      return [{ id: current.id, priority: moved }]
    }
  }
  // 同点が3件以上あると±1だけでは隣を越えてしまう。実際の再読込順と照合する。
  // 端で詰まった同点：順序だけ変えて全件を振り直す（変わる行だけ返す）。
  const reordered = [...ordered]
  const [picked] = reordered.splice(index, 1)
  reordered.splice(nextIndex, 0, picked)
  const updates: PriorityUpdate[] = []
  reordered.forEach((rule, position) => {
    if (rule.priority !== position) updates.push({ id: rule.id, priority: position })
  })
  return updates
}
