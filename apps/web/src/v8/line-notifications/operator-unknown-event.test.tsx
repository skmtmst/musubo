
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

describe('未対応の通知の種類', () => {
  test.each(['toString', 'constructor', '__proto__'])('%s でも管理画面への案内を表示する', async (eventType) => {
    rule.eventType = eventType
    await render()
    expect(host?.textContent).toContain('管理画面で見る ›')
    expect(host?.textContent).toContain('新しい予約が入りました')
  })
})
