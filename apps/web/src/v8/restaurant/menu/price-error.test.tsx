// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// 日付の見本を作る前に日本時間で固定し、待ち合わせのタイマーは動かす。
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
})

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), createMenu: vi.fn(), updateMenu: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())

const account = vi.hoisted(() => ({ id: 'account-1' }))
vi.mock('@/components/shared/allergy-field', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), fetchApi }))
const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }))
const chromeTitle = vi.hoisted(() => vi.fn())
vi.mock('@/components/shell/page-chrome', async load => ({ ...(await load<typeof import('@/components/shell/page-chrome')>()), usePageTitle: chromeTitle }))
vi.mock('next/navigation', async (load) => ({
  ...(await load<typeof import('next/navigation')>()),
  useRouter: () => ({ push: nav.push, replace: nav.push, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/restaurant-test/menu',
}))

import MenuEditPage from './edit'
import { snapshotOf } from '../booking-kit/test-data'

beforeEach(() => {
  account.id = 'account-1'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  role.value = verifiedStaffRole('owner')
  nav.params = new URLSearchParams()
  fixture.snapshot.mockResolvedValue({ data: snapshotOf() })
  fixture.createMenu.mockResolvedValue({ success: true })
  fixture.updateMenu.mockResolvedValue({ success: true })
  fetchApi.mockResolvedValue({ success: true })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: {} })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); verifiedStaffRole(null) })


const reason = '値段は0円以上で入れてください。'
function saveButton() {
  return within(document.querySelector('[data-template-region="footer"]') as HTMLElement).getByRole('button', { name: /^保存/ }) as HTMLButtonElement
}
async function openEditor(mode: 'create' | 'edit', kind: 'course' | 'a_la_carte') {
  nav.params = new URLSearchParams(mode === 'create' ? 'store=store-1' : `id=${kind === 'course' ? 'm1' : 'm2'}`)
  render(<MenuEditPage />)
  const price = await screen.findByLabelText('価格（税込）') as HTMLInputElement
  if (mode === 'create') {
    fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '架空のメニュー' } })
    if (kind === 'course') {
      fireEvent.click(screen.getByRole('button', { name: '所要時間' }))
      fireEvent.click(within(screen.getByRole('option', { name: '2時間（120分）' })).getByRole('button'))
    } else {
      fireEvent.click(screen.getByRole('button', { name: '種類' }))
      fireEvent.click(within(screen.getByRole('option', { name: '単品' })).getByRole('button', { name: '単品' }))
      expect(screen.queryByLabelText('所要時間')).toBeNull()
    }
  }
  return price
}
function changePrice(price: HTMLInputElement, value: string) {
  fireEvent.focus(price)
  fireEvent.change(price, { target: { value } })
  fireEvent.blur(price)
}
for (const mode of ['create', 'edit'] as const) {
  for (const kind of ['course', 'a_la_carte'] as const) {
    it(`${mode}/${kind}: 負数の理由を欄と読み上げへ結び、0と正数へ直すと消える`, async () => {
      const price = await openEditor(mode, kind)
      const name = (screen.getByLabelText('メニュー名') as HTMLInputElement).value
      const field = document.querySelector('label[for="rs-menu-price"]')!.closest('[data-form-requirement]') as HTMLElement
      for (const corrected of ['0', '500']) {
        changePrice(price, '-500')
        const note = await within(field).findByRole('alert')
        expect(note.textContent).toBe(reason)
        expect(screen.getAllByText(reason)).toHaveLength(1)
        expect(price.value).toBe('-500')
        expect(price.min).toBe('0')
        expect(price.getAttribute('aria-invalid')).toBe('true')
        expect((price.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(note.id)
        expect(saveButton().disabled).toBe(true)
        fireEvent.click(saveButton())
        expect(fixture.createMenu).not.toHaveBeenCalled()
        expect(fixture.updateMenu).not.toHaveBeenCalled()
        changePrice(price, corrected)
        await waitFor(() => expect(screen.queryByText(reason)).toBeNull())
        expect(price.getAttribute('aria-invalid')).not.toBe('true')
        expect((price.getAttribute('aria-describedby') ?? '').split(/\s+/)).not.toContain(note.id)
        expect(price.value).toBe(corrected)
        expect((screen.getByLabelText('メニュー名') as HTMLInputElement).value).toBe(name)
        expect(saveButton().disabled).toBe(false)
      }
      changePrice(price, '')
      expect(saveButton().disabled).toBe(true)
      expect(screen.queryByText(reason)).toBeNull()
    })
  }
}
it('0円の新規コースは送る値を保って一度だけ作れる', async () => {
  const price = await openEditor('create', 'course')
  changePrice(price, '-500')
  expect(await screen.findByText(reason)).toBeTruthy()
  changePrice(price, '0')
  fireEvent.click(saveButton())
  await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledExactlyOnceWith('account-1', {
    storeId: 'store-1', kind: 'course', name: '架空のメニュー', price: 0, durationMinutes: 120,
    effectiveAt: null, allergens: [], description: null, photos: [], servicePeriods: [], status: 'draft',
  }))
  expect(fixture.updateMenu).not.toHaveBeenCalled()
})
it('閲覧のみは既存の読む表示を保ち、価格入力と入力の理由を出さない', async () => {
  role.value = verifiedStaffRole('viewer')
  nav.params = new URLSearchParams('id=m1')
  render(<MenuEditPage />)
  expect(await screen.findByText('メニューの内容')).toBeTruthy()
  expect(screen.queryByLabelText('価格（税込）')).toBeNull()
  expect(screen.queryByText(reason)).toBeNull()
  expect(fixture.createMenu).not.toHaveBeenCalled()
  expect(fixture.updateMenu).not.toHaveBeenCalled()
})

it('100万円を超えると理由を出して止め、上限ちょうどは保存できる', async () => {
  const price = await openEditor('create', 'course')
  changePrice(price, '1000001')
  expect(screen.getByRole('alert').textContent).toBe('値段は1,000,000円以下で入れてください。')
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(saveButton()); expect(fixture.createMenu).not.toHaveBeenCalled()
  changePrice(price, '1000000')
  expect(saveButton().disabled).toBe(false)
})

it('100万円を超える既存メニューも価格を変えず名前だけ更新できる', async () => {
  const snapshot = snapshotOf()
  fixture.snapshot.mockResolvedValue({ data: { ...snapshot, menuItems: snapshot.menuItems.map(item => item.id === 'm2' ? { ...item, price: 1_000_001 } : item) } })
  const price = await openEditor('edit', 'a_la_carte')
  expect(price.value).toBe('1000001')
  fireEvent.change(screen.getByLabelText('メニュー名'), { target: { value: '名前を変更' } })
  changePrice(price, '1000002')
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('値段は1,000,000円以下で入れてください。')).toBeTruthy()
  changePrice(price, '1000001')
  expect(saveButton().disabled).toBe(false)
  expect(screen.queryByText('値段は1,000,000円以下で入れてください。')).toBeNull()
  fireEvent.click(saveButton())
  await waitFor(() => expect(fixture.updateMenu).toHaveBeenCalledWith('account-1', 'm2', expect.objectContaining({ name: '名前を変更', price: 1_000_001 })))
})
