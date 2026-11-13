// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UNSAVED_ACTION_EVENT } from '@/lib/unsaved-action'

const net = vi.hoisted(() => ({ list: vi.fn(), latestRun: vi.fn(), setStatus: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'a', name: '本店' }] })) }))
vi.mock('@/lib/api', () => ({ api: { analytics: { v6Funnels: net } } }))
vi.mock('./parts', () => ({ RANGES: [{days:30,label:'過去30日'}], downloadCsv: vi.fn(), formatAnalyticsDate: vi.fn(), formatAnalyticsDateTime: vi.fn(), rangeFor: vi.fn(), useRegisterExport: vi.fn() }))
import FunnelV8 from './funnel'

const funnel = { id: 'flow', name: '購入まで', status: 'active', confirmationRevision: 1, windowDays: 30, migrationState: 'ready', currentVersion: { id: 'v1', versionNumber: 1 } }
beforeEach(() => {
  net.list.mockReset().mockResolvedValue({ success: true, data: [funnel] })
  net.latestRun.mockReset().mockResolvedValue({ success: false, error: 'Not found' })
  net.setStatus.mockReset().mockResolvedValue({ success: true })
})
afterEach(cleanup)

it('削除は確認後に保管し、過去の結果を残して選ぶ一覧から外す', async () => {
  render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
  expect(net.setStatus).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  expect(await within(dialog).findByText('本店')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(dialog.textContent).toContain('過去の結果は残ります')
  net.list.mockResolvedValue({ success: true, data: [{ ...funnel, status: 'archived' }] })
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
  await waitFor(() => expect(net.setStatus).toHaveBeenCalledWith('a', 'flow', { status: 'archived', expectedStatus: 'active', expectedRevision: 1 }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(screen.getByRole('button', { name: '結果を見る' })).toBeTruthy()
})

it('競合時は確認窓と理由を残し、キャンセルでは呼ばない', async () => {
  net.setStatus.mockResolvedValue({ success: false, error: 'analytics_funnel_status_conflict' })
  render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する', exact: true }))
  await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('他の人が先に変更'))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }))
  expect(net.setStatus).toHaveBeenCalledTimes(1)
})

it('閲覧のみには削除の操作を出さない', async () => {
  render(<FunnelV8 accountId="a" canManage={false} />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  expect(screen.queryByRole('button', { name: '削除する' })).toBeNull()
})

it('定義編集や状態変更の前に未保存の画面内操作を確かめる', async () => {
  render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  const listener = vi.fn((event: Event) => event.preventDefault())
  window.addEventListener(UNSAVED_ACTION_EVENT, listener)
  try {
    fireEvent.click(screen.getByRole('button', { name: '定義を編集' }))
    fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '最新の結果をもう一度読む' }))
    fireEvent.click(screen.getByRole('button', { name: '集計する', exact: true }))
    expect(listener).toHaveBeenCalledTimes(4)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.setStatus).not.toHaveBeenCalled()
  } finally { window.removeEventListener(UNSAVED_ACTION_EVENT, listener) }
})

it('アカウントを切り替えた後の古い削除確定は送らない', async () => {
  const view = render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
  const button = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する', exact: true })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  view.rerender(<FunnelV8 accountId="b" canManage />)
  view.rerender(<FunnelV8 accountId="a" canManage />)
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button })
  expect(net.setStatus).not.toHaveBeenCalled()
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('削除が完了した後に保持した古い確定は再送しない', async () => {
  render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
  const button = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する', exact: true })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  fireEvent.click(button)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button })
  expect(net.setStatus).toHaveBeenCalledTimes(1)
})
