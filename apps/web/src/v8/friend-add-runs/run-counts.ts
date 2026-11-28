function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** APIの絞り込み済みtotal/summaryを、別の種類の全件数へ流用しない。 */
export function runCounts(kind: string, routing: string, total: number | undefined, summary: {
  failed: number; returning?: number; testPending?: number | null
} | null) {
  const all = kind === 'all' && routing === 'all'
  const safeTotal = safeCount(total)
  return {
    all: all ? safeTotal : undefined,
    failed: all ? safeCount(summary?.failed) : kind === 'all' && routing === 'failed' ? safeTotal : undefined,
    pending: all ? safeCount(summary?.testPending) : undefined,
    returning: all ? safeCount(summary?.returning) : kind === 'returning' && routing === 'all' ? safeTotal : undefined,
  }
}
