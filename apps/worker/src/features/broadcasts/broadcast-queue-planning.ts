import type { SegmentCondition } from '@line-crm/shared';

/**
 * 1回のCron実行で送る人数の上限。
 *
 * stealth_spread_minutes は「何分かけて配りきるか」。既定の 0 は
 * 一気に送る（従来どおり）。
 *
 * Cron は1分ごとなので、全体を分数で割った人数を1回ぶんにする。
 * 途中で止めても batch_offset がそこに残り、次の tick が続きから送る。
 * この再開のしくみは元からあるもので、新しく二重送信の危険は増えない。
 *
 * 下限を1バッチにしているのは、0人になると永久に進まなくなるため。
 */
export function stealthChunkSize(
  total: number,
  spreadMinutes: number,
  batchSize: number,
): number {
  if (spreadMinutes <= 0) return total;
  const perMinute = Math.ceil(total / spreadMinutes);
  return Math.max(batchSize, perMinute);
}

/** 保存した絞り込み条件を読み、壊れている場合は null を返す。 */
export function parseStoredConditions(stored: unknown): SegmentCondition | null {
  if (typeof stored !== 'string' || stored === '') return null;
  try {
    const parsed = JSON.parse(stored) as SegmentCondition;
    return parsed && Array.isArray(parsed.rules) ? parsed : null;
  } catch {
    return null;
  }
}
