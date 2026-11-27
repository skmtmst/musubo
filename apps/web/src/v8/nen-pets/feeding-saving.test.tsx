// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Feeding from './feeding'
const net = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('@/lib/nen-ranks-api', () => ({ nenRanksApi: {
  feeding: async () => ({ success: true, data: { products: [{ id: 'p', name: '主食', kcalPer100g: 350, isDefault: true, kind: 'staple' }], petCount: 1, treatLimitPercent: 10 } }),
  saveFeeding: net.save,
} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
afterEach(cleanup)
it('WEB-049：保存中は入力・追加・削除・既定の変更を止め、失敗後は再編集できる', async () => {
  let reject!: (reason: Error) => void
  net.save.mockImplementation(() => new Promise((_, no) => { reject = no }))
  render(<Feeding accountId="a" canEdit />)
  const save = await screen.findByRole('button', { name: '保存する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(screen.getByText('ごはんの目安を変更すると保存できます。')).toBeTruthy()
  expect(save.title).toBe('ごはんの目安を変更すると保存できます')
  expect((screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).title).toBe('変更がありません')
  fireEvent.click(await screen.findByRole('button', { name: '主食' }))
  fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '変更済み' } })
  expect(screen.queryByText('ごはんの目安を変更すると保存できます。')).toBeNull()
  expect(save.title).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(net.save).toHaveBeenCalled())
  expect((screen.getByLabelText('商品名') as HTMLInputElement).matches(':disabled')).toBe(true)
  for (const button of screen.getAllByRole('button', { name: /主食を足す|削除/ })) expect(button.matches(':disabled')).toBe(true)
  reject(new Error('down'))
  await waitFor(() => expect((screen.getByLabelText('商品名') as HTMLInputElement).matches(':disabled')).toBe(false))
  expect((screen.getByLabelText('商品名') as HTMLInputElement).value).toBe('変更済み')
})
