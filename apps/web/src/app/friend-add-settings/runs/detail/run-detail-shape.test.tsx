// @vitest-environment happy-dom
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
/*
 * 全ルート監査 A1（2026-09-25）:
 * `/friend-add-settings/runs/detail?id=friend-add-run-1` が `filter` で
 * 「画面を表示できませんでした」になっていた。原因は実行詳細の口が
 * 既定の器（`{items,…}`）で返っていたこと。`actionRuns` が無くても
 * 落とさず「実行した処理はありません」と出す。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 実DOMと遅延応答を最小mockで対照する */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({ runDetail: vi.fn(), retryRun: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id=run-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageCrumbs: () => {}, usePageTitle: () => undefined }))
vi.mock('@/components/shared/button', () => ({ default: ({ children, ...props }: any) => <button {...props}>{children}</button> }))
vi.mock('@/components/shared/list-state', () => ({ default: ({ title }: { title: string }) => <div>{title}</div> }))
vi.mock('@/components/shared/status-badge', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/lib/api', () => ({ api: { friendAddRules: apiMocks } }))

const { default: FriendAddRunDetailPage } = await import('./page')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

async function show() {
  await act(async () => {
    root.render(<FriendAddRunDetailPage />)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

describe('実行詳細の actionRuns なし', () => {
  it('旧偽APIの形でも落ちず処理なしと出す', async () => {
    // 旧偽APIの形。本物は actionRuns の配列まで返す。
    apiMocks.runDetail.mockResolvedValue({
      success: true,
      data: {
        id: 'run-1', receivedAt: '2026-09-07T01:32:00.000Z', processedAt: null,
        friend: { id: 'f1', displayName: 'Demo Person' }, friendKind: 'first_time',
        attribution: { status: 'captured', routeId: 'route-shop', routeName: '店頭QR', reason: 'store-qr' },
        rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'v1', versionNumber: 1 },
        status: 'completed', errorCode: null,
      },
    })
    await show()
    expect(host.textContent).toContain('Demo Person')
    expect(host.textContent).toContain('追加の処理はありません。')
  })
})
