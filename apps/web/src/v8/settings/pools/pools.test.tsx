// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const removeAccount = vi.hoisted(() => vi.fn())
const poolAccounts = vi.hoisted(() => vi.fn())
const deletePool = vi.hoisted(() => vi.fn())

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/pools-availability', () => ({ isPoolsFeatureAvailable: () => true }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      pools: {
        ...actual.api.pools,
        list: async () => ({ success: true, data: [{ id: 'p1', name: '既定', slug: 'main', isMain: true, confirmationRevision: 1 }, { id: 'p2', name: '渋谷', slug: 'shibuya', confirmationRevision: 4 }] }),
        delete: deletePool,
        accounts: { list: poolAccounts, remove: removeAccount },
      },
      lineAccounts: { ...actual.api.lineAccounts, list: async () => ({ success: true, data: [{ id: 'acc-1', name: '本店' }, { id: 'acc-2', name: '渋谷店' }] }) },
    },
  }
})
import PoolsV8 from './pools'

beforeEach(() => {
  poolAccounts.mockReset().mockImplementation(async (poolId: string) => ({ success: true, data: poolId === 'p2' ? [{ id: 'member-2', lineAccountId: 'acc-1' }, { id: 'member-3', lineAccountId: 'acc-2' }] : [{ id: 'member-1', lineAccountId: 'acc-1' }] }))
  deletePool.mockReset().mockResolvedValue({ success: true })
})
afterEach(cleanup)

// 決まり2: 外した時の説明は帯にせず、題の横の「？」へ入れる。
it('プールから外れた時の説明は帯に出さず題の「？」に入れる', async () => {
  render(<PoolsV8 />)
  await screen.findByText('既定')
  expect(screen.queryByText(/振り分けられなくなります/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
  expect(await screen.findByText(/振り分けられなくなります/)).toBeTruthy()
})

it('所属から外す確認には対象のアカウントと環境を出す', async () => {
  render(<PoolsV8 />)
  fireEvent.click((await screen.findAllByRole('button', { name: '外す' }))[0])
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('本店')
  expect(dialog.textContent).toContain('環境')
})

it('所属から外す窓を再表示した後は古い確定を受け付けない', async () => {
  removeAccount.mockClear(); removeAccount.mockResolvedValue({ success: true })
  render(<PoolsV8 />)
  fireEvent.click((await screen.findAllByRole('button', { name: '外す' }))[0])
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: '外す' })
  const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getAllByRole('button', { name: '外す' })[0])
  await act(async () => { oldClick() })
  expect(removeAccount).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '外す' }))
  expect(removeAccount).toHaveBeenCalledWith('p1', 'member-1')
})

it('プール削除の確認には所属するすべてのアカウントと件数を出す', async () => {
  render(<PoolsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '渋谷の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  await waitFor(() => expect(dialog.textContent).toContain('渋谷店'))
  expect(dialog.textContent).toContain('本店')
  expect(dialog.textContent).toContain('2件')
  expect(dialog.textContent).toContain('環境')
})

it('所属が確認できないプールは削除できない', async () => {
  render(<PoolsV8 />)
  const menu = await screen.findByRole('button', { name: '渋谷の操作' })
  await screen.findByText('渋谷店')
  poolAccounts.mockImplementation(async (poolId: string) => poolId === 'p2' ? { success: false, error: 'offline' } : { success: true, data: [] })
  fireEvent.click(menu); fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  await waitFor(() => expect(dialog.textContent).toContain('所属アカウントを確認できませんでした'))
  expect((within(dialog).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true)
  expect(deletePool).not.toHaveBeenCalled()
})

it('確認後に所属が変わったプールは削除しない', async () => {
  render(<PoolsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '渋谷の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  await waitFor(() => expect(dialog.textContent).toContain('2件'))
  poolAccounts.mockResolvedValue({ success: true, data: [{ id: 'member-2', lineAccountId: 'acc-1' }] })
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(dialog.textContent).toContain('所属アカウントが変わりました'))
  expect(deletePool).not.toHaveBeenCalled()
})

it('確定時に所属を読み直せなければ確認し直すまで削除できない', async () => {
  render(<PoolsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '渋谷の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  await waitFor(() => expect(dialog.textContent).toContain('2件'))
  poolAccounts.mockRejectedValue(new Error('offline'))
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(dialog.textContent).toContain('所属アカウントを確認できませんでした'))
  expect((within(dialog).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true)
  expect(deletePool).not.toHaveBeenCalled()
})

it('所属が変わっていないプールは確認後に一度だけ削除する', async () => {
  render(<PoolsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '渋谷の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  await waitFor(() => expect(dialog.textContent).toContain('2件'))
  const button = within(dialog).getByRole('button', { name: '削除する' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(deletePool).toHaveBeenCalledTimes(1))
  expect(deletePool).toHaveBeenCalledWith('p2', { revision: 4, accountIds: ['acc-1', 'acc-2'] })
})

it('プール削除の再表示では別の確定口を受け付けない', async () => {
  render(<PoolsV8 />)
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: '渋谷の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() => expect(dialog.textContent).toContain('2件'))
    return dialog
  }
  let dialog = await open()
  const button = within(dialog).getByRole('button', { name: '削除する' })
  const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  dialog = await open()
  const reads = poolAccounts.mock.calls.length
  await act(async () => { oldClick() })
  expect(poolAccounts).toHaveBeenCalledTimes(reads)
  expect(deletePool).not.toHaveBeenCalled()
  expect(within(dialog).getByRole('button', { name: '削除する' })).toBeTruthy()
})
