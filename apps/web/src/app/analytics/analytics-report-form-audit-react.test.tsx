// @vitest-environment happy-dom
import React, { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportNewPage from './reports/new/page'

/**
 * 定期レポート作成フォームの監査 R449・R453〜R455。
 *
 * R453: 変えない保存で通知方法が変わらない（担当者メール利用・メールのみ）。
 * R455: 遅い保存応答で編集先が前の依頼に戻らない。
 * R449: 保存後に受け取れなくなった担当者を編集画面で知らせる。
 * R454: しまった1回送信も依頼IDで結果へ到達し、送り直せる。
 */

const fixture = vi.hoisted(() => ({
  editId: null as string | null,
  role: 'owner' as 'owner' | 'staff',
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  handler: ((url: string) =>
    Promise.reject(new Error(`未設定: ${url}`))) as
      (url: string, init?: RequestInit) => Promise<unknown>,
  resolvers: [] as Array<(value: unknown) => void>,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => ({ get: (key: string) => (key === 'id' ? fixture.editId : null) }),
  usePathname: () => '/analytics/reports/new',
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
  usePageChrome: () => ({ title: null, fullWidth: false }),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { return this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = await net.handler(path, init)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

const OPTIONS = {
  timeZone: 'Asia/Tokyo',
  savedAnalyses: [],
  recipients: [{ id: 'u-1', name: '担当1', role: 'owner', email: 'u1@example.com', lineLinked: true }],
}

const STAFF_SCHEDULE = {
  id: 'report-1', lineAccountId: 'account-a', name: '担当者メール利用',
  sections: ['friends'], savedAnalysisIds: [],
  cadence: 'weekly', weekday: 1, monthDay: null,
  sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
  recipients: [{ kind: 'staff', staffId: 'u-1', label: '担当1' }],
  channels: ['dashboard', 'email', 'line'], alertRules: [],
  status: 'active', isOneTime: false,
  nextRunAt: '2026-09-28T00:00:00.000Z', createdBy: 'u-1',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}

const EMAIL_ONLY_SCHEDULE = {
  ...STAFF_SCHEDULE,
  id: 'report-2', name: 'メールのみ',
  recipients: [{ kind: 'email', email: 'direct@example.com', label: 'direct@example.com' }],
  channels: ['email'],
}

const FAILED_ONE_TIME = {
  schedule: {
    ...STAFF_SCHEDULE, id: 'once-1', name: '1回送信', isOneTime: true, status: 'archived',
  },
  runs: [{
    id: 'run-1', scheduleId: 'once-1', lineAccountId: 'account-a',
    scheduledFor: '2026-09-07T00:00:00.000Z', state: 'failed',
    deliveryResults: [{ channel: 'email', recipient: 'direct@example.com', status: 'failed', reason: 'x' }],
    errorCode: 'synthetic_mail_failed', startedAt: '2026-09-07T00:00:00.000Z', completedAt: '2026-09-07T00:01:00.000Z',
  }],
}

function listHandler(items: unknown[]) {
  return (path: string, init?: RequestInit) => {
    if (path === '/api/staff/me') return Promise.resolve({ success: true, data: { role: fixture.role } })
    if (path.startsWith('/api/analytics/report-schedules/once-1/runs')) {
      return Promise.resolve({ success: true, data: FAILED_ONE_TIME })
    }
    if (path.startsWith('/api/analytics/report-schedules/') && path.includes('/runs')) {
      return Promise.resolve({ success: false, error: 'Not found' })
    }
    if (path.startsWith('/api/analytics/report-schedules/once-1/retry')) {
      return Promise.resolve({ success: true, data: { ...FAILED_ONE_TIME.schedule, status: 'active' } })
    }
    if (path.startsWith('/api/analytics/report-schedules/') && init?.method === 'PUT') {
      const id = path.split('/').at(-1)?.split('?').at(0)
      const found = (items as Array<{ id: string }>).find((item) => item.id === id)
      return Promise.resolve({
        success: true,
        data: { ...(found ?? STAFF_SCHEDULE), updatedAt: '2026-09-02T00:00:00.000Z' },
      })
    }
    if (path.startsWith('/api/analytics/report-schedules')) {
      return Promise.resolve({ success: true, data: { items, options: OPTIONS } })
    }
    return Promise.reject(new Error(`未設定: ${path}`))
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.editId = null
  fixture.role = 'owner'
  net.calls.length = 0
  net.resolvers.length = 0
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<ReportNewPage />) })
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  )
  if (!found) throw new Error(`ボタンが見つからない: ${label}`)
  return found
}

describe('R453 変えない保存で通知方法が変わらない', () => {
  it('担当者メール利用の設定は channels がそのまま残る', async () => {
    fixture.editId = 'report-1'
    net.handler = listHandler([STAFF_SCHEDULE])
    await render()
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('担当者メール利用')

    await act(async () => { button('変更を保存する').click() })
    const putCall = net.calls.find((call) => call.path.startsWith('/api/analytics/report-schedules/report-1?') && call.method === 'PUT')
    expect(putCall).toBeTruthy()
    // 担当者のメールを使う設定から email が外れない
    expect(putCall?.body).toMatchObject({ channels: ['dashboard', 'email', 'line'] })
  })

  it('メールのみの設定に管理画面のお知らせが付かない', async () => {
    fixture.editId = 'report-2'
    net.handler = listHandler([EMAIL_ONLY_SCHEDULE])
    await render()
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('メールのみ')

    await act(async () => { button('変更を保存する').click() })
    const putCall = net.calls.find((call) => call.path.startsWith('/api/analytics/report-schedules/report-2?') && call.method === 'PUT')
    expect(putCall).toBeTruthy()
    expect(putCall?.body).toMatchObject({ channels: ['email'] })
  })
})

describe('R455 遅い保存応答で編集先が戻らない', () => {
  it('A1保存中にA2へ移ると遅いA1応答を捨てる', async () => {
    fixture.editId = 'report-1'
    net.handler = (path: string, init?: RequestInit) => {
      if (path === '/api/staff/me') return Promise.resolve({ success: true, data: { role: 'owner' } })
      if (path.startsWith('/api/analytics/report-schedules/report-1?') && init?.method === 'PUT') {
        // A1の保存応答を遅らせる
        return new Promise((resolve) => { net.resolvers.push(resolve) })
      }
      return listHandler([STAFF_SCHEDULE, EMAIL_ONLY_SCHEDULE])(path, init)
    }
    await render()
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('担当者メール利用')

    // A1の保存を開始（応答はまだ返さない）
    let savePromise: Promise<void> | null = null
    await act(async () => { savePromise = (async () => { button('変更を保存する').click() })() })
    expect(net.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)

    // 同じ画面のままA2へ移る
    fixture.editId = 'report-2'
    await render()
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('メールのみ')

    // 遅れてA1の成功応答が返る
    await act(async () => {
      net.resolvers.splice(0).forEach((resolve) => resolve({
        success: true, data: { ...STAFF_SCHEDULE, updatedAt: '2026-09-02T00:00:00.000Z' },
      }))
      await savePromise
    })

    // A2のまま。A1への2回目のPUTは出ない
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('メールのみ')
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).not.toBe('担当者メール利用')
    const puts = net.calls.filter((call) => call.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].path).toContain('report-1')
  })
})

describe('R449 保存後に受け取れなくなった担当者を知らせる', () => {
  it('候補に無い保存済み宛先を注意書きで出す', async () => {
    fixture.editId = 'report-1'
    const withGone = {
      ...STAFF_SCHEDULE,
      recipients: [
        { kind: 'staff', staffId: 'u-1', label: '担当1' },
        { kind: 'staff', staffId: 'u-9', label: '辞めた担当' },
      ],
    }
    net.handler = listHandler([withGone])
    await render()
    expect(host.textContent).toContain('前に選んでいた「辞めた担当」は、いまは受け取れません')
  })
})

describe('R454 しまった1回送信の結果へ到達し送り直せる', () => {
  it('依頼IDで結果・失敗理由・宛先別結果を確認できる', async () => {
    fixture.editId = 'once-1'
    net.handler = listHandler([])
    await render()
    expect(host.textContent).toContain('1回送信の結果')
    expect(host.textContent).toContain('失敗')
    expect(host.textContent).toContain('direct@example.com')
    expect(host.textContent).not.toContain('定期レポートが見つかりませんでした')
  })

  it('全部失敗の確定分は送り直せる', async () => {
    fixture.editId = 'once-1'
    net.handler = listHandler([])
    await render()
    await act(async () => { button('届いていない分を送り直す').click() })
    const retryCall = net.calls.find((call) => call.path.includes('/once-1/retry') && call.method === 'POST')
    expect(retryCall).toBeTruthy()
  })
})

describe('新しい定期レポートの表示と取得状態', () => {
  it('送る内容・時刻・宛先を表示し、未選択なら作成できない', async () => {
    net.handler = listHandler([])
    await render()
    for (const text of ['何を入れますか', 'いつ送りますか', 'だれに送りますか', '知らせの決めごと', '宛先を足す', 'LINEでも同じ内容を送る', '今すぐ1回だけ送る', 'つくって動かす', 'レポートが見ているもの', '気をつけること', '保存した分析を添えます']) expect(host.textContent).toContain(text)
    expect((host.querySelector('input[placeholder="例：週次まとめ"]') as HTMLInputElement).value).toBe('週次まとめ')
    expect(button('つくって動かす').disabled).toBe(true)
    expect(net.calls.some(call => call.path.startsWith('/api/analytics/report-schedules?') && new URL(call.path, 'http://localhost').searchParams.get('account_id') === 'account-a')).toBe(true)
  })
  it('宛先がなければ作成せず、名前が空なら欄に理由を表示する', async () => {
    net.handler = listHandler([])
    await render()
    expect(host.textContent).toContain('受け取る人を1人以上選んでください')
    expect(button('つくって動かす').disabled).toBe(true)
    await pickEntities('レポートを受け取る人', ['担当1'])
    const input = host.querySelector<HTMLInputElement>('input[placeholder="例：週次まとめ"]')!
    await act(async () => { fireEvent.change(input, { target: { value: '' } }); button('つくって動かす').click() })
    expect(host.textContent).toContain('レポートの名前を入力してください')
    expect(net.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/analytics/report-schedules'))).toHaveLength(0)
  })
  it('保存した分析を選んで作成すると、選択を送る', async () => {
    net.handler = (path, init) => {
      if (path.startsWith('/api/analytics/report-schedules') && init?.method === 'POST') return Promise.resolve({ success: true, data: STAFF_SCHEDULE })
      if (path.startsWith('/api/analytics/report-schedules')) return Promise.resolve({ success: true, data: { items: [], options: { ...OPTIONS, savedAnalyses: [{ id: 'analysis-1', name: '売上分析', kind: 'cross' }] } } })
      return listHandler([])(path, init)
    }
    await render()
    await pickEntities('レポートを受け取る人', ['担当1'])
    await pickEntities('保存した分析', ['売上分析'])
    const input = host.querySelector<HTMLInputElement>('input[placeholder="例：週次まとめ"]')!
    await act(async () => { fireEvent.change(input, { target: { value: '営業週報' } }) })
    await act(async () => { button('つくって動かす').click(); await Promise.resolve() })
    const call = net.calls.find(call => call.method === 'POST' && call.path.startsWith('/api/analytics/report-schedules'))
    expect(call?.body).toMatchObject({ name: '営業週報', savedAnalysisIds: ['analysis-1'] })
  })
  it('設定の取得中は読み込みを、失敗したらエラーを表示する', async () => {
    let reject!: (reason: unknown) => void
    net.handler = (path, init) => path.startsWith('/api/analytics/report-schedules') ? new Promise((_resolve, fail) => { reject = fail }) : listHandler([])(path, init)
    await render()
    expect(host.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('定期レポートを読み込んでいます')
    await act(async () => { reject(new Error('private error')); await Promise.resolve() })
    expect(host.querySelector('[data-list-state="error"]')?.getAttribute('role')).toBe('alert')
    expect(host.textContent).toContain('定期レポートの設定を読み込めませんでした')
    expect(host.textContent).not.toContain('private error')
  })
})
