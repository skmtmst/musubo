import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPublishedVersionContent,
  createMileageRule,
  enqueueMileageEvent,
  processPendingMileageEvents,
} from './index.js';
import {
  publishMileageEarningRule,
  saveMileageEarningRuleDraft,
} from './admin-operations.js';

/**
 * 対象外の友だちに付与しないため、下書きの条件を公開版へ引き継ぎ、
 * キュー処理でも条件を判定することを実SQLiteで確かめる。
 */

const packageRoot = join(import.meta.dirname, '../..');
const bootstrap = readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8');

function asD1(sqlite: Database.Database): D1Database {
  function prepare(query: string): D1PreparedStatement {
    const statement = sqlite.prepare(query);
    const bound = (params: unknown[]): D1PreparedStatement => ({
      bind: (...next: unknown[]) => bound(next),
      async all<T>() {
        return { results: statement.all(...params) as T[], success: true, meta: {} };
      },
      async first<T>() {
        return (statement.get(...params) as T | undefined) ?? null;
      },
      async run<T>() {
        const result = statement.run(...params);
        return { success: true, meta: { changes: result.changes }, results: [] } as T;
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        const results: T[] = [];
        for (const statementItem of statements) {
          results.push((await (statementItem as unknown as { run(): Promise<T> }).run()));
        }
        return results;
      },
    } as unknown as D1PreparedStatement);
    return bound([]);
  }
  const db = { prepare } as unknown as D1Database;
  // 公開処理は db.batch を使う。prepare 同様に逐次実行する。
  (db as unknown as Record<string, unknown>).batch = async (statements: D1PreparedStatement[]) => {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await (statement as unknown as { run(): Promise<unknown> }).run());
    }
    return results;
  };
  return db;
}

const ACCOUNT = 'account-r52';
const ELIGIBLE = { id: 'friend-eligible', lineUserId: 'U-eligible', displayName: 'OnlyEligible 太郎' };
const OUTSIDE = { id: 'friend-outside', lineUserId: 'U-outside', displayName: 'OutsideTarget 花子' };

const TARGET = {
  operator: 'AND',
  rules: [{ type: 'name', value: { text: 'OnlyEligible', targets: ['display'] } }],
};

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(bootstrap);
  db = asD1(sqlite);
});

async function setupPublishedRuleWithTarget() {
  sqlite
    .prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?, ?, ?, ?, ?)`)
    .run(ACCOUNT, 'ch-r52', 'R52確認用', 'token', 'secret');
  for (const friend of [ELIGIBLE, OUTSIDE]) {
    sqlite
      .prepare(`INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES (?, ?, ?, ?)`)
      .run(friend.id, friend.lineUserId, friend.displayName, ACCOUNT);
  }
  const rule = await createMileageRule(db, {
    name: '予約でたまる',
    eventType: 'booking_created',
    amount: 300,
    lineAccountId: ACCOUNT,
  });
  await saveMileageEarningRuleDraft(db, {
    ruleId: rule.id,
    lineAccountId: ACCOUNT,
    expectedVersion: null,
    draft: {
      name: '予約でたまる',
      eventType: 'booking_created',
      source: null,
      amount: 300,
      initialStatus: 'available',
      validFrom: null,
      validUntil: null,
      expiresAfterDays: null,
      cancellationEventTypes: [],
      targetConditions: TARGET,
      sortOrder: 0,
      notification: { enabled: false, messageTemplate: '' },
    },
  });
  const published = await publishMileageEarningRule(db, {
    ruleId: rule.id,
    lineAccountId: ACCOUNT,
    expectedVersion: 1,
    idempotencyKey: 'r52-first-publish',
  });
  return { ruleId: rule.id, versionNumber: published.versionNumber };
}

describe('R52 対象条件の公開・実行', () => {
  it('公開版に下書きの対象条件が残る', async () => {
    const { ruleId, versionNumber } = await setupPublishedRuleWithTarget();
    const content = await getPublishedVersionContent(db, ruleId, versionNumber);
    expect(content?.target_conditions).toEqual(TARGET);
  });

  it('対象外の友だちにはマイルを付けない', async () => {
    await setupPublishedRuleWithTarget();
    await enqueueMileageEvent(db, {
      eventType: 'booking_created',
      source: 'booking',
      sourceEventId: 'evt-eligible-1',
      friendId: ELIGIBLE.id,
    });
    await enqueueMileageEvent(db, {
      eventType: 'booking_created',
      source: 'booking',
      sourceEventId: 'evt-outside-1',
      friendId: OUTSIDE.id,
    });
    const result = await processPendingMileageEvents(db, { limit: 10 });
    expect(result.granted).toBe(1);
    const grants = sqlite
      .prepare(`SELECT beneficiary_friend_id AS friendId, amount FROM mileage_ledger WHERE entry_type = 'grant'`)
      .all() as Array<{ friendId: string; amount: number }>;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.friendId).toBe(ELIGIBLE.id);
    expect(grants[0]?.amount).toBe(300);
  });
});
