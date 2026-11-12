// @vitest-environment happy-dom
/*
 * 対応マークの自動変更ルール（GMvBd）を描いて押す。
 * 開いただけでは書き込まない・遅い返事を別のマークへ映さない・版競合で窓を閉じない・
 * 読込中／0件／取得失敗／権限不足／未接続を混ぜない・停止は履歴を残すと言う。
 * 言葉と確かめの中身は `support-mark-rules-view.test.ts` が見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/tags/marks/edit',
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

const net = vi.hoisted(() => ({
  list: vi.fn(),
  rules: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      supportMarks: {
        ...actual.api.supportMarks,
        list: (...args: unknown[]) => net.list(...args),
        automationRules: (...args: unknown[]) => net.rules(...args),
        createAutomationRule: (...args: unknown[]) => net.create(...args),
        updateAutomationRule: (...args: unknown[]) => net.update(...args),
        archiveAutomationRule: (...args: unknown[]) => net.archive(...args),
      },
    },
  }
})

import { ApiError, type SupportMarkAutomationRule } from '@/lib/api'
import SupportMarkRulesPanel from './support-mark-rules-panel'
import MarkEditor from '@/v8/tags/mark-editor'
import { LIST_EMPTY, LIST_ERROR, MULTI_MATCH_NOTE } from './support-mark-rules-view'

function rule(overrides: Partial<SupportMarkAutomationRule> = {}): SupportMarkAutomationRule {
  return {
    id: 'rule-1', name: '担当が決まったら対応中', markId: 'mk1', event: 'staff_assigned', condition: null,
    priority: 0, manualProtectionMinutes: 0, isActive: true, version: 3, updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}
const ok = (data: unknown) => ({ success: true, data })
const panel = () => document.querySelector<HTMLElement>('[data-design-node="GMvBd"]')
const writes = () => net.create.mock.calls.length + net.update.mock.calls.length + net.archive.mock.calls.length

beforeEach(() => {
  net.list.mockResolvedValue(ok([{ id: 'mk1', name: '対応中', color: '#2563D4', displayOrder: 0, isDefault: false, version: 1 }]))
  net.rules.mockResolvedValue(ok([rule()]))
  net.create.mockResolvedValue(ok(rule({ id: 'rule-new' })))
  net.update.mockResolvedValue(ok(rule()))
  net.archive.mockResolvedValue(ok(null))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('編集画面からの開き方', () => {
  it('編集中は「きまりを作る」で窓を開いてパネルを出し、開いただけでは書き込まない', async () => {
    render(<MarkEditor markId="mk1" />)
    const open = await screen.findByRole('button', { name: 'きまりを作る' })
    expect(document.querySelector('[data-design-node="ulq9Y"]')).not.toBeNull()
    expect(panel()).toBeNull()
    fireEvent.click(open)
    const dialog = await screen.findByRole('dialog', { name: '自動で変えるきまり' })
    await waitFor(() => expect(within(dialog).getByText('担当が決まったら対応中')).toBeTruthy())
    expect(dialog.querySelector('[data-design-node="GMvBd"] [data-qa-open="GMvBd"]')).not.toBeNull()
    expect(net.rules).toHaveBeenCalledWith('mk1', 'acc')
    expect(writes()).toBe(0)
  })

  it('作る画面では保存先が無いので、パネルを開かずその場の入力で1本だけ足す', async () => {
    render(<MarkEditor />)
    await screen.findByPlaceholderText('例：要確認')
    expect(screen.getByText('自動で変えるきまり')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'きまりを作る' }))
    expect(await screen.findByRole('button', { name: 'きまりを外す' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '自動で変えるきまり' })).toBeNull()
    expect(panel()).toBeNull()
    expect(net.rules).not.toHaveBeenCalled()
  })
})

describe('パネルの読み込み', () => {
  it('開くと取得の口だけを呼び、実行順（優先順位の大きい順）に並べて注意書きを添える', async () => {
    net.rules.mockResolvedValue(ok([
      rule({ id: 'low', name: '低い', priority: 1 }),
      rule({ id: 'high', name: '高い', priority: 10 }),
    ]))
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    await screen.findByText('高い')
    const names = [...panel()!.querySelectorAll('li')].map((li) => li.querySelector('p')?.textContent)
    expect(names).toEqual(['高い', '低い'])
    expect(screen.getByText(MULTI_MATCH_NOTE)).toBeTruthy()
    expect(panel()!.querySelector('li')!.textContent).toContain('担当者が決まったとき・「対応中」に変更')
    expect(net.rules).toHaveBeenCalledTimes(1)
    expect(writes()).toBe(0)
  })

  it.each([
    ['取得失敗', () => new ApiError(500), LIST_ERROR.title, true, true],
    ['権限不足', () => new ApiError(403), '自動変更ルールを見る権限がありません', true, false],
    ['未接続', () => new ApiError(404), '自動変更ルールはまだ接続されていません', false, false],
  ] as const)('%sは0件の文と混ぜずに出し分ける', async (_label, error, title, canRetry, canCreate) => {
    net.rules.mockRejectedValue(error())
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    await screen.findByText(title)
    expect(screen.queryByText(LIST_EMPTY.title)).toBeNull()
    expect(document.querySelector('[data-list-state="loading"]')).toBeNull()
    const retry = screen.queryByRole('button', { name: /もう一度|読み直す|再読み込み/ })
    expect(Boolean(retry)).toBe(canRetry)
    const create = screen.getByRole('button', { name: '＋ ルールを作る' }) as HTMLButtonElement
    expect(create.disabled).toBe(!canCreate)
  })

  it('読込中は読み込みの文だけ、取得できて0件なら0件の文を出す', async () => {
    let done!: (value: unknown) => void
    net.rules.mockReturnValue(new Promise((resolve) => { done = resolve }))
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    const loading = () => document.querySelector('[data-list-state="loading"][aria-label="自動変更ルールを読み込んでいます"]')
    expect(loading()).not.toBeNull()
    expect(screen.queryByText(LIST_EMPTY.title)).toBeNull()
    await act(async () => done(ok([])))
    expect(await screen.findByText(LIST_EMPTY.title)).toBeTruthy()
    expect(loading()).toBeNull()
  })

  it('マークが変わったら前の一覧と失敗をその場で捨て、遅れて届いた前の返事は受け取らない', async () => {
    let lateFirst!: (value: unknown) => void
    net.rules.mockImplementation((markId: string) => markId === 'mk1'
      ? new Promise((resolve) => { lateFirst = resolve })
      : Promise.resolve(ok([rule({ id: 'b', name: 'Bのきまり', markId: 'mk2' })])))
    const view = render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    view.rerender(<SupportMarkRulesPanel accountId="acc" markId="mk2" markName="要確認" />)
    await screen.findByText('Bのきまり')
    await act(async () => lateFirst(ok([rule({ name: 'Aのきまり' })])))
    expect(screen.queryByText('Aのきまり')).toBeNull()
    expect(screen.getByText('Bのきまり')).toBeTruthy()
  })

  it('アカウントやマークが変わると、出ていた失敗の知らせと開いていた窓を閉じる', async () => {
    net.update.mockRejectedValue(new ApiError(409))
    const view = render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '変更' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await screen.findByRole('button', { name: '最新の内容を読み直す' })
    net.rules.mockResolvedValue(ok([]))
    view.rerender(<SupportMarkRulesPanel accountId="acc-2" markId="mk1" markName="対応中" />)
    await screen.findByText(LIST_EMPTY.title)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByText('担当が決まったら対応中')).toBeNull()
    expect(net.rules).toHaveBeenLastCalledWith('mk1', 'acc-2')
  })
})

describe('保存と停止', () => {
  it('版競合では窓と入力を残し、読み直す押し口で取得をやり直す', async () => {
    net.update.mockRejectedValue(new ApiError(409))
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '変更' }))
    const name = screen.getByPlaceholderText('例：担当者が決まったら対応中へ') as HTMLInputElement
    fireEvent.change(name, { target: { value: '直した名前' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    expect(net.update).toHaveBeenCalledWith('rule-1', 'acc', 3, expect.objectContaining({ name: '直した名前' }))
    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-failure-kind')).toBe('conflict')
    expect((screen.getByPlaceholderText('例：担当者が決まったら対応中へ') as HTMLInputElement).value).toBe('直した名前')
    const calls = net.rules.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '最新の内容を読み直す' }))
    await waitFor(() => expect(net.rules.mock.calls.length).toBe(calls + 1))
  })

  it('断られた返事（success: false）では窓を閉じず、通ったときだけ閉じて読み直す', async () => {
    net.create.mockResolvedValueOnce({ success: false, error: 'x' })
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '＋ ルールを作る' }))
    fireEvent.change(screen.getByPlaceholderText('例：担当者が決まったら対応中へ'), { target: { value: '新しいきまり' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy()
    const calls = net.rules.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存する' })).toBeNull())
    expect(net.rules.mock.calls.length).toBe(calls + 1)
    expect(net.create).toHaveBeenLastCalledWith('mk1', 'acc', expect.objectContaining({ name: '新しいきまり' }), expect.any(String))
  })

  it('停止の窓に操作するアカウントと環境を表示する', async () => {
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('対応中')
  })

  it('アカウントを変えて戻しても前の停止確認を復活させない', async () => {
    const view = render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }))
    await screen.findByRole('alertdialog')
    view.rerender(<SupportMarkRulesPanel accountId="acc-2" markId="mk1" markName="対応中" />)
    view.rerender(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.archive).not.toHaveBeenCalled()
  })

  it('停止の窓は履歴が残ると言い、確定で読んだ版つきの停止の口を呼ぶ', async () => {
    render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('「担当が決まったら対応中」を停止します。')
    expect(dialog.textContent).toContain('これまでの変更履歴は監査記録として残ります。')
    expect(net.archive).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'このルールを停止' })) })
    expect(net.archive).toHaveBeenCalledWith('rule-1', 'acc', 3)
  })
})

it('自動変更ルールの入力後にキャンセルすると破棄を確認する', async () => {
  render(<SupportMarkRulesPanel accountId="acc" markId="mk1" markName="対応中" />)
  fireEvent.click(await screen.findByRole('button', { name: /ルールを作る/ }))
  const field = screen.getByPlaceholderText('例：担当者が決まったら対応中へ') as HTMLInputElement
  fireEvent.change(field, { target: { value: '作りかけのルール' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('自動変更ルールへの変更')
  expect(field.value).toBe('作りかけのルール')
})

it('ルールの窓を閉じるときも中の未保存入力を確認する', async () => {
  render(<MarkEditor markId="mk1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'きまりを作る' }))
  const outer = await screen.findByRole('dialog', { name: '自動で変えるきまり' })
  fireEvent.click(await within(outer).findByRole('button', { name: /ルールを作る/ }))
  const field = within(outer).getByPlaceholderText('例：担当者が決まったら対応中へ') as HTMLInputElement
  fireEvent.change(field, { target: { value: '作りかけのルール' } })
  fireEvent.click(within(outer).getByRole('button', { name: '閉じる' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(field.value).toBe('作りかけのルール')
})

it('親のマークだけを編集した状態では、未変更のルール窓を確認なしで閉じて親の入力を残す', async () => {
  render(<MarkEditor markId="mk1" />)
  const name = await screen.findByPlaceholderText('例：要確認') as HTMLInputElement
  fireEvent.change(name, { target: { value: '親の編集中' } })
  fireEvent.click(await screen.findByRole('button', { name: 'きまりを作る' }))
  const outer = await screen.findByRole('dialog', { name: '自動で変えるきまり' })
  fireEvent.click(within(outer).getByRole('button', { name: '閉じる' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '自動で変えるきまり' })).toBeNull())
  expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  expect(name.value).toBe('親の編集中')
})
