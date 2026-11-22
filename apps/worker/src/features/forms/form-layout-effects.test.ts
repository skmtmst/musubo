import { beforeEach, describe, expect, test, vi } from 'vitest';
import { emptyLayout, newBlockId, type FormInputBlock, type FormLayout } from '@line-crm/shared';


const mocks = vi.hoisted(() => ({
  countChoiceUsage: vi.fn(),
  countFormSubmissionsByFriend: vi.fn(),
  enrollFriendInReminder: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendFieldById: vi.fn(),
  getFixedFriendField: vi.fn(),
  getMessageTemplateById: vi.fn(),
  detachTag: vi.fn(),
  setFriendFieldValue: vi.fn(),
  attachTag: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => {
  // 検証だけは本物を使う。mock にすると「検証を外す逆変異」が
  // 捕まらなくなる。書き込み(get/set)は上の差し替えのまま。
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
    countChoiceUsage: mocks.countChoiceUsage,
    countFormSubmissionsByFriend: mocks.countFormSubmissionsByFriend,
    enrollFriendInReminder: mocks.enrollFriendInReminder,
    enrollFriendInScenario: mocks.enrollFriendInScenario,
    getFriendFieldById: mocks.getFriendFieldById,
    getFixedFriendField: mocks.getFixedFriendField,
    getMessageTemplateById: mocks.getMessageTemplateById,
    setFriendFieldValue: mocks.setFriendFieldValue,
    validateFriendFieldValue: actual.validateFriendFieldValue,
    jstNow: () => '2026-08-19T12:00:00+09:00',
  };
});

vi.mock('../friends/friend-tag-attach.js', () => ({
  attachTagAndFireSideEffects: mocks.attachTag,
  detachTagAndFireSideEffects: mocks.detachTag,
}));

import { applyFormLayoutEffects, checkFormGates, collectCapacitySlots, layoutEffectStepIds } from './form-layout-effects.js';

/** UPDATE 文を覚えるだけの D1 の身代わり。 */
function fakeDb(firstResult: unknown = null) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            run: async () => {
              calls.push({ sql, binds });
              return { meta: { changes: 1 } };
            },
            first: async () => firstResult,
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

function input(partial: Partial<FormInputBlock> & { name: string }): FormInputBlock {
  return {
    id: newBlockId(),
    kind: 'input',
    type: 'text',
    label: partial.name,
    ...partial,
  };
}

function layoutWith(blocks: FormInputBlock[]): FormLayout {
  const layout = emptyLayout();
  layout.sections[0].blocks = blocks;
  return layout;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countChoiceUsage.mockResolvedValue(new Map());
  mocks.countFormSubmissionsByFriend.mockResolvedValue(0);
  mocks.enrollFriendInReminder.mockResolvedValue(undefined);
  mocks.enrollFriendInScenario.mockResolvedValue({ id: 'enrolled-scenario' });
  mocks.detachTag.mockResolvedValue({ removed: true });
  mocks.getFriendFieldById.mockResolvedValue({
    id: 'ff-1',
    ec_is_master: 0,
    type: 'text',
    options_json: null,
  });
  mocks.getFixedFriendField.mockResolvedValue({ id: 'fixed-name', type: 'text', ec_is_master: 0 });
  mocks.setFriendFieldValue.mockResolvedValue(undefined);
});

const TEXT_FIELD = {
  id: 'ff-1',
  ec_is_master: 0,
  type: 'text',
  options_json: null,
};

describe('受け付けてよいかの判定', () => {
  const base = {
    formId: 'form-1',
    friendId: 'friend-1',
    submitCount: 0,
    answers: {} as Record<string, unknown>,
  };

  test('期限を過ぎていたら断る', async () => {
    const layout = emptyLayout();
    layout.options.deadline = {
      enabled: true,
      endsAt: '2026-08-18T23:59',
      message: '締め切りました',
    };
    const { db } = fakeDb();

    const result = await checkFormGates({
      ...base,
      db,
      layout,
      now: new Date('2026-08-19T00:00:00+09:00'),
    });
    expect(result).toBe('締め切りました');
  });

  test('期限内なら通す', async () => {
    const layout = emptyLayout();
    layout.options.deadline = { enabled: true, endsAt: '2026-08-31T23:59' };
    const { db } = fakeDb();

    expect(
      await checkFormGates({
        ...base,
        db,
        layout,
        now: new Date('2026-08-19T00:00:00+09:00'),
      }),
    ).toBeNull();
  });

  test('総数が上限に達していたら断る。DBは読みに行かない', async () => {
    const layout = emptyLayout();
    layout.options.totalLimit = { enabled: true, max: 100 };
    const { db } = fakeDb();

    expect(await checkFormGates({ ...base, db, layout, submitCount: 100 })).toBe(
      'このフォームは受付を終了しました',
    );
    expect(mocks.countFormSubmissionsByFriend).not.toHaveBeenCalled();
  });

  test('1人1回。2回目は断る', async () => {
    const layout = emptyLayout();
    layout.options.oncePerFriend = { enabled: true };
    mocks.countFormSubmissionsByFriend.mockResolvedValue(1);
    const { db } = fakeDb();

    expect(await checkFormGates({ ...base, db, layout })).toBe(
      'このフォームは、お一人さま1回までです',
    );
  });

  test('必須が空なら、DBを読む前に断る', async () => {
    const layout = layoutWith([input({ name: 'x', label: 'お名前', required: true })]);
    layout.options.oncePerFriend = { enabled: true };
    const { db } = fakeDb();

    expect(await checkFormGates({ ...base, db, layout, answers: {} })).toBe(
      'お名前 は必須項目です',
    );
    expect(mocks.countFormSubmissionsByFriend).not.toHaveBeenCalled();
  });

  test('定員が埋まった選択肢は断る', async () => {
    const layout = layoutWith([
      input({
        name: 'slot',
        label: '希望の回',
        type: 'radio',
        choices: [
          { id: 'c1', label: '午前', capacity: { enabled: true, limit: 2 } },
          { id: 'c2', label: '午後', capacity: { enabled: true, limit: 2 } },
        ],
      }),
    ]);
    mocks.countChoiceUsage.mockResolvedValue(new Map([['午前', 2]]));
    const { db } = fakeDb();

    expect(await checkFormGates({ ...base, db, layout, answers: { slot: '午前' } })).toBe(
      '「午前」は定員に達しました',
    );
    expect(await checkFormGates({ ...base, db, layout, answers: { slot: '午後' } })).toBeNull();
  });

  // FORM-09: YYYY-MM-DD の形だけでは足りず、暦に存在する日付だけを通す。
  test('暦に無い日付(2月30日・平年の2月29日)は断る', async () => {
    const layout = layoutWith([input({ name: 'day', label: '希望日', type: 'date' })]);
    const { db } = fakeDb();

    expect(
      await checkFormGates({ ...base, db, layout, answers: { day: '2026-02-30' } }),
    ).toBe('希望日 は存在しない日付です');
    expect(
      await checkFormGates({ ...base, db, layout, answers: { day: '2023-02-29' } }),
    ).toBe('希望日 は存在しない日付です');
    // うるう年の2月29日・通常の日付は通る
    expect(
      await checkFormGates({ ...base, db, layout, answers: { day: '2024-02-29' } }),
    ).toBeNull();
  });

  test('定員を決めていない選択肢は、数えに行かない', async () => {
    const layout = layoutWith([
      input({
        name: 'slot',
        label: '希望の回',
        type: 'radio',
        choices: [{ id: 'c1', label: '午前' }],
      }),
    ]);
    const { db } = fakeDb();

    expect(await checkFormGates({ ...base, db, layout, answers: { slot: '午前' } })).toBeNull();
    expect(mocks.countChoiceUsage).not.toHaveBeenCalled();
  });
});

describe('回答を配る', () => {
  test('登録先の情報欄すべてに書く', async () => {
    const layout = layoutWith([
      input({
        name: 'full_name',
        label: 'お名前',
        destinations: { friendFieldIds: ['ff-1', 'ff-2'] },
      }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'friend-1',
      answers: { full_name: '山田太郎' },
    });

    expect(mocks.setFriendFieldValue).toHaveBeenCalledTimes(2);
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'friend-1',
      fieldId: 'ff-1',
      value: '山田太郎',
      updatedBy: 'form',
      field: TEXT_FIELD,
    });
  });

  test('EC側が正の情報欄には書かない', async () => {
    mocks.getFriendFieldById.mockResolvedValue({ id: 'ff-1', ec_is_master: 1 });
    const layout = layoutWith([
      input({ name: 'addr', label: '住所', destinations: { friendFieldIds: ['ff-1'] } }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'friend-1',
      answers: { addr: '東京都...' },
    });
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  test('本名・表示名は友だち、メモは受信箱へ書く', async () => {
    const layout = layoutWith([
      input({
        name: 'full_name',
        label: 'お名前',
        destinations: { realName: true, displayName: true, note: true },
      }),
    ]);
    const { db, calls } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'friend-1',
      answers: { full_name: '山田太郎' },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('INSERT INTO chats');
    expect(calls[0].binds[2]).toBe('山田太郎');
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, expect.objectContaining({ fieldId: 'fixed-name', value: '山田太郎', updatedBy: 'form' }));
    expect(calls[1].sql).toContain('system_display_name = ?');
    expect(calls[1].sql).not.toContain('private_memo = ?');
    expect(calls[1].binds[0]).toBe('山田太郎');
  });

  test('選んだ選択肢のタグだけを付ける', async () => {
    const layout = layoutWith([
      input({
        name: 'pet',
        label: '飼っている子',
        type: 'checkbox',
        choiceMode: 'tag',
        choices: [
          { id: 'c1', label: '犬', tagId: 'tag-dog' },
          { id: 'c2', label: '猫', tagId: 'tag-cat' },
          { id: 'c3', label: '鳥', tagId: 'tag-bird' },
        ],
      }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'friend-1',
      answers: { pet: ['犬', '鳥'] },
    });

    const attached = mocks.attachTag.mock.calls.map((c) => c[2]);
    expect(attached).toEqual(['tag-dog', 'tag-bird']);
  });

  test('友だち情報に登録するときは、値が空なら選択肢名を入れる', async () => {
    const layout = layoutWith([
      input({
        name: 'plan',
        label: 'プラン',
        type: 'radio',
        choiceMode: 'friendField',
        choiceFriendFieldId: 'ff-1',
        choices: [
          { id: 'c1', label: '松', value: 'premium' },
          { id: 'c2', label: '竹' },
        ],
      }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: { plan: '松' } });
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      fieldId: 'ff-1',
      value: 'premium',
      updatedBy: 'form',
      field: TEXT_FIELD,
    });

    vi.clearAllMocks();
    mocks.getFriendFieldById.mockResolvedValue({ ...TEXT_FIELD });
    await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: { plan: '竹' } });
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ value: '竹' }),
    );
  });

  test('選択肢の動作を、選んだものだけ実行する', async () => {
    const layout = layoutWith([
      input({
        name: 'want',
        label: '希望',
        type: 'radio',
        choiceMode: 'action',
        choices: [
          {
            id: 'c1',
            label: '資料がほしい',
            actions: [
              { kind: 'send_text', text: '資料をお送りします' },
              { kind: 'scenario', op: 'start', scenarioId: 'sc-1' },
            ],
          },
          {
            id: 'c2',
            label: '今はいい',
            actions: [{ kind: 'tag', op: 'add', tagIds: ['tag-later'] }],
          },
        ],
      }),
    ]);
    const { db } = fakeDb();
    const sent: string[] = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { want: '資料がほしい' },
      pushText: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual(['資料をお送りします']);
    expect(mocks.enrollFriendInScenario).toHaveBeenCalledWith(db, 'f1', 'sc-1', undefined, { replacingScenarioId: null });
    expect(result.failedEffects).toEqual([]);
    expect(mocks.attachTag).not.toHaveBeenCalled();
  });

  // 選択肢の送信文に消えた共通情報が残っていても、生の差し込み名を
  // 送らない。効果は未完として記録され、運用者が直せば再送で補完される。
  test('解決できない共通情報を含む送信文は送らず、その効果を未完に残す', async () => {
    const layout = layoutWith([
      input({
        name: 'want',
        label: '希望',
        type: 'radio',
        choiceMode: 'action',
        choices: [
          {
            id: 'c1',
            label: '資料がほしい',
            actions: [{ kind: 'send_text', text: '営業時間は{{var.hours}}です' }],
          },
        ],
      }),
    ]);
    const { db } = fakeDb();
    const sent: string[] = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { want: '資料がほしい' },
      formId: 'form-1',
      pushText: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual([]);
    // 選択肢の動作を束ねる choices:<ブロックID> が未完に残る。
    expect(result.failedEffects.some((id) => id.startsWith('choices:'))).toBe(true);
  });

  test('日付の回答からリマインダを動かす', async () => {
    const layout = layoutWith([
      input({
        name: 'birthday',
        label: '生年月日',
        type: 'date',
        reminder: { reminderId: 'rm-1', time: '09:00' },
      }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { birthday: '2026-09-01' },
    });

    expect(mocks.enrollFriendInReminder).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      reminderId: 'rm-1',
      targetDate: '2026-09-01',
      sourceEventId: null,
    });
  });

  test('回答後の動作を実行する', async () => {
    const layout = emptyLayout();
    layout.options.afterActions = [{ kind: 'tag', op: 'remove', tagIds: ['tag-old'] }];
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: {} });
    expect(mocks.detachTag).toHaveBeenCalledWith(db, 'f1', 'tag-old', undefined);
    expect(result.failedEffects).toEqual([]);
  });

  test('1つ失敗しても、残りは実行する', async () => {
    mocks.attachTag.mockRejectedValueOnce(new Error('タグの付与に失敗'));
    const layout = layoutWith([
      input({
        name: 'pet',
        label: '飼っている子',
        type: 'checkbox',
        choiceMode: 'tag',
        choices: [
          { id: 'c1', label: '犬', tagId: 'tag-dog' },
          { id: 'c2', label: '猫', tagId: 'tag-cat' },
        ],
      }),
      input({
        name: 'full_name',
        label: 'お名前',
        destinations: { friendFieldIds: ['ff-1'] },
      }),
    ]);
    const { db } = fakeDb();

    await expect(
      applyFormLayoutEffects({
        db,
        layout,
        friendId: 'f1',
        answers: { pet: ['犬', '猫'], full_name: '山田' },
      }),
    ).resolves.toEqual({
      destinationWrites: { attempted: 1, succeeded: 1, failed: 0 },
      failedEffects: [expect.stringMatching(/^choices:/)],
    });

    expect(mocks.setFriendFieldValue).toHaveBeenCalled();
  });

  test('友だち情報欄への書き込み失敗を回答単位で数える', async () => {
    mocks.setFriendFieldValue.mockRejectedValueOnce(new Error('write failed'));
    const fullName = input({
      name: 'full_name',
      label: 'お名前',
      destinations: { friendFieldIds: ['ff-1'] },
    });
    const layout = layoutWith([fullName]);
    const { db } = fakeDb();

    // 書き込みの失敗は握らず、工程の未完として残す(再送で補完する)。
    await expect(applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { full_name: '山田' },
    })).resolves.toEqual({
      destinationWrites: { attempted: 1, succeeded: 0, failed: 1 },
      failedEffects: [`destinations:${fullName.id}`],
    });
  });

  test('EC側が正の情報欄は数えず、工程を未完にしない', async () => {
    mocks.getFriendFieldById.mockResolvedValue({ id: 'ff-1', ec_is_master: 1 });
    const layout = layoutWith([
      input({ name: 'addr', label: '住所', destinations: { friendFieldIds: ['ff-1'] } }),
    ]);
    const { db } = fakeDb();

    await expect(applyFormLayoutEffects({
      db,
      layout,
      friendId: 'friend-1',
      answers: { addr: '東京都...' },
    })).resolves.toEqual({
      destinationWrites: { attempted: 0, succeeded: 0, failed: 0 },
      failedEffects: [],
    });
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  test('終わった効果は飛ばし、終わった効果だけを記録する', async () => {
    const pet = input({
      name: 'pet',
      label: '飼っている子',
      type: 'radio',
      choiceMode: 'tag',
      choices: [{ id: 'c1', label: '犬', tagId: 'tag-dog' }],
    });
    const layout = layoutWith([
      pet,
      input({ name: 'full_name', label: 'お名前', destinations: { friendFieldIds: ['ff-1'] } }),
    ]);
    const { db } = fakeDb();
    const completed: Array<{ id: string; stats: { attempted: number; succeeded: number; failed: number } }> = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { pet: '犬', full_name: '山田' },
      skipEffect: (effectId) => effectId === `choices:${pet.id}`,
      onEffectComplete: async (effectId, stats) => {
        completed.push({ id: effectId, stats });
      },
    });
    // 飛ばした選択肢のタグは付かない。残りは実行される。
    expect(mocks.attachTag).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValue).toHaveBeenCalled();
    expect(result.failedEffects).toEqual([]);
    expect(completed.map((entry) => entry.id).sort()).toEqual(
      [`destinations:${pet.id}`, `destinations:${layout.sections[0].blocks[1].id}`].sort(),
    );
  });

  test('内側の選択肢動作の失敗は外側の工程も未完にする', async () => {
    const want = input({
      name: 'want',
      label: '希望',
      type: 'radio',
      choiceMode: 'action',
      choices: [
        {
          id: 'c1',
          label: '資料がほしい',
          actions: [{ kind: 'send_text', text: '資料をお送りします' }],
        },
      ],
    });
    const layout = layoutWith([want]);
    const { db } = fakeDb();
    const sent: Array<{ text: string; suffix: string }> = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { want: '資料がほしい' },
      pushText: async (text, stableSuffix) => {
        sent.push({ text, suffix: stableSuffix });
        throw new Error('push failed');
      },
    });
    // 送信の識別子は安定した値で渡る。
    expect(sent).toEqual([{ text: '資料をお送りします', suffix: `choiceAction:${want.id}:c1:0` }]);
    expect(result.failedEffects).toContain(`choiceAction:${want.id}:c1:0`);
    expect(result.failedEffects).toContain(`choices:${want.id}`);
  });

  test('完了記録の失敗は握らず呼び出し元へ返す', async () => {
    const layout = layoutWith([
      input({ name: 'full_name', label: 'お名前', destinations: { friendFieldIds: ['ff-1'] } }),
    ]);
    const { db } = fakeDb();

    await expect(applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { full_name: '山田' },
      onEffectComplete: async () => {
        throw new Error('claim ownership lost');
      },
    })).rejects.toThrow('claim ownership lost');
  });

  // 選択した Flex テンプレートが配信から抜けないよう、組み立てと送信まで確かめる。
  // 素通りしていたため、選んだテンプレートが静かに不達になっていた。
  test('Flex のテンプレートは組み立てて送る', async () => {
    mocks.getMessageTemplateById.mockResolvedValue({
      id: 'tpl-1',
      name: '診断カード',
      message_type: 'flex',
      message_content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"結果です"}]}}',
    });
    const layout = emptyLayout();
    layout.options.afterActions = [{ kind: 'send_template', templateId: 'tpl-1' }];
    const { db } = fakeDb();
    const sent: unknown[] = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: {},
      pushText: async () => {},
      pushMessage: async (message, stableSuffix) => {
        sent.push({ message, stableSuffix });
      },
    });
    expect(result.failedEffects).toEqual([]);
    expect(sent).toHaveLength(1);
    const sentMessage = (sent[0] as { message: { type: string; contents?: unknown } }).message;
    expect(sentMessage.type).toBe('flex');
    // 再送キーは pushText と同じく工程 id(afterAction:N)を使う。
    // 同じテンプレートを別の動作で送っても衝突しない。
    expect((sent[0] as { stableSuffix: string }).stableSuffix).toBe('afterAction:0');
  });

  test('非テキストを送る経路が無いときは、黙らず工程の失敗にする', async () => {
    mocks.getMessageTemplateById.mockResolvedValue({
      id: 'tpl-1',
      name: '診断カード',
      message_type: 'flex',
      message_content: '{}',
    });
    const layout = emptyLayout();
    layout.options.afterActions = [{ kind: 'send_template', templateId: 'tpl-1' }];
    const { db } = fakeDb();
    const sent: string[] = [];

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: {},
      pushText: async (t) => {
        sent.push(t);
      },
    });
    expect(sent).toEqual([]);
    // 静かな不達にしない。未完として残り、再実行の対象になる。
    expect(result.failedEffects).toEqual(['afterAction:0']);
  });

  test('答えていない欄には、何も起こさない', async () => {
    const layout = layoutWith([
      input({
        name: 'pet',
        label: '飼っている子',
        type: 'radio',
        choiceMode: 'tag',
        choices: [{ id: 'c1', label: '犬', tagId: 'tag-dog' }],
      }),
    ]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: {} });
    expect(mocks.attachTag).not.toHaveBeenCalled();
  });

  // FORM-13: 未回答の欄を登録先へ流すと、空文字での上書き＝既存の登録が
  // 消える。空欄は「更新しない」。情報欄の呼び出しも friends 列の UPDATE
  // も走らないことを、書き込みの形まで見て確認する。
  test.each([
    { name: '空文字', value: '' },
    { name: '空白だけ', value: '   ' },
    { name: 'null', value: null },
    { name: '空の選択肢', value: [] },
    { name: '空白だけの選択肢', value: ['', '  '] },
  ])('任意欄の未回答($name)は登録先を更新しない', async ({ value }) => {
    const layout = layoutWith([
      input({
        name: 'full_name',
        label: 'お名前',
        destinations: { friendFieldIds: ['ff-1'], realName: true, note: true },
      }),
    ]);
    const { db, calls } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { full_name: value },
    });

    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.sql.includes('UPDATE friends'))).toEqual([]);
    expect(result.destinationWrites).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(result.failedEffects).toEqual([]);
  });

  // FORM-15: 任意の日付欄を空のまま送っても、空の日付でリマインダの
  // 登録予定を作らない。暦に無い日付も同じく「何もしない」。
  test.each([
    { name: '空文字', value: '' },
    { name: '存在しない日付', value: '2026-02-30' },
  ])('日付欄の未回答・不正な日付($name)ではリマインダを動かさない', async ({ value }) => {
    const layout = layoutWith([
      input({
        name: 'day',
        label: '希望日',
        type: 'date',
        reminder: { reminderId: 'rm-1', time: '09:00' },
      }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { day: value },
    });

    expect(mocks.enrollFriendInReminder).not.toHaveBeenCalled();
    expect(result.failedEffects).toEqual([]);
  });

  test('失敗した工程の名前を残し、欠落を固定しない', async () => {
    mocks.attachTag.mockRejectedValueOnce(new Error('タグの付与に失敗'));
    const pet = input({
      name: 'pet',
      label: '飼っている子',
      type: 'checkbox',
      choiceMode: 'tag',
      choices: [{ id: 'c1', label: '犬', tagId: 'tag-dog' }],
    });
    const layout = layoutWith([pet]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { pet: ['犬'] },
    });
    expect(result.failedEffects).toEqual([`choices:${pet.id}`]);
  });

  test('接頭辞つきのリマインダ登録は安定した登録元idを付ける', async () => {
    const day = input({
      name: 'day',
      label: '希望日',
      type: 'date',
      reminder: { reminderId: 'rm-1', time: '09:00' },
    });
    const layout = layoutWith([day]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { day: '2026-09-01' },
      idempotencyPrefix: 'form-submit:answer-1',
    });
    expect(mocks.enrollFriendInReminder).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      reminderId: 'rm-1',
      targetDate: '2026-09-01',
      // 登録元idは「どの日付欄からか」まで入る。同じリマインダを別の欄に
      // 割り当てても、別の欄の登録と混ざらない(FORM-16)。
      sourceEventId: `form-submit:answer-1:reminder:${day.id}`,
    });
  });

  test('登録済みのリマインダは再開時に重ねない', async () => {
    const day = input({
      name: 'day',
      label: '希望日',
      type: 'date',
      reminder: { reminderId: 'rm-1', time: '09:00' },
    });
    const layout = layoutWith([day]);
    const { db } = fakeDb({ found: 1 });

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { day: '2026-09-01' },
      idempotencyPrefix: 'form-submit:answer-1',
    });
    expect(mocks.enrollFriendInReminder).not.toHaveBeenCalled();
    expect(result.failedEffects).toEqual([]);
  });

  // FORM-16: 同じリマインダを別の日付欄に割り当てたとき、欄ごとに別の
  // 予定を立てる。記録キー(source_event_id)に欄のIDが入るので、2つ目の
  // 予定が「登録済み」と誤認されて消えることはない。
  test('同じリマインダを2つの日付欄に割り当てても、欄ごとに登録される', async () => {
    const day1 = input({ name: 'day1', label: '初回', type: 'date', reminder: { reminderId: 'rm-1', time: '09:00' } });
    const day2 = input({ name: 'day2', label: '再来', type: 'date', reminder: { reminderId: 'rm-1', time: '09:00' } });
    const layout = layoutWith([day1, day2]);
    const { db } = fakeDb();

    await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { day1: '2026-09-01', day2: '2026-10-01' },
      idempotencyPrefix: 'form-submit:answer-1',
    });

    const sourceIds = mocks.enrollFriendInReminder.mock.calls.map(
      (call) => (call[1] as { sourceEventId: string | null }).sourceEventId,
    );
    expect(sourceIds).toEqual([
      `form-submit:answer-1:reminder:${day1.id}`,
      `form-submit:answer-1:reminder:${day2.id}`,
    ]);
    expect(mocks.enrollFriendInReminder).toHaveBeenCalledTimes(2);
  });
});

describe('フォーム回答や回答後動作を保存先の型に合わせて検証する', () => {
  const numberField = (id: string) => ({ id, ec_is_master: 0, type: 'number', options_json: null });

  test('F2 数値項目へ文字の回答は保存せず失敗に数える', async () => {
    mocks.getFriendFieldById.mockResolvedValue(numberField('ff-num'));
    const layout = layoutWith([
      input({ name: 'count', label: '回数', destinations: { friendFieldIds: ['ff-num'] } }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { count: 'あいう' },
    });

    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  test('F2 数値のカンマは正規化して保存する', async () => {
    const field = numberField('ff-num');
    mocks.getFriendFieldById.mockResolvedValue(field);
    const layout = layoutWith([
      input({ name: 'count', label: '回数', destinations: { friendFieldIds: ['ff-num'] } }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { count: '1,000' },
    });

    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      fieldId: 'ff-num',
      value: '1000',
      updatedBy: 'form',
      field,
    });
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
  });

  test('F2 multi_selectの配列回答は正規化JSONで保存する', async () => {
    const field = {
      id: 'ff-multi',
      ec_is_master: 0,
      type: 'multi_select',
      options_json: JSON.stringify(['犬', '猫']),
    };
    mocks.getFriendFieldById.mockResolvedValue(field);
    const layout = layoutWith([
      input({ name: 'pet', label: '飼っている子', destinations: { friendFieldIds: ['ff-multi'] } }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { pet: ['犬', '猫'] },
    });

    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      fieldId: 'ff-multi',
      value: JSON.stringify(['犬', '猫']),
      updatedBy: 'form',
      field,
    });
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
  });

  test('F2 multi_selectの選択肢外は保存しない', async () => {
    mocks.getFriendFieldById.mockResolvedValue({
      id: 'ff-multi',
      ec_is_master: 0,
      type: 'multi_select',
      options_json: JSON.stringify(['犬', '猫']),
    });
    const layout = layoutWith([
      input({ name: 'pet', label: '飼っている子', destinations: { friendFieldIds: ['ff-multi'] } }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { pet: ['恐竜'] },
    });

    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  test('F3 選択肢の値が項目の選択肢に無ければ保存しない', async () => {
    const field = {
      id: 'ff-sel',
      ec_is_master: 0,
      type: 'select',
      options_json: JSON.stringify(['松', '竹']),
    };
    mocks.getFriendFieldById.mockResolvedValue(field);
    const layout = layoutWith([
      input({
        name: 'plan',
        label: 'プラン',
        type: 'radio',
        choiceMode: 'friendField',
        choiceFriendFieldId: 'ff-sel',
        choices: [{ id: 'c1', label: '松', value: 'premium' }],
      }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { plan: '松' },
    });

    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  test('F3 選択肢の値が項目に合えば正規化して保存する', async () => {
    const field = {
      id: 'ff-sel',
      ec_is_master: 0,
      type: 'select',
      options_json: JSON.stringify([{ id: 'premium', label: '松' }, { id: 'std', label: '竹' }]),
    };
    mocks.getFriendFieldById.mockResolvedValue(field);
    const layout = layoutWith([
      input({
        name: 'plan',
        label: 'プラン',
        type: 'radio',
        choiceMode: 'friendField',
        choiceFriendFieldId: 'ff-sel',
        choices: [{ id: 'c1', label: '松', value: 'premium' }],
      }),
    ]);
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({
      db,
      layout,
      friendId: 'f1',
      answers: { plan: '松' },
    });

    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      fieldId: 'ff-sel',
      value: 'premium',
      updatedBy: 'form',
      field,
    });
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
  });

  test('F4 回答後動作の型外の値は保存せず失敗に数える', async () => {
    mocks.getFriendFieldById.mockResolvedValue(numberField('ff-num'));
    const layout = emptyLayout();
    layout.options.afterActions = [{ kind: 'friend_field', fieldId: 'ff-num', value: 'あいう' }];
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: {} });

    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  test('F4 回答後動作の正しい値は保存する', async () => {
    const field = numberField('ff-num');
    mocks.getFriendFieldById.mockResolvedValue(field);
    const layout = emptyLayout();
    layout.options.afterActions = [{ kind: 'friend_field', fieldId: 'ff-num', value: '42' }];
    const { db } = fakeDb();

    const result = await applyFormLayoutEffects({ db, layout, friendId: 'f1', answers: {} });

    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(db, {
      friendId: 'f1',
      fieldId: 'ff-num',
      value: '42',
      updatedBy: 'form',
      field,
    });
    expect(result.destinationWrites).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
  });
});

test('飛ばしたセクションの値が送られても定員・登録先・動作は使わない', async () => {
  const skipped = input({ name: 'skipped', type: 'checkbox', required: true, choiceMode: 'action',
    destinations: { friendFieldIds: ['ff-skipped'] }, choices: [{ id: 'a', label: 'A',
      capacity: { enabled: true, limit: 1 }, actions: [{ kind: 'tag', op: 'add', tagIds: ['tag-skipped'] }] }] });
  const layout = emptyLayout();
  layout.sections = [
    { id: 'first', name: 'First', blocks: [input({ name: 'branch', type: 'radio', choices: [{ id: 'skip', label: 'skip', jumpToSectionId: 'last' }] })] },
    { id: 'middle', name: 'Middle', blocks: [skipped] },
    { id: 'last', name: 'Last', blocks: [input({ name: 'final', required: true })] },
  ];
  const answers = { branch: 'skip', skipped: ['A'], final: 'done' };
  const { db } = fakeDb();
  expect(await checkFormGates({ db, formId: 'form', friendId: 'friend', submitCount: 0, layout, answers })).toBeNull();
  expect(collectCapacitySlots(layout, answers)).toEqual([]);
  expect(layoutEffectStepIds(layout, answers)).not.toContain(`destinations:${skipped.id}`);
  await applyFormLayoutEffects({ db, friendId: 'friend', layout, answers });
  expect(mocks.countChoiceUsage).not.toHaveBeenCalled();
  expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  expect(mocks.attachTag).not.toHaveBeenCalled();
});

describe('住所・予約の登録先は読める文字で保存する', () => {
  test.each([
    ['address', { postalCode: '1234567', prefecture: '東京都', city: '新宿区', addressLine1: '1-2', addressLine2: 'A' }, '〒123-4567 東京都新宿区1-2A'],
    ['booking', { menuId: 'm', staffId: 's', startsAt: '2026-10-10T01:30:00Z' }, '10/10 10:30'],
  ] as const)('%s を情報欄・本名・表示名・メモへ保存する', async (type, value, expected) => {
    const { db, calls } = fakeDb();
    await applyFormLayoutEffects({ db, friendId: 'friend-1', answers: { answer: value },
      layout: layoutWith([input({ name: 'answer', type, destinations: { friendFieldIds: ['ff-1'], realName: true, displayName: true, note: true } })]),
    });
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ value: expected }));
    expect(mocks.setFriendFieldValue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fieldId: 'fixed-name', value: expected }));
    expect(calls.find((c) => c.sql.includes('INSERT INTO chats'))?.binds[2]).toBe(expected);
    expect(calls.find((c) => c.sql.startsWith('UPDATE friends'))?.binds[0]).toBe(expected);
    expect(calls.find((c) => c.sql.startsWith('UPDATE friends'))?.sql).not.toContain('private_memo');
  });
});
