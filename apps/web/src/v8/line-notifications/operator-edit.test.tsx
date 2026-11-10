
import { screen } from '@testing-library/react';
import React, { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OPERATOR_EVENT_OPTIONS } from '@/v8/line-notifications/operator-event-options'
import { EVENT_OPTIONS, eventPlaceLabel } from './operator-words'
import OperatorEditV8 from './operator-edit'
import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

/*
 * ★V8 運用者へのお知らせを なおす（板 ）・作るの動き。
 * - ?id= で開くと、保存ずみの名前で題が「「〇〇」を編集する」になり、選んでいない人も並ぶ
 * - 受け取るスタッフは、選ぶ・外すで「選択 N人」が変わる
 * - きっかけの写しは正本（v8/line-notifications/operator-event-options.ts）と同じ
 */
const search = { value: 'id=rule-9' }
const selectedAccount = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/line-notifications/operator/new',
  useSearchParams: () => new URLSearchParams(search.value),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: selectedAccount.id, selectedAccount: null, loading: false }),
}))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

const recipients = {
  items: [
    { id: 'a', name: '見本 18', lineLinked: true, emailVerified: false, channels: { line: true, email: false, dashboard: true }, canReceive: true },
    { id: 'b', name: '見本 139', lineLinked: false, emailVerified: false, channels: { line: false, email: false, dashboard: true }, canReceive: true },
    { id: 'c', name: '見本 118', lineLinked: true, emailVerified: false, channels: { line: true, email: false, dashboard: true }, canReceive: true },
  ],
  summary: { staff: 3, canReceive: 3, line: 2, email: 0, dashboard: 3, unavailable: 0 },
}
const rule = {
  id: 'rule-9', name: '新しい予約が入りました', eventType: 'booking_created', version: 3,
  conditions: { recipientIds: ['a', 'b'], importance: 'important', dedupeMinutes: 10 },
  channels: ['dashboard', 'line', 'email'],
}
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root | null = null
let host: HTMLDivElement | null = null
const store = new Map<string, string>()

beforeEach(() => {
  selectedAccount.id = 'account-a'
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear() },
  })
  store.set('lh_staff_role', 'admin')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/staff/me')) return json({ success: true, data: { role: 'admin' } })
    if (url.includes('recipients-preview')) return json({ success: true, data: recipients })
    if (url.includes('/api/notifications/teams')) return json({ success: true, data: [] })
    if (url.includes('/operator-rules/rule-9')) return json({ success: true, data: rule })
    if (url.includes('/operator-rules') && (init?.method ?? 'GET') === 'POST') return json({ success: true, data: { ...rule, id: 'rule-new', version: 1 } })
    if (url.endsWith('/api/staff')) return json({ success: true, data: [{ id: 'a', name: '見本 18', role: 'admin' }, { id: 'b', name: '見本 139', role: 'staff' }] })
    return json({ success: false, error: 'not mocked' })
  }))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  store.clear()
  search.value = 'id=rule-9'
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => { root?.render(<OperatorEditV8 />) })
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('運用者へのお知らせを なおす（hiBO8）', () => {
  test('保存ずみの名前で題を出し、選んでいない人も並べて数を数える', async () => {
    await render()
    expect(host?.querySelector('[data-design-node="hiBO8"]')).not.toBeNull()
    expect(host?.querySelector('[data-template-region="heading"] h1')?.textContent).toBe('「新しい予約が入りました」を編集する')
    fireEvent.click(screen.getByRole('button', { name: '受け取るスタッフ' }))
    const rows = screen.getAllByRole('checkbox').filter((node) => node.closest('[role="dialog"]')).filter((node) => ['見本 18', '見本 139', '見本 118'].includes(node.getAttribute('aria-label') ?? '')).map((node) => node.closest('label')?.textContent ?? '')
    expect(rows.length).toBe(3)
    expect(document.body.textContent).toContain('見本 139')
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(host?.textContent).toContain('選択 2 人／LINEで受け取れる 1 人／管理画面で受け取れる 2 人')
    // 保存ずみの「メールでも送る」を戻す。
    const mail = Array.from(host?.querySelectorAll('label') ?? []).find((label) => label.textContent?.includes('メールでも送る'))
    expect(mail?.querySelector('input')?.checked).toBe(true)
    expect(host?.textContent).toContain('予約管理で見る ›')
  })

  test('作るときは題が「運用者へのお知らせを作る」で、全員を選んでおく', async () => {
    search.value = ''
    await render()
    expect(host?.querySelector('[data-design-node="gjUz3"]')).not.toBeNull()
    expect(host?.querySelector('[data-template-region="heading"] h1')?.textContent).toBe('運用者へのお知らせを作る')
    expect(host?.textContent).toContain('選択 3 人／LINEで受け取れる 2 人')
  })
})

test('狭い板の案内は開閉しても入力内容を保つ', async () => {
  await render()
  const toggle = host?.querySelector<HTMLButtonElement>('button[aria-controls][aria-expanded]:not([data-screen-explanation-toggle])')
  expect(toggle?.getAttribute('aria-expanded')).toBe('false')
  const aside = document.getElementById(toggle!.getAttribute('aria-controls')!)
  await act(async () => { toggle?.click() })
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  expect(aside?.hasAttribute('data-expanded')).toBe(true)
  expect(aside?.textContent).toContain('自分にテストを送る')
  await act(async () => { toggle?.click() })
  expect(aside?.hasAttribute('data-expanded')).toBe(false)
  expect(host?.querySelector<HTMLInputElement>('#operator-name')?.value).toBe(rule.name)
})

describe('欄で知らせて移る', () => {
  test('名前を消して下書きを保存すると、口を呼ばず名前の欄が赤くなり理由が出て、そこへ移る', async () => {
    await render()
    const name = host!.querySelector('#operator-name') as HTMLInputElement
    await act(async () => { fireEvent.change(name, { target: { value: '' } }) })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    const save = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '下書きを保存する')!
    await act(async () => { save.click() })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(fetchMock.mock.calls.some(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')).toBe(false)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(host!.querySelector('#operator-name-error')?.textContent).toBe('お知らせの名前を入力してください。')
    expect(document.activeElement).toBe(name)
  })
})

describe('公開前の確認の窓（sDXNy）', () => {
  test('アカウントを切り替えたら古い公開確認は使えない', async () => {
    search.value = ''
    await render()
    const publish = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('運用者へのお知らせを公開'))!
    await act(async () => { publish.click(); for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) })
    expect(document.body.querySelector('[data-design-node="sDXNy"]')).not.toBeNull()
    selectedAccount.id = 'account-b'
    await act(async () => { root.render(<OperatorEditV8 />); await Promise.resolve() })
    expect(document.body.querySelector('[data-design-node="sDXNy"]')).toBeNull()
  })
  test('要約は題と値の2列、宛先の行は名前・役割・札。ボタンは届く人数を言う', async () => {
    search.value = ''
    await render()
    const publish = Array.from(host?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('運用者へのお知らせを公開'))
    await act(async () => {
      ;(publish as HTMLButtonElement).click()
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
    })
    const dialog = document.body.querySelector('[data-design-node="sDXNy"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('LINEアカウント')
    expect(dialog?.textContent).toContain('環境')
    const lines = Array.from(dialog?.querySelectorAll('p[class*=confirmLine]') ?? []).map((p) => Array.from(p.children).map((c) => c.textContent))
    expect(lines).toEqual([
      ['お知らせ', '新しい予約が入りました'],
      ['宛先', '選んだスタッフ 3 人'],
      ['LINE が届く人', '2 人（1 人は LINE 未登録）'],
    ])
    const rows = Array.from(dialog?.querySelectorAll('table[aria-label="受け取る人"] tbody tr') ?? []).map((li) => Array.from(li.children).map((c) => c.textContent))
    expect(rows).toEqual([
      ['見本 18', '管理者', 'LINE'],
      ['見本 139', 'スタッフ', '画面だけ'],
      ['見本 118', '—', 'LINE'],
    ])
    expect(dialog?.textContent).toContain('LINE 未登録の人には、管理画面のお知らせだけで届きます。')
    const send = Array.from(dialog?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('公開して'))
    expect(send?.textContent).toBe('公開して 2 人に LINE で送る')
  })
})

test('きっかけの写しは正本と同じ（ずれると公開しても届かない）', () => {
  expect(EVENT_OPTIONS).toEqual(OPERATOR_EVENT_OPTIONS)
  for (const option of EVENT_OPTIONS) expect(eventPlaceLabel(option.value)).not.toBe('管理画面')
})

test('名前が空の保存は止め、理由を欄に一度だけ出して欄へ移る', async () => {
  const previousFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/operator-rules/rule-9') && (init?.method ?? 'GET') === 'GET'
      ? Promise.resolve(json({ success: true, data: { ...rule, name: '' } }))
      : previousFetch(input, init)))
  await render()
  await act(async () => {
    const save = [...host!.querySelectorAll('button')].find(button => button.textContent === '下書きを保存する')!
    save.click()
  })
  const input = host!.querySelector<HTMLInputElement>('#operator-name')!
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(input)
  expect([...host!.querySelectorAll('[role="alert"]')].filter(node => node.textContent === 'お知らせの名前を入力してください。')).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

test('宛先をすべて外した保存は止め、欄の理由と赤枠を出す', async () => {
  await render()
  await pickEntities('受け取るスタッフ', ['見本 18', '見本 139'])
  await act(async () => {
    [...host!.querySelectorAll('button')].find(button => button.textContent === '下書きを保存する')!.click()
  })
  const field = host!.querySelector('#operator-recipient-team')!
  expect(field.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(field)
  expect([...host!.querySelectorAll('[role="alert"]')].filter(node => node.textContent === '受け取るスタッフを1人以上選んでください。')).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

test('お知らせの公開中は窓の×・Esc・戻って直すを止める', async () => {
  search.value = ''
  const previousFetch = globalThis.fetch
  let resolve!: (value: Response) => void
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/publish')
    ? new Promise<Response>(r => { resolve = r }) : previousFetch(input, init))
  await render()
  await act(async () => {
    const publish = [...host!.querySelectorAll('button')].find(b => b.textContent?.includes('運用者へのお知らせを公開'))!
    publish.click()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
  await act(async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('公開して 2 人'))!
    send.click()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
  const dialog = document.querySelector('[data-design-node="sDXNy"]')!
  expect(dialog.querySelector('button[aria-label="閉じる"]')?.hasAttribute('disabled')).toBe(true)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[data-design-node="sDXNy"]')).toBeTruthy()
  await act(async () => resolve(json({ success: true, data: rule })))
})


test('送る時間を切り替えると、案内もその送信条件へ切り替わる', async () => {
  await render()
  const oldHint = '営業時間外のものは翌朝 10:00 にまとめて送ります。'
  expect(host?.textContent).not.toContain(oldHint)
  expect(host?.textContent).not.toContain('営業時間外のお知らせは、予約設定の営業時間になってから送ります。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る時間' })) })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: '営業時間だけ' }).querySelector('button')!) })
  expect(host?.textContent).toContain('営業時間外のお知らせは、予約設定の営業時間になってから送ります。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る時間' })) })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: '翌朝にまとめる' }).querySelector('button')!) })
  expect(host?.textContent).not.toContain('営業時間外のお知らせは、予約設定の営業時間になってから送ります。')
  expect(host?.textContent).toContain('翌朝の、設定されたおまとめ時刻に送ります。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る時間' })) })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'いつでも' }).querySelector('button')!) })
  expect(host?.textContent).not.toContain('翌朝の、設定されたおまとめ時刻に送ります。')
  expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([input, init]) => {
    const path = new URL(String(input), 'http://worker.test').pathname
    return (path.endsWith('/operator-rules') || path.endsWith('/operator-rules/rule-9'))
      && ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET'
  })).toBe(false)
})
