// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const data = vi.hoisted(() => ({ snapshot: vi.fn(), updateMenu: vi.fn(), upload: vi.fn(), push: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shared/allergy-field', () => ({ default: () => null }))
vi.mock('@/components/shared/media-library-upload', () => ({ uploadToMediaLibrary: data.upload }))
vi.mock('@/components/shared/registered-image-select', () => ({ default: ({ onSelect }: { onSelect: (item: { id: string; filename: string }) => void }) => <button onClick={() => onSelect({ id: 'existing', filename: 'existing.png' })}>登録メディアから選択する</button> }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: data }))
vi.mock('next/navigation', async load => ({ ...(await load<typeof import('next/navigation')>()), useRouter: () => ({ push: data.push }), useSearchParams: () => new URLSearchParams('id=m2'), usePathname: () => '/restaurant-test/menu/edit' }))
import MenuEditPage from './edit'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  data.snapshot.mockResolvedValue({ data: snapshotOf() })
  data.upload.mockResolvedValue({ item: { id: 'uploaded' } })
  data.updateMenu.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('ファイルを登録してメニューに設定する', async () => {
  const view = render(<MenuEditPage />)
  await screen.findByLabelText('メニュー名')
  const input = view.container.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'dish.png', { type: 'image/png' })] } })
  await waitFor(() => expect(data.upload).toHaveBeenCalled())
  await waitFor(() => expect((screen.getByRole('button', { name: /保存する/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
  await waitFor(() => expect(data.updateMenu).toHaveBeenCalledWith('account-1', 'm2', expect.objectContaining({ imageMediaId: 'uploaded' })))
})

it('登録に失敗した理由を画像欄に示し、既存画像も選べる', async () => {
  data.upload.mockRejectedValueOnce(new Error('通信できませんでした'))
  const view = render(<MenuEditPage />)
  await screen.findByLabelText('メニュー名')
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'dish.png', { type: 'image/png' })] } })
  await screen.findByText(/通信できませんでした/)
  fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' }))
  fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
  await waitFor(() => expect(data.updateMenu).toHaveBeenCalledWith('account-1', 'm2', expect.objectContaining({ imageMediaId: 'existing' })))
})

it('形式違いと容量超過は登録せず理由を示す', async () => {
  const view = render(<MenuEditPage />)
  await screen.findByLabelText('メニュー名')
  const input = view.container.querySelector('input[type=file]')!
  fireEvent.change(input, { target: { files: [new File(['x'], 'dish.svg', { type: 'image/svg+xml' })] } })
  expect(screen.getByText(/の画像を選んでください/)).toBeTruthy()
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'dish.png', { type: 'image/png' })] } })
  expect(screen.getByText(/大きすぎます/)).toBeTruthy()
  expect(data.upload).not.toHaveBeenCalled()
})

it('画像取込中は理由を表示して保存できず、完了後に保存できる', async () => {
  let finish!: (value: { item: { id: string } }) => void
  data.upload.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = render(<MenuEditPage />)
  await screen.findByLabelText('メニュー名')
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'dish.png', { type: 'image/png' })] } })
  await waitFor(() => expect(data.upload).toHaveBeenCalled())
  const save = screen.getByRole('button', { name: /保存する/ }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(save.getAttribute('aria-description')).toBe('画像を取り込んでいます。')
  fireEvent.click(save)
  expect(data.updateMenu).not.toHaveBeenCalled()
  finish({ item: { id: 'uploaded' } })
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  await waitFor(() => expect(data.updateMenu).toHaveBeenCalledWith('account-1', 'm2', expect.objectContaining({ imageMediaId: 'uploaded' })))
})
