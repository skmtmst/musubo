// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }) }))
const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/friends' }))
import { AccountProvider, useAccount } from './account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
function Editor({ busy = false }: { busy?: boolean }) {
  const account = useAccount()
  const guard = useUnsavedGuard({ dirty: true, busy })
  return <>
    <p>選択:{account.selectedAccountId ?? 'なし'}</p>
    <button onClick={() => account.setSelectedAccountId('b')}>切り替える</button>
    <button onClick={account.clearSelectedAccountId}>解除する</button>
    {guard.leaveTarget && <div role="dialog"><button onClick={guard.cancelLeave}>残る</button><button onClick={guard.confirmLeave}>移る</button></div>}
  </>
}
const storage = new Map<string, string>()
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
  document.documentElement.dataset.theme = 'v8'; storage.clear()
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })
it('書きかけのアカウント切替を確認まで止め、キャンセルで元の画面を保つ', async () => {
  render(<AccountProvider><Editor /></AccountProvider>)
  fireEvent.click(screen.getByText('切り替える'))
  expect(screen.getByText('選択:なし')).toBeTruthy()
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByText('残る'))
  expect(screen.getByText('選択:なし')).toBeTruthy()
})
it('離脱を確認したときだけアカウントを切り替え、解除も同じ確認を通す', async () => {
  render(<AccountProvider><Editor /></AccountProvider>)
  fireEvent.click(screen.getByText('切り替える'))
  fireEvent.click(screen.getByText('移る'))
  expect(screen.getByText('選択:b')).toBeTruthy()
})
it('保存中のアカウント切替は確認も変更も起こさない', () => {
  render(<AccountProvider><Editor busy /></AccountProvider>)
  fireEvent.click(screen.getByText('切り替える'))
  expect(screen.getByText('選択:なし')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})
