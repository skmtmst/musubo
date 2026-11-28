import { describe, expect, it } from 'vitest'
import type { FriendAddRouting, FriendAddRoutingVersion, LineAccount, Scenario } from '@line-crm/shared'
import {
  CARE_ITEMS,
  STEP_STATE_LABEL,
  type GettingStartedInput,
  buildSteps,
  buildStepsFromApi,
  doneCount,
  allDone,
  featureSetStep,
  insertFeatureSet,
  progressHeadline,
  stoppedReasons,
} from './getting-started-view'

/**
 * 設計板 「はじめの設定」の判定を、文言ごと固定する。
 *
 * ここで守りたいのは 1 点——**「画面を開いた」を「終わった」に読み替えない**こと。
 * 判定はすべて実物から計算する。
 */

function account(over: Partial<LineAccount> = {}): LineAccount {
  return {
    id: 'a1',
    channelId: '1',
    name: '然-NEN- TEST',
    loginChannelId: null,
    liffId: null,
    isActive: true,
    channelSecretConfigured: true,
    webhook: { status: 'matched' },
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  } as LineAccount
}

function routing(over: Partial<FriendAddRouting> = {}): FriendAddRouting {
  return {
    firstTime: { scenarioId: null, actions: [], timing: 'immediate' },
    returning: { scenarioId: null, actions: [], mode: 'none', startPosition: 'start' },
    criteria: { firstTime: 'never_added' },
    ...over,
  } as FriendAddRouting
}

function version(over: Partial<FriendAddRoutingVersion> = {}): FriendAddRoutingVersion {
  return {
    accountId: 'a1',
    versionId: 'v1',
    versionNumber: 1,
    status: 'draft',
    routing: routing(),
    lastTestStatus: null,
    lastTestedAt: null,
    publishedAt: null,
    ...over,
  }
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 's1',
    name: '新規登録 7日間フォロー',
    description: null,
    triggerType: 'tag_added',
    triggerTagId: null,
    lineAccountId: null,
    isActive: true,
    ...over,
  } as Scenario
}

const EMPTY: GettingStartedInput = {
  accounts: [],
  featureSet: null,
  tagCount: 0,
  friendFieldCount: 0,
  friendAdd: null,
  friendAddDraft: null,
  scenarios: [],
  role: 'owner',
}

describe('段は6つで、順番と題が板どおり', () => {
  it('題と丸の文字と補足が板 xuJ7D と一致する', () => {
    const steps = buildSteps(EMPTY)
    expect(steps.map((s) => [s.ordinal, s.title, s.sub])).toEqual([
      ['1', 'LINEアカウントをつなぐ', 'チャネルIDとチャネルシークレット'],
      ['2', '使う機能の初期セット', '業種に合わせて機能を出す'],
      ['3', '友だちの分け方を決める', 'タグと友だち情報欄を作る'],
      ['4', '友だち追加時の配信を作る', '友だちになった人へのあいさつ'],
      ['5', 'シナリオを作る', '決まった日数ごとに送る'],
      ['6', '最初の1通を受け取る', '自分のLINEで受け取って確かめる'],
    ])
  })

  it('どの段でも条件と次のことを必ず出す', () => {
    for (const step of buildSteps(EMPTY)) {
      expect(step.condition.length).toBeGreaterThan(0)
      expect(step.next.length).toBeGreaterThan(0)
    }
  })
})

describe('段1 LINEアカウント', () => {
  it('アカウントを登録すれば終わり', () => {
    expect(buildSteps({ ...EMPTY, accounts: [account()] })[0].state).toBe('done')
  })

  it('Webhook が未確認でも登録済みなら終わり', () => {
    const steps = buildSteps({ ...EMPTY, accounts: [account({ webhook: { status: 'unknown' } })] })
    expect(steps[0].state).toBe('done')
  })

  it('Webhook の利用がオフでも登録済みなら終わり', () => {
    const steps = buildSteps({ ...EMPTY, accounts: [account({ webhook: { status: 'matched', active: false } })] })
    expect(steps[0].state).toBe('done')
  })

  it('停止中でも登録済みなら終わり', () => {
    const steps = buildSteps({ ...EMPTY, accounts: [account({ isActive: false })] })
    expect(steps[0].state).toBe('done')
  })

  it('シークレットが未確認でも登録済みなら終わり', () => {
    const steps = buildSteps({ ...EMPTY, accounts: [account({ channelSecretConfigured: false })] })
    expect(steps[0].state).toBe('done')
  })

  it('1件も無ければ「まだです」', () => {
    expect(buildSteps(EMPTY)[0].state).toBe('todo')
  })
})

describe('段2 使う機能の初期セット', () => {
  it('保存済みの設定があれば終わり', () => {
    expect(featureSetStep({ kind: 'configured' }).state).toBe('done')
    expect(featureSetStep({ kind: 'configured' }).action).toBeNull()
  })

  it('まだ選んでいなければ機能設定へ誘う', () => {
    const step = featureSetStep({ kind: 'picker' })
    expect(step.state).toBe('todo')
    expect(step.action).toEqual({ label: '使う機能を選択する', href: '/settings' })
  })

  it('権限が無ければ進めないと言う', () => {
    const step = featureSetStep({ kind: 'forbidden' })
    expect(step.state).toBe('forbidden')
    expect(step.action).toBeNull()
    expect(step.blockedReason).toBe('管理者に頼んでください')
  })

  it('未取得を「終わった」に数えない', () => {
    expect(featureSetStep(null).state).toBe('unknown')
  })

  it('口の5段へ段2を足して6段にし、段番号を振り直す', () => {
    const five = buildStepsFromApi([
      { key: 'accounts', state: 'done', href: '/accounts', reason: null },
      { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null },
      { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
      { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
      { key: 'firstMessage', state: 'unknown', href: '/', reason: null },
    ])
    expect(five).toHaveLength(5)
    const six = insertFeatureSet(five, { kind: 'picker' })
    expect(six.map((s) => [s.ordinal, s.key])).toEqual([
      ['1', 'accounts'],
      ['2', 'featureSet'],
      ['3', 'attributes'],
      ['4', 'friendAdd'],
      ['5', 'scenario'],
      ['6', 'firstMessage'],
    ])
  })
})

describe('段3 友だちの分け方', () => {
  it('タグだけでも友だち情報欄だけでも終わり', () => {
    expect(buildSteps({ ...EMPTY, tagCount: 1 })[2].state).toBe('done')
    expect(buildSteps({ ...EMPTY, friendFieldCount: 1 })[2].state).toBe('done')
  })
})

describe('段4 友だち追加時の配信', () => {
  it('下書きがあるだけでは終わらず「止まっています」', () => {
    const steps = buildSteps({
      ...EMPTY,
      friendAdd: { configured: true, routing: routing() },
      friendAddDraft: version(),
    })
    expect(steps[3].state).toBe('stalled')
    expect(steps[3].next).toContain('まだ公開していません')
  })

  it('公開されていれば終わり', () => {
    const steps = buildSteps({
      ...EMPTY,
      friendAdd: { configured: true, routing: routing() },
      friendAddDraft: version({ status: 'published', publishedAt: '2026-09-01T00:00:00Z' }),
    })
    expect(steps[3].state).toBe('done')
  })
})

describe('段5 シナリオ', () => {
  it('公開シナリオがあっても、段4のルールから始まらなければ終わらない', () => {
    const steps = buildSteps({ ...EMPTY, scenarios: [scenario()] })
    expect(steps[4].state).toBe('stalled')
  })

  it('段4のルールが指しているシナリオが動いていれば終わり', () => {
    const steps = buildSteps({
      ...EMPTY,
      friendAdd: {
        configured: true,
        routing: routing({ firstTime: { scenarioId: 's1', actions: [], timing: 'immediate' } as FriendAddRouting['firstTime'] }),
      },
      scenarios: [scenario()],
    })
    expect(steps[4].state).toBe('done')
  })

  /*
    実画面で落ちた形。`configured` だけ返って `routing` が来ないことがある。
    **型が言い切っていても、外から来た値は疑う。**
  */
  it('振り分けの中身が読めなくても落ちない', () => {
    const steps = buildSteps({ ...EMPTY, friendAdd: { configured: true }, scenarios: [scenario()] })
    expect(steps[4].state).toBe('stalled')
  })

  it('1本も無いときだけ「レシピから作る」へ誘う', () => {
    expect(buildSteps(EMPTY)[4].action).toEqual({ label: 'レシピから作る', href: '/recipes' })
  })
})

describe('段6 最初の1通', () => {
  /*
    **数を作らない。** 「1通目が届いたか」を返す口がまだ無いので、
    終わったことにも、まだですにもしない。確かめられないと言う。
  */
  it('数える口が無いので「確かめられません」で止める', () => {
    const steps = buildSteps(EMPTY)
    expect(steps[5].state).toBe('unknown')
    expect(steps[5].next).toContain('数える口がまだありません')
  })

  /*
    **読めないのと、無いのは違う。** 役割が引けなかったときに
    「権限がありません」と言うと、実際には進められる人を止めてしまう。
  */
  it('役割が読めなかったときを「権限がありません」と読まない', () => {
    const steps = buildSteps({ ...EMPTY, role: null })
    expect(steps[5].state).toBe('unknown')
    expect(steps[5].blockedReason).toBeNull()
  })

  it('閲覧者には権限で止まっていることを言い、ボタンを描かない', () => {
    const steps = buildSteps({ ...EMPTY, role: 'viewer' })
    expect(steps[5].state).toBe('forbidden')
    expect(steps[5].action).toBeNull()
    expect(steps[5].blockedReason).toBe('管理者に頼んでください')
  })
})

describe('見出しと止まっている理由', () => {
  it('サーバ判定の状態・権限・行き先を画面で再計算しない', () => {
    const steps = buildStepsFromApi([
      { key: 'accounts', state: 'done', href: '/accounts', reason: null },
      { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null },
      { key: 'friendAdd', state: 'stalled', href: '/friend-add-settings', reason: '下書きが1本あります' },
      { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
      { key: 'firstMessage', state: 'forbidden', href: null, reason: '管理者に頼んでください' },
    ])
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'stalled', 'todo', 'forbidden'])
    expect(steps[2].next).toBe('下書きが1本あります')
    expect(steps[2].action).toEqual({ label: '友だち追加時の配信へ', href: '/friend-add-settings' })
    expect(steps[3].action).toEqual({ label: 'レシピから作る', href: '/recipes' })
    expect(steps.find((s) => s.key === 'firstMessage')?.action).toBeNull()
    const done = buildStepsFromApi([
      { key: 'firstMessage', state: 'todo', href: '/', reason: null },
    ])
    expect(done.find((s) => s.key === 'firstMessage')?.action).toEqual({ label: 'テストを送る', href: '/chats' })
  })

  it('帯は「済み / 全体 済み」の形にする', () => {
    const steps = insertFeatureSet(
      buildStepsFromApi([
        { key: 'accounts', state: 'done', href: '/accounts', reason: null },
        { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null },
        { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
        { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
        { key: 'firstMessage', state: 'unknown', href: '/', reason: null },
      ]),
      { kind: 'picker' },
    )
    expect(progressHeadline(steps)).toBe('2 / 6 済み')
    expect(doneCount(steps)).toBe(2)
    expect(allDone(steps)).toBe(false)
  })

  it('確かめられない段を「終わった」に数えない', () => {
    const steps = buildSteps({
      ...EMPTY,
      accounts: [account()],
      tagCount: 1,
      friendAdd: { configured: true, routing: routing({ firstTime: { scenarioId: 's1', actions: [], timing: 'immediate' } as FriendAddRouting['firstTime'] }) },
      friendAddDraft: version({ status: 'published', publishedAt: '2026-09-01T00:00:00Z' }),
      scenarios: [scenario()],
    })
    expect(doneCount(steps)).toBe(4)
    expect(allDone(steps)).toBe(false)
  })

  it('止まっている段と、権限で進めない段を分けて言う', () => {
    const lines = stoppedReasons(buildSteps({ ...EMPTY, accounts: [account()], role: 'viewer' }))
    expect(lines.some((l) => l.startsWith('段2'))).toBe(false)
    expect(lines.some((l) => l.includes('管理者に頼んでください'))).toBe(true)
  })
})

describe('下の2枚', () => {
  it('気をつけることは板の 2 行', () => {
    expect(CARE_ITEMS.map((item) => item.head)).toEqual([
      '手順は飛ばしても使えます。',
      'あとからこの画面に戻れます（設定 › はじめの設定）。',
    ])
  })

  it('状態の呼び名を色に頼らず文字で持つ', () => {
    expect(Object.values(STEP_STATE_LABEL)).toContain('終わりました')
    expect(Object.values(STEP_STATE_LABEL)).toContain('止まっています')
    expect(Object.values(STEP_STATE_LABEL)).toContain('まだです')
  })
})

 it('V8 displays six server states without assuming a test was delivered', () => {
  const steps = buildStepsFromApi(['accounts','featureSet','attributes','friendAdd','scenario','firstMessage'].map(key => ({key:key as import('@/lib/api').GettingStartedStep['key'], state:key === 'featureSet' ? 'done' : 'todo', href:'/settings', reason:null})));
  expect(steps.map(s=>s.ordinal)).toEqual(['1','2','3','4','5','6']);
  expect(steps[1].state).toBe('done'); expect(steps[5].state).toBe('todo'); expect(doneCount(steps)).toBe(1);
 });
