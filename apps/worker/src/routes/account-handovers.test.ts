import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

/**
 * LINEアカウントの乗り換え（引き継ぎ）。設計 ★33-4（`nx3XW`）。台帳。
 *
 * ここで守りたいのは 3 点。
 *   **合計が合わない数を通さない**（合わないと、どこかの人が消えたように見える）
 *   **分からないプロバイダーを「同じ」と言わない**
 *   **決めていない人がいるまま本実行させない**（その人がどちらにも入らず消える）
 */

const db = {
  compareProviders: vi.fn(),
  countsAddUp: vi.fn(),
  MATCH_BUCKETS: ['auto', 'review', 'unmatched', 'lookalike'] as const,
  issueHandoverCode: vi.fn(),
  getHandoverById: vi.fn(),
  linkHandover: vi.fn(),
  savePreview: vi.fn(),
  saveDecision: vi.fn(),
  listDecisions: vi.fn(),
  listHandoversForAccount: vi.fn(),
  unresolvedReviewCount: vi.fn(),
  markResolved: vi.fn(),
  markExecuting: vi.fn(),
  completeHandover: vi.fn(),
  cancelHandover: vi.fn(),
  rollbackHandover: vi.fn(),
  // 実物と同じ形で期限を返す（完了+7日。未完了は null）。
  rollbackDeadlineOf: (row: { completed_at: string | null }) =>
    row.completed_at
      ? new Date(new Date(row.completed_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : null,
  // step-up の台帳。テストでは x-step-up-token 付きなら通す。
  consumeStepUpGrant: vi.fn(),
  getAdminSessionByTokenHash: vi.fn(),
};
vi.mock('@line-crm/db', () => db);

const accountAccess = { canAccessAllLineAccounts: vi.fn(), getVisibleLineAccountScope: vi.fn() };
vi.mock('../services/account-access.js', () => accountAccess);

const { accountHandovers } = await import('./account-handovers.js');

const run = vi.fn();
const bind = vi.fn((..._values: unknown[]) => ({
  run,
  first: vi.fn(),
  all: vi.fn(async () => ({ results: [] })),
}));
// 引数の型を書いておく。書かないと `prepare.mock.calls[n][0]` が
// 長さ0のタプル扱いになり、CI の型検査だけが落ちる。
const prepare = vi.fn((_sql: string) => ({ bind }));
const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => [await statements[0].run()]);
const env = { DB: { prepare, batch } as unknown as D1Database };

function makeApp(role: 'owner' | 'staff' = 'owner') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'u-1', name: 'テスト', role, readOnly: false });
    return next();
  });
  app.route('/', accountHandovers);
  return app;
}

function post(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 本実行・切り戻しは本人確認（step-up）が要る。grant は1回限りなので、
// リクエストごとに新しいトークン値を付ける。
function stepUpPost(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-step-up-token': `grant-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const HANDOVER = {
  id: 'ho-1',
  from_account_id: 'acc-from',
  to_account_id: 'acc-to',
  code: 'ABCD-EFGH-JKMN',
  code_expires_at: '2099-01-01T00:00:00+09:00',
  status: 'linked' as const,
  provider_match: 'same' as const,
  source_friend_total: null,
  auto_count: null,
  review_count: null,
  unmatched_count: null,
  lookalike_count: null,
  moved_count: 0,
  failed_count: 0,
  failure_reason: null,
  created_by: 'u-1',
  created_at: '2026-09-04T00:00:00+09:00',
  linked_at: '2026-09-04T00:01:00+09:00',
  previewed_at: null,
  resolved_at: null,
  executed_at: null,
  completed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({ meta: { changes: 1 } });
  bind.mockImplementation((..._values: unknown[]) => ({ run, first: vi.fn().mockResolvedValue({ id: 'owned-friend' }), all: vi.fn(async () => ({ results: [] })) }));
  accountAccess.canAccessAllLineAccounts.mockResolvedValue(true);
  db.getHandoverById.mockResolvedValue(HANDOVER);
  db.listDecisions.mockResolvedValue([]);
  db.unresolvedReviewCount.mockResolvedValue(0);
  db.savePreview.mockResolvedValue({ ok: true });
  db.consumeStepUpGrant.mockResolvedValue(true);
  db.getAdminSessionByTokenHash.mockResolvedValue(null);
  db.countsAddUp.mockImplementation(
    (counts: Record<string, number>, total: number) =>
      counts.auto + counts.review + counts.unmatched + counts.lookalike === total,
  );
});

describe('段3 事前確認', () => {
  /*
    **合計が合わない結果を通さない。** 通すと画面がそれを出し、
    運用者は「どこかの人が消えた」と読む。
  */
  it('4区分の合計が元の友だち数と合わなければ 422 で断る', async () => {
    const res = await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 100,
        counts: { auto: 60, review: 20, unmatched: 10, lookalike: 5 },
      }),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: '区分の合計が元の友だち数と合いません' });
    expect(db.savePreview).not.toHaveBeenCalled();
  });

  it('合っていれば保存する', async () => {
    prepare.mockImplementationOnce((_sql: string) => ({
      bind: vi.fn((..._values: unknown[]) => ({
        run,
        first: vi.fn().mockResolvedValue({ count: 100 }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    }));
    const res = await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 100,
        counts: { auto: 60, review: 20, unmatched: 15, lookalike: 5 },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(db.savePreview).toHaveBeenCalledWith(expect.anything(), 'ho-1', {
      sourceFriendTotal: 100,
      counts: { auto: 60, review: 20, unmatched: 15, lookalike: 5 },
      declaredFriendTotal: null,
    });
  });

  /*
    **申告の人数をうのみにしない。** 画面の表示数・手作り呼び出しが
    そのまま「事前確認の結果」として残るのを防ぐ。
  */
  it('申告の合計が実際の友だち数と違えば 422 で断る', async () => {
    prepare.mockImplementationOnce((_sql: string) => ({
      bind: vi.fn((..._values: unknown[]) => ({
        run,
        first: vi.fn().mockResolvedValue({ count: 90 }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    }));
    const res = await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 100,
        counts: { auto: 60, review: 20, unmatched: 15, lookalike: 5 },
      }),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('友だち数が変わっています') });
    expect(db.savePreview).not.toHaveBeenCalled();
  });

  it('区分が1つでも欠けていたら断る（0 で埋めない）', async () => {
    const res = await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 100,
        counts: { auto: 60, review: 20, unmatched: 20 },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'lookalike の人数が要ります' });
  });

  /*
    **事前確認だけでは元のアカウントを変えない。**
    設計の「ここで止めても、元のアカウントは何も変わりません」。
  */
  it('friends を書き換えない', async () => {
    await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 10,
        counts: { auto: 10, review: 0, unmatched: 0, lookalike: 0 },
      }),
      env,
    );
    const statements = prepare.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => /UPDATE\s+friends/i.test(sql))).toBe(false);
  });

  it('受け取り先が決まっていなければ断る', async () => {
    db.getHandoverById.mockResolvedValue({ ...HANDOVER, to_account_id: null });
    const res = await makeApp().fetch(
      post('/api/account-handovers/ho-1/preview', {
        sourceFriendTotal: 1,
        counts: { auto: 1, review: 0, unmatched: 0, lookalike: 0 },
      }),
      env,
    );
    expect(res.status).toBe(422);
  });
});

describe('数はまとめて出すか、出さないか', () => {
  it('事前確認の前は counts を null で返す', async () => {
    const res = await makeApp().fetch(
      new Request('https://example.com/api/account-handovers/ho-1'),
      env,
    );
    expect(await res.json()).toMatchObject({ data: { counts: null } });
  });

  it('事前確認のあとは4区分と合計をそろえて返す', async () => {
    db.getHandoverById.mockResolvedValue({
      ...HANDOVER,
      source_friend_total: 100,
      auto_count: 60,
      review_count: 20,
      unmatched_count: 15,
      lookalike_count: 5,
    });
    const res = await makeApp().fetch(
      new Request('https://example.com/api/account-handovers/ho-1'),
      env,
    );
    expect(await res.json()).toMatchObject({
      data: { counts: { sourceTotal: 100, auto: 60, review: 20, unmatched: 15, lookalike: 5 } },
    });
  });
});

describe('段4 競合の判断', () => {
  /*
    **「同じ人として結びつける」のに相手がいない、を通さない。**
    通すと本実行で行き先の無い人ができ、静かに消える。
  */
  it('link なのに相手が無ければ 422 で断る', async () => {
    const res = await makeApp().fetch(
      put('/api/account-handovers/ho-1/decisions', {
        decisions: [{ fromFriendId: 'f-1', decision: 'link', bucket: 'review' }],
      }),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: '結びつける相手が要ります' });
    expect(db.saveDecision).not.toHaveBeenCalled();
  });

  it('skip は相手がいなくてよい', async () => {
    const res = await makeApp().fetch(
      put('/api/account-handovers/ho-1/decisions', {
        decisions: [{ fromFriendId: 'f-1', decision: 'skip', bucket: 'unmatched' }],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(db.saveDecision).toHaveBeenCalledTimes(1);
  });

  it('知らない区分を受け取らない', async () => {
    const res = await makeApp().fetch(
      put('/api/account-handovers/ho-1/decisions', {
        decisions: [{ fromFriendId: 'f-1', decision: 'skip', bucket: 'maybe' }],
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('要確認が全部決まったら段4を終わりにする', async () => {
    db.unresolvedReviewCount.mockResolvedValue(0);
    await makeApp().fetch(
      put('/api/account-handovers/ho-1/decisions', {
        decisions: [{ fromFriendId: 'f-1', decision: 'new', bucket: 'review' }],
      }),
      env,
    );
    expect(db.markResolved).toHaveBeenCalledWith(expect.anything(), 'ho-1');
  });

  it('のこりがあるうちは段4を終わりにしない', async () => {
    db.unresolvedReviewCount.mockResolvedValue(3);
    await makeApp().fetch(
      put('/api/account-handovers/ho-1/decisions', {
        decisions: [{ fromFriendId: 'f-1', decision: 'new', bucket: 'review' }],
      }),
      env,
    );
    expect(db.markResolved).not.toHaveBeenCalled();
  });
});

describe('段5 本実行', () => {
  /*
    **決めていない人がいるまま実行させない。**
    その人はどちらにも入らず、静かに消える。
  */
  it('要確認がのこっていたら 422 で止め、件数を言う', async () => {
    db.getHandoverById.mockResolvedValue({ ...HANDOVER, source_friend_total: 100, review_count: 5 });
    db.unresolvedReviewCount.mockResolvedValue(3);
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: '要確認が3件のこっています。全部決めてから実行してください',
    });
    expect(db.markExecuting).not.toHaveBeenCalled();
  });

  it('事前確認をしていなければ止める', async () => {
    db.getHandoverById.mockResolvedValue({ ...HANDOVER, source_friend_total: null });
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: '先に事前確認をしてください' });
  });

  it('もう実行したものは二重に実行しない', async () => {
    db.getHandoverById.mockResolvedValue({
      ...HANDOVER,
      status: 'completed',
      source_friend_total: 10,
    });
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(409);
  });

  /*
    照合。**動かした数と、動かすつもりだった数を突き合わせる。**
    数だけ返して「終わりました」と言わない。
  */
  it('動かした数と予定数を突き合わせて返す', async () => {
    db.getHandoverById.mockResolvedValue({ ...HANDOVER, source_friend_total: 3, review_count: 0 });
    db.listDecisions.mockResolvedValue([
      { from_friend_id: 'f-1', decision: 'link', to_friend_id: 't-1' },
      { from_friend_id: 'f-2', decision: 'new', to_friend_id: null },
      { from_friend_id: 'f-3', decision: 'skip', to_friend_id: null },
    ]);
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(200);
    // skip は動かさない。予定は 2 件。
    expect(await res.json()).toMatchObject({ data: { plannedCount: 2 } });
    expect(db.completeHandover).toHaveBeenCalledWith(expect.anything(), 'ho-1', {
      movedCount: 2,
      failedCount: 0,
      failureReason: null,
    });
  });

  // X-3。移し元システムの申告件数と事前確認の合計が違うままでは本実行しない。
  it('申告件数が事前確認と違うときは 422 で止め、両方の数を言う', async () => {
    db.getHandoverById.mockResolvedValue({
      ...HANDOVER,
      source_friend_total: 100,
      declared_friend_total: 98,
      review_count: 0,
    });
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('98');
    expect(body.error).toContain('100');
    expect(db.markExecuting).not.toHaveBeenCalled();
  });

  it('本人確認が無いと 401 で止める', async () => {
    db.getHandoverById.mockResolvedValue({ ...HANDOVER, source_friend_total: 3, review_count: 0 });
    const res = await makeApp().fetch(post('/api/account-handovers/ho-1/execute', {}), env);
    expect(res.status).toBe(401);
    expect(db.markExecuting).not.toHaveBeenCalled();
  });
});

// X-5。本実行から7日以内・1回だけの切り戻し。
describe('段6 切り戻し', () => {
  const completed = {
    ...HANDOVER,
    status: 'completed' as const,
    source_friend_total: 10,
    completed_at: new Date().toISOString(),
    rolled_back_at: null,
  };

  it('本人確認つきで戻し、戻した人数を返す', async () => {
    db.getHandoverById.mockResolvedValue(completed);
    db.rollbackHandover.mockResolvedValue({ ok: true, restoredCount: 7 });
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/rollback', { note: 'やり直し' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { restoredCount: 7 } });
  });

  it('戻せないものは 422 で理由を言う', async () => {
    db.getHandoverById.mockResolvedValue(completed);
    db.rollbackHandover.mockResolvedValue({ ok: false, error: '切り戻せる期限（7日間）を過ぎています' });
    const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/rollback', {}), env);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: '切り戻せる期限（7日間）を過ぎています' });
  });

  it('本人確認が無いと 401 で止める', async () => {
    db.getHandoverById.mockResolvedValue(completed);
    const res = await makeApp().fetch(post('/api/account-handovers/ho-1/rollback', {}), env);
    expect(res.status).toBe(401);
    expect(db.rollbackHandover).not.toHaveBeenCalled();
  });
});

describe('見える範囲', () => {
  it('片方のアカウントしか見えない人には出さない', async () => {
    accountAccess.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await makeApp().fetch(
      new Request('https://example.com/api/account-handovers/ho-1'),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('見るだけの担当者の変更拒否（R522）', () => {
  // 口側の境目 requireRole('owner', 'admin') を役割×操作の表で固定する。
  // 画面の出し分け（canManageRole）と同じ表。直しを戻すと赤くなる。
  it.each([
    ['発行', 'POST', '/api/account-handovers', { fromAccountId: 'acc-from' }],
    ['連結', 'POST', '/api/account-handovers/link', { code: 'ABCD-EFGH-JKMN', toAccountId: 'acc-to' }],
    ['事前確認', 'POST', '/api/account-handovers/ho-1/preview', {
      sourceFriendTotal: 2,
      counts: { auto: 1, review: 1, unmatched: 0, lookalike: 0 },
    }],
    ['判断の保存', 'PUT', '/api/account-handovers/ho-1/decisions', { decisions: [] }],
    ['本実行', 'POST', '/api/account-handovers/ho-1/execute', {}],
    ['取り消し', 'POST', '/api/account-handovers/ho-1/cancel', {}],
    ['切り戻し', 'POST', '/api/account-handovers/ho-1/rollback', {}],
  ])('%sはstaffに403を返す', async (_label, method, path, body) => {
    const res = await makeApp('staff').fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it.each([
    ['詳細の読み取り', '/api/account-handovers/ho-1'],
    ['一覧の読み取り', '/api/line-accounts/acc-from/handovers'],
  ])('%sはstaffにも許す', async (_label, path) => {
    const res = await makeApp('staff').fetch(
      new Request(`https://example.com${path}`),
      env,
    );
    expect(res.status).not.toBe(403);
  });
});


it('F13: foreign source/target friends cannot be saved as handover decisions', async () => {
  bind.mockImplementation((..._values: unknown[]) => ({ run, first: vi.fn().mockResolvedValue(null), all: vi.fn(async () => ({ results: [] })) }));
  const res = await makeApp().fetch(put('/api/account-handovers/ho-1/decisions', { decisions: [{ fromFriendId: 'foreign', toFriendId: 'foreign-target', decision: 'link', bucket: 'auto' }] }), env);
  expect(res.status).toBe(404);
  expect(db.saveDecision).not.toHaveBeenCalled();
});
it('F13: execution counts a stale/moved source as failure and never claims a move', async () => {
  db.getHandoverById.mockResolvedValue({ ...HANDOVER, source_friend_total: 1, review_count: 0 });
  db.listDecisions.mockResolvedValue([{ from_friend_id: 'foreign', to_friend_id: null, decision: 'new' }]);
  run.mockResolvedValue({ meta: { changes: 0 } });
  const res = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', {}), env);
  expect(res.status).toBe(200);
  expect(db.completeHandover).toHaveBeenCalledWith(expect.anything(), 'ho-1', expect.objectContaining({ movedCount: 0, failedCount: 1 }));
  expect(prepare.mock.calls.some(([sql]) => sql.includes('AND line_account_id = ?'))).toBe(true);
});

it('確認した版が古い本実行・取消は現在の版を返して止める', async () => {
  db.getHandoverById.mockResolvedValue({ ...HANDOVER, confirmation_revision: 4, source_friend_total: 0, review_count: 0 });
  const execute = await makeApp().fetch(stepUpPost('/api/account-handovers/ho-1/execute', { expectedConfirmationRevision: 3 }), env);
  expect(execute.status).toBe(409); expect(await execute.json()).toMatchObject({current:{confirmationRevision:4}});
  expect(db.markExecuting).not.toHaveBeenCalled();
  const cancel = await makeApp().fetch(post('/api/account-handovers/ho-1/cancel', { expectedConfirmationRevision: 3 }), env);
  expect(cancel.status).toBe(409); expect(db.cancelHandover).not.toHaveBeenCalled();
});
