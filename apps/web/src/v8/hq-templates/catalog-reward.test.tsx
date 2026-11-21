// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ list: vi.fn(), accounts: vi.fn(), preflight: vi.fn(), distribute: vi.fn(), result: vi.fn() }))
vi.mock('@/lib/api/helpers/hq-catalog-templates', () => ({ hqCatalogTemplatesApi: net }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: net }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', useTenantWideAccess: () => true }))
import CatalogRewards from './catalog-reward'
const store = { accountId: 'a', accountName: '本店', items: [{ sourceId: 'mileage_reward', itemKind: 'mileage_reward', name: 'お礼', duplicate: false, allowedModes: ['create'] }], warnings: [] }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-19T00:00:00Z'))
  net.list.mockResolvedValue({ data: [{ id: 'reward', name: 'お礼' }] }); net.accounts.mockResolvedValue([{ id: 'a', name: '本店' }])
  net.preflight.mockResolvedValue({ data: { preflightId: 'p', expiresAt: '2026-11-19T00:30:00Z', stores: [store] } })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })
async function prepare() {
  render(<CatalogRewards />)
  fireEvent.click(await screen.findByRole('button', { name: '配る' }))
  const dialog = screen.getByRole('dialog', { name: '景品を配る先を選ぶ' })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '本店' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '配る先を確かめる' }))
  return screen.findByRole('dialog', { name: '景品を配る前に確かめる' })
}
it('景品の確認から30分たつと配らず、同じ送り先を確かめ直す', async () => {
  const dialog = await prepare()
  vi.setSystemTime(new Date('2026-11-19T00:30:00Z'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で配る' }))
  const expired = await screen.findByRole('dialog', { name: '確かめの期限が切れました' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(expired.querySelector('[data-tone="caution"]')).not.toBeNull()
  expect(expired.querySelector('.lucide-triangle-alert')).toBeNull()
  expect(expired.querySelector('[data-dialog-content]')).toBeNull()
  expect(net.distribute).not.toHaveBeenCalled()
  fireEvent.click(within(expired).getByRole('button', { name: 'もう一度確かめる' }))
  await waitFor(() => expect(net.preflight).toHaveBeenCalledTimes(2))
  expect(net.preflight).toHaveBeenLastCalledWith('reward', ['a'])
  expect(net.distribute).not.toHaveBeenCalled()
})
it('期限内は確認した番号と送り先で配る', async () => {
  net.distribute.mockResolvedValue({ data: { runId: 'p', status: 'completed', stores: [{ accountId: 'a', status: 'succeeded' }] } })
  const dialog = await prepare()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で配る' }))
  await waitFor(() => expect(net.distribute).toHaveBeenCalledWith('reward', 'p', [{ accountId: 'a', sourceId: 'mileage_reward', mode: 'create' }]))
})

it('サーバーが期限切れで断ったら結果不明にせず、確認をやり直す', async () => {
  const { ApiError } = await import('@/lib/api')
  net.distribute.mockRejectedValue(new ApiError(409, undefined, 'PREFLIGHT_EXPIRED'))
  const dialog = await prepare()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で配る' }))
  const expired = await screen.findByRole('dialog', { name: '確かめの期限が切れました' })
  expect(net.result).not.toHaveBeenCalled()
  fireEvent.click(within(expired).getByRole('button', { name: 'もう一度確かめる' }))
  await waitFor(() => expect(net.preflight).toHaveBeenCalledTimes(2))
})
it('通信失敗の結果が不明なときは再配布せず結果だけ確認する', async () => {
  net.distribute.mockRejectedValue(new Error('network'))
  net.result.mockRejectedValue(new Error('network'))
  const dialog = await prepare()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で配る' }))
  fireEvent.click(await within(dialog).findByRole('button', { name: '結果を確認' }))
  await waitFor(() => expect(net.result).toHaveBeenCalledTimes(2))
  expect(net.distribute).toHaveBeenCalledTimes(1)
})
it('確かめの送り先が選んだ店と異なると配らない', async () => {
  net.preflight.mockResolvedValue({ data: { preflightId: 'p', expiresAt: '2026-11-19T00:30:00Z', stores: [{ ...store, accountId: 'other' }] } })
  await prepare().catch(() => undefined)
  expect(net.distribute).not.toHaveBeenCalled()
  expect(await screen.findByText('確かめに失敗しました。もう一度確かめてください。')).toBeTruthy()
})
it('サーバーの店ごとの期限切れ結果でも確認をやり直せる', async () => {
  net.distribute.mockResolvedValue({ data: { runId: 'p', status: 'failed', stores: [{ accountId: 'a', status: 'version_conflict', reason: '確かめの期限が切れました。もう一度確かめてください' }] } })
  const dialog = await prepare()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で配る' }))
  expect(await screen.findByRole('dialog', { name: '確かめの期限が切れました' })).toBeTruthy()
})
it('重複する景品は配り方を選ぶまで配らない', async () => {
  net.preflight.mockResolvedValue({ data: { preflightId: 'p', expiresAt: '2026-11-19T00:30:00Z', stores: [{ ...store, items: [{ ...store.items[0], duplicate: true, allowedModes: ['overwrite', 'alias'] }] }] } })
  const dialog = await prepare()
  const button = within(dialog).getByRole('button', { name: 'この内容で配る' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(net.distribute).not.toHaveBeenCalled()
})
