import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { broadcasts } from './broadcasts';

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const staff: AuthenticatedStaff = {
  ...owner, id: 'staff-1', name: '担当者', role: 'staff', permissionKeys: ['/broadcasts'],
};

function app(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.example' } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', broadcasts);
  return instance;
}

function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/*
 * KPI は直近28日だけを集計するため、時計を fixture の基準日に固定する。実行日によって fixture が期間外となり、送達件数が変わらないようにする。
 */
const NOW = new Date('2026-09-07T12:00:00.000Z');

function seedBroadcast(db: SqliteD1, id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    title: id,
    message_type: 'text',
    message_content: 'https://example.com/campaign',
    target_type: 'all',
    status: 'sent',
    total_count: 10,
    success_count: 10,
    line_account_id: 'account-1',
    sent_at: '2026-09-07T10:00:00.000Z',
    created_at: '2026-09-07T09:00:00.000Z',
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO broadcasts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column] as never));
}

describe('broadcast data contracts', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    testDb = createTestD1();
    testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1'), ('tenant-2', '統括2')").run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1'),
             ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-2')
    `).run();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/quota/consumption')) return Response.json({ totalUsage: 1213 });
      if (url.endsWith('/quota')) return Response.json({ type: 'limited', value: 5000 });
      return new Response(null, { status: 404 });
    }));
  });

  afterEach(() => {
    testDb.raw.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('更新口もLINE送信口と同じ最大5通を受け、6通目を拒否する', async () => {
    seedBroadcast(testDb, 'draft-five', { status: 'draft', sent_at: null });
    const bubbles = Array.from({ length: 5 }, (_, index) => ({
      id: `bubble-${index + 1}`,
      type: 'text',
      content: { text: `${index + 1}通目` },
    }));

    // 版を付けて更新する（版なしは400になる）。
    const accepted = await app(testDb.db).request('/api/broadcasts/draft-five', json('PUT', {
      messageBubbles: bubbles,
      expectedVersion: 1,
    }));
    expect(accepted.status).toBe(200);

    const rejected = await app(testDb.db).request('/api/broadcasts/draft-five', json('PUT', {
      messageBubbles: [...bubbles, bubbles[0]],
      expectedVersion: 2,
    }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: 'messageBubbles must contain 1 to 5 items' });
  });

  // 版なしPUTは400で止め、行を変えない。不正値も400。
  it('版なし・不正版のPUTは400で止める', async () => {
    seedBroadcast(testDb, 'draft-noversion', { status: 'draft', sent_at: null });
    for (const body of [
      { title: '版なし' },
      { title: '文字版', expectedVersion: '1' },
      { title: '小数版', expectedVersion: 1.5 },
      { title: '零版', expectedVersion: 0 },
    ]) {
      const res = await app(testDb.db).request('/api/broadcasts/draft-noversion', json('PUT', body));
      expect(res.status).toBe(400);
    }
    const missing = await app(testDb.db).request('/api/broadcasts/draft-noversion', json('PUT', { title: '版なし' }));
    await expect(missing.json()).resolves.toMatchObject({ success: false, code: 'EXPECTED_VERSION_REQUIRED' });
    expect(testDb.raw.prepare(`SELECT title, lock_version FROM broadcasts WHERE id = 'draft-noversion'`).get())
      .toEqual({ title: 'draft-noversion', lock_version: 1 });
  });

  // 他アカウントの行は版の有無にかかわらず404のまま（版チェックより先）。
  it('他アカウントのPUTは版なしでも404にする', async () => {
    seedBroadcast(testDb, 'draft-foreign', { status: 'draft', sent_at: null, line_account_id: 'account-2' });
    const res = await app(testDb.db).request('/api/broadcasts/draft-foreign', json('PUT', { title: '越境' }));
    expect(res.status).toBe(404);
  });

  // 2編集者の競合は先勝ち・後は409で、先の変更が残る。
  it('2編集者の同時更新は先勝ち・後409にする', async () => {
    seedBroadcast(testDb, 'draft-race', { status: 'draft', sent_at: null });
    const first = await app(testDb.db).request('/api/broadcasts/draft-race', json('PUT', {
      title: 'A案', expectedVersion: 1,
    }));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ data: { version: 2 } });

    const second = await app(testDb.db).request('/api/broadcasts/draft-race', json('PUT', {
      title: 'B案', expectedVersion: 1,
    }));
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ success: false, code: 'VERSION_CONFLICT' });
    expect(testDb.raw.prepare(`SELECT title, lock_version FROM broadcasts WHERE id = 'draft-race'`).get())
      .toEqual({ title: 'A案', lock_version: 2 });
  });

  it('通常: 対象3人・除外理由・送信枠・同時刻配信・21条件軸を実データで返す', async () => {
    insertFriend(testDb.raw, 'friend-ready', {
      line_account_id: 'account-1', display_name: '見本 141', updated_at: '2026-09-07T10:00:00.000Z',
    });
    insertFriend(testDb.raw, 'friend-hidden', {
      line_account_id: 'account-1', display_name: '非表示', is_hidden: 1, updated_at: '2026-09-07T09:00:00.000Z',
    });
    insertFriend(testDb.raw, 'friend-blocked', {
      line_account_id: 'account-1', display_name: 'ブロック', is_following: 0, updated_at: '2026-09-07T08:00:00.000Z',
    });
    seedBroadcast(testDb, 'scheduled-near', {
      status: 'scheduled', sent_at: null, scheduled_at: '2026-09-08T10:30:00.000Z', total_count: 0, success_count: 0,
    });

    const response = await app(testDb.db).request('/api/broadcasts/preflight', json('POST', {
      targetType: 'all', lineAccountId: 'account-1', messageContent: 'お知らせ',
      scheduledAt: '2026-09-08T10:00:00.000Z', messageCount: 1,
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        audience: { matched: number; sendable: number; representatives: unknown[] };
        exclusions: Record<string, number | null>;
        quota: Record<string, unknown>;
        concurrentBroadcasts: unknown[];
        conditionAxes: { standard: unknown[]; broadcastOnly: unknown[] };
      };
    };
    expect(body.data.audience).toMatchObject({ matched: 3, sendable: 1 });
    expect(body.data.audience.representatives).toHaveLength(1);
    expect(body.data.exclusions).toMatchObject({ blocked: 1, hidden: 1, total: 2, paused: 0 });
    expect(body.data.quota).toEqual({
      monthlyUsed: 1213, monthlyLimit: 5000, remaining: 3787, planned: 1, state: 'available', reason: null, unlimited: false, failures: [],
    });
    expect(body.data.concurrentBroadcasts).toHaveLength(1);
    expect(body.data.conditionAxes.standard).toHaveLength(15);
    expect(body.data.conditionAxes.broadcastOnly).toHaveLength(6);
  });

  it('637後の送信前確認は停止者を人で数え、送る人数・枠・案内へ反映する', async () => {
    for (const id of ['ready','stop','unknown']) insertFriend(testDb.raw,id,{line_account_id:'account-1'});
    testDb.raw.exec(`INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES
      ('account-1','stop','marketing','revoked','本人希望','manual'),
      ('account-1','stop','news','unknown','未確認','manual'),
      ('account-1','unknown','marketing','unknown','未確認','manual')`);
    const response=await app(testDb.db).request('/api/broadcasts/preflight',json('POST',{targetType:'all',lineAccountId:'account-1'}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({success:true,data:{audienceCount:1,consentExcluded:2,
      audience:{matched:3,sendable:1,representatives:[{friendId:'ready'}]},
      exclusions:{paused:2,total:2},quota:{planned:1},
      warnings:expect.arrayContaining([{level:'info',message:'配信を止めている 2 人には送りません。'}])}});
  });

  it('一覧とKPIは担当テナントだけを集計し、statsを配信IDとして扱わない', async () => {
    // 種の送信日（9/7）が集計の期間から外れないよう、時計を固定する（日付が進むと落ちていた）。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-08T00:00:00.000Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    seedBroadcast(testDb, 'own-broadcast', { total_count: 12, success_count: 10 });
    seedBroadcast(testDb, 'other-broadcast', {
      line_account_id: 'account-2', total_count: 100, success_count: 99,
    });

    const listResponse = await app(testDb.db).request('/api/broadcasts');
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: [{ id: 'own-broadcast' }],
      kpis: { delivered: 10 },
      pagination: { total: 1 },
    });

    const statsResponse = await app(testDb.db).request('/api/broadcasts/stats');
    expect(statsResponse.status).toBe(200);
    await expect(statsResponse.json()).resolves.toMatchObject({
      success: true,
      data: { delivered: 10, failed: 2 },
    });
  });

  it('空・権限不足・DB失敗を別状態で返す', async () => {
    const empty = await app(testDb.db).request('/api/broadcasts/saved-views?lineAccountId=account-1');
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ success: true, data: [] });

    const forbidden = await app(testDb.db).request('/api/broadcasts/saved-views?lineAccountId=account-2');
    expect(forbidden.status).toBe(403);

    const failingDb = {
      prepare: () => ({ bind: () => ({ all: async () => { throw new Error('db unavailable'); } }) }),
    } as unknown as D1Database;
    const failed = await app(failingDb).request('/api/broadcasts/saved-views?lineAccountId=account-1');
    expect(failed.status).toBe(500);
  });

  it('Slack通知の3状態を版付きで保存し、古い版は409にする', async () => {
    const initial = await app(testDb.db).request(
      '/api/broadcasts/notification-settings?lineAccountId=account-1',
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      data: {
        version: 0, started: true, completed: true, failed: true,
        displayText: '配信開始・完了・エラーはSlackの同じスレッドへ通知します。',
      },
    });

    const saved = await app(testDb.db).request(
      '/api/broadcasts/notification-settings?lineAccountId=account-1',
      json('PUT', { expectedVersion: 0, started: true, completed: false, failed: true }),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: { version: 1, displayText: '配信開始・エラーはSlackの同じスレッドへ通知します。' },
    });

    const conflict = await app(testDb.db).request(
      '/api/broadcasts/notification-settings?lineAccountId=account-1',
      json('PUT', { expectedVersion: 0, started: true, completed: true, failed: true }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: 'version_conflict' });
  });

  it('途中下書きとメッセージ設定を保存し、版競合を409にする', async () => {
    testDb.raw.prepare(`
      INSERT INTO common_actions
        (id, line_account_id, name, status, current_published_version_id, created_at, updated_at)
      VALUES ('action-1', 'account-1', '配信済みタグ', 'published', 'action-version-1',
              '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z')
    `).run();
    testDb.raw.prepare(`
      INSERT INTO common_action_versions
        (id, common_action_id, version_number, status, action_config, created_at, published_at)
      VALUES ('action-version-1', 'action-1', 1, 'published', '[]',
              '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z')
    `).run();
    const created = await app(testDb.db).request('/api/broadcasts', json('POST', {
      saveAsDraft: true,
      draftStep: 'basic',
      draftSendChoice: 'unselected',
      lineAccountId: 'account-1',
      internalMemo: '社内だけのメモ',
      scheduledAt: '2026-09-08T10:00:00.000Z',
      messageOptions: {
        buttons: [{ label: '資料を見る', type: 'pdf', value: 'https://example.com/guide.pdf' }],
      },
      afterActionVersionId: 'action-version-1',
    }));
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; version: number; draftPayload: unknown } };
    expect(createdBody.data).toMatchObject({
      version: 1,
      status: 'draft',
      draftPayload: { saveAsDraft: true, draftStep: 'basic', draftSendChoice: 'unselected' },
    });

    const updated = await app(testDb.db).request(`/api/broadcasts/${createdBody.data.id}`, json('PUT', {
      saveAsDraft: true,
      scheduledAt: '2026-09-09T10:00:00.000Z',
      draftStep: 'audience',
      draftSendChoice: 'now',
      internalMemo: '更新後',
      expectedVersion: 1,
    }));
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { version: 2, status: 'draft', draftStep: 'audience', internalMemo: '更新後', draftPayload: { draftSendChoice: 'now' } },
    });

    const conflict = await app(testDb.db).request(`/api/broadcasts/${createdBody.data.id}`, json('PUT', {
      saveAsDraft: true, internalMemo: '古い画面から更新', expectedVersion: 1,
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it.each([
    { label: '普通の本文', text: '書きかけ', sendBody: {} },
    { label: '名前を差し込む本文', text: '{{name}}へのお知らせ', sendBody: {} },
    { label: '送信の口から予約', text: '予約する本文', sendBody: { expectedVersion: 2, confirmedRecipientCount: 0, scheduledAt: '2026-09-09T10:00:00.000Z' } },
  ])('$label: 宛先未選択の下書きは繰り返し保存して読み直せ、送信は拒否する', async ({ text, sendBody }) => {
    const payload = { saveAsDraft: true, targetType: 'tag', targetTagId: '', draftTargetMode: 'unselected', lineAccountId: 'account-1', messageContent: text, title: '未選択の下書き' };
    const created = await app(testDb.db).request('/api/broadcasts', json('POST', payload));
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { id: string } };
    const updated = await app(testDb.db).request(`/api/broadcasts/${data.id}`, json('PUT', { ...payload, messageContent: text + ' 続きを保存', expectedVersion: 1 }));
    expect(updated.status).toBe(200);
    const read = await app(testDb.db).request(`/api/broadcasts/${data.id}`);
    await expect(read.json()).resolves.toMatchObject({ data: { targetType: 'tag', targetTagId: '', version: 2, status: 'draft', messageContent: text + ' 続きを保存', draftPayload: { draftTargetMode: 'unselected' } } });
    const confirmation = json('POST', sendBody);
    const sent = await app(testDb.db).request(`/api/broadcasts/${data.id}/send`, { ...confirmation, headers: { ...confirmation.headers, 'X-Confirm-Irreversible': 'broadcast-send' } });
    expect(sent.status).toBe(400);
    await expect(sent.json()).resolves.toMatchObject({ success: false, error: '送る相手を選んでください' });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT status FROM broadcasts WHERE id = ?').get(data.id)).toEqual({ status: 'draft' });
  });

  it('日時を保持した未選択の下書きでも、名前だけの更新は下書きのまま保存する', async () => {
    seedBroadcast(testDb, 'draft-retained-date', { status: 'draft', sent_at: null, target_type: 'tag', target_tag_id: null, scheduled_at: '2026-09-09T10:00:00.000Z' });
    const res = await app(testDb.db).request('/api/broadcasts/draft-retained-date', json('PUT', { expectedVersion: 1, title: '名前を更新' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { title: '名前を更新', status: 'draft', targetType: 'tag', targetTagId: null, scheduledAt: '2026-09-09T10:00:00.000Z', version: 2 } });
  });

  it.each(['stored', 'changed', 'cleared'])('%sの空タグの予約確定は入力も版も変えずに拒否する', async kind => {
    seedBroadcast(testDb, 'draft-empty-target', { status: 'draft', sent_at: null, target_type: kind === 'changed' ? 'all' : 'tag', target_tag_id: kind === 'cleared' ? 'old-tag' : null });
    const before = testDb.raw.prepare('SELECT * FROM broadcasts WHERE id = ?').get('draft-empty-target');
    const res = await app(testDb.db).request('/api/broadcasts/draft-empty-target', json('PUT', { expectedVersion: 1, scheduledAt: '2026-09-09T10:00:00.000Z', ...(kind === 'stored' ? {} : { targetType: 'tag', targetTagId: '' }), messageContent: '送らない新しい入力' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, error: '送る相手を選んでください' });
    expect(testDb.raw.prepare('SELECT * FROM broadcasts WHERE id = ?').get('draft-empty-target')).toEqual(before);
  });

  it.each(['all', 'tag', 'segment'] as const)('明示した%sの有効な宛先なら予約として保存する', async targetType => {
    testDb.raw.prepare("INSERT INTO tags (id, name, line_account_id) VALUES ('valid-tag', '購入者', 'account-1')").run();
    seedBroadcast(testDb, 'draft-valid-target', { status: 'draft', sent_at: null });
    const payload = { expectedVersion: 1, targetType, targetTagId: targetType === 'tag' ? 'valid-tag' : null, ...(targetType === 'segment' ? { segmentConditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] } } : {}), scheduledAt: '2026-09-09T10:00:00.000Z' };
    const res = await app(testDb.db).request('/api/broadcasts/draft-valid-target', json('PUT', payload));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { targetType, status: 'scheduled', scheduledAt: payload.scheduledAt, version: 2, messageContent: 'https://example.com/campaign' } });
  });

  it.each(['send', 'schedule'])('空タグでも%sの権限不足を先に返す', async operation => {
    seedBroadcast(testDb, 'draft-locked-target', { status: 'draft', sent_at: null, target_type: 'tag', target_tag_id: null });
    const req = operation === 'send' ? { ...json('POST', {}), headers: { 'Content-Type': 'application/json', 'X-Confirm-Irreversible': 'broadcast-send' } } : json('PUT', { expectedVersion: 1, scheduledAt: '2026-09-09T10:00:00.000Z' });
    const res = await app(testDb.db, staff).request('/api/broadcasts/draft-locked-target' + (operation === 'send' ? '/send' : ''), req);
    expect(res.status).toBe(403);
    expect(testDb.raw.prepare('SELECT status, lock_version FROM broadcasts WHERE id = ?').get('draft-locked-target')).toEqual({ status: 'draft', lock_version: 1 });
  });

  it('通常の確定で下書きの印が古くなっても、現在の予約日時と分散45分を返す', async () => {
    seedBroadcast(testDb, 'draft-choice', { status: 'draft', sent_at: null });
    const first = await app(testDb.db).request('/api/broadcasts/draft-choice', json('PUT', {
      saveAsDraft: true, scheduledAt: null, stealthSpreadMinutes: 0,
      draftSendChoice: 'now', draftScheduledDate: '2020-01-01', expectedVersion: 1,
    }));
    expect(first.status).toBe(200);
    const final = await app(testDb.db).request('/api/broadcasts/draft-choice', json('PUT', {
      scheduledAt: '2026-09-09T10:00:00.000Z', stealthSpreadMinutes: 45, expectedVersion: 2,
    }));
    expect(final.status).toBe(200);
    const read = await app(testDb.db).request('/api/broadcasts/draft-choice');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ data: {
      scheduledAt: '2026-09-09T10:00:00.000Z', stealthSpreadMinutes: 45,
      draftPayload: { draftSendChoice: 'now', stealthSpreadMinutes: 0, draftScheduledDate: '2020-01-01' },
    } });
    expect(testDb.raw.prepare("SELECT stealth_spread_minutes FROM broadcasts WHERE id = 'draft-choice'").get()).toEqual({ stealth_spread_minutes: 45 });
  });

  it('保存した検索はアカウント内だけに保存し、同名を409にする', async () => {
    const request = json('POST', {
      name: '予約中のみ', filters: { statuses: ['scheduled'] }, sortKey: 'newest', pageSize: 20,
    });
    const created = await app(testDb.db).request('/api/broadcasts/saved-views?lineAccountId=account-1', request);
    expect(created.status).toBe(201);
    const duplicate = await app(testDb.db).request('/api/broadcasts/saved-views?lineAccountId=account-1', request);
    expect(duplicate.status).toBe(409);
    const denied = await app(testDb.db, staff).request(
      '/api/broadcasts/saved-views?lineAccountId=account-1', request,
    );
    expect(denied.status).toBe(403);
  });

  it('配信に紐づくURLだけのクリック内訳とLINE開封母数を返す', async () => {
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', display_name: '見本 141' });
    seedBroadcast(testDb, 'broadcast-1');
    testDb.raw.prepare(`
      INSERT INTO tracked_links
        (id, name, original_url, line_account_id, short_code, dedup_key, is_active, click_count, created_at, updated_at)
      VALUES ('link-1', '商品を見る', 'https://example.com/campaign', 'account-1', 'Abc1234',
              'account-1|broadcast:broadcast-1|https://example.com/campaign', 1, 1,
              '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z')
    `).run();
    testDb.raw.prepare(`
      INSERT INTO broadcast_tracked_links (broadcast_id, tracked_link_id, label, created_at)
      VALUES ('broadcast-1', 'link-1', '商品を見る', '2026-09-07T10:00:00.000Z')
    `).run();
    testDb.raw.prepare(`
      INSERT INTO link_clicks (id, tracked_link_id, friend_id, clicked_at)
      VALUES ('click-1', 'link-1', 'friend-1', '2026-09-07T10:05:00.000Z')
    `).run();
    testDb.raw.prepare(`
      INSERT INTO broadcast_insights
        (id, broadcast_id, delivered, unique_impression, unique_click, open_rate, click_rate, status, fetched_at)
      VALUES ('insight-1', 'broadcast-1', 10, 7, 1, 0.7, 0.1, 'ready', '2026-09-07T11:00:00.000Z')
    `).run();

    const response = await app(testDb.db).request('/api/broadcasts/broadcast-1/insight');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        opens: { count: 7, denominator: 10, rate: 0.7, state: 'available' },
        links: [{ label: '商品を見る', clickCount: 1, uniqueClickCount: 1, clickRate: 0.1 }],
      },
    });
  });
});
