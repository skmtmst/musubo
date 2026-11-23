// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const fx = vi.hoisted(() => ({ save: vi.fn(), notify: vi.fn(), close: vi.fn(), saved: vi.fn() }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: fx.notify }))
vi.mock('@/lib/api/helpers/gap1', () => ({ inboxRoutingApi: { get: async () => ({ data: { enabled: false, firstResponseMinutes: 30, businessHoursOnly: false, escalateTeamId: null, version: 1 } }), save: fx.save } }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { list: async () => ({ success: true, data: [{id:'s1',name:'担当者',isActive:true,role:'staff',readOnly:false}] }) }, notifications: { teams: { list: async () => ({ success: true, data: [] }) } } } }
})
import Drawer from './routing-drawer'
const view = (accountId = 'A') => <Drawer open accountId={accountId} onClose={fx.close} onSaved={fx.saved} />
beforeEach(() => { vi.clearAllMocks(); fx.save.mockReset().mockResolvedValue({ data: { version: 2 } }) })
afterEach(cleanup)
async function edit() {
  const result = render(view())
  fireEvent.click(await screen.findByRole('switch', { name: '返事の期限を使う' }))
  return result
}
it('保存の対象を知らせ、確定した設定を渡して閉じる', async () => {
  await edit()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true })) })
  expect(fx.notify).toHaveBeenCalledExactlyOnceWith('「割り当てと返事の期限」を保存しました')
  expect(fx.save).toHaveBeenCalledWith('A', expect.objectContaining({ expectedVersion: 1, enabled: true }))
  expect(fx.saved).toHaveBeenCalledWith({ version: 2 })
  expect(fx.close).toHaveBeenCalledOnce()
})
it('自動割り当ての方法と担当者を保存する', async () => {
  render(view())
  fireEvent.click(await screen.findByText('均等'))
  fireEvent.click(await screen.findByText('担当者'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true })) })
  expect(fx.save).toHaveBeenCalledWith('A', expect.objectContaining({strategy:'even',targets:[expect.objectContaining({staffId:'s1'})]}))
})
it('競合は入力を残す帯に表示し、成功のトーストを出さない', async () => {
  const { ApiError } = await import('@/lib/api')
  fx.save.mockRejectedValueOnce(new ApiError(409, '競合'))
  await edit()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true })) })
  expect(screen.getByRole('switch', { name: '返事の期限を使う' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/ほかの人が/)).toBeTruthy()
  expect(fx.notify).not.toHaveBeenCalled()
  expect(fx.close).not.toHaveBeenCalled()
})
it('保存中にアカウントを替えたら旧設定の結果を新画面へ出さない', async () => {
  let resolve!: (value: { data: { version: number } }) => void
  fx.save.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
  const result = await edit()
  fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
  result.rerender(view('B'))
  await act(async () => resolve({ data: { version: 2 } }))
  expect(fx.notify).not.toHaveBeenCalled()
  expect(fx.saved).not.toHaveBeenCalled()
  expect(fx.close).not.toHaveBeenCalled()
})
