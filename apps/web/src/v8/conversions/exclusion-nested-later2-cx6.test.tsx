import { expectPermissionLocked, expectLockedFolderMenu } from '@/test-utils/permission-locked-control'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
import { READ_ONLY_MESSAGE } from '@/components/shared/read-only-notice'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const narrow = vi.hoisted(() => ({ value: false }))
const push = vi.hoisted(() => vi.fn())
const search = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/conversions',
  useSearchParams: () => new URLSearchParams(search.value),
}));


vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));


vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}));


vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}));


vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
});


vi.mock('@/lib/use-narrow-viewport', () => ({
  useNarrowViewport: () => narrow.value,
}));


import ConversionListV8 from './list'
import { originInfoOf } from './origin-labels'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function point(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, sourceType: 'ec_order_confirmed', value: null, measureMethod: 'webhook', targetUrl: null, countRepeat: true,
    attributionDays: 90, sourceConfig: {}, deduplicationMode: 'every', deduplicationWindowDays: null, valueMode: 'source',
    reversalPolicy: 'source_cancelled', lineAccountId: 'account-a', status: 'active', state: 'active', stateReason: null,
    ingest: { configured: true, disabledAt: null }, version: 3, usageCount: 2, usageNames: ['ファネル 1', 'アフィリエイト 1'],
    metrics: { recordedCount: 52, netCount: 52, reversedCount: null, reversedValue: null, netValue: 412000, reversalState: 'unavailable', reversalReason: '', cancellationCount: null, cancellationValue: null },
    stoppedAt: null, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  }
}

const items = [
  point('cp-1', '商品を買った', { folderId: 'f-ec' }),
  point('cp-6', '資料をダウンロードした', { sourceType: 'url_reach', measureMethod: 'url_reach', targetUrl: 'https://example.com/dl', deduplicationMode: 'once_per_friend', valueMode: 'none', status: 'stopped', state: 'stopped', usageCount: 0, usageNames: [], stoppedAt: '2026-09-20T09:00:00.000Z' }),
]

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const calls: string[] = []

let root: Root
let host: HTMLDivElement

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount() {
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
  await flush()
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  narrow.value = false
  window.history.replaceState(null, '', '/conversions')
  push.mockReset()
  search.value = ''
  calls.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/api/conversions/definitions') {
      return json({ success: true, data: { items, stateCounts: { active: 1, draft: 0, stopped: 1, invalid: 0, sourceStopped: 0, unused: 1 }, range: {}, pagination: { total: 2, limit: 100, cursor: '0', nextCursor: null } } })
    }
    if (url.pathname === '/api/conversions/report') {
      return json({ success: true, data: { kpis: { netCount: 52, previousNetCount: 40, netValue: 412000 }, byDefinition: [] } })
    }
    if (url.pathname === '/api/folders') {
      return json({ success: true, data: [{ id: 'f-ec', kind: 'conversion', name: '通販', parentId: null, displayOrder: 0, color: '#16a34a', createdAt: '', updatedAt: '', itemCount: 1 }], unfiledCount: 1 })
    }
    if (url.pathname.endsWith('/delete-impact')) {
      return json({ success: true, data: { definition: { ...items[0], version: 3 }, usages: [], eventCount: 52, canDelete: false, stopImpact: { affectedUsageCount: 2, preservesPastEvents: true, preservesUsages: true }, replacementCandidates: [] } })
    }
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

it('編集しても保存済みの空の入れ子はサーバーと同じ条件のまま残す', async () => {
  const exclusion = { operator: 'OR', rules: [], groups: [{ operator: 'AND', rules: [], groups: [{ operator: 'OR', rules: [] }] }] }
  items[0].sourceConfig = { exclusion }
  let sent: unknown = null
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/conversions/definitions/cp-1/revise') {
      sent = JSON.parse(String(init?.body))
      return json({ success: true, data: { id: 'cp-1', version: 4 } })
    }
    return baseFetch(input, init)
  })
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  fireEvent.change(screen.getByLabelText('成果地点の名前'), { target: { value: '商品を買った（更新）' } })
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  await waitFor(() => expect(sent).toMatchObject({ name: '商品を買った（更新）', sourceConfig: { exclusion } }))
})

it('編集で空の条件のかたまりを追加したときは、案内して保存しない', async () => {
  items[0].sourceConfig = {}
  let submitted = false
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/conversions/definitions/cp-1/revise') {
      submitted = true
      return json({ success: true, data: {} })
    }
    return baseFetch(input, init)
  })
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'いずれか条件のかたまりを足す' }))
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  expect(await screen.findByText(/空の「いずれか」の条件のかたまりがあります/)).toBeTruthy()
  expect(submitted).toBe(false)
})

it('保存済みの空グループと未完成の条件が混ざるときは保存しない', async () => {
  items[0].sourceConfig = { exclusion: { operator: 'AND', rules: [], groups: [
    { operator: 'OR', rules: [] },
    { operator: 'OR', rules: [{ type: 'tag_exists', value: '' }] },
  ] } }
  let submitted = false
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/conversions/definitions/cp-1/revise') {
      submitted = true
      return json({ success: true, data: {} })
    }
    return baseFetch(input, init)
  })
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  await flush()
  expect(submitted).toBe(false)
  expect(screen.getByText(/未完成の条件があります/)).toBeTruthy()
})

it.each([1, 2])('保存済みの第%i階層に rules がないとき、落ちずに案内して保存を止める', async (depth) => {
  const broken = { operator: 'AND' }
  items[0].sourceConfig = { exclusion: { operator: 'AND', rules: [], groups: [
    depth === 1 ? broken : { operator: 'OR', rules: [], groups: [broken] },
  ] } }
  let submitted = false
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/conversions/definitions/cp-1/revise') {
      submitted = true
      return json({ success: true, data: {} })
    }
    return baseFetch(input, init)
  })
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  await flush()
  expect(screen.getByText('保存された数えない条件を確認できません。条件を見直してください。')).toBeTruthy()
  expect(submitted).toBe(false)
})

it('壊れた条件を外してから保存すると、除外なしを送る', async () => {
  items[0].sourceConfig = { exclusion: { operator: 'AND', rules: [], groups: [{ operator: 'OR' }] } }
  let sent: unknown = null
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/conversions/definitions/cp-1/revise') {
      sent = JSON.parse(String(init?.body))
      return json({ success: true, data: { id: 'cp-1', version: 4 } })
    }
    return baseFetch(input, init)
  })
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  expect(screen.getByText('保存された数えない条件の形が読めません。外してから、もう一度作ってください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'この条件を外す' }))
  expect(screen.getByRole('button', { name: '追加する条件を選択する' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  await waitFor(() => expect(sent).toMatchObject({ sourceConfig: { exclusion: null } }))
})

it('閲覧のみでは編集画面を開けず、条件を外せない', async () => {
  items[0].sourceConfig = { exclusion: { operator: 'AND', rules: [], groups: [{ operator: 'OR' }] } }
  role.value = verifiedStaffRole('viewer')
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
  await flush()
  expect(screen.getByText('この成果地点を編集できません')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'この条件を外す' })).toBeNull()
})
