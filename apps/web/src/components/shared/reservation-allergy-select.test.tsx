// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { accountSettings: { getAllergyOptions: net.read, saveAllergyOptions: net.save } } }))
import ReservationAllergySelect from './reservation-allergy-select'
function Sample({ role }: { role: string }) {
  const [values, setValues] = useState<string[]>([])
  return <><ReservationAllergySelect accountId="account" role={role} values={values} onChange={setValues} /><output>{JSON.stringify(values)}</output></>
}
beforeEach(() => { net.read.mockResolvedValue({ success: true, data: { version: 3, options: ['卵', '乳', '小麦'] } }); net.save.mockResolvedValue({ success: true, data: { version: 4 } }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('共通の候補を読み、複数の札を選択できる', async () => {
  render(<Sample role="staff" />)
  const box = await screen.findByRole('combobox', { name: 'アレルギー' })
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false))
  fireEvent.focus(box)
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '卵' }))
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '乳' }))
  expect(screen.getByText('["卵","乳"]')).toBeTruthy()
  expect(net.save).not.toHaveBeenCalled()
})
it('スタッフの候補外はこの予約のその他になり、共通候補は書き換えない', async () => {
  render(<Sample role="staff" />)
  const box = await screen.findByRole('combobox', { name: 'アレルギー' })
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false))
  fireEvent.focus(box); fireEvent.change(box, { target: { value: 'キウイ' } })
  fireEvent.click(screen.getByText('「その他：キウイ」として追加'))
  expect(screen.getByText('["その他：キウイ"]')).toBeTruthy()
  expect(net.save).not.toHaveBeenCalled()
})
it('管理者は版を指定して共通候補を追加できる', async () => {
  render(<Sample role="admin" />)
  const box = await screen.findByRole('combobox', { name: 'アレルギー' })
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false))
  fireEvent.focus(box); fireEvent.change(box, { target: { value: 'キウイ' } })
  fireEvent.click(screen.getByText('「キウイ」を候補に追加'))
  await waitFor(() => expect(net.save).toHaveBeenCalledWith('account', ['卵', '乳', '小麦', 'キウイ'], 3))
  expect(await screen.findByText('["キウイ"]')).toBeTruthy()
})
