// @vitest-environment happy-dom
/*
 * 監査 R389・R391（解除の競合・保管履歴）の画面回帰試験。
 * 本物の MergedPersonDetailView を react-dom で動かし、api の成否だけを差し替える。
 *
 * - R389: 解除で409が返ったら、解除の窓を閉じて最新を読み直す。
 *   古い結び付きと窓を残さない。
 * - R391: 権限不足の面にも「一覧へ戻る」を残す。
 */
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

const { ApiError } = await import('@/lib/api')
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

it.each([MergedPersonDetailView, MergedPersonV8])('解除窓に結び付け先のアカウントと環境を出す (%#)', async (View) => {
  calls.get.mockResolvedValue(personFixture(1, true))
  await renderView(vi.fn(), View); await flush()
  fireEvent.click(buttonByText('解除する')); await flush()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog?.textContent).toContain('LINEアカウント')
  expect(dialog?.textContent).toContain('本店')
  expect(dialog?.textContent).toContain('環境')
})

it.each([MergedPersonDetailView, MergedPersonV8])('統合ユーザーを変えたら古い解除は送らない (%#)', async (View) => {
  calls.get.mockResolvedValue(personFixture(1, true))
  await renderView(vi.fn(), View); await flush()
  fireEvent.click(buttonByText('解除する')); await flush()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')!
  fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '確認した根拠' } })
  await act(async () => { root.render(<View personId="user-b" onClose={vi.fn()} />) })
  const stale = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  if (stale) fireEvent.click(buttonByText('結び付けを解除', stale))
  await flush()
  expect(calls.unlink).not.toHaveBeenCalled()
})

it.each([MergedPersonDetailView, MergedPersonV8])('選択アカウントを切り替えた古い解除を送らない (%#)', async (View) => {
  calls.get.mockResolvedValue(personFixture(1, true))
  await renderView(vi.fn(), View); await flush()
  fireEvent.click(buttonByText('解除する')); await flush()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')!
  fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '確認した根拠' } })
  calls.selectedAccountId = 'account-b'
  await act(async () => { root.render(<View personId="user-a" onClose={vi.fn()} />) })
  const stale = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  if (stale) fireEvent.click(buttonByText('結び付けを解除', stale))
  await flush()
  expect(calls.unlink).not.toHaveBeenCalled()
})

describe('R389 解除の競合は窓を閉じて読み直す', () => {
  it.each([MergedPersonDetailView, MergedPersonV8])('409の後は古い結び付きの窓を残さず、成功した解除だけが残る (%#)', async (View) => {
    calls.get
      .mockResolvedValueOnce(personFixture(1, true))
      .mockResolvedValue(personFixture(2, false))
    calls.unlink.mockRejectedValue(new ApiError(409, '別の人が先に変更しました'))
    const onClose = vi.fn()
    await renderView(onClose, View)
    await flush()
    fireEvent.click(buttonByText('解除する'))
    await flush()
    const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
    if (!dialog) throw new Error('unlink dialog not open')
    const textarea = dialog.querySelector('textarea')
    if (!textarea) throw new Error('reason field not found')
    fireEvent.change(textarea, { target: { value: '確認した根拠を書きます' } })
    fireEvent.click(buttonByText('結び付けを解除', dialog))
    await flush()
    // 解除の窓は閉じ、競合の文と読み直した中身が出る。
    await waitFor(() => expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull())
    expect(document.body.textContent).toContain('別の人が先に変更しました')
    expect(calls.get).toHaveBeenCalledTimes(2)
    expect(calls.unlink).toHaveBeenCalledWith('user-a', 'friend-a', {
      expectedRevision: 1, reason: '確認した根拠を書きます',
    })
    expect(document.body.textContent).not.toContain('friend-a')
  })
})

describe('R391 権限不足でも一覧へ戻れる', () => {
  it.each([MergedPersonDetailView, MergedPersonV8])('forbidden の面に「一覧へ戻る」がある (%#)', async (View) => {
    calls.get.mockRejectedValue(new ApiError(403, 'この統合ユーザーを表示する権限がありません'))
    const onClose = vi.fn()
    await renderView(onClose, View)
    await flush()
    expect(document.body.textContent).toContain('権限')
    fireEvent.click(buttonByText('一覧へ戻る'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

it('プロフィールの編集入口は鉛筆印を持ち、候補の窓を開く', async () => {
  calls.get.mockResolvedValue(personFixture(1, true))
  await renderView(vi.fn(), MergedPersonV8)
  await flush()
  const edit = buttonByText('使う値を編集する')
  expect(edit.querySelector('svg.lucide-pencil')).not.toBeNull()
  fireEvent.click(edit)
  await flush()
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('統合プロフィールを編集')
  expect(calls.unlink).not.toHaveBeenCalled()
})
