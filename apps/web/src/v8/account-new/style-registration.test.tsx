// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ACCOUNT_STYLES } from '@line-crm/shared'
import { STYLE_EXPERIENCE_SCRIPT } from '@/v8/onboarding/style-experience-player'
import AccountRegisterV8 from './register'
import { REGISTRATION_STYLE_KEY as STYLE_KEY } from './use-registration-style'
import { registrationPresentationKey, registrationStorageKey, rememberRegistrationPresentation } from './registration-storage'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { readStaffIdentity, rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
const REGISTRATION_STYLE_KEY = registrationStorageKey(STYLE_KEY, { id: 'style-owner', tenantId: 'style-tenant' })!
const net = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(),starterSet:vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    staff: { me: vi.fn(() => new Promise(() => {})) },
    lineAccounts: {
      registrationReceipt: vi.fn(async () => ({ success: true, data: { status: 'confirmed' } })),
      get: vi.fn(async () => ({ success: true, data: { id: 'created-account', name: '登録した教室' } })),
      followerImportState: vi.fn(async () => ({ success: true, data: { phase: 'not_started' } })),
    },
  },
}))
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [{ id: 'created-account', name: '登録した教室' }] }) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
beforeEach(() => {
  verifiedStaffRole('owner')
  rememberStaffIdentity({ ...readStaffIdentity()!, id: 'style-owner', tenantId: 'style-tenant' })
  sessionStorage.clear()
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'created-account')
  net.starterSet.mockReset()
  net.get.mockReset().mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })
  net.save.mockReset().mockResolvedValue({ success: true, data: { version: 1 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

it('登録再開中のスタイル選択はページ移動を確認し、編集に戻れば選択を保つ', async () => {
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(screen.getByRole('button', { name: '飲食店（選んでいます）' })).toBeTruthy()
  link.remove()
})

it('読み込んだ保存済みスタイルだけでは未保存の確認を出さない', async () => {
  net.get.mockResolvedValueOnce({ success: true, data: { style: 'lesson', styleSelected: true, version: 4 } })
  render(<AccountRegisterV8 />)
  await screen.findByText('LINEアカウントの登録が完了しました')
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it('選択窓を閉じても下書きを保ち、ページ移動を確認する', async () => {
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})

it('登録を再開したアカウントの店名を見本へ渡す', async () => {
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  await waitFor(() => expect(dialog.querySelector('[data-pane="phone"]')?.textContent).toContain('登録した教室'))
  expect(dialog.querySelector('[data-pane="phone"]')?.textContent).not.toContain('店名未取得')
  expect(net.save).not.toHaveBeenCalled()
})

it('飲食店を選び、同じアカウントへ保存して登録をやり直さない', async () => {
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'created-account')
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect(dialog.querySelectorAll('[data-style-switcher]')).toHaveLength(1)
  expect(dialog.querySelector('[data-window-body]')?.contains(dialog.querySelector('[data-style-switcher]'))).toBe(false)
  const next = within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  await waitFor(() => expect(next.disabled).toBe(false))
  fireEvent.click(next)
  await screen.findByText('LINEアカウントの登録が完了しました')
  expect(screen.queryByRole('dialog', { name: '最初のリッチメニューを選ぶ' })).toBeNull()
  expect(net.starterSet).not.toHaveBeenCalled()
  expect(net.save).toHaveBeenCalledExactlyOnceWith('created-account', { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'later' } } }, true)
  expect(sessionStorage.getItem(REGISTRATION_STYLE_KEY)).toBe('created-account')
  expect(screen.getByRole('link', { name: '管理画面へ' }).getAttribute('href')).toBe('/hq')
})

it.each(ACCOUNT_STYLES.filter(style => style !== 'restaurant'))('%sの未保存の選択から再開しても、そのスタイルは選べない', async style => {
  rememberRegistrationPresentation(registrationPresentationKey(REGISTRATION_STYLE_KEY, 'created-account'), { choice: style, viewing: style })
  render(<AccountRegisterV8 />)
  const dialog = within(await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' }))
  const unavailable = dialog.getByRole('button', { name: STYLE_EXPERIENCE_SCRIPT.styles[style].label })
  expect(unavailable).toHaveProperty('disabled', true)
  fireEvent.click(unavailable)
  expect(dialog.getByRole('heading', { name: '飲食店でできること' })).toBeTruthy()
  expect(dialog.getByRole('button', { name: '次へ' })).toHaveProperty('disabled', true)
  expect(net.save).not.toHaveBeenCalled()
})

it('保存済みの使い方があれば登録完了を復元し、メニューの設定も保存し直さない', async () => {
  net.get.mockResolvedValueOnce({ success: true, data: {
    style: 'restaurant', styleSelected: true, version: 4,
    answers: { image: { mode: 'configured', value: 'existing', resourceId: 'saved-menu' } },
  } })
  render(<AccountRegisterV8 />)
  await screen.findByText('LINEアカウントの登録が完了しました')
  expect(net.save).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '最初のリッチメニューを選ぶ' })).toBeNull()
})

it('保存失敗では完了にせず、同じ選択と作成済みIDで再試行する', async () => {
  net.save.mockRejectedValueOnce(new Error('offline'))
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  const save = within(dialog).getByRole('button', { name: '次へ' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(save)
  await screen.findByText('使い方を確認・保存できませんでした')
  expect(screen.queryByText('使い方を保存しました')).toBeNull()
  expect(within(dialog).getByRole('button', { name: '飲食店（選んでいます）' })).toBeTruthy()
  fireEvent.click(save)
  await screen.findByText('LINEアカウントの登録が完了しました')
  expect(net.save.mock.calls.map(call => call[0])).toEqual(['created-account', 'created-account'])
})

it('取得失敗を標準へ戻さず、再読込後も保存済みの業種を選ぶ', async () => {
  net.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: { style: 'lesson', styleSelected: true, version: 4 } })
  render(<AccountRegisterV8 />)
  await screen.findByText('使い方を確認・保存できませんでした')
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /もう一度読み込む/ }))
  await screen.findByText('LINEアカウントの登録が完了しました')
  expect(net.save).not.toHaveBeenCalled()
})

it('スタイルが未選択の登録再開では、窓を閉じても保留を保存せず再開できる', async () => {
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'created-account')
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect((within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(true)
  expect(within(dialog).queryByRole('button', { name: 'あとで設定する' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  expect(screen.queryByRole('button', { name: 'あとで設定する' })).toBeNull()
  expect(net.save).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(REGISTRATION_STYLE_KEY)).toBe('created-account')
  const stickyBar = document.querySelector<HTMLElement>('[data-shared-part="sticky-bar"]')!
  fireEvent.click(within(stickyBar).getByRole('button', { name: 'スタイルを選ぶ' }))
  expect(screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeTruthy()
})

it('見本を切り替えただけでは未選択と示し、選ぶ操作を案内する', async () => {
  render(<AccountRegisterV8 />)
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: '飲食店' }))
  const next = within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  expect(next.getAttribute('aria-description')).toBe('「このスタイルにする」を押して選んでください')
  expect(net.save).not.toHaveBeenCalled()
})
