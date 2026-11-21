import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * マイルの使い道をつくる・編集する（設計 `p9CcEB` 17-1-G）を本物の React で動かして守る。
 *
 * 数の限りの「空欄＝限りなし／0＝品切れ」・欄ごとの止め方・選べる種類と
 * 渡せなかったときの決めごと・既存の使い道の版つき保存・確認後だけの公開・
 * 壊れた1件取得の受け止め・共通アクションの公開版・交換対象の条件を、
 * 押して保存の口（api モック）に渡った中身で確かめる。
 *
 * 口そのもの（PATCH・版ID・公開の確認ヘッダー）は lib/api.test.ts、
 * 交換テストのあとの保存の続きは v8/mileage/reward-partial-save.test.tsx が見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMIT_FIELD_ERRORS } from '@/v8/mileage/reward-form'

const f = vi.hoisted(() => ({
  query: '',
  push: vi.fn(),
  reward: vi.fn(),
  rewards: vi.fn(),
  create: vi.fn(),
  createDraft: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
  test: vi.fn(),
  resources: vi.fn(),
}))

vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: f.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(f.query),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      featureSettings: { visibility: async () => ({ success: true, data: { features: {} } }) },
      commonActions: { ...actual.api.commonActions, resources: f.resources },
      mileage: {
        ...actual.api.mileage,
        friendsV6: async () => ({ success: true, data: { balanceSource: 'musubo' } }),
        reward: f.reward,
        rewards: f.rewards,
        createReward: f.create,
        createRewardDraft: f.createDraft,
        saveRewardDraft: f.save,
        publishReward: f.publish,
        testReward: f.test,
      },
    },
  }
})

import RewardEditPage from './page'

function existing(overrides: Record<string, unknown> = {}, version: Record<string, unknown> = {}) {
  return {
    id: 'reward-1',
    lineAccountId: 'account-1',
    programId: 'program-1',
    name: '先行のお知らせ',
    description: null,
    imageUrl: null,
    rewardKind: 'coupon',
    status: 'published',
    sortOrder: 0,
    currentDraftVersionId: null,
    currentPublishedVersionId: 'published-1',
    currentVersion: {
      id: 'published-1',
      versionNumber: 1,
      status: 'published',
      revision: 4,
      requiredMiles: 300,
      stockLimit: null,
      perFriendLimit: null,
      startsAt: null,
      endsAt: null,
      benefitExpiresDays: null,
      commonActionVersionId: null,
      targetConditions: null,
      failurePolicy: 'retry',
      customerMessage: '',
      publishedAt: '2026-09-10T00:00:00.000Z',
      ...version,
    },
    exchangedThisMonth: 0,
    availableCodeCount: null,
    benefitName: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.clearAllMocks()
  f.query = ''
  // 条件の部品などが読む候補は空で返す（ここで見たいのは保存の口だけ）。
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) as typeof globalThis.fetch
  f.resources.mockResolvedValue({ success: true, data: { commonActions: [] } })
  f.create.mockImplementation(async (_account: string, draft: Record<string, unknown>) => ({
    success: true,
    data: { ...existing({ id: 'reward-new', status: 'draft', currentDraftVersionId: 'draft-1' }, { revision: 1 }), ...draft },
  }))
  f.createDraft.mockResolvedValue({ success: true, data: existing({ currentDraftVersionId: 'draft-9' }, { id: 'draft-9', status: 'draft', revision: 5 }) })
  f.save.mockResolvedValue({ success: true, data: existing({ currentDraftVersionId: 'draft-9' }, { id: 'draft-9', status: 'draft', revision: 6 }) })
  f.publish.mockResolvedValue({ success: true, data: existing() })
  window.history.replaceState(null, '', '/')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
})

async function settle() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

async function render() {
  await act(async () => { root.render(<RewardEditPage />) })
  await settle()
}

async function input(id: string, value: string) {
  await act(async () => { fireEvent.change(host.querySelector(`#${id}`)!, { target: { value } }) })
}

function button(text: string, scope: ParentNode = host): HTMLButtonElement {
  const found = ([...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? querySupplementaryPageAction(text))
  if (!found) throw new Error(`「${text}」のボタンがありません`)
  return found as HTMLButtonElement
}

async function click(target: HTMLElement) {
  await act(async () => { target.click() })
  await settle()
}

/** 選ぶ欄を開き、並んだ選択肢の文字を返す（開いたまま）。 */
async function openSelect(label: string): Promise<HTMLElement[]> {
  await click(host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement)
  return [...document.querySelectorAll('[role="option"]')] as HTMLElement[]
}

async function chooseOption(label: string, option: string) {
  const opened = [...document.querySelectorAll('[role="option"]')] as HTMLElement[]
  const options = opened.length > 0 ? opened : await openSelect(label)
  const target = options.find((item) => item.textContent?.trim() === option)
  if (!target) throw new Error(`「${option}」が選択肢にありません`)
  await click((target.querySelector('button') ?? target) as HTMLElement)
}

function savedDraft(): Record<string, unknown> {
  const call = f.create.mock.calls.at(-1) ?? []
  return call[1] as Record<string, unknown>
}

async function fillBasics() {
  await input('reward-name', '送料無料クーポン')
  await input('reward-miles', '1000')
}

describe('数の限り', () => {
  it.each([
    ['', null],
    ['0', 0],
    ['10', 10],
    ['１０', 10],
  ])('出す数 %j は %j として保存する（空欄は限りなし・0 は品切れ）', async (typed, expected) => {
    await render()
    await fillBasics()
    await input('reward-stock', typed)
    await click(button('下書きを保存'))

    expect(f.create).toHaveBeenCalledTimes(1)
    expect(savedDraft().stockLimit).toBe(expected)
  })

  it('全角数字は欄の中で半角へそろえる', async () => {
    await render()
    for (const id of ['reward-stock', 'reward-per-friend', 'reward-expires']) {
      await input(id, '１２')
      expect((host.querySelector(`#${id}`) as HTMLInputElement).value, id).toBe('12')
    }
  })

  it('出す数の欄で、空欄と0の意味を出す', async () => {
    await render()
    expect(host.querySelector('#reward-stock')?.getAttribute('title')).toBe('空欄なら限りなし。0 と書くと品切れ（交換できません）')
  })

  it.each([
    ['reward-stock', 'abc', LIMIT_FIELD_ERRORS.stockLimit],
    ['reward-stock', '-1', LIMIT_FIELD_ERRORS.stockLimit],
    ['reward-per-friend', '0', LIMIT_FIELD_ERRORS.perFriendLimit],
    ['reward-per-friend', '1.5', LIMIT_FIELD_ERRORS.perFriendLimit],
    ['reward-expires', '0', LIMIT_FIELD_ERRORS.benefitExpiresDays],
  ])('%s に %j を入れると、その欄の下で止めて保存しない', async (id, typed, message) => {
    await render()
    await fillBasics()
    await input(id, typed)
    await click(button('下書きを保存'))

    expect(f.create).not.toHaveBeenCalled()
    expect(host.textContent).toContain(message)
  })
})

describe('選べるもの', () => {
  it('渡すものの7種類を選べ、選ぶと種類が変わる', async () => {
    await render()
    const kinds = [...host.querySelectorAll<HTMLInputElement>('input[name="reward-kind-cards"]')]
    expect(kinds.map((item) => item.value)).toEqual(['handgift', 'coupon', 'tag', 'scenario', 'template', 'early_access', 'rank'])
    const rank = kinds.find((item) => item.value === 'rank')!
    await act(async () => { fireEvent.click(rank) })
    expect(rank.checked).toBe(true)
  })

  it('手渡しを選ぶと種類を保存する', async () => {
    await render()
    const handgift = host.querySelector<HTMLInputElement>('input[name="reward-kind-primary"][value="handgift"]')!
    await act(async () => { fireEvent.click(handgift) })
    await fillBasics()
    await click(button('下書きを保存'))
    expect(savedDraft().rewardKind).toBe('handgift')
  })

  it.each([['handgift', 'coupon'], ['coupon', 'handgift']])('作成済みの%sから%sには切り替えられない', async (current, blocked) => {
    f.query = 'id=reward-1'
    f.reward.mockResolvedValue({ success: true, data: existing({ rewardKind: current }) })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()
    expect(host.querySelector<HTMLInputElement>(`input[name="reward-kind-cards"][value="${blocked}"]`)?.disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>(`input[name="reward-kind-primary"][value="${blocked}"]`)?.disabled).toBe(true)
  })

  it('渡せなかったときの決めごとを3つから選び、そのまま保存する', async () => {
    await render()
    const labels = (await openSelect('渡せなかったときにどうするか')).map((item) => item.textContent?.trim())
    expect(labels).toEqual(['もう一度試す（おすすめ）', 'マイルを返す', '担当者が手で対応する'])

    await chooseOption('渡せなかったときにどうするか', 'マイルを返す')
    await fillBasics()
    await click(button('下書きを保存'))
    expect(savedDraft().failurePolicy).toBe('refund')
  })
})

describe('既存の使い道', () => {
  it('公開中の使い道は下書きの版を作ってから、版IDと更新番号つきで保存する', async () => {
    f.query = 'id=reward-1'
    f.reward.mockResolvedValue({ success: true, data: existing() })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()
    await input('reward-name', '先行のお知らせ（改）')
    await click(button('下書きを保存'))

    expect(f.create).not.toHaveBeenCalled()
    expect(f.createDraft).toHaveBeenCalledWith('reward-1', 'account-1')
    expect(f.save).toHaveBeenCalledTimes(1)
    const [id, account, versionId, revision, draft] = f.save.mock.calls[0]
    expect([id, account, versionId, revision]).toEqual(['reward-1', 'account-1', 'draft-9', 5])
    expect((draft as { name: string }).name).toBe('先行のお知らせ（改）')
  })

  it('保存して出すは確認の窓を出し、確かめたあとだけ公開する', async () => {
    await render()
    await fillBasics()
    await click(button('保存して出す'))

    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
    expect(dialog?.textContent).toContain('この使い道を公開しますか？')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()

    await click(button('使い道を公開', document.body))
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.publish).toHaveBeenCalledWith('reward-new', 'account-1', 'draft-1', 1)
  })

  it('1件取得の形が壊れていても、一覧から同じIDを探して開く', async () => {
    f.query = 'id=reward-1'
    f.reward.mockResolvedValue({ success: true, data: { id: 'reward-1' } })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [existing({ id: 'reward-0', name: '別の使い道' }), existing()] } })
    await render()

    expect((host.querySelector('#reward-name') as HTMLInputElement).value).toBe('先行のお知らせ')
    expect((host.querySelector('#reward-miles') as HTMLInputElement).value).toBe('300')
    expect(host.textContent).not.toContain('使い道を表示できませんでした')
  })

  it('1件取得も一覧も取れなければ、画面を落とさず表示できなかったと出す', async () => {
    f.query = 'id=reward-1'
    f.reward.mockRejectedValue(new Error('network'))
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()

    expect(host.querySelector('[data-list-state="error"]')).not.toBeNull()
    expect(host.textContent).toContain('管理者にお問い合わせください。')
    expect(host.querySelector('#reward-name')).toBeNull()
  })
})

describe('渡すものと交換できる人', () => {
  it('共通アクションは公開版のIDで選択肢に並べ、そのIDで保存する', async () => {
    f.query = 'id=reward-1'
    f.resources.mockResolvedValue({
      success: true,
      data: { commonActions: [{ id: 'action-1', name: 'VIPタグを付ける', version: 2, currentPublishedVersionId: 'action-1-v2' }] },
    })
    f.reward.mockResolvedValue({ success: true, data: existing({ rewardKind: 'tag' }, { commonActionVersionId: 'action-1-v2' }) })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()

    const field = host.querySelector('#reward-action')?.closest('[data-entity-picker-field]')
    expect(field?.textContent).toContain('VIPタグを付ける（公開中の第2版）')
    expect(field?.textContent).not.toContain('現在選択中の公開版')

    await click(button('下書きを保存'))
    expect((f.save.mock.calls[0][4] as { commonActionVersionId: string }).commonActionVersionId).toBe('action-1-v2')
  })

  it('交換できる人の条件は共通の条件の部品で開き、下書きへそのまま保存する', async () => {
    const condition = { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-vip' }] }
    f.query = 'id=reward-1'
    f.reward.mockResolvedValue({ success: true, data: existing({}, { targetConditions: condition }) })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()

    expect(host.querySelector('button[aria-label="交換できる人"]')?.textContent).toContain('条件で絞る')
    expect(host.textContent).not.toContain('条件を足す（タグ・会員ランクなど）')

    await click(button('下書きを保存'))
    expect((f.save.mock.calls[0][4] as { targetConditions: unknown }).targetConditions).toMatchObject(condition)
  })

  it('すべての友だちに戻すと、条件を外して保存する', async () => {
    const condition = { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-vip' }] }
    f.query = 'id=reward-1'
    f.reward.mockResolvedValue({ success: true, data: existing({}, { targetConditions: condition }) })
    f.rewards.mockResolvedValue({ success: true, data: { rewards: [] } })
    await render()

    await chooseOption('交換できる人', 'すべての友だち')
    await click(button('下書きを保存'))
    expect((f.save.mock.calls[0][4] as { targetConditions: unknown }).targetConditions).toBeNull()
  })
})

describe('交換テスト', () => {
  it('受け渡せないときは理由を出し、残高と在庫は動かしていないと添える', async () => {
    f.test.mockResolvedValue({ success: true, data: { canDeliver: false, requiredMiles: 1000, warning: 'クーポンの在庫がありません' } })
    await render()
    await fillBasics()
    await click(button('自分で交換をテスト'))

    expect(f.test).toHaveBeenCalledWith('reward-new', 'account-1')
    expect(host.textContent).toContain('交換テストで確認が必要です。クーポンの在庫がありません。残高と在庫は動かしていません。')
  })
})
