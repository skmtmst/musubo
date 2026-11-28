// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UNSAVED_ACTION_EVENT } from '@/lib/unsaved-action'

const net = vi.hoisted(() => ({ list: vi.fn(), latestRun: vi.fn(), setStatus: vi.fn(), run: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'a', name: '本店' }] })) }))
vi.mock('@/lib/api', () => ({ api: { analytics: { v6Funnels: net } } }))
vi.mock('./parts', () => ({ RANGES: [{days:30,label:'過去30日'}], downloadCsv: vi.fn(), formatAnalyticsDate: vi.fn(), formatAnalyticsDateTime: vi.fn(), rangeFor: vi.fn(() => ({ from: '2026-11-01' })), useRegisterExport: vi.fn() }))
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

it('閲覧のみは削除と再集計の理由を見られ、操作を送れない', async () => {
  const { verifiedStaffRole } = await import('@/test-utils/verified-staff-role')
  verifiedStaffRole('viewer')
  try {
    render(<FunnelV8 accountId="a" canManage={false} />)
    fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
    for (const name of ['削除する', 'この30日を再集計', '定義を編集', '停止']) {
      const button = screen.getByRole('button', { name, exact: true })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(button)
    }
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.setStatus).not.toHaveBeenCalled()
    expect(net.run).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('閲覧のみのため変更できません')
  } finally { verifiedStaffRole(null) }
})

it('閲覧のみの空一覧に作成できない理由を出す', async () => {
  const { verifiedStaffRole } = await import('@/test-utils/verified-staff-role')
  verifiedStaffRole('viewer')
  net.list.mockResolvedValue({ success: true, data: [] })
  const renderForm = vi.fn(() => <div>作成フォーム</div>)
  try {
    render(<FunnelV8 accountId="a" canManage={false} renderForm={renderForm} />)
    const button = await screen.findByRole('button', { name: 'ファネルを作る' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(renderForm).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('閲覧のみのため変更できません')
  } finally { verifiedStaffRole(null) }
})

it('確認中に権限が外れると以前の確定操作を送らない', async () => {
  const view = render(<FunnelV8 accountId="a" canManage />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '削除する', exact: true }))
  view.rerender(<FunnelV8 accountId="a" canManage={false} />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  view.rerender(<FunnelV8 accountId="a" canManage />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(net.setStatus).not.toHaveBeenCalled()
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


it('運用担当スタッフは詳細欄から再集計できる', async () => {
  net.run.mockReset().mockResolvedValue({ success: true, data: { runId: 'r1', state: 'available', groups: [], cohortFrom: '2026-01-01', cohortTo: '2026-01-02', dataCutoffAt: '2026-01-02' } })
  render(<FunnelV8 accountId="a" canManage={false} canRun />)
  fireEvent.click(await screen.findByText('定義の操作と集計の詳細', { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'この30日を再集計' }))
  await waitFor(() => expect(net.run).toHaveBeenCalledTimes(1))
})

it('閲覧のみには対象者作成と結果保存も理由付きで出す', async () => {
  const { verifiedStaffRole } = await import('@/test-utils/verified-staff-role')
  verifiedStaffRole('viewer')
  net.latestRun.mockResolvedValue({ success: true, data: { runId: 'r1', state: 'available', cohortFrom: '2026-01-01', cohortTo: '2026-01-02', dataCutoffAt: '2026-01-02', groups: [{ key: 'all', label: '全員', entrants: 10, completed: 5, steps: [{ stepOrder: 1, label: '入口', reached: 10, droppedAfter: 5, inProgressAfter: 0, conversionFromPrevious: null }, { stepOrder: 2, label: '完了', reached: 5, droppedAfter: 0, inProgressAfter: 0, conversionFromPrevious: 0.5 }] }] } })
  const renderSave = vi.fn(() => <div>保存欄</div>)
  try {
    render(<FunnelV8 accountId="a" canManage={false} renderSave={renderSave} />)
    for (const name of ['対象者を開く', 'この対象者へ配信を作る', 'この結果を保存する']) {
      const button = await screen.findByRole('button', { name })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(button)
    }
    expect(renderSave).not.toHaveBeenCalled()
  } finally { verifiedStaffRole(null) }
})

it('閲覧のみには停止中ファネルの再開を理由付きで出す', async () => {
  const { verifiedStaffRole } = await import('@/test-utils/verified-staff-role')
  verifiedStaffRole('viewer')
  net.list.mockResolvedValue({ success: true, data: [{ ...funnel, status: 'stopped' }] })
  try {
    render(<FunnelV8 accountId="a" canManage={false} />)
    const button = await screen.findByRole('button', { name: '再開' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.setStatus).not.toHaveBeenCalled()
  } finally { verifiedStaffRole(null) }
})
