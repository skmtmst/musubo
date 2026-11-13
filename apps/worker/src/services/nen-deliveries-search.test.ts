/*
 *  配信履歴の検索が「読み込み済みの20件」ではなく履歴全体に効くことを
 * 実D1で固定する。
 *  1. 1ページ目（新しい20件）に載らない古い記録も検索語で見つかる
 *  2. 宛先名だけでなく配信名（キャンペーン名）でも見つかる
 *  3. 別アカウントの記録は同じ検索語を入れても返らない
 */
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { listNenDeliveries, nenDeliveryRange } from './nen-campaign-metrics.js';

const ACCOUNT = 'account-nen';

function seed(raw: ReturnType<typeof createTestD1>['raw']): void {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('${ACCOUNT}', 'channel-nen', '然', 'token', 'secret'),
           ('account-other', 'channel-o', '別', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', '${ACCOUNT}', 1, '2026-09-01', '2026-09-01'),
      ('friend-rare', 'U-r', '珍名 次郎', '${ACCOUNT}', 1, '2026-09-01', '2026-09-01'),
      ('friend-x', 'U-x', '珍名 別店', 'account-other', 1, '2026-09-01', '2026-09-01');
    INSERT INTO nen_campaign_settings
      (campaign_key, label, category, is_enabled, title, body_text, created_at, updated_at)
    VALUES ('column', 'コラム', 'column', 1, 'コラム', '本文', '2026-01-01', '2026-01-01'),
           ('arrival_check', '到着確認', 'follow_up', 1, '届きましたか', '本文', '2026-01-01', '2026-01-01');
  `);
  // 新しい順に並ぶので、friend-rare 宛の1件は25件中いちばん古い＝1ページ目に載らない。
  for (let i = 0; i < 24; i += 1) {
    const day = String(28 - Math.floor(i / 4)).padStart(2, '0');
    raw.exec(`
      INSERT INTO nen_delivery_jobs
        (id, campaign_key, friend_id, line_account_id, source_key, payload, scheduled_at, status, attempts, created_at, updated_at)
      VALUES ('job-${i}', 'arrival_check', 'friend-a', '${ACCOUNT}', 'src-${i}', '{}', '2026-09-${day} 10:0${i % 10}:00', 'sent', 1, '2026-09-01', '2026-09-01');
    `);
  }
  raw.exec(`
    INSERT INTO nen_delivery_jobs
      (id, campaign_key, friend_id, line_account_id, source_key, payload, scheduled_at, status, attempts, created_at, updated_at)
    VALUES ('job-old', 'column', 'friend-rare', '${ACCOUNT}', 'src-old', '{}', '2026-09-01 10:00:00', 'sent', 1, '2026-09-01', '2026-09-01'),
           ('job-x', 'column', 'friend-x', 'account-other', 'src-x', '{}', '2026-09-02 10:00:00', 'sent', 1, '2026-09-01', '2026-09-01');
  `);
}

const range = () => nenDeliveryRange({ from: '2026-09-01', to: '2026-09-30' });

const search = (db: D1Database, q: string, cursor = 0, limit = 20) =>
  listNenDeliveries(db, { lineAccountId: ACCOUNT, range: range(), q, cursor, limit });

describe('NEN配信履歴の検索（listNenDeliveries の q）', () => {
  it('1ページ目に載らない古い記録も宛先名で見つかる', async () => {
    const { raw, db } = createTestD1();
    seed(raw);
    // 検索なしの1ページ目に job-old は載らない前提を先に確かめる。
    const firstPage = await listNenDeliveries(db, { lineAccountId: ACCOUNT, range: range(), cursor: 0, limit: 20 });
    expect(firstPage.deliveries.map((row) => row.id)).not.toContain('job-old');
    // 宛先名で検索すると、ページをめくらなくても見つかる。
    const result = await search(db, '珍名');
    expect(result.deliveries.map((row) => row.id)).toEqual(['job-old']);
    expect(result.pagination.total).toBe(1);
  });

  it('配信名（キャンペーン名）でも見つかる', async () => {
    const { raw, db } = createTestD1();
    seed(raw);
    const result = await search(db, 'コラム');
    expect(result.deliveries.map((row) => row.id)).toEqual(['job-old']);
  });

  it('別アカウントの記録は同じ検索語を入れても返らない', async () => {
    const { raw, db } = createTestD1();
    seed(raw);
    const result = await search(db, '珍名');
    expect(result.deliveries.every((row) => row.friendId !== 'friend-x')).toBe(true);
    expect(result.deliveries.map((row) => row.id)).not.toContain('job-x');
  });

  it('検索語の % や _ はワイルドカードにしない', async () => {
    const { raw, db } = createTestD1();
    seed(raw);
    const result = await search(db, '%');
    expect(result.deliveries).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});
