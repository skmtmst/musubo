/** 90日を経過した信頼記録を消す。 */
export async function purgeExpiredTrustedLogins(db: D1Database, now: Date): Promise<void> {
  await db.prepare("DELETE FROM auth_trusted_logins WHERE datetime(confirmed_at) <= datetime(?, '-90 days')").bind(now.toISOString()).run();
}
