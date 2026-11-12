import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * V8 たまる決めごとを作る（src/v8/mileage/earning-rule-new/create.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 足りない入力は保存しない・保存は 作る→下書き の順・下書きが 409 で返ると競合の帯・保存して動かすで一覧へ戻る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const roleFixture = vi.hoisted(() => ({ role: 'owner' as string | null }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => roleFixture.role }))

const push = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/mileage/earning-rules/new',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '然-NEN-TEST' }, accounts: [], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import EarningRuleCreateV8 from './create'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; key: string | null }> = []
let draftStatus = 200

let root: Root
let host: HTMLDivElement

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount() {
  if (roleFixture.role) rememberStaffIdentity({ role: roleFixture.role } as StaffMember); else forgetStaffIdentity()
  await act(async () => { root.render(<EarningRuleCreateV8 />) })
  await flush()
}

function type(label: string, value: string) {
  const field = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.change(field, { target: { value } })
}

async function clickButton(name: string) {
  await act(async () => { fireEvent.click(getPageAction({ name })) })
  await flush()
}

beforeEach(() => {
  roleFixture.role = 'owner'
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  push.mockReset()
  calls.length = 0
  draftStatus = 200
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ method, path: url.pathname, body, key: new Headers(init?.headers).get('Idempotency-Key') })
    if (url.pathname === '/api/tags') return json({ success: true, data: [] })
    if (method === 'POST' && url.pathname === '/api/mileage/rules') return json({ success: true, data: { id: 'rule-new' } })
    if (method === 'PATCH' && url.pathname === '/api/mileage/earning-rules/rule-new/draft') {
      return draftStatus === 409
        ? json({ success: false, error: 'ほかの人が先に保存しました', code: 'VERSION_CONFLICT', data: { updatedByName: '坂本', updatedAt: '2026-10-07T05:02:00.000Z' } }, 409)
        : json({ success: true, data: { ruleId: 'rule-new', lineAccountId: 'account-a', version: 1, draft: {}, updatedAt: '2026-10-07T05:02:00.000Z' } })
    }
    return json({ success: true, data: [] })
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  forgetStaffIdentity()
  vi.unstubAllGlobals()
})

describe('V8 たまる決めごとを作る', () => {
  it('名前が無いときは保存の口を呼ばず、足りない所を知らせる', async () => {
    await mount()
    await clickButton('保存して動かす')
    expect(screen.getByText('ルール名を入力してください')).toBeTruthy()
    const name = screen.getByLabelText('名前')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByText('ルール名を入力してください')).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('畳まれた有効期限に誤りがあれば、開いてその欄へ移り、保存しない', async () => {
    await mount()
    type('名前', 'リンクをクリック')
    type('マイル', '10')
    type('有効期限の日数', '0')
    await clickButton('保存して動かす')
    const expiry = screen.getByLabelText('有効期限の日数')
    await waitFor(() => expect(document.activeElement).toBe(expiry))
    expect(expiry.closest('details')?.open).toBe(true)
    expect(expiry.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByText('有効期限は1〜3650日で入力してください')).toHaveLength(1)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('保存して動かすは、作る→下書きの順に送って一覧へ戻る', async () => {
    await mount()
    expect(screen.queryByRole('button', { name: '付け方' })).toBeNull()
    expect(screen.getByText('付け方：決まった数')).toBeTruthy()
    type('名前', 'リンクをクリック')
    type('マイル', '10')
    await clickButton('保存して動かす')
    const writes = calls.filter((call) => call.method !== 'GET')
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/mileage/rules',
      'PATCH /api/mileage/earning-rules/rule-new/draft',
    ])
    expect(writes[0].body).toMatchObject({ name: 'リンクをクリック', amount: 10, lineAccountId: 'account-a', initialStatus: 'available' })
    expect(writes[1].body).toMatchObject({ accountId: 'account-a', expectedVersion: 0 })
    expect(push).toHaveBeenCalledWith('/mileage?tab=earning-rules&highlight=rule-new')
    expect(document.querySelector('[data-design-node="BnrQp"]')).toBeNull()
  })

  it('下書きの保存が 409 で返ると、だれが保存したかを競合の帯（BnrQp）で知らせ、一覧へは戻らない', async () => {
    draftStatus = 409
    await mount()
    type('名前', 'リンクをクリック')
    type('マイル', '10')
    await clickButton('保存して動かす')
    const band = screen.getByRole('alert')
    expect(band.textContent).toContain('坂本さんが 14:02 にこの決めごとを保存しました')
    expect(band.textContent).toContain('このまま保存すると、坂本さんの変更が消えます')
    expect(document.querySelector('[data-design-node="BnrQp"]')).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })
})

it.each([null, 'staff', 'viewer'])('役割%sでは作成・試算を出さずAPIも呼ばない', async role => {
  roleFixture.role = role
  await mount()
  expect(screen.queryByRole('button', { name: '保存して動かす' })).toBeNull()
  expect(screen.queryByRole('button', { name: '保存して続けて作る' })).toBeNull()
  expect(screen.queryByRole('button', { name: '試算する' })).toBeNull()
  expect(screen.getByRole('link', { name: '一覧へ戻る' })).toBeTruthy()
  if (role === null) expect(host.querySelector('[data-read-only-notice]')).toBeNull()
  else expect(host.textContent).toContain(role === 'viewer' ? '閲覧のみ' : '権限')
  expect(calls.filter(call => call.method !== 'GET')).toEqual([])
})

it('続けて作ると入力と要求キーを作り直し、名前に焦点を戻す', async () => {
  await mount()
  type('名前', '同じ名前で二つ作る')
  type('マイル', '10')
  await clickButton('保存して続けて作る')
  expect(push).not.toHaveBeenCalled()
  expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('マイル') as HTMLInputElement).value).toBe('')
  expect(document.activeElement).toBe(screen.getByLabelText('名前'))
  type('名前', '同じ名前で二つ作る')
  type('マイル', '10')
  await clickButton('保存して続けて作る')
  const creates = calls.filter(call => call.method === 'POST' && call.path === '/api/mileage/rules')
  expect(creates).toHaveLength(2)
  expect(creates[0].key).toBeTruthy()
  expect(creates[1].key).toBeTruthy()
  expect(creates[0].key).not.toBe(creates[1].key)
})

it('追加保存が失敗したときは続けて作るでも入力を消さない', async () => {
  draftStatus = 409
  await mount()
  type('名前', '残す名前')
  type('マイル', '10')
  await clickButton('保存して続けて作る')
  expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('残す名前')
  expect((screen.getByLabelText('マイル') as HTMLInputElement).value).toBe('10')
  expect(push).not.toHaveBeenCalled()
})

it('停止して保存する場合はボタンも停止を示し、停止状態で作る', async () => {
  await mount()
  type('名前', 'リンクをクリック')
  type('マイル', '10')
  await act(async () => { fireEvent.click(screen.getByText('詳しい設定（倍率・通知・取り消し・公開）')) })
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '作成したらすぐ動かす' })) })
  expect(screen.queryByRole('button', { name: '保存して動かす' })).toBeNull()
  await clickButton('停止して保存')
  expect(calls.find((call) => call.method === 'POST' && call.path === '/api/mileage/rules')?.body).toMatchObject({ isActive: false })
})
