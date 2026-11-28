// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const calls = vi.hoisted(() => ({
  get: vi.fn(),
  unlink: vi.fn(),
  selectedAccountId: 'account-a',
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      mergedPeople: {
        ...actual.api.mergedPeople,
        get: calls.get,
        unlink: calls.unlink,
        updateDeliveryPriorities: vi.fn(),
        updateProfileValues: vi.fn(),
      },
    },
  }
})

import MergedPersonDetailView from './merged-person-detail-v8'
import MergedPersonV8 from '@/v8/friends/merged/person'
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: calls.selectedAccountId }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/friends' }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function personFixture(revision: number, linked: boolean) {
  return {
    success: true,
    data: {
      id: 'user-a', status: 'active', revision, primaryDisplayName: '見本 171',
      linkedFriends: linked
        ? [{
          friendId: 'friend-a', displayName: '見本 171', lineAccountId: 'account-a',
          lineAccountName: '本店', isFollowing: true, linkedAt: '2026-08-30T09:00:00.000Z',
          linkMethod: 'operator_review', confidence: 92, candidateId: 'candidate-a', candidateVersion: 2,
        }]
        : [],
      profileValues: [], deliveryPriorities: [],
      history: [
        { id: 'event-1', eventType: 'unlink', summary: '統合ユーザーから友だちを解除しました', actorName: '担当B', occurredAt: '2026-08-30T10:00:00.000Z' },
      ],
      profileCandidates: [], tagCandidates: [],
      createdAt: '2026-08-30T09:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', archivedAt: null,
    },
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  calls.selectedAccountId = 'account-a'
  calls.get.mockReset()
  calls.unlink.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
})

async function renderView(onClose: () => void, View = MergedPersonDetailView) {
  await act(async () => {
    root.render(<View personId="user-a" onClose={onClose} />)
  })
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`button "${text}" not found`)
  return found
}

it.each(['詳細パネル', '統合ユーザー画面'] as const)('%s は候補が null のとき編集を止め、再取得で正常な情報を出す', async (which) => {
  const invalid = personFixture(1, true)
  calls.get.mockResolvedValueOnce({ ...invalid, data: { ...invalid.data, profileCandidates: null } })
  calls.get.mockResolvedValueOnce(personFixture(1, true))
  await renderView(vi.fn(), which === '詳細パネル' ? MergedPersonDetailView : MergedPersonV8)
  await waitFor(() => expect(host.textContent).toContain('統合ユーザーを読み込めませんでした'))
  expect(host.textContent).not.toContain('見本 171')
  expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('使う値を編集する'))).toBe(false)
  expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('解除する'))).toBe(false)
  expect(calls.unlink).not.toHaveBeenCalled()
  fireEvent.click(buttonByText('もう一度読み込む'))
  await waitFor(() => expect(host.textContent).toContain('見本 171'))
  expect(calls.get).toHaveBeenCalledTimes(2)
})
