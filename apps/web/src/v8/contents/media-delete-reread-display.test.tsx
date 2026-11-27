// @vitest-environment happy-dom
/*
 * ★V8 登録メディア一覧（src/v8/contents/list.tsx）の削除の動き。
 * 1件ずつの削除確認（設計 `YfTfJ`）と、まとめて削除の途中交代・結果文を、
 * 画面を描いて押し、API へ届いた要求と画面の変化で確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())


vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const account = vi.hoisted(() => ({ id: 'account-a' }))
const toast = vi.hoisted(() => vi.fn())

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: null, loading: false }),
}))
vi.mock('@/components/shared/toast', async (importOriginal: () => Promise<typeof import('@/components/shared/toast')>) => ({
  ...(await importOriginal()),
  notifyToast: toast,
}))

import MediaLibraryListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Media = { id: string; filename: string; usageCount: number; lineAccountId?: string | null }
type Impact = {
  usageCount: number
  canDelete: boolean
  verified?: boolean
  checkedAt?: string
  references?: Array<{ kind: string; name: string | null; href: string | null; state: 'available' | 'unavailable' }>
}

const item = ({ id, filename, usageCount, lineAccountId = account.id }: Media) => ({
  id, lineAccountId, folderId: null, filename, kind: 'image', mimeType: 'image/png', sizeBytes: 1000,
  width: 10, height: 10, durationMs: null, usageCount, archivedAt: null, archiveReason: null,
  url: `https://example.test/${id}.png`, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
})
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const impactOf = (id: string, impact: Impact) => ({
  media: { id, filename: id, kind: 'image' },
  usageCount: impact.usageCount,
  references: (impact.references ?? []).map((ref) => ({ ...ref, scannedAt: '2026-09-01T00:00:00.000Z' })),
  checkedAt: impact.checkedAt ?? '2026-09-16T01:30:00.000Z',
  lastScannedAt: null,
  verified: impact.verified ?? true,
  canDelete: impact.canDelete,
  recommendedAction: impact.canDelete ? 'delete' : 'review_references',
})

type Call = { method: string; path: string; params: URLSearchParams }
let calls: Call[] = []
let media: Media[] = []
/** メディアごとの影響の返事。関数なら呼ぶたびに決める（読み直しで変わる場合）。 */
let impacts = new Map<string, Impact | (() => Impact | Promise<Impact>) | 'fail'>()
/** メディアごとの削除の返事（HTTP の状態）。無ければ 200。 */
let deleteStatus = new Map<string, number | (() => Promise<number>)>()
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  account.id = 'account-a'
  calls = []
  media = [{ id: 'm-1', filename: '秋の新商品.png', usageCount: 0 }]
  impacts = new Map()
  deleteStatus = new Map()
  toast.mockReset()
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/contents')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname, params: url.searchParams })
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { id: 'staff-1', role: 'admin' } })
    if (url.pathname === '/api/media/counts') return json({ success: true, data: { total: media.length, byKind: { image: media.length, video: 0, audio: 0, file: 0 }, unused: 0, archived: 0 } })
    if (url.pathname === '/api/media/quota') return json({ success: true, data: { usageBytes: 1, reservedBytes: 0, limitBytes: 100, remainingBytes: 99, usageRate: 0.01, state: 'normal' } })
    if (url.pathname === '/api/folders') return json({ success: true, data: [], unfiledCount: 0 })
    if (url.pathname === '/api/media' && method === 'GET') {
      const unusedOnly = url.searchParams.get('unusedOnly') === '1'
      const rows = media.filter((row) => !unusedOnly || row.usageCount === 0).map(item)
      return json({ success: true, data: { items: rows, total: rows.length, limit: Number(url.searchParams.get('limit') ?? 20), offset: 0 } })
    }
    const impactMatch = url.pathname.match(/^\/api\/media\/([^/]+)\/delete-impact$/)
    if (impactMatch) {
      const answer = impacts.get(impactMatch[1])
      if (answer === 'fail' || answer === undefined) return json({ success: false, error: 'scan failed' })
      const impact = typeof answer === 'function' ? await answer() : answer
      return json({ success: true, data: impactOf(impactMatch[1], impact) })
    }
    const deleteMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const answer = deleteStatus.get(deleteMatch[1]) ?? 200
      const status = typeof answer === 'function' ? await answer() : answer
      return status === 200 ? json({ success: true, data: null }) : json({ success: false, error: 'conflict' }, status)
    }
    return json({ success: false, error: 'not mocked' }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const render = async () => {
  await act(async () => root.render(<MediaLibraryListV8 />))
  await settle()
}
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('押す相手がありません')
  await act(async () => { (element as HTMLElement).click() })
  await settle()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
const reactClick = (element: Element | undefined) => {
  if (!element) throw new Error('押す相手がありません')
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  if (!key) throw new Error('操作を取得できません')
  return (element as unknown as Record<string, { onClick: () => void }>)[key].onClick
}
const buttonIn = (scope: ParentNode | null, text: string) =>
  [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim() === text)
const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) => row.textContent?.trim() === text)
const impactCalls = (id?: string) => calls.filter((call) => /\/delete-impact$/.test(call.path) && (!id || call.path.includes(`/${id}/`)))
const deleteCalls = () => calls.filter((call) => call.method === 'DELETE')
const openDeleteFor = async (filename: string) => {
  await click(host.querySelector(`button[aria-label="${filename}のその他操作"]`))
  await click(menuItem('削除する'))
}
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('削除の競合後に使用先を読み直せなければ、削除を止めて読み直しを案内する', async () => {
  impacts.set('m-1', { usageCount: 0, canDelete: true })
  deleteStatus.set('m-1', 409)
  await render(); await openDeleteFor('秋の新商品.png')
  impacts.set('m-1', 'fail')
  await click(buttonIn(dialog(), '削除する'))
  expect(dialog()?.textContent).toContain('使われている場所を確認できませんでした')
  expect(dialog()?.textContent).not.toContain('使用先を確認しています')
  expect(buttonIn(dialog(), '削除する')).toBeUndefined()
  expect(buttonIn(dialog(), 'もう一度読み込む')).toBeTruthy()
})
