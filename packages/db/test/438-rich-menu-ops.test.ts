import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRichMenuGroup,
  duplicateRichMenuGroupAtomic,
  getRichMenuDuplicateByKey,
  getRichMenuGroupWithPages,
  listRichMenuGroupIdsByAreaLabel,
  normalizeRichMenuSearchText,
  setRichMenuPageImage,
  setPageRichMenuId,
} from '../src/rich-menus/index.js';
import {
  beginRichMenuTestApplyRevert,
  captureRichMenuTestApplyPrevious,
  createRichMenuTestApplyAtomic,
  getActiveRichMenuTestApply,
  getRichMenuTestApplyById,
  markRichMenuTestApplyApplied,
  markRichMenuTestApplyFailed,
  markRichMenuTestApplyRevertFailed,
  markRichMenuTestApplyReverted,
  recordRichMenuTestApplyShells,
} from '../src/rich-menu-test-apply.js';

const ROOT = join(import.meta.dirname, '..');

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const bound = (...params: unknown[]) => {
        const statement = sqlite.prepare(query);
        return {
          async run() { const meta = statement.run(...params); return { meta: { changes: meta.changes } }; },
          async first<T>() { return (statement.reader ? statement.get(...params) : null) as T | null; },
          async all<T>() { return { results: (statement.reader ? statement.all(...params) : []) as T[] }; },
        };
      };
      return {
        bind: (...params: unknown[]) => bound(...params),
        run: () => bound().run(), first: <T>() => bound().first<T>(), all: <T>() => bound().all<T>(),
      };
    },
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
}

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_access_token, channel_secret) VALUES ('a1', 'a', 'c1', 't', 's'), ('a2', 'b', 'c2', 't', 's')`).run();
  return asD1(sqlite);
}

function area(label: string | null, actionType: 'uri' | 'richmenuswitch' = 'uri', actionData: Record<string, unknown> = { uri: 'https://example.com' }) {
  return {
    boundsX: 0, boundsY: 0, boundsWidth: 100, boundsHeight: 100,
    actionType, actionData, intent: 'url' as const, label,
  };
}

// =============================================================================
// ボタン名での検索
// =============================================================================
describe('438 検索: ボタン名（エリアラベル）でメニューが見つかる', () => {
  it('画像を差し替えるたびに確認版が進む', async () => {
    const db = setup();
    const group = await createRichMenuGroup(db, { accountId: 'a1', name: '確認', chatBarText: 'menu', size: 'large', pages: [{ name: 'トップ', orderIndex: 0, areas: [] }] });
    const before = await getRichMenuGroupWithPages(db, group.id);
    await setRichMenuPageImage(db, before!.pages[0].id, 'new-image', 'image/png');
    const after = await getRichMenuGroupWithPages(db, group.id);
    expect(after!.confirmation_revision).toBe(before!.confirmation_revision! + 1);
  });
  it('大小文字と空白（半角・全角）を揃えて比較する', () => {
    expect(normalizeRichMenuSearchText('  New Campaign　')).toBe('newcampaign');
    expect(normalizeRichMenuSearchText('予約　する')).toBe('予約する');
    expect(normalizeRichMenuSearchText('')).toBe('');
  });

  it('ラベル一致でgroup idを返す。複数ページの奥にあるラベルにも当たる', async () => {
    const db = setup();
    const group = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'メイン', chatBarText: 'menu', size: 'large',
      pages: [
        { name: 'トップ', orderIndex: 0, areas: [area('キャンペーン')] },
        { name: 'タブA', orderIndex: 1, areas: [area(' クーポン　一覧 ')] },
      ],
    });
    // 2ページ目のラベル・大小文字と空白を揃えた検索語で当たる
    const hit = await listRichMenuGroupIdsByAreaLabel(db, 'a1', normalizeRichMenuSearchText('クーポン 一覧'));
    expect(hit.has(group.id)).toBe(true);
    // 名前でもボタン名でもない語には当たらない
    const miss = await listRichMenuGroupIdsByAreaLabel(db, 'a1', normalizeRichMenuSearchText('ポイント'));
    expect(miss.size).toBe(0);
  });

  it('別アカウントのボタン名は検索結果に混ざらない', async () => {
    const db = setup();
    await createRichMenuGroup(db, {
      accountId: 'a2', name: 'g2', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [area('限定セール')] }],
    });
    const hit = await listRichMenuGroupIdsByAreaLabel(db, 'a1', normalizeRichMenuSearchText('限定セール'));
    expect(hit.size).toBe(0);
  });

  it('LIKEのワイルドカードはリテラル扱いになる', async () => {
    const db = setup();
    await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [area('abc')] }],
    });
    // '%' が効くなら 'abc' に当たってしまう。効かないことを確かめる。
    const hit = await listRichMenuGroupIdsByAreaLabel(db, 'a1', normalizeRichMenuSearchText('%'));
    expect(hit.size).toBe(0);
  });
});

// =============================================================================
// 作成時の既定ページ・出し分け・切替
// =============================================================================
describe('438 作成: 既定ページ・出し分け・切替を作る時点で決める', () => {
  it('defaultPageIndex で既定ページを選べる。未指定なら先頭ページ', async () => {
    const db = setup();
    const created = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g', chatBarText: 'm', size: 'large',
      defaultPageIndex: 1,
      pages: [
        { name: 'トップ', orderIndex: 0, areas: [] },
        { name: 'タブA', orderIndex: 1, areas: [] },
      ],
    });
    expect(created.default_page_id).toBe(created.pages[1].id);

    const fallback = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g2', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [] }],
    });
    expect(fallback.default_page_id).toBe(fallback.pages[0].id);
  });

  it('出し分け条件・優先度・全員既定を保存する', async () => {
    const db = setup();
    const created = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g', chatBarText: 'm', size: 'large',
      isDefaultForAll: true,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ rules: [{ kind: 'tag', tagId: 't1' }] }),
      targetingPriority: 3,
      pages: [{ name: 'トップ', orderIndex: 0, areas: [] }],
    });
    expect(created.is_default_for_all).toBe(1);
    expect(created.targeting_enabled).toBe(1);
    expect(created.targeting_priority).toBe(3);
    expect(created.targeting_condition).toContain('tag');
  });

  it('切替ボタンの targetPageIndex は生成されたページIDへ解決される', async () => {
    const db = setup();
    const created = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g', chatBarText: 'm', size: 'large',
      pages: [
        {
          name: 'トップ', orderIndex: 0,
          areas: [{ ...area('タブへ', 'richmenuswitch', { targetPageIndex: 1 }), intent: 'switch' as const }],
        },
        { name: 'タブA', orderIndex: 1, areas: [] },
      ],
    });
    const switchArea = created.pages[0].areas[0];
    expect(switchArea.actionData.targetPageId).toBe(created.pages[1].id);
    // orderIndex は使い切りの指定なので、保存済み actionData に残さない
    expect(switchArea.actionData.targetPageIndex).toBeUndefined();
  });
});

// =============================================================================
// 下書き複製
// =============================================================================
describe('438 複製: 内容のコピーと台帳', () => {
  async function seedSource(db: D1Database) {
    const source = await createRichMenuGroup(db, {
      accountId: 'a1', name: '元メニュー', chatBarText: 'menu', size: 'large',
      isDefaultForAll: true,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ rules: [] }),
      targetingPriority: 2,
      defaultPageIndex: 1,
      pages: [
        {
          name: 'トップ', orderIndex: 0,
          areas: [
            area('予約'),
            { ...area('タブへ', 'richmenuswitch', { targetPageIndex: 1 }), intent: 'switch' as const },
          ],
        },
        { name: 'タブA', orderIndex: 1, areas: [area('クーポン')] },
      ],
    });
    // 公開済みっぽい状態（画像・LINE ID）を元に付ける
    await setRichMenuPageImage(db, source.pages[0].id, 'img/p0.png', 'image/png');
    await setPageRichMenuId(db, source.pages[0].id, 'richmenu-live-0');
    return getRichMenuGroupWithPages(db, source.id);
  }

  it('ページ・ボタン・画像参照・出し分けを写し、公開状態とLINE IDは写さない', async () => {
    const db = setup();
    const source = (await seedSource(db))!;
    const result = await duplicateRichMenuGroupAtomic(db, {
      requestId: 'dup-1', accountId: 'a1', sourceGroupId: source.id, idempotencyKey: 'key-1',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    const copy = (await getRichMenuGroupWithPages(db, result.groupId))!;

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('元メニュー のコピー');
    expect(copy.status).toBe('draft');
    // 全員既定は写さない（いきなり既定にならない）
    expect(copy.is_default_for_all).toBe(0);
    // 出し分けは写す
    expect(copy.targeting_enabled).toBe(1);
    expect(copy.targeting_priority).toBe(2);
    // 既定ページは対応する新ページ
    expect(copy.default_page_id).toBe(copy.pages[1].id);
    // 画像は同じ保管物を参照、LINE ID は写さない
    expect(copy.pages[0].image_r2_key).toBe('img/p0.png');
    expect(copy.pages[0].line_richmenu_id).toBeNull();
    // ボタンは写す
    expect(copy.pages[0].areas.map((a) => a.label).sort()).toEqual(['タブへ', '予約'].sort());
    // 切替の行き先は新しいページIDへ張り替え済み（元ページIDを指さない）
    const switchArea = copy.pages[0].areas.find((a) => a.action_type === 'richmenuswitch')!;
    expect(switchArea.actionData.targetPageId).toBe(copy.pages[1].id);
    expect(switchArea.actionData.targetPageId).not.toBe(source.pages[1].id);
  });

  it('同じ鍵のやり直しは同じ作成物を返し、別元への鍵違いは conflict', async () => {
    const db = setup();
    const source = (await seedSource(db))!;
    const other = await createRichMenuGroup(db, {
      accountId: 'a1', name: '別', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [] }],
    });
    const first = await duplicateRichMenuGroupAtomic(db, {
      requestId: 'dup-1', accountId: 'a1', sourceGroupId: source.id, idempotencyKey: 'key-1',
    });
    const replay = await duplicateRichMenuGroupAtomic(db, {
      requestId: 'dup-2', accountId: 'a1', sourceGroupId: source.id, idempotencyKey: 'key-1',
    });
    // 同じ作成物へ「もう作ってある」と答える。新しい下書きは増えない。
    if (first.outcome !== 'created') throw new Error('unreachable');
    expect(replay).toEqual({ outcome: 'existing', groupId: first.groupId });
    await expect(duplicateRichMenuGroupAtomic(db, {
      requestId: 'dup-3', accountId: 'a1', sourceGroupId: other.id, idempotencyKey: 'key-1',
    })).resolves.toEqual({ outcome: 'conflict' });
    // 台帳はアカウントの境目を越えない
    await expect(getRichMenuDuplicateByKey(db, 'a2', 'key-1')).resolves.toBeNull();
  });

  it('別アカウントのメニューは複製できない', async () => {
    const db = setup();
    const source = (await seedSource(db))!;
    await expect(duplicateRichMenuGroupAtomic(db, {
      requestId: 'dup-x', accountId: 'a2', sourceGroupId: source.id, idempotencyKey: 'key-x',
    })).rejects.toThrow('source group not found');
  });
});

// =============================================================================
// 本人LINEへのテスト適用の台帳
// =============================================================================
describe('438 テスト適用: 台帳と戻しの状態遷移', () => {
  async function seed(db: D1Database) {
    const group = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [] }],
    });
    const created = await createRichMenuTestApplyAtomic(db, {
      id: 'ta-1', groupId: group.id, accountId: 'a1', staffId: 'staff-1',
      lineUserId: 'U123', idempotencyKey: 'apply-1',
    });
    return { group, created };
  }

  it('同じ鍵の再送は既存行を返し、別groupへの鍵違いは conflict', async () => {
    const db = setup();
    const { group, created } = await seed(db);
    expect(created.outcome).toBe('created');
    const replay = await createRichMenuTestApplyAtomic(db, {
      id: 'ta-2', groupId: group.id, accountId: 'a1', staffId: 'staff-1',
      lineUserId: 'U123', idempotencyKey: 'apply-1',
    });
    expect(replay.outcome).toBe('existing');
    if (replay.outcome === 'existing') expect(replay.apply.id).toBe('ta-1');

    const other = await createRichMenuGroup(db, {
      accountId: 'a1', name: 'g2', chatBarText: 'm', size: 'large',
      pages: [{ name: 'トップ', orderIndex: 0, areas: [] }],
    });
    await expect(createRichMenuTestApplyAtomic(db, {
      id: 'ta-3', groupId: other.id, accountId: 'a1', staffId: 'staff-1',
      lineUserId: 'U123', idempotencyKey: 'apply-1',
    })).resolves.toEqual({ outcome: 'conflict' });
  });

  it('適用→戻し→完了の順に進み、戻し済みの再試行は already', async () => {
    const db = setup();
    const { created } = await seed(db);
    if (created.outcome !== 'created') throw new Error('unreachable');
    const apply = created.apply;

    // 適用前のメニューは一度だけ記録する
    await captureRichMenuTestApplyPrevious(db, apply.id, 'richmenu-prev');
    await recordRichMenuTestApplyShells(db, apply.id, ['lht:shell-1']);
    await markRichMenuTestApplyApplied(db, apply.id, 'lht:shell-1');
    const applied = (await getRichMenuTestApplyById(db, apply.id))!;
    expect(applied.status).toBe('applied');
    expect(applied.previous_richmenu_id).toBe('richmenu-prev');
    expect(applied.previous_captured).toBe(1);

    // 適用中は active として見つかる（同じ人の二重適用を止めるため）
    expect((await getActiveRichMenuTestApply(db, apply.group_id, 'staff-1'))?.id).toBe(apply.id);

    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-1')).toBe('claimed');
    // 同じ戻し鍵の再試行は続きから、別鍵は conflict
    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-1')).toBe('claimed');
    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-other')).toBe('conflict');

    await markRichMenuTestApplyReverted(db, apply.id);
    expect((await getRichMenuTestApplyById(db, apply.id))!.status).toBe('reverted');
    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-1')).toBe('already');
    // 戻し済みは「適用中」ではないので次のテスト適用を塞がない
    expect(await getActiveRichMenuTestApply(db, apply.group_id, 'staff-1')).toBeNull();
  });

  it('戻し途中の失敗は applied へ戻し、失敗した適用自体も再開できる', async () => {
    const db = setup();
    const { created } = await seed(db);
    if (created.outcome !== 'created') throw new Error('unreachable');
    const apply = created.apply;

    await markRichMenuTestApplyApplied(db, apply.id, 'lht:shell-1');
    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-1')).toBe('claimed');
    await markRichMenuTestApplyRevertFailed(db, apply.id, 'line timeout');
    const back = (await getRichMenuTestApplyById(db, apply.id))!;
    expect(back.status).toBe('applied');
    expect(back.last_error_code).toBe('line timeout');

    // 適用失敗も台帳に残り、failed から戻しへ進める（掃除のため）
    await markRichMenuTestApplyFailed(db, apply.id, 'create failed');
    expect((await getRichMenuTestApplyById(db, apply.id))!.status).toBe('failed');
    expect(await beginRichMenuTestApplyRevert(db, apply.id, 'revert-2')).toBe('claimed');
  });
});
