// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  program: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  tiers: vi.fn(),
  activate: vi.fn(),
  stop: vi.fn(),
}))
const account = vi.hoisted(() => ({
  selectedAccountId: 'acc-1' as string | null,
  selectedAccount: { id: 'acc-1', name: '検証本店' } as { id: string; name: string } | null,
  accounts: [{ id: 'acc-1', name: '検証本店' }] as Array<{ id: string; name: string }>,
  loading: false,
}))

vi.mock('@/lib/api/helpers/gap3', () => ({ memberRanksApi: api }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/mileage',
  useSearchParams: () => new URLSearchParams('tab=ranks'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('./frame', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./frame')>()
  return {
    ...actual,
    useMileageShell: () => ({ tab: 'ranks', readonly: false, narrow: false, counts: {}, setCount: () => {} }),
  }
})

import RanksTab from './ranks'

const PROGRAM = {
  metric: 'visits' as const,
  windowMonths: 12,
  status: 'stopped' as const,
  version: 4,
  activatedAt: null,
  notificationsAvailable: false,
  notifyUpgrade: true,
  notifyDowngrade: true,
  tiers: [
    { id: 't1', name: 'ブロンズ', threshold: 0, mileMultiplier: 1 },
    { id: 't2', name: 'シルバー', threshold: 3, mileMultiplier: 1.2 },
    { id: 't3', name: 'ゴールド', threshold: 8, mileMultiplier: 1.5 },
  ],
}

const PREVIEW = {
  byTier: [
    { tierId: 't1', name: 'ブロンズ', count: 780 },
    { tierId: 't2', name: 'シルバー', count: 360 },
    { tierId: 't3', name: 'ゴールド', count: 144 },
  ],
  wouldUpgrade: 504,
  wouldDowngrade: 12,
}

beforeEach(() => {
  account.selectedAccountId = 'acc-1'
  account.selectedAccount = { id: 'acc-1', name: '検証本店' }
  account.accounts = [{ id: 'acc-1', name: '検証本店' }]
  account.loading = false
  api.program.mockReset()
  api.preview.mockReset()
  api.program.mockResolvedValue({ success: true, data: PROGRAM })
  api.preview.mockResolvedValue({ success: true, data: PREVIEW })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('会員ランクの人数見込み（preview）の失敗表示とその場復旧', () => {
  it('preview 取得が失敗しても段の表は残し、未取得表示と注意帯から「人数を読み直す」で復旧できる', async () => {
    api.preview
      .mockRejectedValueOnce(new Error('preview timeout'))
      .mockResolvedValueOnce({ success: true, data: PREVIEW })

    render(<RanksTab />)
    await screen.findByText('シルバー')
    await screen.findByText(/今の人数と、動かしたときに変わる人数の見込みを読み込めませんでした/)
    expect(screen.getAllByText('未取得').length).toBe(3)
    expect(api.program).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '人数を読み直す' }))

    await waitFor(() => expect(screen.getByText('360 人')).toBeTruthy())
    expect(screen.getByText('780 人')).toBeTruthy()
    expect(screen.getByText('144 人')).toBeTruthy()
    expect(screen.queryByText(/今の人数と、動かしたときに変わる人数の見込みを読み込めませんでした/)).toBeNull()
    // プログラム本体は読み直さず、preview だけを再取得する
    expect(api.program).toHaveBeenCalledTimes(1)
    expect(api.preview).toHaveBeenCalledTimes(2)
  })

  it('動かす確認窓でも preview 失敗を伝え、窓の中から「人数を読み直す」で段ごとの人数と変動見込みを復旧できる', async () => {
    api.preview
      .mockResolvedValueOnce({ success: false, error: 'preview unavailable' })
      .mockResolvedValueOnce({ success: true, data: PREVIEW })

    render(<RanksTab />)
    await screen.findByText('シルバー')
    await screen.findByText(/今の人数と、動かしたときに変わる人数の見込みを読み込めませんでした/)

    fireEvent.click(screen.getByRole('button', { name: '動かす' }))
    const dialog = await screen.findByRole('dialog', { name: '会員ランクを動かしますか？' })
    expect(within(dialog).getByText(/段ごとの人数と、上がる人・下がる人の見込みを読み込めませんでした/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '人数を読み直す' }))

    await waitFor(() => expect(within(dialog).getByText('360 人')).toBeTruthy())
    expect(within(dialog).getByText('上がる人 504 人・下がる人 12 人')).toBeTruthy()
    expect(within(dialog).queryByText(/見込みを読み込めませんでした/)).toBeNull()
  })

  it('人数を読み直すの二重押しを防ぎ、再試行中にアカウントを切り替えた後の古い応答を破棄する', async () => {
    let finishOldPreview!: (value: unknown) => void
    let retryAttempted = false
    api.program.mockImplementation(async (id: string) => ({
      success: true,
      data: id === 'acc-2'
        ? { ...PROGRAM, tiers: PROGRAM.tiers.map((t) => ({ ...t, name: `別店${t.name}` })) }
        : PROGRAM,
    }))
    api.preview.mockImplementation((id: string) => {
      if (id === 'acc-2') {
        return Promise.resolve({
          success: true,
          data: {
            byTier: [
              { tierId: 't1', name: '別店ブロンズ', count: 55 },
              { tierId: 't2', name: '別店シルバー', count: 22 },
              { tierId: 't3', name: '別店ゴールド', count: 9 },
            ],
            wouldUpgrade: 31,
            wouldDowngrade: 1,
          },
        })
      }
      if (!retryAttempted) {
        retryAttempted = true
        return Promise.reject(new Error('first preview failed'))
      }
      return new Promise((resolve) => { finishOldPreview = resolve })
    })

    const view = render(<RanksTab />)
    await screen.findByText('シルバー')
    const retryBtn = await screen.findByRole('button', { name: '人数を読み直す' })

    const callsBefore = api.preview.mock.calls.length
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(api.preview.mock.calls.length).toBe(callsBefore + 1)

    account.selectedAccountId = 'acc-2'
    account.selectedAccount = { id: 'acc-2', name: '別店' }
    account.accounts = [{ id: 'acc-2', name: '別店' }]
    view.rerender(<RanksTab />)

    await screen.findByText('別店シルバー')
    await waitFor(() => expect(screen.getByText('22 人')).toBeTruthy())

    await act(async () => {
      finishOldPreview({
        success: true,
        data: {
          byTier: [
            { tierId: 't1', name: 'ブロンズ', count: 9999 },
            { tierId: 't2', name: 'シルバー', count: 8888 },
            { tierId: 't3', name: 'ゴールド', count: 7777 },
          ],
          wouldUpgrade: 999,
          wouldDowngrade: 0,
        },
      })
      await Promise.resolve()
    })

    expect(screen.getByText('22 人')).toBeTruthy()
    expect(screen.queryByText('8,888 人')).toBeNull()
  })

  it('アカウント未選択のときは読み込み中のまま固まらず、選択を促す案内を出す', async () => {
    account.selectedAccountId = null
    account.selectedAccount = null
    render(<RanksTab />)
    await screen.findByText('LINEアカウントを選択してください')
    expect(api.program).not.toHaveBeenCalled()
  })
})
