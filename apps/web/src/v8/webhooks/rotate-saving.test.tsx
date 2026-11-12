// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const update = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())
const reload = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', accounts: [] }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffIdentity: () => null, useStaffRole: () => 'owner' }))
vi.mock('./shell', async importOriginal => {
  const actual = await importOriginal<typeof import('./shell')>()
  const deliverySummary = { total: 0, failed: 0, pending: 0, lastResult: null, canRetry: false }
  return { ...actual, useWebhookOverview: () => ({
    incoming: [{ id: 'in-1', name: '申込フォーム', confirmationRevision: 2, hasSecret: true, isActive: true }], incomingStatus: 'ready',
    outgoing: [{ id: 'out-1', name: '予約台帳', confirmationRevision: 3, url: 'https://example.test', hasSecret: true, isActive: true, eventTypes: ['booking_created'], deliverySummary }], outgoingStatus: 'ready',
    loadedAccountId: 'a', reload, summary: null,
  }) }
})
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    webhooks: { ...actual.api.webhooks,
      incoming: { ...actual.api.webhooks.incoming, update, delete: remove, list,
        detail: async () => ({ success: true, data: { id: 'in-1', name: '申込フォーム', confirmationRevision: 2, version: 1, identityMatching: { methods: [] }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0 } }),
        unmatched: async () => ({ success: true, data: [] }),
      },
      outgoing: { ...actual.api.webhooks.outgoing, update },
    },
  } }
})
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
beforeEach(() => { verifiedStaffRole('owner'); update.mockReset(); remove.mockReset(); reload.mockReset().mockResolvedValue(undefined); list.mockReset().mockResolvedValue({success:true,data:[{id:'in-1',name:'新しい受け取り口',confirmationRevision:3}]}) })
import Incoming from './incoming'
import Outgoing from './outgoing'
afterEach(cleanup)
it.each(['incoming', 'outgoing'] as const)('%sの合言葉の保存中は×・キャンセル・Escを止める', async kind => {
  let resolve!: (value: unknown) => void
  update.mockReset().mockImplementation(() => new Promise(r => { resolve = r }))
  render(kind === 'incoming' ? <Incoming /> : <Outgoing />)
  await act(async () => {})
  if (kind === 'incoming') fireEvent.click(screen.getByRole('button', { name: '合言葉を更新する' }))
  else {
    fireEvent.click(screen.getByRole('button', { name: '「予約台帳」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '鍵を作り直す' }))
  }
  fireEvent.change(screen.getByPlaceholderText('ランダムな英数字32文字以上'), { target: { value: 'x'.repeat(40) } })
  fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith(kind === 'incoming' ? 'in-1' : 'out-1', 'a', expect.objectContaining({ expectedConfirmationRevision: kind === 'incoming' ? 2 : 3 }), undefined)
  expect(screen.getByRole('button', { name: '閉じる' }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => resolve({ success: true }))
})
it('送信先の新しい鍵を編集中は画面移動前に確認する', async () => {
  window.history.replaceState(null, '', '/webhooks')
  render(<><Outgoing /><a href="/events">イベントへ</a></>)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '「予約台帳」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '鍵を作り直す' }))
  fireEvent.change(screen.getByLabelText('新しい鍵'), { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('受け取り口の合言葉は競合後に対象と版を読み直し、もう一度確認する', async () => {
  const { ApiError } = await import('@/lib/api')
  update.mockRejectedValueOnce(new ApiError(409, '確認した内容が変わりました')).mockResolvedValueOnce({success:true})
  render(<Incoming />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', {name:'合言葉を更新する'}))
  fireEvent.change(screen.getByLabelText('新しい合言葉'), {target:{value:'x'.repeat(40)}})
  fireEvent.click(screen.getByRole('button', {name:'保存する',exact:true}))
  expect(await screen.findByText(/確認した内容が変わりました/)).toBeTruthy()
  expect(list).toHaveBeenCalledWith('a')
  expect(reload).toHaveBeenCalled()
  expect(screen.getByRole('dialog').textContent).toContain('新しい受け取り口')
  fireEvent.click(screen.getByRole('button', {name:'保存する',exact:true}))
  await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith('in-1','a',expect.objectContaining({expectedConfirmationRevision:3}),undefined))
})

it('受け取り口の競合後は最新の対象と版で再試行できる', async () => {
  const { ApiError } = await import('@/lib/api')
  remove.mockRejectedValueOnce(new ApiError(409, '確認した内容が変わりました')).mockResolvedValueOnce({success:true})
  render(<Incoming />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', {name:'この受け取り口を削除する'}))
  fireEvent.click(screen.getByRole('button', {name:'削除する',exact:true}))
  expect(await screen.findByText(/確認した内容が変わりました/)).toBeTruthy()
  expect(screen.getByRole('alertdialog').textContent).toContain('新しい受け取り口')
  fireEvent.click(screen.getByRole('button', {name:'削除する',exact:true}))
  await vi.waitFor(() => expect(remove).toHaveBeenLastCalledWith('in-1','a',3))
})

it('競合後に読み直せなければ古い確認で再実行しない', async () => {
  const { ApiError } = await import('@/lib/api')
  update.mockRejectedValueOnce(new ApiError(409, '確認した内容が変わりました'))
  list.mockRejectedValueOnce(new Error('offline'))
  render(<Incoming />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', {name:'合言葉を更新する'}))
  fireEvent.change(screen.getByLabelText('新しい合言葉'), {target:{value:'x'.repeat(40)}})
  fireEvent.click(screen.getByRole('button', {name:'保存する',exact:true}))
  expect(await screen.findByText(/読み直せませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', {name:'保存する',exact:true}))
  expect(update).toHaveBeenCalledTimes(1)
})
