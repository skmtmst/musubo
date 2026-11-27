// @vitest-environment happy-dom
/*
 * V8 ウェビナー一覧（src/v8）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 行の「…」からアーカイブの確かめが開く・札に件数が出る・
 * フォルダの「…」は選んだ行だけ・終わった公開は「非公開」・公開ページの道。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const access = vi.hoisted(() => ({ canEdit: true }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => access.canEdit }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webinars',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import WebinarListV8 from './list'
import type { WebinarListItem } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function webinar(overrides: Partial<WebinarListItem> = {}): WebinarListItem {
  return {
    id: 'webinar-1', accountId: 'account-a', title: 'NEN活用スタートセミナー', slug: 'nen-start', status: 'active',
    videoPrefix: 'videos/nen-start', durationSeconds: 872, schedule: [], cta: null, tagOnAttend: null, tagOnCtaClick: null,
    folderId: null, folderName: null, registrationCount: 124, viewerCount: 98,
    publicationState: 'always', publicationStartsAt: null, publicationEndsAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

const items = [
  webinar({ folderId: 'folder-seminar', folderName: 'セミナー' }),
  webinar({ id: 'webinar-5', title: '旧機能説明会', slug: 'old', status: 'draft', publicationState: 'ended' }),
]
const folders = [
  { id: 'folder-seminar', kind: 'webinar', accountId: 'account-a', name: 'セミナー', parentId: null, displayOrder: 0, count: 1, color: '#2f6fde', createdAt: '', updatedAt: '' },
]

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  access.canEdit = true
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/overview')) return json({ data: { state: 'partial', registrationMode: 'people', metrics: {} } })
    if (url.pathname.includes('/folders')) return json({ success: true, data: folders })
    if (url.pathname.endsWith('/api/webinars')) {
      const status = url.searchParams.get('status')
      const rows = status ? items.filter((item) => item.status === status) : items
      return json({ data: { items: rows, total: rows.length, limit: 20, sort: [] } })
    }
    return json({ data: null })
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  window.history.replaceState(null, '', '/webinars')
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function render() {
  await act(async () => { root.render(<WebinarListV8 />) })
  await act(async () => {})
  await act(async () => {})
}

const buttonByLabel = (label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label) as HTMLButtonElement | undefined

async function renderUnknown(patch: Record<string, unknown>) {
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/api/webinars')) return Promise.resolve(json({ data: { items: [{ ...items[0], ...patch }], total: 1, limit: 20, sort: [] } }))
    return originalFetch(input, init)
  })
  await render()
  return host.querySelector('[data-row-id="webinar-1"]')!
}

it('未知の状態を公開予定と誤表示しない', async () => {
  const row = await renderUnknown({ status: 'future-status', publicationState: 'scheduled' })
  expect(row.textContent).toContain('状態を確認できません')
  expect(row.textContent).not.toContain('公開予定')
})

it('未知の公開状態を公開中や正しい人数として表示しない', async () => {
  const row = await renderUnknown({ status: 'active', publicationState: 'future-publication' })
  expect(row.textContent).toContain('状態を確認できません')
  expect(row.textContent).not.toContain('公開中')
  expect(row.textContent).not.toContain('124人')
})
