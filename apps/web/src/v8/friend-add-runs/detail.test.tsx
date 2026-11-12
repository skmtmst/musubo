// @vitest-environment happy-dom
/*
 * V8 友だち追加時の配信の実行の詳細（src/v8・）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 失敗の帯は「何つ目で止まったか」／処理の名前は設定の言葉（種類が合うときだけ）／
 * もう一度実行は失敗の処理だけ／閲覧のみには出さない／顧客名が隠された記録はトークへ進ませない／戻り先に絞り込みを残す。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/friend-add-settings/runs/detail',
  useSearchParams: () => new URLSearchParams('id=run-4&status=failed&pages=c2'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

const chrome = vi.hoisted(() => ({ crumbs: null as Array<{ label: string; href?: string }> | null }))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: (crumbs: Array<{ label: string; href?: string }> | null) => { chrome.crumbs = crumbs },
}))

const roleState = vi.hoisted(() => ({ role: 'owner' as string }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => roleState.role }
})

import FriendAddRunDetailV8, { actionTitle, pastTense } from './detail'
import type { FriendAddRunDetail } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ActionRun = FriendAddRunDetail['actionRuns'][number]

const configured = [
  { type: 'add_tag', label: 'タグ「経路が分からない」を付ける' },
  { type: 'start_scenario', label: 'シナリオ「共通のあいさつ」を始める' },
]

function actionRun(overrides: Partial<ActionRun>): ActionRun {
  return {
    id: 'a', stableId: 'v1:0', type: 'tag', status: 'completed', attemptCount: 1, nextRetryAt: null, errorCode: null,
    startedAt: '2026-09-07T01:14:02.000Z', completedAt: '2026-09-07T01:14:02.000Z', updatedAt: '2026-09-07T01:14:02.000Z',
    ...overrides,
  }
}

let detail: FriendAddRunDetail
let retried = 0
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  roleState.role = 'owner'
  retried = 0
  detail = {
    id: 'run-4', receivedAt: '2026-09-07T01:14:01.000Z', processedAt: '2026-09-07T01:14:02.000Z',
    friend: { id: 'friend-4', displayName: '見本 141', redacted: false }, friendKind: 'first_time',
    attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
    rule: { id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'v1', versionNumber: 1 },
    configuredActions: configured,
    actionRuns: [
      actionRun({ id: 'a1', stableId: 'v1:0', type: 'tag' }),
      actionRun({ id: 'a2', stableId: 'v1:1', type: 'scenario', status: 'failed', errorCode: 'action_failed', completedAt: null }),
    ],
    status: 'failed', errorCode: 'action_failed',
  }
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { role: roleState.role } })
    if (url.pathname === '/api/friend-add-runs/run-4/retry' && init?.method === 'POST') {
      retried += 1
      return json({ success: true, data: { status: 'completed', retried: 1 } })
    }
    if (url.pathname === '/api/friend-add-runs/run-4') return json({ success: true, data: detail })
    return json({ success: true, data: null })
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function render() {
  await act(async () => { root.render(<FriendAddRunDetailV8 />) })
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

const buttonByText = (text: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes(text))

describe('処理の名前', () => {
  it('成功した処理は設定の言葉を終わった形にする', () => {
    expect(pastTense('タグ「新規」を付ける')).toBe('タグ「新規」を付けた')
    expect(pastTense('シナリオ「7日間フォロー」を開始する')).toBe('シナリオ「7日間フォロー」を開始した')
    expect(actionTitle(actionRun({ stableId: 'v1:0', type: 'tag' }), configured)).toBe('タグ「経路が分からない」を付けた')
  })

  it('失敗した処理は設定の言葉のまま', () => {
    expect(actionTitle(actionRun({ stableId: 'v1:1', type: 'scenario', status: 'failed' }), configured)).toBe('シナリオ「共通のあいさつ」を始める')
  })

  it('番号の先の設定と種類が合わないときは、設定の言葉を使わない（違う処理の名前を出さない）', () => {
    expect(actionTitle(actionRun({ stableId: 'v1:0', type: 'scenario' }), configured)).toBe('シナリオ操作')
    expect(actionTitle(actionRun({ stableId: 'v1:5', type: 'tag' }), configured)).toBe('タグ操作')
    expect(actionTitle(actionRun({ stableId: 'v1:0', type: 'tag' }), undefined)).toBe('タグ操作')
  })
})

describe('実行の詳細の画面（N43uVX）', () => {
  it('失敗の帯は何つ目で止まったかを出し、行ったことを順に並べる', async () => {
    await render()
    expect(host.querySelector('[data-design-node="N43uVX"]')).toBeTruthy()
    expect(host.textContent).toContain('見本 141さんの友だち追加')
    await act(async () => { (host.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement)?.click() })
    expect(host.textContent).toContain('9月7日（月）10:14 に追加・はじめて')
    expect(host.textContent).toContain('3つ目の処理を完了できませんでした')
    expect(host.textContent).toContain('シナリオを始めるところで止まりました。')
    const steps = Array.from(host.querySelectorAll('ol > li')).map((li) => li.getAttribute('data-state'))
    expect(steps).toEqual(['ok', 'ok', 'ng'])
    expect(host.textContent).toContain('9/7 10:14:01')
  })

  it('戻るは上の帯のパンくずで、一覧の絞り込みとページを残す（板の頭の「← 実行結果へ」は 2026-10-08 に無くした）', async () => {
    await render()
    expect(Array.from(host.querySelectorAll('a')).some((link) => link.textContent?.includes('実行結果へ'))).toBe(false)
    expect(chrome.crumbs?.find((crumb) => crumb.label === '実行結果')?.href).toBe('/friend-add-settings/runs?status=failed&pages=c2')
  })

  it('「失敗した処理をもう一度」で再試行の口を呼ぶ', async () => {
    await render()
    await act(async () => { buttonByText('失敗した処理をもう一度')?.click() })
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    expect(retried).toBe(1)
  })

  it('閲覧のみには「失敗した処理をもう一度」を出さない（帯は出す）', async () => {
    roleState.role = 'viewer'
    await render()
    expect(host.textContent).toContain('3つ目の処理を完了できませんでした')
    expect(buttonByText('失敗した処理をもう一度')).toBeUndefined()
  })

  it('実行の JSON は開いた時だけ出し、友だちの名前・ID と設定の文面を入れない', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render()
    expect(host.querySelector('pre')).toBeNull()
    await act(async () => { buttonByText('この実行の JSON を開く')!.click() })
    const text = host.querySelector('pre')?.textContent ?? ''
    expect(text).toContain('"id": "run-4"')
    expect(text).toContain('"errorCode": "action_failed"')
    for (const leak of ['見本 141', 'friend-4', '共通のあいさつ']) expect(text).not.toContain(leak)
    await act(async () => { buttonByText('JSON をコピー')!.click() })
    expect(writeText).toHaveBeenLastCalledWith(text)
  })

  it('閲覧のみは実行の JSON を読めるが写す操作は出さない', async () => {
    roleState.role = 'viewer'
    await render()
    await act(async () => { buttonByText('この実行の JSON を開く')!.click() })
    expect(host.querySelector('pre')?.textContent).toContain('"id": "run-4"')
    expect(buttonByText('JSON をコピー')).toBeUndefined()
  })

  it('顧客名が隠された記録は「トークを開く」を出さない', async () => {
    detail = { ...detail, friend: { displayName: '顧客名は非表示', redacted: true } }
    await render()
    expect(host.textContent).toContain('設定を開く')
    expect(host.textContent).not.toContain('トークを開く')
    expect(host.querySelector('a[href^="/chats"]')).toBeNull()
  })
})
