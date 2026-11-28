// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ target: vi.fn(), sync: vi.fn() }))
const fixture = vi.hoisted(() => ({ account: 'a' }))
const saveErrors = vi.hoisted(() => ({ capture: () => false }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: { id: fixture.account, name: '本店' }, accounts: [] }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/shared/save-form-errors', () => ({ useSaveFormErrors: () => saveErrors }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('./shell', () => ({ useWebhookOverview: () => ({}) }))
vi.mock('@/lib/api', () => ({ api: { webhooks: { googleSheets: { connection: () => new Promise(() => {}), runs: () => new Promise(() => {}), setTarget: calls.target, sync: calls.sync } } } }))
import { useSheets } from './use-sheets'
function Screen() {
  const sheets = useSheets()
  return <><p role="status">{sheets.busy ?? '待機中'}</p><form onSubmit={sheets.handleSaveTarget} aria-label="出力先"><button type="submit">保存</button></form><button onClick={() => void sheets.handleSync()}>同期</button></>
}
beforeEach(() => { fixture.account = 'a'; vi.resetAllMocks(); calls.target.mockReturnValue(new Promise(() => {})); calls.sync.mockReturnValue(new Promise(() => {})) })
afterEach(cleanup)
it('出力先の保存が処理中に重なっても一度だけ送る', () => {
  render(<Screen />)
  const form = screen.getByRole('form', { name: '出力先' })
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(calls.target).toHaveBeenCalledTimes(1)
})
it('手動同期が処理中に重なっても一度だけ送る', () => {
  render(<Screen />)
  const button = screen.getByRole('button', { name: '同期' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(calls.sync).toHaveBeenCalledTimes(1)
})
it('保存が失敗したら同じ操作をやり直せる', async () => {
  calls.target.mockRejectedValueOnce(new Error('offline'))
  render(<Screen />)
  const form = screen.getByRole('form', { name: '出力先' })
  await act(async () => { fireEvent.submit(form) })
  fireEvent.submit(form)
  expect(calls.target).toHaveBeenCalledTimes(2)
})
it('別のアカウントでは操作でき、元に戻ると処理中の表示と守りが戻る', () => {
  const view = render(<Screen />)
  fireEvent.submit(screen.getByRole('form', { name: '出力先' }))
  fixture.account = 'b'; view.rerender(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '同期' }))
  expect(calls.sync).toHaveBeenCalledWith('b')
  fixture.account = 'a'; view.rerender(<Screen />)
  expect(screen.getByRole('status').textContent).toBe('target')
  fireEvent.submit(screen.getByRole('form', { name: '出力先' }))
  expect(calls.target).toHaveBeenCalledTimes(1)
})
