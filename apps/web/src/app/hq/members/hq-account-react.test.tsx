// @vitest-environment happy-dom
/*
 * 統括のメンバー（src/v8/hq/members.tsx）・統括の情報（settings.tsx）・お問い合わせ（support.tsx）を描いて押して見る。
 * - メンバー：共通の表に最終ログインと「（あなた）」、招待は管理者と閲覧のみだけ、送る口は統括の扱い（managementContext: 'hq'）
 * - お問い合わせ：種類・件名・本文は必須、画像は png/jpeg、送ると控えの知らせを出して欄を空にする
 * - 画面名はトップバーへ渡し、型の見出しのほかに h1 を足さない
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('@/v8/settings/staff', () => ({ SelfSecurity: () => null }))

const mocks = vi.hoisted(() => ({
  me: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), resend: vi.fn(), lastLogins: vi.fn(), accounts: vi.fn(),
  tenant: vi.fn(), updateName: vi.fn(), contact: vi.fn(),
  supportContext: vi.fn(), supportList: vi.fn(), supportCreate: vi.fn(), title: vi.fn(),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: mocks.me, list: mocks.list, create: mocks.create, update: mocks.update, resendInvite: mocks.resend, lastLogins: mocks.lastLogins },
      lineAccounts: { ...actual.api.lineAccounts, list: mocks.accounts },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [] } })) },
      tenants: { ...actual.api.tenants, me: mocks.tenant, updateName: mocks.updateName, companyContact: mocks.contact, saveCompanyContact: vi.fn() },
      hqSupport: { ...actual.api.hqSupport, context: mocks.supportContext, list: mocks.supportList, create: mocks.supportCreate },
      postalCode: { search: vi.fn() },
    },
  }
})
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/components/tenant-access-context', () => ({ useTenantStatus: () => 'active' }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/members',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: mocks.title, usePageCrumbs: () => {} }))

import HqMembersV8 from '@/v8/hq/members'
import HqSettingsV8 from '@/v8/hq/settings'
import HqSupportV8 from '@/v8/hq/support'
import { lastLoginShort } from '@/lib/hq-members'

const member = (over: Record<string, unknown>) => ({
  id: 'stf', name: '名前', email: 'a@example.com', role: 'viewer', isActive: true, inviteStatus: 'active',
  accountScope: 'all', scopedLineAccountIds: [], assignedLineAccountId: null, permissionKeys: [], notificationPreferences: {},
  lineLinked: false, twoFactorEnabled: false, canAccessDescendantAccounts: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})
const owner = member({ id: 'owner', name: '見本 145', email: 'owner@example.com', role: 'owner' })
const staff = member({ id: 'stf-staff', name: '見本 30', email: 'nakagawa@example.com', role: 'staff', accountScope: 'accounts', scopedLineAccountIds: ['acc-1'], assignedLineAccountId: 'acc-1' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.me.mockResolvedValue({ success: true, data: owner })
  mocks.list.mockResolvedValue({ success: true, data: [owner, staff] })
  mocks.lastLogins.mockResolvedValue({ success: true, data: { owner: '2026-10-20T09:15:00+09:00' } })
  mocks.accounts.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '然 -NEN- 本店', displayOrder: 0 }] })
  mocks.create.mockResolvedValue({ success: true, data: member({ id: 'new' }) })
  mocks.update.mockResolvedValue({ success: true, data: staff })
  mocks.tenant.mockResolvedValue({ success: true, data: { name: '統括の名前' } })
  mocks.updateName.mockResolvedValue({ success: true, data: { name: '新しい統括名' } })
  mocks.contact.mockResolvedValue({ success: true, data: null })
  mocks.supportContext.mockResolvedValue({ success: true, data: {
    kinds: [{ key: 'trouble', label: '不具合' }], accounts: [{ id: 'line-1', name: '本店' }],
    sender: { tenantName: '統括テスト', name: '見本 141', email: 'owner@example.com', planLabel: 'スタンダード' },
  } })
  mocks.supportList.mockResolvedValue({ success: true, data: [] })
  mocks.supportCreate.mockResolvedValue({ success: true, data: { id: 'req-9', ticketLabel: '#1099', subject: '文字が崩れる', status: 'open', notified: true } })
})
afterEach(cleanup)

/* 共通の Select は「釦＋一覧」。釦を押して一覧を開き、見える名前で選ぶ。 */
const openSelect = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }))
  return screen.getByRole('listbox')
}
const optionNames = (label: string) => {
  const names = within(openSelect(label)).getAllByRole('button').map((option) => option.textContent?.trim())
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
  return names
}
const choose = async (label: string, option: string) => {
  const listbox = openSelect(label)
  await act(async () => { fireEvent.click(within(listbox).getByRole('button', { name: option })) })
}

describe('メンバー（36-5）', () => {
  it('権限者は共通の表に出し、最終ログインと自分の印を並べる', async () => {
    render(<HqMembersV8 />)
    const table = await screen.findByRole('table', { name: '権限者の一覧' })
    await waitFor(() => expect(mocks.lastLogins).toHaveBeenCalledTimes(1))
    const self = within(table).getByText('見本 145（あなた）').closest('[role="row"]')!
    await waitFor(() => expect(self.textContent).toContain(lastLoginShort('2026-10-20T09:15:00+09:00')))
    expect(within(table).queryByText('見本 30（あなた）')).toBeNull()
    expect(mocks.title).toHaveBeenCalledWith('メンバー')
    expect(document.querySelectorAll('h1')).toHaveLength(0)
  })

  it('招待で管理者・担当者・閲覧のみを選べ、送る口は統括の扱いにする', async () => {
    render(<HqMembersV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '招待する' }))
    const dialog = await screen.findByRole('dialog', { name: '権限者を招待' })
    expect(optionNames('役割')).toEqual(['管理者（メンバーと決済も管理できる）', '担当者（業務を操作できる）', '閲覧のみ（見るだけ）'])
    expect(within(dialog).getByText('予約・配信などの業務を操作できます。メンバーの追加や決済の変更はできません。')).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '名前' }), { target: { value: '見本 141' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メールアドレス' }), { target: { value: 'yamada@example.com' } })
    await choose('役割', '管理者（メンバーと決済も管理できる）')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '招待メールを送る' })) })
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ name: '見本 141', email: 'yamada@example.com', role: 'admin', managementContext: 'hq' })
  })

  it('担当者の役割を残して選べ、役割を変えなければ役割を送らない', async () => {
    render(<HqMembersV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '見本 30のその他操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '権限を変更する' }))
    await screen.findByRole('dialog')
    expect(optionNames('役割')).toEqual(['管理者（メンバーと決済も管理できる）', '担当者（業務を操作できる）', '閲覧のみ（見るだけ）'])
    expect(screen.getByRole('button', { name: '役割' }).textContent).toContain('担当者（業務を操作できる）')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '変更を保存する' })) })
    const confirm = document.querySelector('[data-design-node="M4jS9"]')!
    const go = [...confirm.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().endsWith('変える'))!
    await act(async () => { fireEvent.click(go) })
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][0]).toBe('stf-staff')
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ managementContext: 'hq' })
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('role')
  })
})

describe('統括の情報', () => {
  it('画面名は「統括の情報」。統括名は前後の空白を外して保存する', async () => {
    render(<HqSettingsV8 />)
    const name = await screen.findByLabelText(/^統括名/) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('統括の名前'))
    expect(mocks.title).toHaveBeenCalledWith('統括の情報')
    fireEvent.change(name, { target: { value: '  新しい統括名  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await waitFor(() => expect(mocks.updateName).toHaveBeenCalledWith('新しい統括名'))
  })
})

describe('お問い合わせ（36-3）', () => {
  const open = async () => {
    render(<HqSupportV8 />)
    await screen.findByText(/送信者：見本 141/)
  }

  it('問い合わせのタブは設定メニューと並ぶ内容の中に置く', async () => {
    await open()
    const tabs = screen.getByRole('tablist', { name: '問い合わせの表示' })
    expect(tabs.closest('[data-template-region="content"]')).not.toBeNull()
  })

  it('種類・件名・本文がそろうまで送れず、画像は png と jpeg だけを受け付ける', async () => {
    await open()
    expect(mocks.title).toHaveBeenCalledWith('お問い合わせ')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    const send = screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(document.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/png,image/jpeg')
    await choose('種類', '不具合')
    fireEvent.change(screen.getByLabelText(/^件名/), { target: { value: '文字が崩れる' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^本文/), { target: { value: '本文です' } })
    expect(send.disabled).toBe(false)
  })

  it('送ると問い合わせを作り、控えの知らせを出して欄を空にし、履歴を読み直す', async () => {
    await open()
    await choose('種類', '不具合')
    fireEvent.change(screen.getByLabelText(/^件名/), { target: { value: '  文字が崩れる ' } })
    fireEvent.change(screen.getByLabelText(/^本文/), { target: { value: ' 日本語が崩れます ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送信する' })) })
    expect(mocks.supportCreate).toHaveBeenCalledWith({ kind: 'trouble', subject: '文字が崩れる', body: '日本語が崩れます', lineAccountId: null, attachments: [] })
    const done = await screen.findByRole('dialog', { name: '送信完了しました' })
    expect(done.textContent).toContain('控えが登録メールアドレスにも届きます')
    expect(done.textContent).toContain('#1099')
    expect((screen.getByLabelText(/^件名/) as HTMLInputElement).value).toBe('')
    expect(mocks.supportList).toHaveBeenCalledTimes(2)
  })

  it('「内容をクリア」で書いた件名と本文を空にする', async () => {
    await open()
    fireEvent.change(screen.getByLabelText(/^件名/), { target: { value: '件名' } })
    fireEvent.change(screen.getByLabelText(/^本文/), { target: { value: '本文' } })
    fireEvent.click(screen.getByRole('button', { name: '内容をクリア' }))
    expect((screen.getByLabelText(/^件名/) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/^本文/) as HTMLTextAreaElement).value).toBe('')
    expect(mocks.supportCreate).not.toHaveBeenCalled()
  })
})
