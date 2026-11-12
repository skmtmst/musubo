// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ACCOUNT_STYLES } from '@line-crm/shared'
import { STYLE_EXPERIENCE_SCRIPT } from '@/v8/onboarding/style-experience-player'
import ResumeRegistrationStyle from './resume-style'
import { REGISTRATION_STYLE_KEY as STYLE_KEY } from './use-registration-style'
import { registrationStorageKey } from './registration-storage'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { readStaffIdentity, rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
const REGISTRATION_STYLE_KEY = registrationStorageKey(STYLE_KEY, { id: 'style-owner', tenantId: 'style-tenant' })!
const net = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(),starterSet:vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [{ id: 'created-account', name: '登録した教室' }] }) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
beforeEach(() => {
  verifiedStaffRole('owner')
  rememberStaffIdentity({ ...readStaffIdentity()!, id: 'style-owner', tenantId: 'style-tenant' })
  sessionStorage.clear()
  net.starterSet.mockResolvedValue({success:true,data:{definition:{items:[{key:'menu',kind:'rich_menu'}]}}})
  net.get.mockReset().mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })
  net.save.mockReset().mockResolvedValue({ success: true, data: { version: 1 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

it('登録再開中のスタイル選択はページ移動を確認し、編集に戻れば選択を保つ', async () => {
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: '面談・相談' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(screen.getByRole('button', { name: '面談・相談（選んでいます）' })).toBeTruthy()
  link.remove()
})

it('読み込んだ保存済みスタイルだけでは未保存の確認を出さない', async () => {
  net.get.mockResolvedValueOnce({ success: true, data: { style: 'lesson', styleSelected: true, version: 4 } })
  render(<ResumeRegistrationStyle accountId="created-account" />)
  await screen.findByRole('button', { name: '教室・レッスン（選んでいます）' })
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it('選択窓を閉じても下書きを保ち、ページ移動を確認する', async () => {
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: '面談・相談' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})

it('登録を再開したアカウントの店名を見本へ渡す', async () => {
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  await waitFor(() => expect(dialog.querySelector('[data-pane="phone"]')?.textContent).toContain('登録した教室'))
  expect(dialog.querySelector('[data-pane="phone"]')?.textContent).not.toContain('店名未取得')
  expect(net.save).not.toHaveBeenCalled()
})

it.each(ACCOUNT_STYLES)('%sをポップアップで選び、同じアカウントへ保存して登録をやり直さない', async style => {
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'created-account')
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect(dialog.querySelectorAll('[data-style-switcher]')).toHaveLength(1)
  expect(dialog.querySelector('[data-window-body]')?.contains(dialog.querySelector('[data-style-switcher]'))).toBe(false)
  const next = within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: STYLE_EXPERIENCE_SCRIPT.styles[style].label }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  await waitFor(() => expect(next.disabled).toBe(false))
  fireEvent.click(next)
  expect(net.save).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog',{name:'最初のリッチメニューを選ぶ'})).getByRole('button',{name:'このメニューで進む'}))
  await screen.findByText('使い方を保存しました')
  expect(net.save).toHaveBeenCalledExactlyOnceWith('created-account', { expectedVersion: 0, style, confirmInitialMenu:true,answers: {image:{mode:'configured',value:'simple'}}, choices:{menu:{mode:'sample'}} })
  expect(sessionStorage.getItem(REGISTRATION_STYLE_KEY)).toBeNull()
  expect(screen.getByRole('link', { name: '次へ' }).getAttribute('href')).toBe(style === 'restaurant' ? '/restaurant-test/stores/new' : '/hq')
})

it('保存失敗では完了にせず、同じ選択と作成済みIDで再試行する', async () => {
  net.save.mockRejectedValueOnce(new Error('offline'))
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: '面談・相談' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  const save = within(dialog).getByRole('button', { name: '次へ' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(save)
  fireEvent.click(within(screen.getByRole('dialog',{name:'最初のリッチメニューを選ぶ'})).getByRole('button',{name:'このメニューで進む'}))
  await screen.findByText('使い方を確認・保存できませんでした')
  expect(screen.queryByText('使い方を保存しました')).toBeNull()
  expect((within(dialog).getByRole('radio',{name:/シンプルなメニュー/}) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('button',{name:'このメニューで進む'}))
  await screen.findByText('使い方を保存しました')
  expect(net.save.mock.calls.map(call => call[0])).toEqual(['created-account', 'created-account'])
})

it('取得失敗を標準へ戻さず、再読込後も保存済みの業種を選ぶ', async () => {
  net.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: { style: 'lesson', styleSelected: true, version: 4 } })
  render(<ResumeRegistrationStyle accountId="created-account" />)
  await screen.findByText('使い方を確認・保存できませんでした')
  expect((within(screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })).getByRole('button', { name: 'あとで設定する' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /もう一度読み込む/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '教室・レッスン（選んでいます）' })).toBeTruthy())
  expect(net.save).not.toHaveBeenCalled()
})

it('「あとで設定する」は保留を保存して次へ進み、次回の登録再開を止める', async () => {
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'created-account')
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  await waitFor(() => expect((within(dialog).getByRole('button', { name: 'あとで設定する' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(within(dialog).getByRole('button', { name: 'あとで設定する' }))
  await screen.findByText('登録が完了しました')
  expect(net.save).toHaveBeenCalledExactlyOnceWith('created-account', { expectedVersion: 0, styleMode: 'later' })
  expect(sessionStorage.getItem(REGISTRATION_STYLE_KEY)).toBeNull()
  expect(screen.getByRole('link', { name: '次へ' }).getAttribute('href')).toBe('/hq')
})

it('見本を切り替えただけでは未選択と示し、選ぶ操作を案内する', async () => {
  render(<ResumeRegistrationStyle accountId="created-account" />)
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: '飲食店' }))
  const next = within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  expect(next.getAttribute('aria-description')).toBe('「このスタイルにする」を押して選んでください')
  expect(net.save).not.toHaveBeenCalled()
})
