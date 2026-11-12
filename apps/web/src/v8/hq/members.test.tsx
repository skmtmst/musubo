// @vitest-environment happy-dom
/*
 * V8 統括のメンバー（src/v8/hq/members.tsx・member-dialog.tsx）の動きの試験。
 * 招待の始まり（閲覧のみ・統括の全アカウント固定・範囲の選択は無い）、
 * 変更→確認の間は変更の窓を閉じる、確認をやめたら中身のまま戻る、
 * 役割を変えないときは役割を送らない（担当者が管理者に上がらない）。
 */
import React, { act } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const me = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const accounts = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: {
        ...actual.api.staff,
        me,
        list,
        update,
        create,
        lastLogins: vi.fn(async () => ({ success: true, data: {} })),
        resendInvite: vi.fn(),
      },
      lineAccounts: { ...actual.api.lineAccounts, list: accounts },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [] } })) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/members',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

import HqMembersV8 from './members'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const staffMember = {
  id: 'stf-staff', name: '見本 30', email: 'nakagawa@example.com', role: 'staff', isActive: true,
  inviteStatus: 'active', accountScope: 'accounts', scopedLineAccountIds: ['acc-1'], assignedLineAccountId: 'acc-1',
  permissionKeys: [], notificationPreferences: {}, lineLinked: true, twoFactorEnabled: false,
  canAccessDescendantAccounts: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

let root: Root | null = null
let host: HTMLDivElement

const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() }) }
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
const dialogTitles = () => Array.from(document.querySelectorAll('[role="dialog"] h2')).map((h) => h.textContent)

beforeEach(async () => {
  me.mockResolvedValue({ success: true, data: { id: 'owner', name: 'Kenta', role: 'owner', accountScope: 'all' } })
  list.mockResolvedValue({ success: true, data: [staffMember] })
  update.mockResolvedValue({ success: true, data: staffMember })
  create.mockResolvedValue({ success: true, data: staffMember })
  accounts.mockResolvedValue({ success: true, data: [
    { id: 'acc-1', name: '然 -NEN- 本店', displayOrder: 0 },
    { id: 'acc-2', name: '然 -NEN- 渋谷店', displayOrder: 1 },
    { id: 'acc-old', name: '旧キャンペーン', displayOrder: 2, archivedAt: '2026-01-01T00:00:00Z' },
  ] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<HqMembersV8 />) })
  await flush()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('V8 統括のメンバーの窓', () => {
  it('本人の二段階認証設定を一覧の下に表示する', () => {
    expect(screen.getByRole('region', { name: '自分の設定' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '二段階認証' })).toBeTruthy()
  })

  it('招待は担当者から始め、範囲の選択は無く全アカウントを付けて送る', async () => {
    await act(async () => { buttonByText('招待する')!.click() })
    await flush()
    expect(dialogTitles()).toContain('権限者を招待')
    const dialog = document.querySelector('[role="dialog"]')!
    // 範囲の選び直しは無い（統括の招待は全アカウント固定）。
    expect(screen.queryByRole('radio', { name: '指定したアカウントだけ' })).toBeNull()
    expect(dialog.textContent).toContain('予約・配信などの業務を操作できます。メンバーの追加や決済の変更はできません。')
    expect(dialog.textContent).toContain('担当者（業務を操作できる）')
    const name = screen.getByRole('textbox', { name: '名前' }) as HTMLInputElement
    const email = screen.getByRole('textbox', { name: 'メールアドレス' }) as HTMLInputElement
    await act(async () => { fireEvent.change(name, { target: { value: '見本 146' } }) })
    await act(async () => { fireEvent.change(email, { target: { value: 'arai@example.com' } }) })
    await act(async () => { buttonByText('招待メールを送る')!.click() })
    await flush()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      name: '見本 146', email: 'arai@example.com', role: 'staff',
      accountScope: 'all', scopedLineAccountIds: [], assignedLineAccountId: null,
    }))
  })

  it('招待で名前が空なら送らず、名前の欄に理由を出して名前の欄へ移る', async () => {
    await act(async () => { buttonByText('招待する')!.click() })
    await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    const email = screen.getByRole('textbox', { name: 'メールアドレス' }) as HTMLInputElement
    await act(async () => { fireEvent.change(email, { target: { value: 'staff@example.com' } }) })
    await act(async () => { buttonByText('招待メールを送る')!.click() })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(create).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain('名前を入力してください')
    expect(dialog.querySelector('input[id$="-name"]')?.closest('[data-form-requirement]')?.getAttribute('data-form-requirement')).toBe('required')
    expect(email.closest('[data-form-requirement]')?.getAttribute('data-form-requirement')).toBe('required')
    expect((document.activeElement as HTMLInputElement | null)?.id).toMatch(/-name$/)
  })

  it('確認の間は変更の窓を閉じ、やめたら入れた中身のまま戻り、役割を変えないときは役割を送らない', async () => {
    await act(async () => { buttonByText('見本 30のその他操作')!.click() })
    await flush()
    await act(async () => { buttonByText('権限を変更する')!.click() })
    await flush()
    expect(dialogTitles()).toEqual(['メンバーの権限を変更する'])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('予約・配信などの業務を操作できます。メンバーの追加や決済の変更はできません。')
    // 担当者のまま。状態だけ無効にする。
    const inactive = Array.from(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')).find((r) => r.value === 'inactive')!
    await act(async () => { inactive.click() })
    await act(async () => { buttonByText('変更を保存する')!.click() })
    await flush()
    expect(dialogTitles()).toEqual(['見本 30 さんの権限を変えますか？'])

    await act(async () => { buttonByText('キャンセル')!.click() })
    await flush()
    expect(dialogTitles()).toEqual(['メンバーの権限を変更する'])
    const stillInactive = Array.from(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')).find((r) => r.value === 'inactive')!
    expect(stillInactive.checked).toBe(true)

    await act(async () => { buttonByText('変更を保存する')!.click() })
    await flush()
    await act(async () => { buttonByText('変える')!.click() })
    await flush()
    expect(update).toHaveBeenCalledTimes(1)
    const body = update.mock.calls[0][1] as Record<string, unknown>
    expect(body).not.toHaveProperty('role')
    expect(body.isActive).toBe(false)
    expect(body).toEqual(expect.objectContaining({
      assignedLineAccountId: 'acc-1', accountScope: 'accounts', scopedLineAccountIds: ['acc-1'],
    }))
  })

  it('WEB216：統括（owner）の状態だけを変えても、役割（owner→admin）を送らない', async () => {
    const ownerMember = { ...staffMember, id: 'stf-owner', name: '本部 太郎', role: 'owner', accountScope: 'all', scopedLineAccountIds: [] }
    list.mockResolvedValue({ success: true, data: [ownerMember, staffMember] })
    await act(async () => { root!.render(<HqMembersV8 key="again" />) })
    await flush()
    const edit = buttonByText('本部 太郎のその他操作')
    expect(edit).toBeTruthy()
    await act(async () => { edit!.click() })
    await flush()
    await act(async () => { buttonByText('権限を変更する')!.click() })
    await flush()
    // 範囲は選べない。状態だけ無効にする。
    expect(screen.queryByRole('radio', { name: '指定したアカウントだけ' })).toBeNull()
    const inactive = Array.from(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')).find((r) => r.value === 'inactive')!
    await act(async () => { inactive.click() })
    await act(async () => { buttonByText('変更を保存する')!.click() })
    await flush()
    expect(dialogTitles()).toEqual(['本部 太郎 さんの権限を変えますか？'])
    // 管理者を止めるので本人確認つきの確定になる。
    await act(async () => { buttonByText('確認コードを入れて変える')!.click() })
    await flush()
    expect(update).toHaveBeenCalled()
    const body = update.mock.calls.at(-1)![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('role')
    expect(body.isActive).toBe(false)
  })
})

describe('V8 統括のメンバーの表の列（絵 r4ARpV・2026-10-08）', () => {
  it('名前の列は 160 で守り、伸び縮みするのはメールアドレスだけ', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, 'members.module.css'), 'utf8')
    const globals = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')
    const columns = css.match(/\.head,\s*\.row\s*\{[^}]*grid-template-columns:\s*([^;]+);/)?.[1].trim().split(/\s+(?![^(]*\))/)
    expect(columns).toEqual([
      'var(--tpl-hq-col-name)', 'minmax(0, 1fr)', 'var(--tpl-hq-col-role)', 'var(--tpl-hq-col-scope)',
      'var(--tpl-hq-col-state)', 'var(--tpl-hq-col-login)', 'var(--tpl-hq-col-action)',
    ])
    const value = (name: string) => globals.match(new RegExp(`--tpl-hq-col-${name}:\\s*([^;]+);`))?.[1]
    expect([value('name'), value('role'), value('scope'), value('state'), value('login'), value('action')])
      .toEqual(['160px', '80px', '110px', '80px', '90px', '80px'])
  })
})
