// @vitest-environment happy-dom
/*
 * 機能設定：権限がない時も灰色の操作と共通理由を保ち、下書きと送信を変更しない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFeatureSettingsCache } from '@/lib/feature-settings-cache'
import { fireEvent, renderHook, within } from '@testing-library/react'
import { useFeatureSettings } from './use-feature-settings'
import { CATALOG_DEFAULT_FEATURES } from './feature-settings-view'
import type { FeatureGroup } from '@/lib/feature-settings'
import { PERMISSION_LOCK_REASON, PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { READ_ONLY_MESSAGE } from '@/components/shared/read-only-notice'
import { rememberStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'

const fixture = vi.hoisted(() => ({ role: 'owner', identity: 'ready', account: 'account-a', style: 'standard', styleSelected: true }))
const heldImpact = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.title === 'オフにする前に確認' && props.onConfirm) heldImpact.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/settings',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account, loading: false }),
}))

const { default: FeatureSettingsScreen } = await import('./screen')

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  heldImpact.confirm = null
  clearFeatureSettingsCache()
  fixture.role = 'owner'
  fixture.identity = 'ready'
  fixture.account = 'account-a'
  fixture.style = 'standard'
  fixture.styleSelected = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = String(input)
    if (path.includes('/api/staff/me') && fixture.identity === 'pending') return new Promise<Response>(() => {})
    if (path.includes('/api/staff/me') && fixture.identity === 'failed') return response({ success: false, error: '読み込めませんでした' }, 503)
    if (path.includes('/api/staff/me')) return response({ success: true, data: { id: 'staff-1', role: fixture.role, permissionKeys: [] } })
    if (path.includes('/api/dashboard/style')) return response({ success: true, data: { style: fixture.style, styleSelected: fixture.styleSelected } })
    if (path.includes('/api/settings/features')) {
      return response({
        success: true,
        data: { features: { scenarios: true, broadcasts: true, webinars: false }, sidebarItemOrder: {}, specializedFeatureKeys: [], version: 3 },
      })
    }
    if (path.includes('/api/analytics/usage')) return response({ success: true, data: { categories: [] } })
    return response({ success: false, error: 'not found' }, 404)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await Promise.resolve()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
}

const buttonNames = () => [...host.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '')

describe('★V8 機能設定の閲覧のみ', () => {
  it('機能停止の確認に対象アカウントと環境を示す', async () => {
    fixture.role = 'owner'
    const originalFetch = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/api/settings/features/impact')) return response({ success: true, data: { version: 3, impacts: [{ feature: 'scenarios', items: [{ kind: 'scheduled', targetType: '配信', count: 2 }], blocking: true }], requiresConfirmation: true, impactToken: 'fixture' } })
      return originalFetch(input, init)
    })
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      const toggle = [...host.querySelectorAll('[role="switch"]')].find(el => el.getAttribute('aria-label')?.includes('シナリオ配信'))!
      expect(toggle).toBeTruthy()
      await act(async () => { fireEvent.click(toggle) })
      const reason = host.querySelector<HTMLInputElement>('#feature-settings-reason')!
      await act(async () => { fireEvent.change(reason, { target: { value: '運用変更' } }) })
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: '機能設定を保存' })) })
      await flush()
      const dialog = within(document.body).getByRole('alertdialog', { name: 'オフにする前に確認' })
      expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
      expect(within(dialog).getByText('環境')).toBeTruthy()
      const impactLabel = within(dialog).getByText('止まるもの')
      expect(impactLabel.tagName).toBe('DT')
      expect(impactLabel.nextElementSibling?.textContent).toMatch(/シナリオ配信.*配信\s*2\s*件/)
      expect(dialog.querySelector('[title="account-a"]')).toBeTruthy()
      expect(dialog.querySelector('.lucide-trash-2')).toBeNull()
      const held = heldImpact.confirm!
      fixture.account = 'account-b'
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      expect(within(document.body).queryByRole('alertdialog', { name: 'オフにする前に確認' })).toBeNull()
      fixture.account = 'account-a'
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      const impactCalls = spy.mock.calls.filter(([input]) => String(input).includes('/api/settings/features/impact')).length
      await act(async () => { await held() })
      expect(within(document.body).queryByRole('alertdialog', { name: 'オフにする前に確認' })).toBeNull()
      expect(spy.mock.calls.filter(([input]) => String(input).includes('/api/settings/features/impact'))).toHaveLength(impactCalls)
      expect(spy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    } finally { spy.mockRestore() }
  })
  it('権限がない人の星は無効として共通の表示対象になる', async () => {
    fixture.style = 'restaurant'
    fixture.role = 'viewer'
    await act(async () => { root.render(<FeatureSettingsScreen />) })
    await flush()
    const star = within(host).getByRole('button', { name: '予約台帳をお気に入りに入れる' }) as HTMLButtonElement
    expect(star.disabled).toBe(true)
    expect(star.parentElement?.hasAttribute('data-disabled')).toBe(true)
  })
  it('飲食店の機能行で星を選ぶと黄色の状態になり、保存対象になる', async () => {
    fixture.style = 'restaurant'
    await act(async () => { root.render(<FeatureSettingsScreen />) })
    await flush()
    const star = within(host).getByRole('button', { name: '予約台帳をお気に入りに入れる' })
    expect(star.getAttribute('aria-pressed')).toBe('false')
    await act(async () => { fireEvent.click(star) })
    expect(within(host).getByRole('button', { name: '予約台帳をお気に入りから外す' }).getAttribute('aria-pressed')).toBe('true')
    expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(true)
  })

  it.each([
    ['standard', false],
    ['ec', true],
  ] as const)('使い方が%sの機能設定でEC連携の行を%sにする', async (style, visible) => {
    fixture.account = `account-${style}`
    fixture.style = style
    await act(async () => { root.render(<FeatureSettingsScreen />) })
    await flush()
    await act(async () => { fireEvent.click(within(host).getByRole('button', { name: '設定を開く' })) })
    expect(Boolean(within(host).queryByText('EC連携'))).toBe(visible)
  })

  it('初期値に戻す項目は印なしで、取消は下書きを保ち、確認しても保存するまで送信しない', async () => {
    fixture.role = 'owner'
    const requestMethod = ([input, init]: Parameters<typeof fetch>) =>
      (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/api/settings/features')) return response({
        success: true,
        data: {
          features: { ...CATALOG_DEFAULT_FEATURES, scenarios: !CATALOG_DEFAULT_FEATURES.scenarios },
          sidebarItemOrder: { delivery: ['broadcasts', 'scenarios'] }, specializedFeatureKeys: [], version: 3,
        },
      })
      return originalFetch(input, init)
    })
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      const switches = () => [...host.querySelectorAll('[role="switch"]')].map((element) => ({
        name: element.getAttribute('aria-label')?.replace(/を(?:オン|オフ)にする$/, ''), checked: element.getAttribute('aria-checked'),
      }))
      const deliveryNames = () => [...host.querySelector('[aria-label="配信"]')!.querySelectorAll('li')]
        .map((row) => row.querySelector('p')?.firstElementChild?.textContent)
      const before = switches()
      expect(before.length).toBeGreaterThan(0)
      expect(deliveryNames().slice(0, 2)).toEqual(['一斉配信', 'シナリオ配信'])
      expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(false)
      const openReset = async () => {
        await act(async () => { fireEvent.click(host.querySelector('[aria-label="機能設定のほかの操作"]')!) })
        await flush()
        const item = within(document.body).getByRole('menuitem', { name: '初期値に戻す', exact: true })
        expect(item.querySelector('svg')).toBeNull()
        await act(async () => { fireEvent.click(item) })
        await flush()
        return within(document.body).getByRole('dialog', { name: '初期値に戻しますか？', exact: true })
      }
      let dialog = await openReset()
      expect(dialog.textContent).toContain('機能ごとの表示（オン・オフ）')
      expect(dialog.textContent).toContain('メニューの並び順')
      expect(switches()).toEqual(before)
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true })) })
      await flush()
      expect(within(document.body).queryByRole('dialog', { name: '初期値に戻しますか？', exact: true })).toBeNull()
      expect(switches()).toEqual(before)
      expect(deliveryNames().slice(0, 2)).toEqual(['一斉配信', 'シナリオ配信'])
      expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(false)
      dialog = await openReset()
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '初期値を下書きに入れる', exact: true })) })
      await flush()
      expect(within(document.body).queryByRole('dialog', { name: '初期値に戻しますか？', exact: true })).toBeNull()
      const after = switches()
      expect(after).not.toEqual(before)
      expect(deliveryNames().slice(0, 2)).toEqual(['シナリオ配信', '一斉配信'])
      const previous = new Map(before.map((entry) => [entry.name, entry.checked]))
      const changed = after.filter((entry) => entry.checked !== previous.get(entry.name))
      expect(changed).toEqual([{ name: 'シナリオ配信', checked: String(CATALOG_DEFAULT_FEATURES.scenarios) }])
      expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(true)
      expect(fetchSpy.mock.calls.filter((call) => !['GET', 'HEAD'].includes(requestMethod(call)))).toHaveLength(0)
    } finally { fetchSpy.mockRestore() }
  })

  it('変更理由が空なら送信せず、その欄へ移動して誤りを一度だけ知らせる', async () => {
    fixture.role = 'owner'
    const scroll = vi.fn()
    const originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      await act(async () => { fireEvent.click(host.querySelector('[role="switch"]:not([aria-label*="まとめて"])')!) })
      const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('機能設定を保存'))!
      await act(async () => { fireEvent.click(save) })
      const reason = host.querySelector<HTMLInputElement>('#feature-settings-reason')!
      expect(reason.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(reason)
      expect(scroll).toHaveBeenCalledWith({ block: 'center' })
      expect(host.textContent?.match(/変更理由を入力してください/g)).toHaveLength(1)
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll
      fetchSpy.mockRestore()
    }
  })
  it('すべてオンとすべてオフは下書きだけを変え、保存前には送信しない', async () => {
    fixture.role = 'owner'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      const group = host.querySelector('[role="group"][aria-label$="の一括設定"]')!
      const buttons = group.querySelectorAll('button')
      await act(async () => { fireEvent.click(buttons[1]) })
      expect(group.textContent).toMatch(/件中 0 件オン/)
      await act(async () => { fireEvent.click(buttons[0]) })
      const count = group.textContent?.match(/(\d+) 件中 (\d+) 件オン/)
      expect(count?.[1]).toBe(count?.[2])
      expect(fetchSpy.mock.calls.filter(([, init]) => !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()))).toHaveLength(0)
    } finally { fetchSpy.mockRestore() }
  })
  it('一括でオフにする時も変更不可の機能を下書き上で維持する', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const hook = renderHook(() => useFeatureSettings())
    try {
      await flush()
      expect(hook.result.current.features.scenarios).toBe(true)
      expect(hook.result.current.features.broadcasts).toBe(true)
      const group: FeatureGroup = { id: 'delivery', label: '配信', items: [
        { id: 'scenarios', label: 'シナリオ', note: '変更できません', keys: ['scenarios'], required: true },
        { id: 'broadcasts', label: '一斉配信', note: '配信に使います', keys: ['broadcasts'] },
      ] }
      await act(async () => { hook.result.current.toggleGroup(group, false) })
      expect(hook.result.current.features.scenarios).toBe(true)
      expect(hook.result.current.features.broadcasts).toBe(false)
      expect(fetchSpy.mock.calls.filter(([, init]) => !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()))).toHaveLength(0)
    } finally { hook.unmount(); fetchSpy.mockRestore() }
  })
  it('オーナーは変更した時だけ保存の帯が現れ、元へ戻すと消える', async () => {
    fixture.role = 'owner'
    await act(async () => { root.render(<FeatureSettingsScreen />) })
    await flush()
    expect(host.querySelectorAll('[role="switch"]:not([aria-label*="まとめて"])').length).toBeGreaterThan(0)
    expect(buttonNames()).toContain('並びを変える')
    expect(host.querySelector('[role="switch"][aria-label*="まとめて"]')).toBeNull()
    expect(buttonNames()).toContain('すべてオン')
    expect(buttonNames()).toContain('すべてオフ')
    expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(false)
    const checkbox = host.querySelector('[role="switch"]:not([aria-label*="まとめて"])')!
    await act(async () => { fireEvent.click(checkbox) })
    expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(true)
    await act(async () => { fireEvent.click(checkbox) })
    expect(buttonNames().some((name) => name.includes('機能設定を保存'))).toBe(false)
    expect(host.textContent).not.toContain('閲覧のみで見ています')
  })

  it.each(['staff', 'viewer'])('%sにも行・一括・並び・初期値の操作を灰色と理由付きで残し、下書きも送信も変更しない', async role => {
    fixture.role = role
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      expect(host.textContent).toContain(role === 'viewer' ? READ_ONLY_MESSAGE : PERMISSION_LOCK_SUMMARY.manager)
      const controls = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      expect(controls.length).toBeGreaterThan(0)
      const before = controls.map(button => button.getAttribute('aria-checked'))
      const actions = within(host)
      const locked = [...controls, actions.getByRole('button', { name: '並びを変える' }) as HTMLButtonElement,
        ...actions.getAllByRole('button', { name: /をすべて(?:オン|オフ)$/ }) as HTMLButtonElement[]]
      const reason = role === 'viewer' ? PERMISSION_LOCK_REASON.viewer : PERMISSION_LOCK_REASON.manager
      for (const button of locked) {
        expect(button.disabled).toBe(false)
        expect(button.getAttribute('aria-disabled')).toBe('true')
        expect(button.getAttribute('aria-describedby')!.split(/\s+/).map(id => document.getElementById(id)?.textContent)).toContain(reason)
        await act(async () => { fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' }) })
      }
      await act(async () => { fireEvent.click(actions.getByRole('button', { name: '機能設定のほかの操作' })) })
      await flush()
      const reset = within(document.body).getByRole('menuitem', { name: '初期値に戻す', exact: true })
      expect(reset.getAttribute('aria-disabled')).toBe('true')
      await act(async () => { fireEvent.click(reset) })
      expect(within(document.body).queryByRole('dialog')).toBeNull()
      expect(controls.map(button => button.getAttribute('aria-checked'))).toEqual(before)
      expect(fetchSpy.mock.calls.filter(([, init]) => !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()))).toHaveLength(0)
    } finally { fetchSpy.mockRestore() }
  })

  it.each(['pending', 'failed'])('本人が%sの間は共通理由を出さず通常disabledにして、設定を変更・送信しない', async identity => {
    fixture.role = 'owner'; fixture.identity = identity
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      const controls = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      expect(controls.length).toBeGreaterThan(0)
      for (const button of controls) {
        expect(button.disabled).toBe(true)
        expect(button.hasAttribute('data-permission-locked')).toBe(false)
        await act(async () => { fireEvent.click(button) })
      }
      expect((within(host).getByRole('button', { name: '並びを変える' }) as HTMLButtonElement).disabled).toBe(true)
      expect(host.querySelector('[data-read-only-notice]')).toBeNull()
      expect(within(document.body).queryByRole('tooltip')).toBeNull()
      const writes = fetchSpy.mock.calls.filter(([, init]) => !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()))
      expect(writes.map(([input, init]) => ({ path: new URL(String(input), 'http://localhost').pathname, method: init?.method }))).toEqual(
        identity === 'failed' ? [{ path: '/api/client-errors', method: 'POST' }] : [],
      )
      if (identity === 'failed') expect(JSON.parse(String(writes[0][1]?.body)).message).toBe('API 503: /api/staff/me')
    } finally { fetchSpy.mockRestore() }
  })

  it('編集中に閲覧のみへ変わっても下書きを保ち、確認中のresetと保存を起動しない', async () => {
    fixture.role = 'owner'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await act(async () => { root.render(<FeatureSettingsScreen />) })
      await flush()
      await act(async () => { fireEvent.click(host.querySelector('[role="switch"]')!) })
      const before = [...host.querySelectorAll('[role="switch"]')].map(button => button.getAttribute('aria-checked'))
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: '機能設定のほかの操作' })) })
      await flush()
      await act(async () => { fireEvent.click(within(document.body).getByRole('menuitem', { name: '初期値に戻す', exact: true })) })
      await flush()
      expect(within(document.body).getByRole('dialog', { name: '初期値に戻しますか？' })).toBeTruthy()
      await act(async () => { rememberStaffIdentity({ ...readStaffIdentity()!, role: 'viewer' }) })
      await flush()
      expect(within(document.body).queryByRole('dialog')).toBeNull()
      const save = within(host).getByRole('button', { name: '機能設定を保存' })
      expect(save.getAttribute('aria-disabled')).toBe('true')
      await act(async () => { fireEvent.click(save) })
      expect([...host.querySelectorAll('[role="switch"]')].map(button => button.getAttribute('aria-checked'))).toEqual(before)
      expect(fetchSpy.mock.calls.filter(([, init]) => !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()))).toHaveLength(0)
    } finally { fetchSpy.mockRestore() }
  })

  it('探す言葉に合う機能が無いときは「条件を外す」を出し、押すと一覧へ戻る', async () => {
    fixture.role = 'owner'
    await act(async () => { root.render(<FeatureSettingsScreen />) })
    await flush()
    const search = host.querySelector<HTMLInputElement>('input[aria-label="機能の名前で探す"]')!
    await act(async () => { fireEvent.change(search, { target: { value: '存在しない機能の名前' } }) })
    /* 探す欄は打ち終わりを少し待ってから絞る。 */
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 350)) })
    await flush()
    expect(host.textContent).toContain('条件に合うものはありません')
    expect(host.querySelector('[data-design="機能の一覧"]')).toBeNull()
    const clear = [...host.querySelectorAll('button')].find((button) => button.textContent === '条件を外す')!
    await act(async () => { fireEvent.click(clear) })
    await flush()
    expect(host.querySelector('[data-design="機能の一覧"]')).not.toBeNull()
  })
})

it.each(['owner', 'viewer'])('機能設定の操作説明は %s の権限に合う', async role => {
  fixture.role = role
  fixture.style = 'restaurant'
  await act(async () => { root.render(<FeatureSettingsScreen />) })
  await flush()
  await act(async () => { fireEvent.click(within(host).getByRole('button', { name: 'この画面の説明' })) })
  expect(document.body.textContent).toContain(role === 'owner' ? '並び順は「並びを変える」から入れ替えます。' : '機能ごとの設定を確認できます。')
  if (role === 'viewer') {
    expect(document.body.textContent).not.toContain('並び順は「並びを変える」から入れ替えます。')
    expect(document.body.textContent).not.toContain('星を選ぶと左メニューのお気に入りに表示します。')
  }
})

it.each(['owner', 'viewer'])('変更できない機能の並替案内は %s の権限に合う', async role => {
  fixture.role = role
  await act(async () => { root.render(<FeatureSettingsScreen />) })
  await flush()
  const main = within(host).getByRole('region', { name: 'メイン' })
  expect(main.textContent).toContain('消せません')
  expect(main.textContent?.includes('並びだけ変えられる')).toBe(role === 'owner')
})
