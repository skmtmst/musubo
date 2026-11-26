// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  rules: vi.fn(),
  sends: vi.fn(),
  save: vi.fn(),
  enableMock: vi.fn(),
  test: vi.fn(),
}))
vi.mock('@/lib/api/helpers/gap3', () => ({ ecAutoLineApi: api }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ec-commerce',
  useSearchParams: () => new URLSearchParams(),
}))

const { default: EcAutoLine } = await import('./auto-line')

const RULES = [
  { kind: 'cart', enabled: true, waitMinutes: 60, messages: [{ type: 'text', text: '{{name}} さま' }], version: 3, testMode: true },
  { kind: 'browse', enabled: false, waitMinutes: 1440, messages: [], version: 1, testMode: true },
  { kind: 'restock', enabled: true, waitMinutes: 0, messages: [], version: 2, testMode: true },
]

beforeEach(() => {
  api.rules.mockResolvedValue({ success: true, data: RULES })
  api.save.mockResolvedValue({ success: true, data: RULES[0] })
  api.enableMock.mockResolvedValue({ success: true, data: RULES[1] })
  api.test.mockResolvedValue({ success: true, data: { preview: RULES[0], sent: false, testMode: true } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('自動の LINE の送った件数の取得失敗と再試行', () => {
  it('送った件数の取得に失敗しても設定の表は使えるまま、警告と「件数を読み直す」から回復できる', async () => {
    api.sends.mockImplementation(async (_account: string, kind: string) => {
      if (kind === 'browse') throw new Error('sends down')
      return { success: true, data: { items: [], total: kind === 'cart' ? 214 : 96 } }
    })

    render(<EcAutoLine accountId="acc-1" canEdit />)
    await screen.findByText('カゴ落ち')
    expect(await screen.findByText(/送った件数の一部を読み込めませんでした/)).toBeTruthy()
    expect(screen.getByText('214 件')).toBeTruthy()
    expect(screen.getByText('96 件')).toBeTruthy()

    const retryButton = screen.getByRole('button', { name: '件数を読み直す' })
    let releaseRetry!: () => void
    api.sends.mockImplementation(
      (_account: string, kind: string) =>
        new Promise((resolve) => {
          const done = () => resolve({ success: true, data: { items: [], total: kind === 'cart' ? 214 : kind === 'browse' ? 18 : 96 } })
          if (kind === 'browse') releaseRetry = done
          else done()
        }),
    )

    fireEvent.click(retryButton)
    await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(true))
    const callsDuringRetry = api.sends.mock.calls.length
    fireEvent.click(retryButton)
    expect(api.sends.mock.calls.length).toBe(callsDuringRetry)

    await act(async () => { releaseRetry() })
    await waitFor(() => expect(screen.getByText('18 件')).toBeTruthy())
    expect(screen.queryByText(/送った件数の一部を読み込めませんでした/)).toBeNull()
  })

  it('アカウントを切り替えた後に古い送った件数の返答が届いても上書きしない', async () => {
    let resolveOld!: (value: { success: true; data: { items: unknown[]; total: number } }) => void
    api.sends.mockImplementation((account: string) => {
      if (account === 'acc-1') {
        return new Promise((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve({ success: true, data: { items: [], total: 5 } })
    })

    const view = render(<EcAutoLine accountId="acc-1" canEdit />)
    await screen.findByText('カゴ落ち')

    view.rerender(<EcAutoLine accountId="acc-2" canEdit />)
    await waitFor(() => expect(screen.getAllByText('5 件').length).toBe(3))

    await act(async () => {
      resolveOld({ success: true, data: { items: [], total: 999 } })
    })
    expect(screen.queryByText('999 件')).toBeNull()
    expect(screen.getAllByText('5 件').length).toBe(3)
  })
})
