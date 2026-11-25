// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import RegisterV8 from './register'
import { DRAFT_KEY } from './logic'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const calls = vi.hoisted(() => ({ me: vi.fn(), connect: vi.fn(), connectCheck: vi.fn(), stepFollowerImport: vi.fn(), getStyle: vi.fn(), saveStyle: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: calls.getStyle, save: calls.saveStyle } }))
vi.mock('@/lib/api', () => ({ api: { staff: { me: calls.me }, lineAccounts: { connect: calls.connect, connectCheck: calls.connectCheck, stepFollowerImport: calls.stepFollowerImport } } }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/step-up-prompt', () => ({ default: () => null, isStepUpRequired: () => false }))
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks() })

it.each([
  { role: 'owner', readOnly: true },
  { role: 'owner', readOnly: false, roleBundle: 'view_only' },
  { role: 'staff', readOnly: true, roleBundle: 'view_only' },
  { role: 'admin', readOnly: true },
  { role: 'admin', readOnly: false, roleBundle: 'view_only' },
])('サーバーの権限が%jなら、保存済みの途中の段を復元せず登録操作を隠す', async identity => {
  const draft = JSON.stringify({ step: 5, sub: 1, name: '途中の下書き', channelId: '123', importFriends: true })
  localStorage.setItem(DRAFT_KEY, draft)
  // 端末の役割を書き換えても権限を広げない。
  localStorage.setItem('lh_staff_role', 'owner')
  calls.me.mockResolvedValue({ success: true, data: { id: 'reader', name: '閲覧者', ...identity } })
  const view = render(<RegisterV8 />)
  await screen.findByText('LINEアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。')
  expect(view.container.querySelector('form')).toBeNull()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  for (const name of ['次へ', '登録する', '接続を確認する']) expect(screen.queryByRole('button', { name })).toBeNull()
  expect(localStorage.getItem(DRAFT_KEY)).toBe(draft)
  expect(calls.connect).not.toHaveBeenCalled()
  expect(calls.connectCheck).not.toHaveBeenCalled()
  expect(calls.stepFollowerImport).not.toHaveBeenCalled()
  expect(calls.getStyle).not.toHaveBeenCalled()
  expect(calls.saveStyle).not.toHaveBeenCalled()
})

it('権限の取得失敗では登録フォームを起動しない', async () => {
  calls.me.mockRejectedValue(new Error('模擬の取得失敗'))
  const view = render(<RegisterV8 />)
  await waitFor(() => expect(calls.me).toHaveBeenCalledOnce())
  expect(view.container.querySelector('form')).toBeNull()
  expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
  expect(calls.connect).not.toHaveBeenCalled()
})
