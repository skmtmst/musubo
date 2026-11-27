// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ role: 'owner', get: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => state.role, canAdministerRole: (role: string) => role === 'owner' || role === 'admin' }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { accountSettings: { getAllergyOptions: state.get, saveAllergyOptions: state.save } } }))
import AllergyField from './allergy-field'

beforeEach(() => {
  state.role = 'owner'
  state.get.mockResolvedValue({ success: true, data: { version: 3, options: ['卵', '乳'] } })
  state.save.mockResolvedValue({ success: true, data: { version: 4 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('登録された候補を選び、既存値を保つ', async () => {
  const change = vi.fn()
  render(<AllergyField accountId="account-1" value={'["卵"]'} onChange={change} />)
  expect(screen.getByText('卵')).toBeTruthy()
  await waitFor(() => expect(state.get).toHaveBeenCalledWith('account-1'))
  fireEvent.click(screen.getByRole('button', { name: '選んで足す' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByText('乳'))
  fireEvent.click(within(dialog).getByRole('button', { name: /選択する（2件）/ }))
  expect(JSON.parse(change.mock.calls[0][0])).toEqual(['卵', '乳'])
})

it.each(['owner', 'staff'])('%s が追加した候補の保存先を権限で分ける', async role => {
  state.role = role
  render(<AllergyField accountId="account-1" value={null} onChange={() => {}} />)
  await waitFor(() => expect(state.get).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: '選んで足す' }))
  fireEvent.change(screen.getByLabelText('そのほか（自由に書く）'), { target: { value: 'キウイ' } })
  fireEvent.click(screen.getByRole('button', { name: role === 'owner' ? '候補に足す' : 'この項目にだけ足す' }))
  await screen.findByText('キウイ')
  if (role === 'owner') expect(state.save).toHaveBeenCalledWith('account-1', ['卵', '乳', 'キウイ'], 3)
  else expect(state.save).not.toHaveBeenCalled()
})

it('候補が同時に更新されたら最新を読み直し、入力を保って再試行できる', async () => {
  const { ApiError } = await import('@/lib/api')
  state.get.mockReset().mockResolvedValueOnce({ success: true, data: { version: 3, options: ['卵'] } }).mockResolvedValueOnce({ success: true, data: { version: 4, options: ['卵', '乳'] } })
  state.save.mockReset().mockRejectedValueOnce(new ApiError(409)).mockResolvedValueOnce({ success: true, data: { version: 5 } })
  render(<AllergyField accountId="account-1" value={null} onChange={() => {}} />)
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: '選んで足す' }))
  const input = screen.getByLabelText('そのほか（自由に書く）') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'キウイ' } })
  fireEvent.click(screen.getByRole('button', { name: '候補に足す' }))
  await screen.findByText(/候補が更新されました/)
  expect(input.value).toBe('キウイ')
  fireEvent.click(screen.getByRole('button', { name: '候補に足す' }))
  await waitFor(() => expect(state.save).toHaveBeenLastCalledWith('account-1', ['卵', '乳', 'キウイ'], 4))
})
