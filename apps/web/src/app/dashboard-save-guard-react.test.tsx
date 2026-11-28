// @vitest-environment happy-dom
import { act } from 'react'
import { waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 共通ダッシュボード本体の境界/既存カードを検査する。業種の入口分岐はhome.test.tsxが検査する。
import DashboardPage from '@/v8/dashboard/dashboard'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '店' }, loading: false }),
}))

type PendingSave = { body: { version: number; cards: unknown }; resolve: (response: Response) => void }
let pending: PendingSave[]
let host: HTMLDivElement
let root: Root
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

beforeEach(() => {
  pending = []
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path.includes('/api/staff/me')) return Promise.resolve(json({ success: true, data: { id: 'test-owner', role: 'owner' } }))
    if (path.includes('/api/dashboard/preferences?')) {
      if (init?.method === 'PUT') {
        return new Promise<Response>(resolve => pending.push({ body: JSON.parse(String(init.body)), resolve }))
      }
      return Promise.resolve(json({ success: true, data: { version: 7, cards: {} } }))
    }
    return Promise.resolve(json({ success: false, error: 'not available' }, 404))
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  // アサーション失敗でも保留通信を残して次の試験へ漏らさない。
  await act(async () => {
    for (const save of pending) save.resolve(json({ success: false, error: 'test cleanup' }, 400))
    await Promise.resolve()
  })
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function button(text: string): HTMLButtonElement {
  const node = Array.from(document.body.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  if (!node) throw new Error(`Button not found: ${text}`)
  return node
}

async function openEditor() {
  await act(async () => { root.render(<DashboardPage />) })
  await act(async () => { button('表示を変更する').click() })
  await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull())
}

describe('N-006 ダッシュボード保存の連打防止 (#758)', () => {
  it('応答保留中の同一描画内の連打でもPUTは1回で、保存中表示とdisabledを保つ', async () => {
    await openEditor()
    const save = button('ダッシュボードに反映')
    await act(async () => {
      // Reactがdisabledを描画する前に2回発火し、同期ガード自体を検証する。
      save.click()
      save.click()
    })
    expect(pending).toHaveLength(1)
    expect(pending[0].body.version).toBe(7)
    expect(button('保存しています…').disabled).toBe(true)
    expect(button('保存しています…').getAttribute('aria-busy')).toBe('true')
    expect(button('初期状態に戻す').disabled).toBe(true)
    await act(async () => { button('保存しています…').click() })
    expect(pending).toHaveLength(1)
    await act(async () => { pending[0].resolve(json({ success: true, data: { version: 8 } })) })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('別の画面で配置が更新されました')
    await act(async () => { button('表示を変更する').click() })
  await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull())
    await act(async () => { button('ダッシュボードに反映').click() })
    expect(pending).toHaveLength(2)
    expect(pending[1].body.version).toBe(8)
  })

  it('保存失敗後は編集を残して同じ内容で再試行できる', async () => {
    await openEditor()
    await act(async () => { button('ダッシュボードに反映').click() })
    await act(async () => { pending[0].resolve(json({ success: false, error: 'unavailable' }, 503)) })
    expect(button('ダッシュボードに反映').disabled).toBe(false)
    expect(document.body.textContent).toContain('配置を保存できませんでした')
    await act(async () => { button('ダッシュボードに反映').click() })
    expect(pending).toHaveLength(2)
    expect(pending[1].body).toEqual(pending[0].body)
    await act(async () => { pending[1].resolve(json({ success: true, data: { version: 8 } })) })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('本当の409は自動で上書きせず既存の競合案内を維持する', async () => {
    await openEditor()
    await act(async () => { button('ダッシュボードに反映').click() })
    await act(async () => { pending[0].resolve(json({ success: false, error: 'conflict', currentVersion: 8 }, 409)) })
    expect(pending).toHaveLength(1)
    expect(button('ダッシュボードに反映').disabled).toBe(false)
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('ほかの人が先にダッシュボードの配置を保存しました')
  })
})
