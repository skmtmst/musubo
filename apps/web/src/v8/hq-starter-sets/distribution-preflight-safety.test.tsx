// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ preflight: vi.fn(), distribute: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { preflight: net.preflight, distribute: net.distribute } }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: vi.fn() }))
import { useDistribute } from './use-distribute'
import { DistributionDialog } from './distribution-dialog'
function View() { const share = useDistribute('salon', 7, () => {}); return <><button onClick={() => share.setDraft({ target: 'style', accounts: [], editedAction: 'notify' })}>窓を開く</button><DistributionDialog share={share} /></> }
beforeEach(() => { net.preflight.mockReset(); net.distribute.mockReset() })
afterEach(cleanup)
it('事前確認のトークンが欠けているときは配る操作を許さない', async () => {
  net.preflight.mockResolvedValue({ success: true, data: { accountCount: 1, editedCount: 0 } })
  render(<View />)
  fireEvent.click(screen.getByRole('button', { name: '窓を開く' }))
  expect(await screen.findByText(/読み込み/)).toBeTruthy()
  const button = screen.getByRole('button', { name: '配る' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(net.distribute).not.toHaveBeenCalled()
})
it('配るボタンの同時連打は1回だけ送る', async () => {
  net.preflight.mockResolvedValue({ success: true, data: { token: 'fixture', accountCount: 1, editedCount: 0, accounts: [] } })
  net.distribute.mockReturnValue(new Promise(() => {}))
  render(<View />)
  fireEvent.click(screen.getByRole('button', { name: '窓を開く' }))
  const button = await screen.findByRole('button', { name: '1 アカウントへ配る' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(net.distribute).toHaveBeenCalledTimes(1)
})
it('事前確認の失敗を知らせ、同じ対象をもう一度確かめられる', async () => {
  net.preflight.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: { token: 'fixture', accountCount: 1, editedCount: 0, accounts: [] } })
  render(<View />)
  fireEvent.click(screen.getByRole('button', { name: '窓を開く' }))
  const retry = await screen.findByRole('button', { name: 'もう一度確かめる' })
  expect(screen.queryByText('配る先を確かめています…')).toBeNull()
  fireEvent.click(retry)
  expect(await screen.findByRole('button', { name: '1 アカウントへ配る' })).toBeTruthy()
  expect(net.preflight).toHaveBeenCalledTimes(2)
})
it('配布中は選択と窓を閉じる操作を止め、理由を出す', async () => {
  net.preflight.mockResolvedValue({ success: true, data: { token: 'fixture', accountCount: 1, editedCount: 0, accounts: [] } })
  net.distribute.mockReturnValue(new Promise(() => {}))
  render(<View />)
  fireEvent.click(screen.getByRole('button', { name: '窓を開く' }))
  fireEvent.click(await screen.findByRole('button', { name: '1 アカウントへ配る' }))
  expect(screen.getByText('配布が終わるまで変更できません。')).toBeTruthy()
  for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'やめる' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})
