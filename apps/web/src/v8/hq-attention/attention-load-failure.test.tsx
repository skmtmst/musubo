// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  push: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
  attention: vi.fn(),
  accounts: [{ id: 'account-a', name: '本店' }],
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: fixture.accounts, selectedAccountId: null, setSelectedAccountId: fixture.select }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: fixture.toast }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention: fixture.attention } }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: { lineAccountFolders: { list: async () => ({ success: true, data: { folders: [] } }) } },
}))

import AttentionPage from '@/app/hq/attention/page'

beforeEach(() => {
  fixture.push.mockReset()
  fixture.select.mockReset()
  fixture.toast.mockReset()
  fixture.attention.mockReset()
})

afterEach(cleanup)

describe('統括「対応が要るもの」の読み込み失敗時KPI表示と再読み込み', () => {
  it('取得失敗時にKPI帯を読み込み中のままや「0 アカウント」にせず、再読み込みで復旧できる', async () => {
    fixture.attention
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        success: true,
        data: {
          items: [{ accountId: 'account-a', name: '本店', counts: { connections: 1, unhandledChats: 2 }, details: {} }],
        },
      })

    render(<AttentionPage />)

    await screen.findByRole('alert')
    const statsRegion = document.querySelector<HTMLElement>('[data-template-region="stats"]')!
    expect(statsRegion).toBeTruthy()
    expect(statsRegion.querySelectorAll('[aria-busy="true"]')).toHaveLength(0)
    expect(within(statsRegion).queryByText('0 アカウント')).toBeNull()
    expect(within(statsRegion).getAllByText('読み込めませんでした')).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))

    expect(await screen.findByRole('button', { name: '本店の接続の異常 1件を開く' })).toBeTruthy()
    await waitFor(() => expect(fixture.attention).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(statsRegion).queryByText('読み込めませんでした')).toBeNull()
  })
})
