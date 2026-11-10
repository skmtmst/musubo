// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
const preview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: { testSend: send, testRecipients: preview } }))
import { HqTestSendDialog } from './approval'
import { ApiError } from '@/lib/api'

beforeEach(() => preview.mockImplementation(async (id: string) => ({ success: true, data: { count: 1, recipients: [{ id: `f-${id}`, displayName: `受信者-${id}` }], token: 'a'.repeat(64) } })))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('テスト送信の窓で実際に選んだアカウントと環境を確認できる', () => {
  render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={async () => 'draft'} onClose={() => {}} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('本店LINE')
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
})

it('準備中に対象が切り替わればテスト送信を行わない', async () => {
  let finish!: (id: string | null) => void
  const prepare = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve }))
  const view = render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={prepare} onClose={() => {}} />)
  await screen.findByText(/送信先 1 人：受信者-a/)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }))
  expect(prepare).toHaveBeenCalledTimes(1)
  view.rerender(<HqTestSendDialog open accounts={[{ id: 'b', name: '別店LINE' }]} prepare={prepare} onClose={() => {}} />)
  await act(async () => { finish('draft-a'); await Promise.resolve() })
  expect(send).not.toHaveBeenCalled()
})

it('対象を切り替えると準備中の応答を待たずに新しい対象を操作できる', async () => {
  let finishOld!: (id: string | null) => void
  let finishNew!: (id: string | null) => void
  const prepare = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
  send.mockResolvedValue({ data: { sent: 1, failed: 0 } })
  const view = render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={prepare} onClose={() => {}} />)
  await screen.findByText(/送信先 1 人：受信者-a/)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }))
  view.rerender(<HqTestSendDialog open accounts={[{ id: 'b', name: '別店LINE' }]} prepare={prepare} onClose={() => {}} />)
  await screen.findByText(/送信先 1 人：受信者-b/)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }))
  expect(prepare).toHaveBeenCalledTimes(2)
  await act(async () => { finishOld('draft-a'); await Promise.resolve() })
  expect(send).not.toHaveBeenCalled()
  await act(async () => { finishNew('draft-b'); await Promise.resolve() })
  expect(send).toHaveBeenCalledExactlyOnceWith('draft-b', 'b', 'a'.repeat(64))
})

it('確認したアカウントに一度だけテスト送信する', async () => {
  send.mockResolvedValue({ data: { sent: 1, failed: 0 } })
  const close = vi.fn()
  render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={async () => 'draft-a'} onClose={close} />)
  await screen.findByText(/送信先 1 人：受信者-a/)
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send).toHaveBeenCalledWith('draft-a', 'a', 'a'.repeat(64))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
})

it('窓の再表示では別の確定口を受け付けない', async () => {
  const prepare = vi.fn().mockResolvedValue('draft-a')
  const accounts = [{ id: 'a', name: '本店LINE' }]
  const view = render(<HqTestSendDialog open accounts={accounts} prepare={prepare} onClose={() => {}} />)
  await screen.findByText(/送信先 1 人：受信者-a/)
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' })
  const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  view.rerender(<HqTestSendDialog open={false} accounts={accounts} prepare={prepare} onClose={() => {}} />)
  view.rerender(<HqTestSendDialog open accounts={accounts} prepare={prepare} onClose={() => {}} />)
  await act(async () => { oldClick() })
  expect(prepare).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})


it('宛先を読み取れないときは送れない', async () => {
  preview.mockRejectedValueOnce(new Error('down'))
  render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={async () => 'draft'} onClose={() => {}} />)
  await screen.findByText('テスト送信の宛先を確認できません。')
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(send).not.toHaveBeenCalled()
})


it('409では新しい人数を伝え、古い確認では再送できない', async () => {
  send.mockRejectedValueOnce(new ApiError(409, '変更されました', 'HQ_TEST_RECIPIENT_CHANGED', { count: 2 }))
  render(<HqTestSendDialog open accounts={[{ id: 'a', name: '本店LINE' }]} prepare={async () => 'draft'} onClose={() => {}} />)
  await screen.findByText(/送信先 1 人：受信者-a/)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }))
  await screen.findByText(/現在 2 人です/)
  expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'テストを送る' }) as HTMLButtonElement).disabled).toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
})
