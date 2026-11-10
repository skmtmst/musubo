import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  compareProviders,
  countsAddUp,
  generateHandoverCode,
  rollbackDeadlineOf,
  rollbackHandover,
  saveDecision,
  savePreview,
} from '../src/account-handovers.js';
import { asD1 } from './d1-test-helper.js';

/**
 * 乗り換え（引き継ぎ）の判定。設計 ★33-4。
 */

describe('4区分の合計', () => {
  /*
    **合わない結果を保存しない。** 出すと、運用者は「どこかの人が消えた」と読む。
    画面側（`handover-view.ts` の `totalsMatch`）と同じ決まりを口の側でも守る。
  */
  it('合っていれば true', () => {
    expect(countsAddUp({ auto: 60, review: 20, unmatched: 15, lookalike: 5 }, 100)).toBe(true);
  });

  it('1人でも足りなければ false', () => {
    expect(countsAddUp({ auto: 60, review: 20, unmatched: 15, lookalike: 4 }, 100)).toBe(false);
  });

  it('多すぎても false', () => {
    expect(countsAddUp({ auto: 60, review: 20, unmatched: 15, lookalike: 6 }, 100)).toBe(false);
  });

  it('友だちが0人でも合う', () => {
    expect(countsAddUp({ auto: 0, review: 0, unmatched: 0, lookalike: 0 }, 0)).toBe(true);
  });
});

describe('プロバイダーの照合', () => {
  /*
    **分からないことを「同じ」と書かない。** LINE の Messaging API は
    プロバイダーを返さないので、入っていなければ unknown。
    ここで same にすると、事前確認で「一致しない」が大量に出た理由が
    運用者に分からなくなる。
  */
  it('両方入っていて同じなら same', () => {
    expect(compareProviders('p-1', 'p-1')).toBe('same');
  });

  it('両方入っていて違えば different', () => {
    expect(compareProviders('p-1', 'p-2')).toBe('different');
  });

  it.each([
    ['引き継ぎ元が空', null, 'p-1'],
    ['引き継ぎ先が空', 'p-1', null],
    ['どちらも空', null, null],
    ['空文字', '', 'p-1'],
    ['未定義', undefined, 'p-1'],
  ])('%s なら unknown（same と決めつけない）', (_label, from, to) => {
    expect(compareProviders(from, to)).toBe('unknown');
  });
});

describe('引き継ぎコード', () => {
  it('4文字ごとに区切った12文字', () => {
    const code = generateHandoverCode(() => 0);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  /*
    **読み違えやすい文字を使わない。** 0とO、1とIとLは、
    電話や口頭で伝えるときに必ず取り違える。
  */
  it('0 O 1 I L を含まない', () => {
    const codes = Array.from({ length: 200 }, () => generateHandoverCode());
    for (const code of codes) {
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});

/*
  申告件数の保存と、7日以内・1回だけの切り戻し。
  「動かした人だけを元に戻す」— あとから人手で移した行は触らない。
*/
function setupHandoverDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-a', 'A社')`).run();
  const insertAccount = sqlite.prepare(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES (?, ?, ?, 'token', 'secret', 1, 'tenant-a')
  `);
  insertAccount.run('from-acc', 'ch-from', '元アカウント');
  insertAccount.run('to-acc', 'ch-to', '先アカウント');
  const insertFriend = sqlite.prepare(`
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES (?, ?, ?, ?)
  `);
  insertFriend.run('friend-1', 'U1', '一郎', 'to-acc');
  insertFriend.run('friend-2', 'U2', '二郎', 'to-acc');
  sqlite.prepare(`
    INSERT INTO account_handovers (id, from_account_id, to_account_id, code, code_expires_at, status, created_at)
    VALUES ('h-1', 'from-acc', 'to-acc', 'AAAA-BBBB-CCCC', '2099-01-01', 'previewed', '2026-09-20')
  `).run();
  return { sqlite, db: asD1(sqlite) };
}

describe('申告件数の保存（X-3）', () => {
  it('申告件数を記録する', async () => {
    const { sqlite, db } = setupHandoverDb();
    const result = await savePreview(db, 'h-1', {
      sourceFriendTotal: 100,
      counts: { auto: 60, review: 20, unmatched: 15, lookalike: 5 },
      declaredFriendTotal: 98,
    });
    expect(result).toEqual({ ok: true });
    expect(sqlite.prepare(
      `SELECT declared_friend_total FROM account_handovers WHERE id = 'h-1'`,
    ).get()).toEqual({ declared_friend_total: 98 });
  });

  it('申告が無ければ null のまま', async () => {
    const { sqlite, db } = setupHandoverDb();
    await savePreview(db, 'h-1', {
      sourceFriendTotal: 100,
      counts: { auto: 60, review: 20, unmatched: 15, lookalike: 5 },
    });
    expect(sqlite.prepare(
      `SELECT declared_friend_total FROM account_handovers WHERE id = 'h-1'`,
    ).get()).toEqual({ declared_friend_total: null });
  });
});

describe('切り戻し（X-5）', () => {
  async function complete(sqlite: ReturnType<typeof Database>, db: ReturnType<typeof asD1>) {
    await saveDecision(db, { handoverId: 'h-1', fromFriendId: 'friend-1', decision: 'link', bucket: 'auto' });
    await saveDecision(db, { handoverId: 'h-1', fromFriendId: 'friend-2', decision: 'new', bucket: 'review' });
    sqlite.prepare(`INSERT INTO account_handover_moves (handover_id, friend_id, from_account_id, to_account_id, tenant_id, moved_at)
      VALUES ('h-1', ?, 'from-acc', 'to-acc', 'tenant-a', '2026-09-20')`).run('friend-1');
    sqlite.prepare(`INSERT INTO account_handover_moves (handover_id, friend_id, from_account_id, to_account_id, tenant_id, moved_at)
      VALUES ('h-1', ?, 'from-acc', 'to-acc', 'tenant-a', '2026-09-20')`).run('friend-2');
    sqlite.prepare(`
      UPDATE account_handovers SET status = 'completed',
             completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
       WHERE id = 'h-1'`).run();
  }

  it('動かした人を元のアカウントへ戻し、記録を残す', async () => {
    const { sqlite, db } = setupHandoverDb();
    await complete(sqlite, db);

    const result = await rollbackHandover(db, 'h-1', { rolledBackBy: 'owner-a', note: 'やり直し' });
    expect(result).toEqual({ ok: true, restoredCount: 2 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS c FROM friends WHERE line_account_id = 'from-acc'`,
    ).get()).toEqual({ c: 2 });
    expect(sqlite.prepare(
      `SELECT rolled_back_by, rollback_note FROM account_handovers WHERE id = 'h-1'`,
    ).get()).toEqual({ rolled_back_by: 'owner-a', rollback_note: 'やり直し' });
  });

  it('終わっていない引き継ぎは戻せない', async () => {
    const { db } = setupHandoverDb();
    const result = await rollbackHandover(db, 'h-1', {});
    expect(result).toMatchObject({ ok: false });
  });

  it('もう戻した引き継ぎは戻せない', async () => {
    const { sqlite, db } = setupHandoverDb();
    await complete(sqlite, db);
    await rollbackHandover(db, 'h-1', {});
    const again = await rollbackHandover(db, 'h-1', {});
    expect(again).toMatchObject({ ok: false });
  });

  it('7日を過ぎた引き継ぎは戻せない', async () => {
    const { sqlite, db } = setupHandoverDb();
    await complete(sqlite, db);
    sqlite.prepare(`
      UPDATE account_handovers
         SET completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-8 days') || '+09:00'
       WHERE id = 'h-1'`).run();
    const result = await rollbackHandover(db, 'h-1', {});
    expect(result).toMatchObject({ ok: false });
  });

  it('期限は完了から7日', async () => {
    const { db } = setupHandoverDb();
    const handover = {
      completed_at: '2026-09-20T12:00:00.000+09:00',
    } as Parameters<typeof rollbackDeadlineOf>[0];
    expect(rollbackDeadlineOf(handover)).toBe('2026-09-27T03:00:00.000Z');
  });
});
