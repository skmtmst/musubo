import { describe, it, expect, vi } from 'vitest';
import {
  buildAliasId,
  resolveSwitcherActions,
  publishRichMenuGroup,
  createRichMenuShells,
  switchRichMenuLive,
  restorePreSwitchLive,
  restorePreSwitchDefault,
  deletableAfterCompensation,
  deleteRichMenuShells,
  RichMenuValidationError,
  validateRichMenuGroupForPublish,
  unpublishRichMenuGroup,
  linkRichMenuBulkChunked,
  type AreaInput,
  type LineRichMenuClient,
  type R2Like,
} from './rich-menu-publisher.js';

describe('buildAliasId', () => {
  it('groupId 先頭 8 文字 + order_index で生成', () => {
    expect(buildAliasId('3a7c2f1d-1234-5678-9abc-def012345678', 0)).toBe('lhx-3a7c2f1d-0');
    expect(buildAliasId('3a7c2f1d-1234-5678-9abc-def012345678', 2)).toBe('lhx-3a7c2f1d-2');
  });
});

describe('resolveSwitcherActions', () => {
  it('targetPageId を alias_id に変換', () => {
    const groupId = '3a7c2f1d-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const pages = [
      {
        id: 'p1', orderIndex: 0, name: 'p1',
        imageR2Key: null, imageContentType: null, lineRichMenuId: null,
        areas: [{
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          actionType: 'richmenuswitch' as const,
          actionData: { targetPageId: 'p2' },
        }],
      },
      {
        id: 'p2', orderIndex: 1, name: 'p2',
        imageR2Key: null, imageContentType: null, lineRichMenuId: null,
        areas: [VALID_AREA],
      },
    ];
    const resolved = resolveSwitcherActions(pages, groupId);
    expect(resolved[0].areas[0].actionData).toEqual({
      richMenuAliasId: 'lhx-3a7c2f1d-1',
      data: 'switch-to-p2',
    });
  });

  it('uri/message/postback はそのまま', () => {
    const pages = [{
      id: 'p1', orderIndex: 0, name: 'p1',
      imageR2Key: null, imageContentType: null, lineRichMenuId: null,
      areas: [
        { bounds: { x: 0, y: 0, width: 100, height: 100 }, actionType: 'uri' as const, actionData: { uri: 'https://x.example' } },
        { bounds: { x: 0, y: 0, width: 100, height: 100 }, actionType: 'message' as const, actionData: { text: 'hi' } },
      ],
    }];
    const resolved = resolveSwitcherActions(pages, 'gid12345-aaaa');
    expect(resolved[0].areas[0].actionData).toEqual({ uri: 'https://x.example' });
    expect(resolved[0].areas[1].actionData).toEqual({ text: 'hi' });
  });

  it('未知の targetPageId は throw', () => {
    const pages = [{
      id: 'p1', orderIndex: 0, name: 'p1',
      imageR2Key: null, imageContentType: null, lineRichMenuId: null,
      areas: [{
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        actionType: 'richmenuswitch' as const,
        actionData: { targetPageId: 'nonexistent' },
      }],
    }];
    expect(() => resolveSwitcherActions(pages, 'gid12345-aaaa')).toThrow(/nonexistent/);
  });
});

type MockLineClient = LineRichMenuClient & { calls: string[]; currentDefault: string | null };

function makeMockLineClient(opts: { currentDefault?: string | null } = {}): MockLineClient {
  const calls: string[] = [];
  const state = { currentDefault: opts.currentDefault ?? null };
  return {
    calls,
    get currentDefault() {
      return state.currentDefault;
    },
    set currentDefault(value: string | null) {
      state.currentDefault = value;
    },
    createRichMenu: vi.fn(async () => {
      calls.push('create');
      return { richMenuId: `lm-${calls.filter((c) => c === 'create').length}` };
    }),
    validateRichMenu: vi.fn(async () => {
      calls.push('validate');
    }),
    listRichMenus: vi.fn(async () => []),
    uploadRichMenuImage: vi.fn(async () => {
      calls.push('upload');
    }),
    deleteRichMenuAlias: vi.fn(async () => {
      calls.push('delete-alias');
    }),
    createRichMenuAlias: vi.fn(async () => {
      calls.push('create-alias');
    }),
    upsertRichMenuAlias: vi.fn(async () => {
      calls.push('upsert-alias');
    }),
    deleteRichMenu: vi.fn(async () => {
      calls.push('delete-old');
    }),
    setDefaultRichMenu: vi.fn(async () => {
      calls.push('set-default');
    }),
    clearDefaultRichMenu: vi.fn(async () => {
      calls.push('clear-default');
    }),
    getCurrentDefaultRichMenuId: vi.fn(async () => {
      calls.push('get-default');
      return state.currentDefault;
    }),
    linkRichMenuBulk: vi.fn(async (_richMenuId: string, userIds: string[]) => {
      calls.push(`link-bulk-${userIds.length}`);
    }),
  } as MockLineClient;
}

function makeMockR2(): R2Like {
  return {
    get: vi.fn(async (_key: string) => ({ body: new Uint8Array([1, 2, 3]) })),
  };
}

/**
 *  以降、公開には「切替以外の行き先を持つボタン」が1つ必要で、全ボタンに
 * 読み上げラベルが必須。publish を通す group はこれを1つ含める。
 */
const VALID_AREA = {
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  actionType: 'uri' as const,
  actionData: { uri: 'https://example.com' },
  label: 'リンク',
};

describe('publishRichMenuGroup', () => {
  it('空の message action は LINE API を呼ぶ前に分かりやすく拒否する', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await expect(
      publishRichMenuGroup(
        {
          id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
          pages: [{
            id: 'p1', orderIndex: 0, name: '基本メニュー',
            imageR2Key: 'a.png', imageContentType: 'image/png',
            lineRichMenuId: null,
            areas: [{
              bounds: { x: 0, y: 0, width: 100, height: 100 },
              actionType: 'message',
              actionData: { text: '' },
              label: '送信ボタン',
            }],
          }],
        },
        line,
        r2,
      ),
    ).rejects.toThrow('ページ「基本メニュー」の「送信ボタン」: 送信テキストを入力してください');
    expect(line.calls).toEqual([]);
  });

  it('アクション必須値を publish 前に検証する', () => {
    const group = {
      id: 'gid12345-aaaa',
      size: 'large' as const,
      chatBarText: 'm',
      isDefaultForAll: false,
      pages: [{
        id: 'p1', orderIndex: 0, name: 'p1',
        imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: null,
        areas: [{
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          actionType: 'uri' as const,
          actionData: { uri: '   ' },
          label: 'リンク',
        }],
      }],
    };
    expect(() => validateRichMenuGroupForPublish(group))
      .toThrowError(RichMenuValidationError);
    expect(() => validateRichMenuGroupForPublish(group))
      .toThrow('URLを入力してください');
  });
});

/** LINE の400を一般的な失敗として返す前に、操作種別ごとに検証し、運用者が直せる入力エラーとして伝える。 */
describe('validateRichMenuGroupForPublish', () => {
  const groupWith = (
    actionType: 'message' | 'uri' | 'postback' | 'richmenuswitch',
    actionData: Record<string, unknown>,
    pageName = '基本メニュー',
  ) => ({
    id: 'gid12345-aaaa',
    size: 'large' as const,
    chatBarText: 'm',
    isDefaultForAll: false,
    pages: [{
      id: 'p1', orderIndex: 0, name: pageName,
      imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: null,
      areas: [{
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        actionType,
        actionData,
        label: 'ボタン',
      }],
    }],
  });

  const rejects = (group: ReturnType<typeof groupWith>, fragment: string) => {
    expect(() => validateRichMenuGroupForPublish(group)).toThrowError(RichMenuValidationError);
    expect(() => validateRichMenuGroupForPublish(group)).toThrow(fragment);
  };

  const accepts = (group: ReturnType<typeof groupWith>) => {
    expect(() => validateRichMenuGroupForPublish(group)).not.toThrow();
  };

  describe('message', () => {
    it.each([
      ['未設定', {}],
      ['空文字', { text: '' }],
      ['空白のみ', { text: '   ' }],
    ])('%s は拒否する', (_label, data) => {
      rejects(groupWith('message', data), '送信テキストを入力してください');
    });

    it('300文字を超えたら拒否する', () => {
      rejects(groupWith('message', { text: 'あ'.repeat(301) }), '300文字以内');
    });

    it('300文字ちょうどは許可する', () => {
      accepts(groupWith('message', { text: 'あ'.repeat(300) }));
    });
  });

  describe('uri', () => {
    it.each([
      ['未設定', {}],
      ['空文字', { uri: '' }],
      ['空白のみ', { uri: '   ' }],
    ])('%s は拒否する', (_label, data) => {
      rejects(groupWith('uri', data), 'URLを入力してください');
    });

    it('1000文字を超えたら拒否する', () => {
      rejects(groupWith('uri', { uri: `https://x.example/${'a'.repeat(1000)}` }), '1000文字以内');
    });

    it('1000文字ちょうどは許可する', () => {
      accepts(groupWith('uri', { uri: `https://x.example/${'a'.repeat(981)}` }));
    });

    it('URLではない文字列は、どの面かを伝えて拒否する', () => {
      rejects(groupWith('uri', { uri: 'not-a-url' }), 'URLの形が正しくありません');
      rejects(groupWith('uri', { uri: 'not-a-url' }), '「ボタン」');
    });

    it('LINEのuriアクションが通せない scheme は拒否する', () => {
      rejects(groupWith('uri', { uri: 'javascript:alert(1)' }), 'https://・http://・tel:・mailto:');
    });

    it('https:// 以外に LINE が通す tel: と mailto: は許可する', () => {
      accepts(groupWith('uri', { uri: 'tel:0300005678' }));
      accepts(groupWith('uri', { uri: 'mailto:info@example.com' }));
    });
  });

  describe('postback', () => {
    it.each([
      ['未設定', {}],
      ['空文字', { data: '' }],
      ['空白のみ', { data: '   ' }],
    ])('data が %s なら拒否する', (_label, data) => {
      rejects(groupWith('postback', data), 'postback dataを入力してください');
    });

    it('data が300文字を超えたら拒否する', () => {
      rejects(groupWith('postback', { data: 'a'.repeat(301) }), 'postback dataは300文字以内');
    });

    it('displayText が300文字を超えたら拒否する', () => {
      rejects(
        groupWith('postback', { data: 'ok', displayText: 'あ'.repeat(301) }),
        'displayTextは300文字以内',
      );
    });

    it('displayText は任意なので未設定でも許可する', () => {
      accepts(groupWith('postback', { data: 'ok' }));
    });
  });

  describe('richmenuswitch', () => {
    it.each([
      ['どちらも無い', {}],
      ['alias が無い', { data: 'switch-to-p2' }],
      ['data が無い', { richMenuAliasId: 'lhx-gid12345-1' }],
    ])('%s なら拒否する', (_label, data) => {
      rejects(groupWith('richmenuswitch', data), '遷移先ページを選択してください');
    });

    it('alias と data が揃っていれば許可する', () => {
      const group = groupWith('richmenuswitch', { richMenuAliasId: 'lhx-gid12345-1', data: 'switch-to-p2' });
      // 切替だけでは行き先ゼロなので、行き先のあるボタンを1つ足す。
      group.pages[0].areas.push(VALID_AREA);
      accepts(group);
    });
  });

  it('どのページのどの領域かをメッセージに含める', () => {
    const group = groupWith('message', { text: '' }, 'クーポン');
    expect(() => validateRichMenuGroupForPublish(group))
      .toThrow('ページ「クーポン」の「ボタン」: 送信テキストを入力してください');
  });

  describe('#827: 読み上げラベルと行き先', () => {
    it.each([
      ['未設定', undefined],
      ['空文字', ''],
      ['空白のみ', '   '],
    ])('ボタン名が %s なら拒否する', (_label, label) => {
      const group = groupWith('uri', { uri: 'https://x.example' });
      group.pages[0].areas[0].label = label as unknown as string;
      rejects(group, 'ボタン名（読み上げラベル）を入力してください');
    });

    it('ボタン名が21文字なら拒否する', () => {
      const group = groupWith('uri', { uri: 'https://x.example' });
      group.pages[0].areas[0].label = 'あ'.repeat(21);
      rejects(group, '20文字以内');
    });

    it('ボタン名がちょうど20文字なら許可する', () => {
      const group = groupWith('uri', { uri: 'https://x.example' });
      group.pages[0].areas[0].label = 'あ'.repeat(20);
      accepts(group);
    });

    it('切替ボタンしか無いグループは、行き先ゼロとして拒否する', () => {
      rejects(
        groupWith('richmenuswitch', { richMenuAliasId: 'lhx-gid12345-1', data: 'switch-to-p2' }),
        'ページ切替以外の行き先',
      );
    });

    it('ボタンが1つも無いグループは拒否する', () => {
      const group = groupWith('uri', { uri: 'https://x.example' });
      group.pages[0].areas = [];
      rejects(group, 'ページ切替以外の行き先');
    });
  });
});

describe('publishRichMenuGroup', () => {
  it('入力不備なら LINE API を一度も呼ばない', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await expect(
      publishRichMenuGroup(
        {
          id: 'gid12345-aaaa', size: 'large', chatBarText: 'menu', isDefaultForAll: false,
          pages: [{
            id: 'p1', orderIndex: 0, name: '基本メニュー',
            imageR2Key: 'rich-menus/test/p1.png', imageContentType: 'image/png',
            lineRichMenuId: null,
            areas: [{
              bounds: { x: 0, y: 0, width: 100, height: 100 },
              actionType: 'message',
              actionData: { text: '' },
              label: '送信ボタン',
            }],
          }],
        },
        line,
        r2,
      ),
    ).rejects.toThrowError(RichMenuValidationError);
    expect(line.calls).toEqual([]);
  });

  it('空の displayText は LINE へ送らない', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'menu', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'rich-menus/test/p1.png', imageContentType: 'image/png',
          lineRichMenuId: null,
          areas: [{
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            actionType: 'postback',
            actionData: { data: 'go', displayText: '' },
            label: 'ボタン',
          }],
        }],
      },
      line,
      r2,
    );
    const payload = (line.createRichMenu as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      areas: { action: Record<string, unknown> }[];
    };
    expect(payload.areas[0].action).toEqual({ type: 'postback', data: 'go' });
    expect(payload.areas[0].action).not.toHaveProperty('displayText');
  });

  it('displayText が入力されていれば LINE へ送る', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'menu', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'rich-menus/test/p1.png', imageContentType: 'image/png',
          lineRichMenuId: null,
          areas: [{
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            actionType: 'postback',
            actionData: { data: 'go', displayText: '受付しました' },
            label: 'ボタン',
          }],
        }],
      },
      line,
      r2,
    );
    const payload = (line.createRichMenu as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      areas: { action: Record<string, unknown> }[];
    };
    expect(payload.areas[0].action).toEqual({
      type: 'postback',
      data: 'go',
      displayText: '受付しました',
    });
  });

  it('1 page: create → upload → alias update → 旧削除', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    const result = await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'menu', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'rich-menus/test/p1.png', imageContentType: 'image/png',
          lineRichMenuId: 'old-1',
          areas: [VALID_AREA],
        }],
      },
      line,
      r2,
    );
    // isDefaultForAll=false かつ LINE current default なし → clear-default は呼ばない (Round 2 修正)
    // 切替前の実default読み(get-default)が切替の前に入る(段階公開の補償用)。
    expect(line.calls).toEqual([
      'create', 'upload', 'get-default', 'upsert-alias', 'get-default', 'delete-old',
    ]);
    expect(line.calls).not.toContain('clear-default');
    expect(result.pages).toEqual([{ pageId: 'p1', newRichMenuId: 'lm-1' }]);
  });

  it('2 page: 全ページの画像準備後に alias を切り替える', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    const result = await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: null, areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'b.png', imageContentType: 'image/png', lineRichMenuId: null, areas: [VALID_AREA] },
        ],
      },
      line,
      r2,
    );
    expect(result.pages.map((p) => p.newRichMenuId)).toEqual(['lm-1', 'lm-2']);
    expect(line.calls.slice(0, 6)).toEqual([
      'create', 'upload', 'create', 'upload', 'get-default', 'upsert-alias',
    ]);
    // 旧 ID なしなので delete-old は呼ばれない
    expect(line.calls.filter((c) => c === 'delete-old')).toHaveLength(0);
  });

  it('isDefaultForAll=true なら setDefaultRichMenu を最初の page で呼ぶ', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: true,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'a.png', imageContentType: 'image/png',
          lineRichMenuId: null, areas: [VALID_AREA],
        }],
      },
      line,
      r2,
    );
    expect(line.calls).toContain('set-default');
    // 有効化時は clear-default を呼ばない
    expect(line.calls).not.toContain('clear-default');
  });

  it('isDefaultForAll=false かつ LINE current default が own page と一致 → clear-default を呼ぶ (Round 2 P1)', async () => {
    // 旧 line_richmenu_id が現在の LINE default と一致 = この group が以前 default だった
    const line = makeMockLineClient({ currentDefault: 'old-1' });
    const r2 = makeMockR2();
    await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'a.png', imageContentType: 'image/png',
          lineRichMenuId: 'old-1', areas: [VALID_AREA],
        }],
      },
      line,
      r2,
    );
    expect(line.calls).toContain('get-default');
    expect(line.calls).toContain('clear-default');
    expect(line.calls).not.toContain('set-default');
  });

  it('isDefaultForAll=false かつ LINE current default が他 group → clear-default を呼ばない (Round 2 P1)', async () => {
    // 別 group が現在 default。own page とは無関係。
    const line = makeMockLineClient({ currentDefault: 'rm-from-other-group' });
    const r2 = makeMockR2();
    await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'a.png', imageContentType: 'image/png',
          lineRichMenuId: 'old-1', areas: [VALID_AREA],
        }],
      },
      line,
      r2,
    );
    expect(line.calls).toContain('get-default');
    expect(line.calls).not.toContain('clear-default');
  });

  it('isDefaultForAll=false で getCurrentDefaultRichMenuId が throw しても publish 成功 (Round 3 P2-3)', async () => {
    const line = makeMockLineClient();
    line.getCurrentDefaultRichMenuId = vi.fn(async () => {
      throw new Error('LINE 5xx transient');
    });
    const r2 = makeMockR2();
    const result = await publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1',
          imageR2Key: 'a.png', imageContentType: 'image/png',
          lineRichMenuId: null, areas: [VALID_AREA],
        }],
      },
      line,
      r2,
    );
    // publish 自体は成功 (alias swap 完了済み、status 更新を呼出側に任せられる)
    expect(result.pages[0].newRichMenuId).toBe('lm-1');
  });

  it('画像が R2 にないと throw', async () => {
    const line = makeMockLineClient();
    const r2: R2Like = { get: vi.fn(async () => null) };
    await expect(
      publishRichMenuGroup(
        {
          id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
          pages: [{
            id: 'p1', orderIndex: 0, name: 'p1',
            imageR2Key: 'missing.png', imageContentType: 'image/png',
            lineRichMenuId: null, areas: [VALID_AREA],
          }],
        },
        line,
        r2,
      ),
    ).rejects.toThrow(/R2 image missing/);
  });

  it('2ページ目の画像が無ければ LINE 側を一切変更しない', async () => {
    const line = makeMockLineClient();
    const r2: R2Like = {
      get: vi.fn(async (key: string) => key === 'missing.png'
        ? null
        : { body: new Uint8Array([1, 2, 3]) }),
    };
    await expect(publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: 'old-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'missing.png', imageContentType: 'image/png', lineRichMenuId: 'old-2', areas: [VALID_AREA] },
        ],
      },
      line,
      r2,
    )).rejects.toThrow(/R2 image missing/);
    expect(line.calls).toEqual([]);
  });

  it('全画像準備後の upload 失敗は alias を切り替えず新規メニューを片付ける', async () => {
    const line = makeMockLineClient();
    line.uploadRichMenuImage = vi.fn(async (richMenuId: string) => {
      line.calls.push('upload');
      if (richMenuId === 'lm-2') throw new Error('upload failed');
    });
    await expect(publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: 'old-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'b.png', imageContentType: 'image/png', lineRichMenuId: 'old-2', areas: [VALID_AREA] },
        ],
      },
      line,
      makeMockR2(),
    )).rejects.toThrow('upload failed');
    expect(line.calls).not.toContain('upsert-alias');
    expect(line.calls.filter((call) => call === 'delete-old')).toHaveLength(2);
  });

  it('alias 切替の途中失敗は切替済みページを旧IDへ戻す', async () => {
    const line = makeMockLineClient();
    let aliasCalls = 0;
    line.upsertRichMenuAlias = vi.fn(async () => {
      aliasCalls++;
      line.calls.push(`upsert-alias-${aliasCalls}`);
      if (aliasCalls === 2) throw new Error('alias failed');
    });
    await expect(publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: 'old-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'b.png', imageContentType: 'image/png', lineRichMenuId: 'old-2', areas: [VALID_AREA] },
        ],
      },
      line,
      makeMockR2(),
    )).rejects.toThrow('alias failed');
    expect(aliasCalls).toBe(4);
    expect(line.calls.filter((call) => call === 'delete-old')).toHaveLength(2);
  });

  it('default 設定に失敗したら alias を旧IDへ戻して新規メニューを片付ける', async () => {
    const line = makeMockLineClient();
    line.setDefaultRichMenu = vi.fn(async () => {
      line.calls.push('set-default');
      throw new Error('default failed');
    });
    await expect(publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: true,
        pages: [{
          id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png',
          imageContentType: 'image/png', lineRichMenuId: 'old-1', areas: [VALID_AREA],
        }],
      },
      line,
      makeMockR2(),
    )).rejects.toThrow('default failed');
    // 切替前のdefault読みの後、失敗時は旧aliasへ戻し、defaultは現在の値が
    // 今回の新メニューでないため触らず、新メニューを片付ける。
    expect(line.calls).toEqual([
      'create', 'upload', 'get-default', 'upsert-alias', 'set-default', 'upsert-alias', 'get-default', 'delete-old',
    ]);
  });

  it('alias の復旧も失敗したページは新メニューを消さずリンク切れを避ける', async () => {
    const line = makeMockLineClient();
    let aliasCalls = 0;
    line.upsertRichMenuAlias = vi.fn(async () => {
      aliasCalls++;
      line.calls.push(`upsert-alias-${aliasCalls}`);
      if (aliasCalls === 2 || aliasCalls === 3) throw new Error('alias unavailable');
    });
    await expect(publishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'a.png', imageContentType: 'image/png', lineRichMenuId: 'old-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'b.png', imageContentType: 'image/png', lineRichMenuId: 'old-2', areas: [VALID_AREA] },
        ],
      },
      line,
      makeMockR2(),
    )).rejects.toThrow('alias unavailable');
    // p1 は旧IDへ戻せたため新メニューを削除。p2 は復旧不明なので削除しない。
    expect(line.calls.filter((call) => call === 'delete-old')).toHaveLength(1);
  });

  it('image_r2_key が null だと throw (画像未設定 page)', async () => {
    const line = makeMockLineClient();
    const r2 = makeMockR2();
    await expect(
      publishRichMenuGroup(
        {
          id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
          pages: [{
            id: 'p1', orderIndex: 0, name: 'p1',
            imageR2Key: null, imageContentType: null,
            lineRichMenuId: null, areas: [VALID_AREA],
          }],
        },
        line,
        r2,
      ),
    ).rejects.toThrow(/no image/);
  });
});

describe('unpublishRichMenuGroup', () => {
  it('alias + richmenu を全 page で delete (own default は unlink)', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-old-1' });
    const result = await unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: true,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-old-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-old-2', areas: [VALID_AREA] },
        ],
      },
      line,
    );
    // 各 page で delete-alias + delete-old (richmenu)
    expect(line.calls.filter((c) => c === 'delete-alias')).toHaveLength(2);
    expect(line.calls.filter((c) => c === 'delete-old')).toHaveLength(2);
    // default が own なので clear-default
    expect(line.calls).toContain('clear-default');
    expect(result.warnings).toEqual([]);
    expect(result.pages).toEqual([
      { pageId: 'p1', clearedRichMenuId: 'lm-old-1' },
      { pageId: 'p2', clearedRichMenuId: 'lm-old-2' },
    ]);
  });

  it('default が他 group の場合は clear-default を呼ばない', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-other-group' });
    await unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-mine', areas: [VALID_AREA] },
        ],
      },
      line,
    );
    expect(line.calls).not.toContain('clear-default');
  });

  it('richmenuId なし page でも alias 削除は行う (404 は成功扱い)', async () => {
    const line = makeMockLineClient();
    // 実クライアントは 404 を飲む（既に消えている）。ここでも解決させる。
    line.deleteRichMenuAlias = vi.fn(async () => {
      line.calls.push('delete-alias');
    });
    const result = await unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: null, areas: [VALID_AREA] },
        ],
      },
      line,
    );
    expect(line.calls).toContain('delete-alias');
    expect(result.warnings).toEqual([]);
  });

  it('M953: alias 削除の失敗は throw（成功扱いにしない）', async () => {
    const line = makeMockLineClient();
    line.deleteRichMenuAlias = vi.fn(async () => {
      throw new Error('LINE deleteRichMenuAlias failed: 500 fail');
    });
    await expect(unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-1', areas: [VALID_AREA] },
        ],
      },
      line,
    )).rejects.toThrow('LINE上のメニューの削除に失敗しました');
  });

  it('M953: richmenu 削除の一部失敗でも throw（残存を成功にしない）', async () => {
    const line = makeMockLineClient();
    line.deleteRichMenu = vi.fn(async () => {
      line.calls.push('delete-old');
      throw new Error('LINE deleteRichMenu failed: 500 fail');
    });
    await expect(unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-1', areas: [VALID_AREA] },
          { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-2', areas: [VALID_AREA] },
        ],
      },
      line,
    )).rejects.toThrow('LINE上に残っています');
    // 止めずに最後まで試す（もう片方も消しに行く）。
    expect(line.calls.filter((c) => c === 'delete-old')).toHaveLength(2);
  });

  it('M953: 標準表示の解除の失敗だけは警告に留める（取り下げ自体は成功）', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-mine' });
    line.clearDefaultRichMenu = vi.fn(async () => {
      throw new Error('LINE clearDefaultRichMenu failed: 500 fail');
    });
    const result = await unpublishRichMenuGroup(
      {
        id: 'gid12345-aaaa', size: 'large', chatBarText: 'm', isDefaultForAll: false,
        pages: [
          { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: null, imageContentType: null, lineRichMenuId: 'lm-mine', areas: [VALID_AREA] },
        ],
      },
      line,
    );
    expect(result.warnings.some((w) => w.includes('default lookup/clear'))).toBe(true);
  });
});

describe('linkRichMenuBulkChunked', () => {
  it('500 以下は 1 chunk', async () => {
    const line = makeMockLineClient();
    const ids = Array.from({ length: 300 }, (_, i) => `U${i}`);
    const result = await linkRichMenuBulkChunked(line, 'lm-1', ids);
    expect(result).toEqual({ chunks: 1, total: 300 });
    expect(line.calls).toEqual(['link-bulk-300']);
  });

  it('500 超は分割', async () => {
    const line = makeMockLineClient();
    const ids = Array.from({ length: 1100 }, (_, i) => `U${i}`);
    const result = await linkRichMenuBulkChunked(line, 'lm-1', ids);
    expect(result).toEqual({ chunks: 3, total: 1100 });
    expect(line.calls).toEqual(['link-bulk-500', 'link-bulk-500', 'link-bulk-100']);
  });

  it('成功したチャンクだけを順番に台帳コールバックへ渡す', async () => {
    const line = makeMockLineClient();
    const ids = Array.from({ length: 501 }, (_, i) => `U${i}`);
    const recorded: Array<{ size: number; index: number }> = [];

    await linkRichMenuBulkChunked(line, 'lm-1', ids, async (chunk, index) => {
      recorded.push({ size: chunk.length, index });
    });

    expect(recorded).toEqual([{ size: 500, index: 0 }, { size: 1, index: 1 }]);
  });

  it('空配列は no-op', async () => {
    const line = makeMockLineClient();
    const result = await linkRichMenuBulkChunked(line, 'lm-1', []);
    expect(result).toEqual({ chunks: 0, total: 0 });
    expect(line.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 運用者から見た「何をするボタンか」(intent) を LINE の action へ変換する
// ---------------------------------------------------------------------------

/** publish して、LINE に送られた areas の action だけを取り出す。 */
async function publishAndReadActions(
  group: Parameters<typeof publishRichMenuGroup>[0],
): Promise<Record<string, unknown>[]> {
  const line = makeMockLineClient();
  const r2 = makeMockR2();
  await publishRichMenuGroup(group, line, r2);
  const payload = (line.createRichMenu as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0][0] as { areas: { action: Record<string, unknown> }[] };
  return payload.areas.map((a) => a.action);
}

/** areas だけ差し替えた、publish できる最小の group を作る。 */
function groupWithAreas(
  areas: Parameters<typeof publishRichMenuGroup>[0]['pages'][number]['areas'],
  extra: { formBaseUrl?: string | null } = {},
): Parameters<typeof publishRichMenuGroup>[0] {
  return {
    id: 'gid12345-aaaa',
    size: 'large',
    chatBarText: 'menu',
    isDefaultForAll: false,
    ...extra,
    pages: [
      {
        id: 'p1',
        orderIndex: 0,
        name: '基本メニュー',
        imageR2Key: 'rich-menus/test/p1.png',
        imageContentType: 'image/png',
        lineRichMenuId: null,
        // 読み上げラベルは必須。試験対象の area にラベルが無ければ既定を足す。
        areas: areas.map((area) => ({ label: 'ボタン', ...area })),
      },
    ],
  };
}

const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };

describe('押したら6つの公開', () => {
  const choices: AreaInput[] = [
    { bounds: BOUNDS, actionType: 'uri', intent: 'url', actionData: { uri: 'https://example.com' } },
    { bounds: BOUNDS, actionType: 'message', intent: 'text', actionData: { text: '予約したい' } },
    { bounds: BOUNDS, actionType: 'uri', intent: 'booking', actionData: { menuId: 'menu-1' } },
    { bounds: BOUNDS, actionType: 'uri', intent: 'form', formId: 'form-1', actionData: {} },
    { bounds: BOUNDS, actionType: 'uri', intent: 'booking_history', actionData: {} },
    { bounds: BOUNDS, actionType: 'uri', intent: 'visit_stamp', actionData: { cardId: 'card-1' } },
  ];
  it.each(choices)('保存した種類からLINE用の動きに変換: $intent', async area => {
    const [action] = await publishAndReadActions(groupWithAreas([area], { formBaseUrl: 'https://liff.line.me/store-id' }));
    expect(action.type).toBe(area.intent === 'text' ? 'message' : 'uri');
    if (area.intent === 'booking') expect(action.uri).toBe('https://liff.line.me/store-id/?page=salon-book&menu_id=menu-1');
    if (area.intent === 'visit_stamp') expect(action.uri).toBe('https://liff.line.me/store-id/?page=visit-stamps&card=card-1');
    if (area.intent === 'booking_history') expect(action.uri).toContain('view=history');
  });
  it.each(choices.slice(2))('LIFF未設定は公開前に拒否: $intent', area => {
    expect(() => validateRichMenuGroupForPublish(groupWithAreas([area]))).toThrow('LIFF');
  });
  it.each(['booking', 'visit_stamp'] as const)('選択先なしでも入口を開ける: %s', async intent => {
    const [action] = await publishAndReadActions(groupWithAreas([{ bounds: BOUNDS, actionType: 'uri', intent, actionData: {} }], { formBaseUrl: 'https://liff.line.me/store-id' }));
    expect(action.uri).toBe(`https://liff.line.me/store-id/?page=${intent === 'booking' ? 'salon-book' : 'visit-stamps'}`);
  });
});

describe('intent から LINE の action への変換', () => {
  it('電話をかける → tel: の uri。ハイフンや括弧は落とす', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'uri',
          actionData: { tel: '03-0000-5678' },
          intent: 'tel',
        },
      ]),
    );
    expect(action).toEqual({ type: 'uri', uri: 'tel:0300005678' });
  });

  it('回答フォームを開く → アカウントの LIFF に form を付けた uri', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas(
        [
          {
            id: 'a1',
            bounds: BOUNDS,
            actionType: 'uri',
            actionData: {},
            intent: 'form',
            formId: 'form-9',
          },
        ],
        { formBaseUrl: 'https://liff.line.me/1234-abcd' },
      ),
    );
    expect(action).toEqual({ type: 'uri', uri: 'https://liff.line.me/1234-abcd/?page=form&id=form-9' });
  });

  it('テンプレートを送る → 押されたことが届く postback', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'postback',
          actionData: {},
          intent: 'template',
          templateId: 'tpl-1',
        },
      ]),
    );
    expect(action).toEqual({ type: 'postback', data: 'rma=a1' });
  });

  it('URLを開く → 計測リンクを選んでいればそちらを開く', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'uri',
          actionData: { uri: 'https://example.com/original' },
          intent: 'url',
          trackedLinkUrl: 'https://short.example/t/abc123',
        },
      ]),
    );
    expect(action).toEqual({ type: 'uri', uri: 'https://short.example/t/abc123' });
  });

  it('テキストを送る（追加の動きなし）→ メッセージ送信のまま', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'message',
          actionData: { text: 'こんにちは' },
          intent: 'text',
        },
      ]),
    );
    expect(action).toEqual({ type: 'message', text: 'こんにちは' });
  });

  it('テキストを送る（タグ付きの場合）→ 見え方はそのままに postback へ寄せる', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'message',
          actionData: { text: '資料がほしい' },
          intent: 'text',
          tagIds: ['tag-1'],
        },
      ]),
    );
    expect(action).toEqual({
      type: 'postback',
      data: 'rma=a1&d=%E8%B3%87%E6%96%99%E3%81%8C%E3%81%BB%E3%81%97%E3%81%84',
      // displayText があるので、トークの見え方はメッセージ送信と変わらない
      displayText: '資料がほしい',
    });
  });

  it('テキストを送る（シナリオ開始付きの場合）→ タップを受け取る postback へ寄せる', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([{ id: 'a1', bounds: BOUNDS, actionType: 'message', actionData: { text: '案内を見る', scenarioId: 'scenario-a' }, intent: 'text' }]),
    );
    expect(action).toEqual({
      type: 'postback',
      data: 'rma=a1&d=%E6%A1%88%E5%86%85%E3%82%92%E8%A6%8B%E3%82%8B',
      displayText: '案内を見る',
    });
  });

  it('スコアだけ設定した場合も postback へ寄せる', async () => {
    const [action] = await publishAndReadActions(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'message',
          actionData: { text: 'はい' },
          intent: 'text',
          scoreChange: 10,
        },
      ]),
    );
    expect(action.type).toBe('postback');
  });

  it('intent が無い昔のボタンは、今までどおりそのまま送る', async () => {
    const actions = await publishAndReadActions(
      groupWithAreas([
        { id: 'a1', bounds: BOUNDS, actionType: 'message', actionData: { text: 'hi' } },
        {
          id: 'a2',
          bounds: BOUNDS,
          actionType: 'uri',
          actionData: { uri: 'https://example.com' },
        },
      ]),
    );
    expect(actions).toEqual([
      { type: 'message', text: 'hi' },
      { type: 'uri', uri: 'https://example.com' },
    ]);
  });

  it('メニューを切り替える（intent あり）→ 押されたことが届く目印を data に載せる', async () => {
    const group = {
      id: 'gid12345-aaaa',
      size: 'large' as const,
      chatBarText: 'menu',
      isDefaultForAll: false,
      pages: [
        {
          id: 'p1',
          orderIndex: 0,
          name: 'p1',
          imageR2Key: 'rich-menus/test/p1.png',
          imageContentType: 'image/png',
          lineRichMenuId: null,
          areas: [
            {
              id: 'a1',
              bounds: BOUNDS,
              actionType: 'richmenuswitch' as const,
              actionData: { targetPageId: 'p2' },
              intent: 'switch' as const,
              label: '2ページ目へ',
            },
          ],
        },
        {
          id: 'p2',
          orderIndex: 1,
          name: 'p2',
          imageR2Key: 'rich-menus/test/p2.png',
          imageContentType: 'image/png',
          lineRichMenuId: null,
          areas: [VALID_AREA],
        },
      ],
    };
    const [action] = await publishAndReadActions(group);
    expect(action).toEqual({
      type: 'richmenuswitch',
      richMenuAliasId: 'lhx-gid12345-1',
      data: 'rma=a1&d=switch-to-p2',
    });
  });
});

describe('intent の入力チェック', () => {
  const r2 = makeMockR2();

  it('電話番号が空なら、LINE を呼ぶ前に日本語で止める', async () => {
    await expect(
      publishRichMenuGroup(
        groupWithAreas([
          {
            id: 'a1',
            bounds: BOUNDS,
            actionType: 'uri',
            actionData: { tel: '' },
            intent: 'tel',
            label: '電話する',
          },
        ]),
        makeMockLineClient(),
        r2,
      ),
    ).rejects.toThrowError(/「電話する」: 電話番号を入力してください/);
  });

  it('LIFF が無いアカウントでは、回答フォームのボタンを publish させない', async () => {
    await expect(
      publishRichMenuGroup(
        groupWithAreas([
          {
            id: 'a1',
            bounds: BOUNDS,
            actionType: 'uri',
            actionData: {},
            intent: 'form',
            formId: 'form-1',
          },
        ]),
        makeMockLineClient(),
        r2,
      ),
    ).rejects.toThrowError(/LIFFが設定されていない/);
  });

  it('テンプレート未選択なら止める', async () => {
    await expect(
      publishRichMenuGroup(
        groupWithAreas([
          { id: 'a1', bounds: BOUNDS, actionType: 'postback', actionData: {}, intent: 'template' },
        ]),
        makeMockLineClient(),
        r2,
      ),
    ).rejects.toThrowError(/送るテンプレートを選んでください/);
  });

  it('「URLを開く」に URL でない文字列なら、LINE を呼ぶ前に止める', async () => {
    const line = makeMockLineClient();
    await expect(
      publishRichMenuGroup(
        groupWithAreas([
          {
            id: 'a1',
            bounds: BOUNDS,
            actionType: 'uri',
            actionData: { uri: 'not-a-url' },
            intent: 'url',
            label: '予約ページ',
          },
        ]),
        line,
        r2,
      ),
    ).rejects.toThrowError(/「予約ページ」: URLの形が正しくありません/);
    expect(line.calls).toEqual([]);
  });

  it('計測リンクを選んだ面は、生成済みURLなので手入力URIの検査を飛ばす', async () => {
    const line = makeMockLineClient();
    const result = await publishRichMenuGroup(
      groupWithAreas([
        {
          id: 'a1',
          bounds: BOUNDS,
          actionType: 'uri',
          actionData: {},
          intent: 'url',
          trackedLinkUrl: 'https://l.example.com/r/abc',
          label: '予約ページ',
        },
      ]),
      line,
      r2,
    );
    expect(result.pages).toEqual([{ pageId: 'p1', newRichMenuId: 'lm-1' }]);
    expect(line.calls[0]).toBe('create');
  });
});

describe('段階公開 (E-08 #621 案A)', () => {
  const group = {
    id: 'gid12345-aaaa', size: 'large' as const, chatBarText: 'm', isDefaultForAll: false,
    pages: [{
      id: 'p1', orderIndex: 0, name: 'p1',
      imageR2Key: 'a.png', imageContentType: 'image/png',
      lineRichMenuId: 'old-1', areas: [VALID_AREA],
    }],
  };

  it('createRichMenuShells は alias/default を触らない', async () => {
    const line = makeMockLineClient();
    const { shells } = await createRichMenuShells(group, line, makeMockR2());
    expect(shells).toEqual([{ pageId: 'p1', orderIndex: 0, newRichMenuId: 'lm-1' }]);
    expect(line.calls).toEqual(['create', 'upload']);
  });

  it('切替失敗の補償は旧aliasへ戻し、戻せない分だけ新メニューを残す', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-1' });
    line.upsertRichMenuAlias = vi.fn(async (aliasId: string) => {
      line.calls.push('upsert-alias');
      // 切替(新ID)は通し、補償の戻し(旧ID)だけ失敗させる。
      if (aliasId === buildAliasId(group.id, 0) && line.calls.filter((c) => c === 'upsert-alias').length > 1) {
        throw new Error('alias unavailable');
      }
    });
    const { shells } = await createRichMenuShells(group, line, makeMockR2());
    await switchRichMenuLive(line, group, shells);
    const prev = {
      oldIds: [{ pageId: 'p1', orderIndex: 0, lineRichMenuId: 'old-1' as string | null }],
      previousDefaultId: null,
    };
    const unrestored = await restorePreSwitchLive(line, group.id, prev);
    // 戻しに失敗したページは新メニューを消さない。
    expect(unrestored).toEqual(new Set(['p1']));
    await restorePreSwitchDefault(line, prev, shells.map((s) => s.newRichMenuId));
    // 現在defaultは新メニューだが切替前defaultが無いため外す。
    expect(line.calls).toContain('clear-default');
  });

  it('切替前のdefaultがあれば補償で戻す', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-1' });
    await restorePreSwitchDefault(
      line,
      { oldIds: [], previousDefaultId: 'old-default-1' },
      ['lm-1'],
    );
    expect(line.calls).toEqual(['get-default', 'set-default']);
    expect((line.setDefaultRichMenu as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('old-default-1');
  });

  it('その間に外から変わったdefaultは触らない', async () => {
    const line = makeMockLineClient({ currentDefault: 'external-1' });
    await restorePreSwitchDefault(
      line,
      { oldIds: [], previousDefaultId: 'old-default-1' },
      ['lm-1'],
    );
    expect(line.calls).toEqual(['get-default']);
    expect(line.calls).not.toContain('set-default');
    expect(line.calls).not.toContain('clear-default');
  });

  it('default復元の結果を返し、戻せなかった新メニューは消せる集合から外す', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-1' });
    line.setDefaultRichMenu = vi.fn(async () => {
      throw new Error('LINE setDefaultRichMenu failed: 500');
    });
    const outcome = await restorePreSwitchDefault(
      line,
      { oldIds: [], previousDefaultId: 'old-default-1' },
      ['lm-1', 'lm-2'],
    );
    expect(outcome).toEqual({ state: 'failed', retainedId: 'lm-1' });
    // defaultが指したままの lm-1 は消さない。指されていない lm-2 は消す。
    expect(
      deletableAfterCompensation(
        [
          { pageId: 'p1', newRichMenuId: 'lm-1' },
          { pageId: 'p2', newRichMenuId: 'lm-2' },
        ],
        new Set<string>(),
        outcome,
      ),
    ).toEqual(['lm-2']);
  });

  it('defaultを読めなければ、どれが指されているか分からないので1つも消さない', async () => {
    const line = makeMockLineClient({ currentDefault: 'lm-1' });
    line.getCurrentDefaultRichMenuId = vi.fn(async () => {
      throw new Error('LINE getCurrentDefaultRichMenu failed: 500');
    });
    const outcome = await restorePreSwitchDefault(
      line,
      { oldIds: [], previousDefaultId: 'old-default-1' },
      ['lm-1'],
    );
    expect(outcome).toEqual({ state: 'failed', retainedId: null });
    expect(
      deletableAfterCompensation([{ pageId: 'p1', newRichMenuId: 'lm-1' }], new Set<string>(), outcome),
    ).toEqual([]);
  });

  it('deleteRichMenuShells は失敗を飲み込む', async () => {
    const line = makeMockLineClient();
    line.deleteRichMenu = vi.fn(async () => {
      throw new Error('LINE 500');
    });
    await expect(deleteRichMenuShells(line, ['lm-1', 'lm-2'])).resolves.toBeUndefined();
  });
});
