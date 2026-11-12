import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateCondition,
  isPermanentLineDeliveryError,
  isSupportedConditionType,
  SUPPORTED_CONDITION_TYPES,
  processStepDeliveries,
  expandVariables,
  resolveScenarioDeliveryFriend,
} from './step-delivery.js';
import type { LineClient } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';

/**
 * 通の conditionType/conditionValue は配信時に評価する。不明・不正な条件を常時通過と解釈して過剰配信しないよう、安全側でその通を飛ばす。
 */

interface FakeTables {
  friendTags?: Set<string>; // "friendId|tagId" entries
  friendMetadata?: Record<string, Record<string, unknown>>; // 友だち ID から metadata を引く。
  friendUserIds?: Record<string, string | null>; // 友だち ID から共有 UUID を引く。
}

function mockDb(tables: FakeTables): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T = unknown>(): Promise<T | null> => {
          if (sql.includes('FROM friend_tags ft')) {
            const [tagId, friendId] = args as [string, string, string];
            const userId = tables.friendUserIds?.[friendId] ?? null;
            const hasTag = [...(tables.friendTags ?? [])].some((entry) => {
              const [taggedFriendId, taggedTagId] = entry.split('|');
              return taggedTagId === tagId && (
                taggedFriendId === friendId ||
                (userId !== null && tables.friendUserIds?.[taggedFriendId] === userId)
              );
            });
            return hasTag ? ({ 1: 1 } as unknown as T) : null;
          }
          if (sql.includes('FROM friends')) {
            const [friendId] = args as [string];
            const meta = tables.friendMetadata?.[friendId];
            if (meta === undefined) return null;
            return {
              user_id: tables.friendUserIds?.[friendId] ?? null,
              metadata: JSON.stringify(meta),
              line_account_id: 'account-same-tenant',
            } as unknown as T;
          }
          return null;
        },
        all: async () => {
          if (sql.includes('SELECT f.metadata FROM friends f') && sql.includes('WHERE f.user_id')) {
            const [userId] = args as [string];
            return {
              results: Object.entries(tables.friendMetadata ?? {})
                .filter(([friendId]) => tables.friendUserIds?.[friendId] === userId)
                .map(([, meta]) => ({ metadata: JSON.stringify(meta) })),
            };
          }
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  } as unknown as D1Database;
}

describe('isSupportedConditionType', () => {
  it('accepts each value in SUPPORTED_CONDITION_TYPES', () => {
    for (const t of SUPPORTED_CONDITION_TYPES) {
      expect(isSupportedConditionType(t)).toBe(true);
    }
  });

  it.each(['tag_not_has', 'TAG_EXISTS', '', null, undefined, 42])(
    'rejects unsupported value %j',
    (val) => {
      expect(isSupportedConditionType(val)).toBe(false);
    },
  );
});

describe('evaluateCondition', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns true when condition_type is null (no condition set)', async () => {
    const db = mockDb({});
    expect(await evaluateCondition(db, 'f1', { condition_type: null, condition_value: null })).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns false (skip) when condition_type is set but condition_value is empty', async () => {
    // 値が欠けた条件を空文字の SQL として通して過剰配信しないよう、保存済み不整合も安全側で拒む。
    const db = mockDb({});
    expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_exists', condition_value: '' })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns false (skip) when condition_type is set but condition_value is null', async () => {
    const db = mockDb({});
    expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_not_exists', condition_value: null })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  describe('tag_exists', () => {
    it('returns true when the friend has the tag', async () => {
      const db = mockDb({ friendTags: new Set(['f1|tag-A']) });
      expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_exists', condition_value: 'tag-A' })).toBe(true);
    });
    it('returns false when the friend does not have the tag', async () => {
      const db = mockDb({ friendTags: new Set() });
      expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_exists', condition_value: 'tag-A' })).toBe(false);
    });
    it('returns true when a UUID-linked friend on another account has the tag', async () => {
      const db = mockDb({
        friendTags: new Set(['f2|tag-A']),
        friendUserIds: { f1: 'user-1', f2: 'user-1' },
      });
      expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_exists', condition_value: 'tag-A' })).toBe(true);
    });
  });

  describe('tag_not_exists', () => {
    it('returns true when the friend does not have the tag', async () => {
      const db = mockDb({ friendTags: new Set() });
      expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_not_exists', condition_value: 'tag-A' })).toBe(true);
    });
    it('returns false when the friend has the excluded tag', async () => {
      const db = mockDb({ friendTags: new Set(['f1|tag-A']) });
      expect(await evaluateCondition(db, 'f1', { condition_type: 'tag_not_exists', condition_value: 'tag-A' })).toBe(false);
    });
  });

  describe('metadata_equals', () => {
    it('returns true when the metadata matches', async () => {
      const db = mockDb({ friendMetadata: { f1: { purchased: 'true' } } });
      expect(
        await evaluateCondition(db, 'f1', {
          condition_type: 'metadata_equals',
          condition_value: JSON.stringify({ key: 'purchased', value: 'true' }),
        }),
      ).toBe(true);
    });
    it('returns false when the metadata key is absent', async () => {
      const db = mockDb({ friendMetadata: { f1: {} } });
      expect(
        await evaluateCondition(db, 'f1', {
          condition_type: 'metadata_equals',
          condition_value: JSON.stringify({ key: 'purchased', value: 'true' }),
        }),
      ).toBe(false);
    });
    it('returns true when UUID-linked metadata on another account matches', async () => {
      const db = mockDb({
        friendMetadata: { f1: {}, f2: { purchased: 'true' } },
        friendUserIds: { f1: 'user-1', f2: 'user-1' },
      });
      expect(
        await evaluateCondition(db, 'f1', {
          condition_type: 'metadata_equals',
          condition_value: JSON.stringify({ key: 'purchased', value: 'true' }),
        }),
      ).toBe(true);
    });
  });

  describe('metadata_not_equals', () => {
    it('returns false when the metadata equals the excluded value', async () => {
      const db = mockDb({ friendMetadata: { f1: { tier: 'gold' } } });
      expect(
        await evaluateCondition(db, 'f1', {
          condition_type: 'metadata_not_equals',
          condition_value: JSON.stringify({ key: 'tier', value: 'gold' }),
        }),
      ).toBe(false);
    });
    it('returns true when the metadata differs from the excluded value', async () => {
      const db = mockDb({ friendMetadata: { f1: { tier: 'silver' } } });
      expect(
        await evaluateCondition(db, 'f1', {
          condition_type: 'metadata_not_equals',
          condition_value: JSON.stringify({ key: 'tier', value: 'gold' }),
        }),
      ).toBe(true);
    });
  });

  describe('fail-safe semantics (OSS #120 regression)', () => {
    it('unknown condition_type → false (skip), NOT true (deliver)', async () => {
      // 未知の tag_not_has などを常時通過にせず、その通を飛ばす。
      const db = mockDb({ friendTags: new Set(['f1|tag-A']) });
      const result = await evaluateCondition(db, 'f1', {
        condition_type: 'tag_not_has',
        condition_value: 'tag-A',
      });
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('malformed condition_value JSON for metadata_equals → false (skip)', async () => {
      const db = mockDb({ friendMetadata: { f1: { tier: 'gold' } } });
      const result = await evaluateCondition(db, 'f1', {
        condition_type: 'metadata_equals',
        condition_value: '{this is not json',
      });
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('condition_value missing "key" → false (skip)', async () => {
      const db = mockDb({ friendMetadata: { f1: { tier: 'gold' } } });
      const result = await evaluateCondition(db, 'f1', {
        condition_type: 'metadata_equals',
        condition_value: JSON.stringify({ value: 'gold' }),
      });
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('condition_value missing "value" key → false (skip; would otherwise match undefined keys)', async () => {
      // metadata の value が欠けると未設定同士が一致してしまうため、値の存在を明示的に検査する。
      const db = mockDb({ friendMetadata: { f1: {} } });
      const result = await evaluateCondition(db, 'f1', {
        condition_type: 'metadata_equals',
        condition_value: JSON.stringify({ key: 'tier' }),
      });
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('friend metadata stored as invalid JSON → treated as empty map (does not throw)', async () => {
      const db = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ metadata: '{not json' }),
          }),
        }),
      } as unknown as D1Database;
      const result = await evaluateCondition(db, 'f1', {
        condition_type: 'metadata_equals',
        condition_value: JSON.stringify({ key: 'tier', value: 'gold' }),
      });
      // metadata が空ならキーはなく、不一致として false を返す。
      expect(result).toBe(false);
    });
  });
});

describe('resolveScenarioDeliveryFriend', () => {
  const friend = (overrides: Partial<Friend>): Friend => ({
    id: 'f-source',
    line_user_id: 'U-source',
    display_name: 'Source',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: 'user-1',
    line_account_id: 'account-1',
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
    ...overrides,
  });

  it('uses the following UUID-linked friend belonging to the scenario account', async () => {
    const linked = friend({
      id: 'f-target',
      line_user_id: 'U-target',
      line_account_id: 'account-2',
    });
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => linked }),
      }),
    } as unknown as D1Database;

    await expect(resolveScenarioDeliveryFriend(db, friend({}), 'account-2')).resolves.toEqual(linked);
  });

  it('does not fall back to a friend explicitly belonging to another account', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;

    await expect(resolveScenarioDeliveryFriend(db, friend({}), 'account-2')).resolves.toBeNull();
  });

  it('allows an OAuth-before-webhook row with no account to use the scenario account once', async () => {
    const oauthFriend = friend({ line_account_id: null });
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;

    await expect(resolveScenarioDeliveryFriend(db, oauthFriend, 'account-2')).resolves.toEqual(oauthFriend);
  });
});

describe('isPermanentLineDeliveryError', () => {
  const lineError = (status: number): Error =>
    new Error(`LINE API error: ${status} Test — {}`);

  it.each([400, 401, 403, 404, 422])('treats LINE %i as permanent', (status) => {
    expect(isPermanentLineDeliveryError(lineError(status))).toBe(true);
  });

  it.each([408, 409, 429, 500, 503])('keeps LINE %i retryable', (status) => {
    expect(isPermanentLineDeliveryError(lineError(status))).toBe(false);
  });

  it('does not classify unrelated errors as permanent LINE failures', () => {
    expect(isPermanentLineDeliveryError(new Error('network failure'))).toBe(false);
  });
});

/**
 * 条件不成立の遷移先が次の通と異なっていても、指定した通へ飛ぶことを確かめる。
 * 時刻だけを遷移先から使い、通番を元の位置のまま進めない。
 */
describe('condition-false jump (next_step_on_false)', () => {
  interface AdvanceCall {
    nextStepOrder: number;
    nextDeliveryAt: string | null;
    id: string;
  }

  /** 通番1から、タグ条件を満たさない次の通へ進む期限到達の購読を作り、条件不成立の経路を試す。 */
  function deliveryMockDb(opts: { nextStepOnFalse: number | null; steps?: number[] }): {
    db: D1Database;
    advances: AdvanceCall[];
    completes: string[];
  } {
    const advances: AdvanceCall[] = [];
    const completes: string[] = [];
    const stepOrders = opts.steps ?? [1, 2, 3, 4];
    const stepRows = stepOrders.map((order) => ({
      id: `step-${order}`,
      scenario_id: 'sc1',
      step_order: order,
      message_type: 'text',
      message_content: `msg ${order}`,
      template_id: null,
      delay_minutes: 10,
      offset_days: null,
      offset_minutes: null,
      delivery_time: null,
      condition_type: order === 2 ? 'tag_exists' : null,
      condition_value: order === 2 ? 'tag-X' : null,
      next_step_on_false: order === 2 ? opts.nextStepOnFalse : null,
      on_reach_tag_id: null,
    }));
    // 配信は購読に固定された公開版だけを読む（351）。版の写しを通の正本にし、
    // live の通IDは控えにだけ残す。
    const versionRow = {
      id: 'v-sc1',
      scenario_id: 'sc1',
      version_number: 1,
      delivery_mode: 'relative',
      audience_condition_json: null,
      on_complete_mode: 'pause',
      on_complete_scenario_id: null,
      steps_snapshot: JSON.stringify(
        stepRows.map((row) => ({
          ...row,
          version_step_id: `v-sc1:${row.step_order}`,
          template_id_at_send: null,
          after_send: 'continue',
          target_condition_json: null,
          question_json: null,
          is_draft: 0,
          live_step_id: row.id,
          created_at: '2026-01-01T00:00:00+09:00',
        })),
      ),
      status: 'published',
      published_at: '2026-01-01T00:00:00+09:00',
      published_by_staff_id: null,
      created_at: '2026-01-01T00:00:00+09:00',
      updated_at: '2026-01-01T00:00:00+09:00',
    };

    const db = {
      prepare: (sql: string) => {
        const stmt = (args: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM friend_tags')) {
              return null; // tag-X を持たないため条件は不成立になる。
            }
            if (sql.includes('FROM scenario_versions')) {
              return versionRow;
            }
            if (sql.includes('FROM friends')) {
              return {
                id: 'f1',
                line_user_id: 'U1',
                display_name: 'Test',
                is_following: 1,
                user_id: null,
                metadata: null,
                line_account_id: null,
              };
            }
            if (sql.includes('FROM scenarios')) {
              return { delivery_mode: 'relative', line_account_id: null };
            }
            return null;
          },
          all: async () => {
            if (sql.includes('FROM friend_scenarios')) {
              return {
                results: [
                  {
                    id: 'fs1',
                    friend_id: 'f1',
                    scenario_id: 'sc1',
                    current_step_order: 1,
                    status: 'active',
                    next_delivery_at: '2026-01-01T00:00:00+09:00',
                    started_at: '2026-01-01T00:00:00+09:00',
                    published_version_id: 'v-sc1',
                  },
                ],
              };
            }
            if (sql.includes('FROM scenario_steps')) {
              return { results: stepRows };
            }
            return { results: [] };
          },
          run: async () => {
            if (sql.includes("status = 'delivering'") && sql.includes("status = 'active'")) {
              return { meta: { changes: 1 } }; // 実行権の取得は成功させる。
            }
            if (sql.includes('current_step_order = ?') && sql.includes("status = 'active'")) {
              advances.push({
                nextStepOrder: args[0] as number,
                nextDeliveryAt: args[1] as string | null,
                id: args[3] as string,
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes("status = 'completed'")) {
              completes.push(args[1] as string);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        });
        return {
          bind: (...args: unknown[]) => stmt(args),
          ...stmt([]),
        };
      },
    } as unknown as D1Database;

    return { db, advances, completes };
  }

  function mockLineClient(): { client: LineClient; push: ReturnType<typeof vi.fn> } {
    const push = vi.fn(async () => ({}));
    return { client: { pushMessage: push } as unknown as LineClient, push };
  }

  it('failed condition with next_step_on_false=4 advances so the JUMP TARGET (4) is delivered next, not step 3', async () => {
    const { db, advances } = deliveryMockDb({ nextStepOnFalse: 4 });
    const { client, push } = mockLineClient();

    await processStepDeliveries(db, client);

    expect(push).not.toHaveBeenCalled(); // 条件不成立では push しない。
    expect(advances).toHaveLength(1);
    expect(advances[0].id).toBe('fs1');
    // 次に通番4を選ぶため、現在値は3へ進める。元の通番2のままでは通番3へ誤って送る。
    expect(advances[0].nextStepOrder).toBe(3);
  });

  it('jump target works with non-contiguous step orders (1,2,5,9 → jump to 9)', async () => {
    const { db, advances } = deliveryMockDb({ nextStepOnFalse: 9, steps: [1, 2, 5, 9] });
    const { client } = mockLineClient();

    await processStepDeliveries(db, client);

    expect(advances).toHaveLength(1);
    // 現在値8の次は9を選び、途中の5は飛ばす。
    expect(advances[0].nextStepOrder).toBe(8);
  });

  it('failed condition WITHOUT jump target keeps sequential advance (next tick delivers step 3)', async () => {
    const { db, advances } = deliveryMockDb({ nextStepOnFalse: null });
    const { client } = mockLineClient();

    await processStepDeliveries(db, client);

    expect(advances).toHaveLength(1);
    // 遷移先がなければ現在の通番2へ進め、次は3を選ぶ。
    expect(advances[0].nextStepOrder).toBe(2);
  });

  it('jump target pointing at a missing step_order falls back to sequential advance', async () => {
    const { db, advances } = deliveryMockDb({ nextStepOnFalse: 99 });
    const { client } = mockLineClient();

    await processStepDeliveries(db, client);

    expect(advances).toHaveLength(1);
    expect(advances[0].nextStepOrder).toBe(2); // 遷移先99がなければ、順番の経路へ戻る。
  });
});

/**
 * 条件ブロックの削除で崩れたカンマを補正するのは Flex JSON だけとし、通常の本文にある連続カンマや角括弧を勝手に変更しない。
 */
describe('expandVariables comma cleanup scope', () => {
  const friend = { id: 'f1', display_name: 'Test', user_id: null };

  describe('text messages are never rewritten', () => {
    it('preserves ",," in a text body', () => {
      const body = '価格は 1,, 2,, 3 のように表記します';
      expect(expandVariables(body, friend, undefined, 'text')).toBe(body);
    });

    it('preserves "[," and ",]" in a text body', () => {
      const body = '記法メモ: [, は開き、 ,] は閉じ';
      expect(expandVariables(body, friend, undefined, 'text')).toBe(body);
    });

    it('preserves ",," when messageType is omitted (safe default)', () => {
      const body = 'A,, B';
      expect(expandVariables(body, friend)).toBe(body);
    });

    it('still expands {{name}} in text without touching commas', () => {
      const out = expandVariables('{{name}}様, , こんにちは', friend, undefined, 'text');
      expect(out).toBe('Test様, , こんにちは');
    });
  });

  describe('flex messages keep the JSON repair (existing behaviour)', () => {
    it('repairs "[," left by a removed {{#if_ref}} block so the JSON parses', () => {
      // ref_code なしで先頭の条件付き要素が消える Flex 配列を再現する。
      const template = '{"contents":[{{#if_ref}}{"type":"text","text":"ref: {{ref}}"}{{/if_ref}},{"type":"text","text":"hello"}]}';
      const out = expandVariables(template, { ...friend, ref_code: null }, undefined, 'flex');
      expect(out).toBe('{"contents":[{"type":"text","text":"hello"}]}');
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('repairs ",]" when the removed block was the last array element', () => {
      const template = '{"contents":[{"type":"text","text":"hello"},{{#if_metadata.plan}}{"type":"text","text":"{{metadata.plan}}"}{{/if_metadata.plan}}]}';
      const out = expandVariables(template, { ...friend, metadata: {} }, undefined, 'flex');
      expect(out).toBe('{"contents":[{"type":"text","text":"hello"}]}');
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });
});

/**
 * 途中で停止した delivering の購読を取り残さないよう、active だけを対象とする期限取得より前に、各 cron が停止中の実行権を回復する。
 */
describe('processStepDeliveries crash recovery', () => {
  it("resets stuck 'delivering' enrollments before querying due rows", async () => {
    const executed: string[] = [];
    const db = {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          first: async () => null,
          all: async () => {
            executed.push(sql);
            return { results: [] };
          },
          run: async () => {
            executed.push(sql);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    } as unknown as D1Database;
    const push = vi.fn(async () => ({}));
    const client = { pushMessage: push } as unknown as LineClient;

    await processStepDeliveries(db, client);

    const recoveryIdx = executed.findIndex(
      (sql) => sql.includes("status = 'active'") && sql.includes("status = 'delivering'"),
    );
    const dueQueryIdx = executed.findIndex((sql) => sql.includes('FROM friend_scenarios'));
    expect(recoveryIdx).toBeGreaterThanOrEqual(0); // 回復処理が実行されたことを確かめる。
    expect(dueQueryIdx).toBeGreaterThanOrEqual(0);
    expect(recoveryIdx).toBeLessThan(dueQueryIdx); // 回復が対象取得より先に実行されたことを確かめる。
  });
});
