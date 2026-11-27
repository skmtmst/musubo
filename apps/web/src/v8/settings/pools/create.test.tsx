import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * ★V8-B プール管理の「プールを作る」（板 ）。
 * 番号つきの節・複数の受け入れ先・部分失敗の伝え方が動くこと。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const staff = vi.hoisted(() => ({ role: 'owner' as string | null }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => staff.role }))

const lineAccountsList = vi.hoisted(() => vi.fn())
const poolsCreate = vi.hoisted(() => vi.fn())
const poolsAccountsAdd = vi.hoisted(() => vi.fn())
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: lineAccountsList },
      pools: {
        ...actual.api.pools,
        create: poolsCreate,
        accounts: { ...actual.api.pools.accounts, add: poolsAccountsAdd },
      },
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}))

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
}))

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))

import PoolNewV8 from './create'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import PoolNewPage from '@/app/pools/new/page'


const ACCOUNTS = [
  { id: 'a1', name: '然-NEN-渋谷店' },
  { id: 'a2', name: '然-NEN-中目黒店' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  staff.role = verifiedStaffRole('owner')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  lineAccountsList.mockReset()
  poolsCreate.mockReset()
  poolsAccountsAdd.mockReset()
  routerPush.mockReset()
  lineAccountsList.mockResolvedValue({ success: true, data: ACCOUNTS })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  clearToastsForTest()
})

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderV8() {
  await act(async () => { root.render(<><PoolNewV8 /><ToastHost /></>) })
  await flush()
}

async function setInput(selector: string, value: string) {
  const input = document.querySelector(selector) as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

describe('V8-B プールを作る（D0AOyx）', () => {
  it('実入口から設定の型の本文にプール名の入力欄を描く', async () => {
    await act(async () => { root.render(<PoolNewPage />) })
    await flush()
    const name = host.querySelector('#pl-name')
    expect(name).toBeTruthy()
    expect(name?.closest('[data-template-region="content"]')?.closest('[data-page-template="settings"]')).toBeTruthy()
    expect(lineAccountsList).toHaveBeenCalled()
  })

  it('入力の誤りは該当欄に一度だけ示し、そこへ移動して保存を止める', async () => {
    await renderV8()
    const save = document.querySelector('button[form="pool-create-form"]') as HTMLButtonElement
    await act(async () => save.click())
    await flush()
    const name = document.querySelector('#pl-name') as HTMLInputElement
    expect(document.activeElement).toBe(name)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect([...document.querySelectorAll('[role="alert"]')].filter(node => node.textContent === '名前を入力してください')).toHaveLength(1)
    expect(poolsCreate).not.toHaveBeenCalled()

    await setInput('#pl-name', '渋谷')
    expect(name.getAttribute('aria-invalid')).not.toBe('true')
    await setInput('#pl-slug', '日本語')
    await act(async () => save.click())
    await flush()
    const slug = document.querySelector('#pl-slug') as HTMLInputElement
    expect(document.activeElement).toBe(slug)
    expect(slug.getAttribute('aria-invalid')).toBe('true')
    expect(poolsCreate).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('保存帯は本文の外に置き、保存ボタンは元の作成フォームへ接続する', async () => {
    await renderV8()
    const frame = document.querySelector('[data-design-node="D0AOyx"]')!
    const footer = frame.querySelector(':scope > [data-template-region="footer"]')
    expect(footer).not.toBeNull()
    const body = frame.querySelector('[data-template-region="body"]')!
    expect(body.contains(footer)).toBe(false)
    const save = [...footer!.querySelectorAll('button')].find(button => button.textContent?.includes('保存してURLを発行'))!
    expect(save.form).toBe(document.getElementById('pool-create-form'))
    const cancel = [...footer!.querySelectorAll('a')].find(link => link.textContent === 'キャンセル')!
    expect(cancel).toBeTruthy()
    expect(cancel.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(footer!.textContent).not.toContain('保存して続けて作る')
    expect(poolsCreate).not.toHaveBeenCalled()
  })

  it('番号つきの節とプレビューが出る', async () => {
    await renderV8()
    expect(document.querySelector('[data-design-node="D0AOyx"]'), '板IDの枠がある').toBeTruthy()
    expect(document.body.textContent).toContain('1. どのプールか')
    expect(document.body.textContent).toContain('2. いまの受け入れ先')
    expect(document.body.textContent).toContain('プレビュー')
  })

  async function chooseSecondAccount() {
    // 2件目を足す（共有 Select は小さな窓で選ぶ形）
    const addButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('アカウントを足す'))
    await act(async () => { addButton!.click() })
    await flush()
    await pickEntity('足すアカウント', '然-NEN-中目黒店')
    await flush()
    const add = [...document.querySelectorAll('button')].find((b) => b.textContent === '追加')
    await act(async () => { add!.click() })
    await flush()
  }

  it('複数の受け入れ先を一度に保存する', async () => {
    poolsCreate.mockResolvedValue({ success: true, data: { id: 'p1' } })
    poolsAccountsAdd.mockResolvedValue({ success: true, data: {} })
    await renderV8()
    await setInput('#pl-name', '渋谷エリア')
    await setInput('#pl-slug', 'shibuya')
    await chooseSecondAccount()
    expect(document.body.textContent).toContain('然-NEN-中目黒店')

    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('保存してURLを発行'))
    expect(save, '保存の帯がある').toBeTruthy()
    await act(async () => { save!.click() })
    await flush()
    expect(poolsCreate).toHaveBeenCalledWith({ name: '渋谷エリア', slug: 'shibuya', activeAccountId: 'a1', accountIds: ['a1', 'a2'] })
    expect(poolsAccountsAdd).not.toHaveBeenCalled()
    expect(routerPush, '保存できたら一覧へ進む').toHaveBeenCalled()
    expect(document.body.textContent).toContain('プールを作成しました。')
  })

  it('保存失敗時は入力を残して再試行できる', async () => {
    poolsCreate.mockResolvedValue({ success: false, error: '保存できませんでした' })
    poolsAccountsAdd.mockResolvedValue({ success: false, error: 'down' })
    await renderV8()
    await setInput('#pl-name', '渋谷エリア')
    await setInput('#pl-slug', 'shibuya2')
    await chooseSecondAccount()
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('保存してURLを発行'))
    await act(async () => { save!.click() })
    await flush()
    expect(document.body.textContent).toContain('保存できませんでした')
    expect(document.body.textContent).toContain('然-NEN-中目黒店')
    expect(poolsAccountsAdd).not.toHaveBeenCalled()
    expect(routerPush, '落ちた分があるときは進まない').not.toHaveBeenCalled()
  })

  /* 板の印は「番号つきの節とプレビューが出る」で描画して確かめる。 */
  it('実際のプール作成画面に未接続の準備中を表示しない', async () => {
    await act(async () => { root.render(<PoolNewPage />) })
    await flush()
    expect(host.querySelector('#pl-name')).toBeTruthy()
    expect(host.textContent).not.toContain('準備中')
  })
})

it('未保存の入力があればキャンセル前に確認し、編集を続けると入力を残す', async () => {
  window.history.replaceState(null, '', '/pools/new')
  await renderV8()
  await setInput('#pl-name', '入力途中のプール')
  const cancel = [...document.querySelectorAll('a')].find(a => a.textContent === 'キャンセル')!
  await act(async () => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await flush()
  expect(document.body.textContent).toContain('保存せずに移る')
  const stay = [...document.querySelectorAll('button')].find(b => b.textContent === '編集を続ける')!
  await act(async () => stay.click())
  expect((document.querySelector('#pl-name') as HTMLInputElement).value).toBe('入力途中のプール')
  expect(routerPush).not.toHaveBeenCalled()
})
it('保存成功後は離脱確認を解除して一覧へ進む', async () => {
  poolsCreate.mockResolvedValue({ success: true, data: { id: 'p1' } })
  await renderV8()
  await setInput('#pl-name', '渋谷'); await setInput('#pl-slug', 'shibuya')
  await act(async () => { (document.querySelector('button[form="pool-create-form"]') as HTMLButtonElement).click() })
  expect(routerPush).toHaveBeenCalledTimes(1)
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it.each([null, 'admin', 'staff', 'viewer'])('owner以外の直接URL（%s）は入力と保存を出さず作成を呼ばない', async (role) => {
  staff.role = verifiedStaffRole(role)
  await renderV8()
  if (role === null) expect(host.querySelector('[data-read-only-notice]')).toBeNull()
  else expect(host.textContent).toContain('プールを作れるのはオーナーだけです')
  expect(host.querySelector('#pool-create-form')).toBeNull()
  expect(host.querySelector('button[form="pool-create-form"]')).toBeNull()
  expect(host.querySelector('a[href="/pools"]')).toBeTruthy()
  expect(lineAccountsList).not.toHaveBeenCalled()
  expect(poolsCreate).not.toHaveBeenCalled()
})

afterEach(() => { verifiedStaffRole(null) })
