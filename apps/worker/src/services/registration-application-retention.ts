/** 最終更新から365日を過ぎた、未成立または却下の申込を削除する。 */
export async function purgeExpiredRegistrationApplications(db: D1Database, now: Date): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_application_retention_time');
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  // updated_at は +09:00 を含む ISO 時刻。文字列順ではなく同じ瞬間として比較する。
  const result = await db.prepare(`DELETE FROM registration_applications
    WHERE status IN ('pending', 'contacted', 'approved', 'rejected')
      AND julianday(updated_at) < julianday(?)`).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}
