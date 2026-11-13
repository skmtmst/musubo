import { logger } from '@line-crm/shared/server';

/** 版列の有無に応じて照合し、列情報は毎回取得する。 */
export async function hasConversionApprovalRevision(db: D1Database): Promise<boolean> {
  const columns = await db.prepare('PRAGMA table_info(conversion_events)').all<{ name: string }>();
  const available = columns.results.some(column => column.name === 'approval_revision');
  if (!available) logger.warn('conversion_approval_revision_unavailable');
  return available;
}
