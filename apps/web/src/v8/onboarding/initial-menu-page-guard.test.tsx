// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-a' as string | null,
  role: 'owner' as string | null,
  push: vi.fn(),
  replace: vi.fn(),
  starterSet: vi.fn(),
  save: vi.fn(),
  accountStyleUpdated: vi.fn(),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/components/shared/list-navigation', () => ({
  useListNavigationRouter: () => ({ push: fx.push, replace: fx.replace }),
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fx.accountId, accounts: [], loading: false }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => fx.role,
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))
vi.mock('@/hooks/use-account-style', () => ({
  useAccountStyle: () => ({
    status: 'ready',
    stale: false,
    error: null,
    reload: vi.fn(),
    data: { style: 'standard', styleSelected: true, version: 3 },
  }),
  accountStyleUpdated: fx.accountStyleUpdated,
}))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: {
    starterSet: fx.starterSet,
    save: fx.save,
  },
}))
vi.mock('./initial-menu-choice', () => ({
  InitialMenuChoice: () => React.createElement('div', null, 'choice-mock'),
  InitialMenuPhone: () => React.createElement('div', null, 'phone-mock'),
}))

import InitialMenuPage from './initial-menu-page'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('InitialMenuPage 保存中のアカウント切替・二重送信・不正定義防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.accountId = 'acc-a'
    fx.role = 'owner'
    fx.starterSet.mockResolvedValue({ success: true, data: { definition: { items: [{ kind: 'rich_menu', key: 'rm-1' }] } } })
    fx.save.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('保存途中でアカウントを切り替えたら旧アカウントの保存を続行・遷移させず、新アカウントで保存ボタンが押せる', async () => {
    const firstStarter = deferred<unknown>()
    fx.starterSet.mockReturnValueOnce(firstStarter.promise)

    const view = render(<InitialMenuPage />)
    const submitBtn = screen.getByRole('button', { name: 'このメニューで進む' })
    fireEvent.click(submitBtn)
    fireEvent.click(submitBtn)
    expect(fx.starterSet).toHaveBeenCalledTimes(1)

    fx.accountId = 'acc-b'
    view.rerender(<InitialMenuPage />)

    await act(async () => {
      firstStarter.resolve({ success: true, data: { definition: { items: [{ kind: 'rich_menu', key: 'rm-1' }] } } })
    })
    expect(fx.save).not.toHaveBeenCalled()
    expect(fx.push).not.toHaveBeenCalled()

    const submitBtnB = screen.getByRole('button', { name: 'このメニューで進む' }) as HTMLButtonElement
    expect(submitBtnB.disabled).toBe(false)
    fireEvent.click(submitBtnB)
    await waitFor(() => expect(fx.save).toHaveBeenCalledWith('acc-b', expect.anything()))
  })

  it('starterSet の定義 items が欠損した不正応答でも落ちずにエラー表示する', async () => {
    fx.starterSet.mockResolvedValueOnce({ success: true, data: { definition: null } })
    render(<InitialMenuPage />)
    fireEvent.click(screen.getByRole('button', { name: 'このメニューで進む' }))
    expect(await screen.findByText(/メニューを確認できませんでした/)).toBeTruthy()
    expect(fx.save).not.toHaveBeenCalled()
  })
})
