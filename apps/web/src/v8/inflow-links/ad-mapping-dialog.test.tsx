// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import AdMappingDialog from './ad-mapping-dialog'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => { cleanup(); clearToastsForTest() })
it('広告の対応を連続確定しても1回だけ保存し、拒否の後も入力を保持して再保存できる', async () => {
  let fail!: (error: Error) => void
  const save = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject })).mockResolvedValue(true)
  render(<AdMappingDialog item={{ pointId: 'point-1', eventType: 'booking_created', automaticEventName: 'Schedule', version: 1, pointName: '予約', provider: 'google', mode: 'manual', eventName: '予約完了', googleActionId: '123' }} onSave={save} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('予約 googleに返す名前'), { target: { value: '来店予約' } })
  const button = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
  act(() => { button.click(); button.click() })
  expect(save).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  await act(async () => { fail(new ApiError(403)) })
  expect(screen.getByText(/このLINEアカウントや権限では保存できません/)).toBeTruthy()
  expect((screen.getByLabelText('予約 googleに返す名前') as HTMLInputElement).value).toBe('来店予約')
  await act(async () => { fireEvent.click(button) })
  expect(save).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenLastCalledWith({ mode: 'manual', eventName: '来店予約', googleActionId: '123' })
})
it('同じ画面の表示条件へ移るとき、破棄を選べば編集窓も閉じる', async () => {
  window.history.replaceState(null, '', '/inflow-links/ad-connections')
  const close = vi.fn()
  render(<><AdMappingDialog item={{ pointId: 'point-1', eventType: 'booking_created', automaticEventName: 'Schedule', version: 1, pointName: '予約', provider: 'google', mode: 'manual', eventName: '予約完了', googleActionId: '123' }} onSave={vi.fn()} onClose={close} /><a href="/inflow-links/ad-connections?tab=logs">履歴へ</a></>)
  fireEvent.change(screen.getByLabelText('予約 googleに返す名前'), { target: { value: '来店予約' } })
  fireEvent.click(screen.getByRole('link', { name: '履歴へ' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存せずに移動' })) })
  expect(close).toHaveBeenCalledTimes(1)
})


it('広告への対応を保存できたら完了を知らせる', async () => {
  const save = vi.fn().mockResolvedValue(true)
  render(<><AdMappingDialog item={{ pointId: 'point-1', eventType: 'booking_created', automaticEventName: 'Schedule', version: 1, pointName: '予約', provider: 'google', mode: 'manual', eventName: '予約完了', googleActionId: '123' }} onSave={save} onClose={vi.fn()} /><ToastHost /></>)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText('広告への対応を保存しました。')).toBeTruthy()
  expect(save).toHaveBeenCalledTimes(1)
})

it('保存できなかった場合は完了を知らせない', async () => {
  const save = vi.fn().mockResolvedValue(false)
  render(<><AdMappingDialog item={{ pointId: 'point-1', eventType: 'booking_created', automaticEventName: 'Schedule', version: 1, pointName: '予約', provider: 'google', mode: 'manual', eventName: '予約完了', googleActionId: '123' }} onSave={save} onClose={vi.fn()} /><ToastHost /></>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
  expect(screen.queryByText('広告への対応を保存しました。')).toBeNull()
})
