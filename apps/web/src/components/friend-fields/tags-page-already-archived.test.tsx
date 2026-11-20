// @vitest-environment happy-dom
/*
 * #708: 保管の確定直前にほかが保管したタグで、archive の 409 already_archived を
 * 「失敗」ではなく「もう着いている」として見せることを、実物の React で確かめる。
 *
 * ソース文字列の検査では次が固定できない。happy-dom へ実物のタグ一覧を
 * マウントし、一覧の取得と archive・依存確認を実物の Promise で返してから、
 * 保管の確認窓を開いて押す。
 *
 *   - already_archived のとき、赤い失敗ではなく「すでに保管済みです」が出る
 *   - そのとき一覧を読み直す（load がもう一度走る）
 *   - ほかの 409（版が古い等）は今までどおり失敗として出る
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({
  tagsList: null as null | ((...args: unknown[]) => Promise<unknown>),
  tagGroupsList: null as null | ((...args: unknown[]) => Promise<unknown>),
  dependencies: null as null | ((...args: unknown[]) => Promise<unknown>),
  archive: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a' }),
}))

vi.mock('@/lib/api', () => {
  /** 本物と同じ形。画面は code で分岐する。 */
  class ApiError extends Error {
    status: number
    code: string | undefined
    data: unknown
    constructor(status: number, message?: string, code?: string, data?: unknown) {
      super(message || `API error: ${status}`)
      this.name = 'ApiError'
      this.status = status
      this.code = code
      this.data = data
    }
  }
  return {
    ApiError,
    api: {
      tags: {
        list: (...args: unknown[]) => fixture.tagsList!(...args),
        dependencies: (...args: unknown[]) => fixture.dependencies!(...args),
        archive: (...args: unknown[]) => fixture.archive!(...args),
        update: async () => ({ success: true, data: null }),
        setGroup: async () => ({ success: true, data: null }),
        reorder: async () => ({ success: true, data: null }),
      },
      tagGroups: {
        list: (...args: unknown[]) => fixture.tagGroupsList!(...args),
        update: async () => ({ success: true, data: null }),
        delete: async () => ({ success: true, data: null }),
      },
      listStats: { get: async () => ({ success: false, error: 'unused' }) },
      featureSettings: {
        visibility: async () => ({
          success: true,
          data: { features: { friend_fields: true, support_marks: true, saved_searches: true } },
        }),
      },
    },
  }
})

vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))

import TagsList from '@/v8/tags/list'
import { flushListUrlState } from '@/components/shared/list-url-state'

const TAGS = [
  {
    id: 'tag-archived',
    name: '旧キャンペーン',
    color: '#222222',
    createdAt: '2026-09-01T00:00:00Z',
    lineAccountId: 'account-a',
    status: 'active',
  },
]

/** 削除確認の窓が読む依存の形。`impact.tag.version` と `revision` を返す。 */
function dependencies() {
  const counts = {
    broadcasts: 0, forms: 0, scenarios: 0, autoReplies: 0, savedSearches: 0,
    automations: 0, commonActions: 0, richMenus: 0, templates: 0, webinars: 0,
    reminders: 0, entryRoutes: 0, trackedLinks: 0, bookingMenus: 0,
    affiliateOffers: 0, events: 0, analyticsFunnels: 0, friendAddSettings: 0,
  }
  return {
    success: true,
    data: {
      tag: { id: 'tag-archived', name: '旧キャンペーン', version: 2, status: 'archived' },
      friendCount: 0,
      referenceCounts: counts,
      references: [],
      referenceItems: [],
      linkedActions: [],
      pendingRunCount: 0,
      mileageImpact: {
        configured: false, self: 0, referrer: 0, multiplier: null, priority: 0,
        reapplyPolicy: 'first_only', historyPreserved: true,
      },
      blockingReferenceCount: 0,
      canArchive: false,
      canDelete: true,
      checkedAt: '2026-09-11T00:00:00.000Z',
      revision: 'tag:tag-archived:v2:2026-09-11T00:00:00.000Z',
    },
  }
}

beforeEach(() => {
  flushListUrlState(); window.history.replaceState(null, '', '/tags')
  fixture.tagsList = vi.fn(async () => ({ success: true, data: TAGS }))
  fixture.tagGroupsList = vi.fn(async () => ({ success: true, data: [] }))
  fixture.dependencies = vi.fn(async () => dependencies())
  fixture.archive = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 一覧を描き、行の「…」から削除の確認窓を開く。 */
async function openDeleteDialog() {
  // 整理の結果は Toast（右下・4秒）で出す。置き場所も一緒に描く。
  clearToastsForTest()
  render(<><TagsList accountId="account-a" /><ToastHost /></>)
  // 表と狭幅カードの両方に同じ操作が出るため、見えている側として先頭を取る。
  // ★管理画面 `Xn1Mz`：削除は「…」メニューの中の危ない操作へ。赤いゴミ箱だけの
  // ボタンは行に直に置かない。確認窓の動き（#708）はそのまま守る。
  const moreButton = (await screen.findAllByRole('button', { name: 'タグ「旧キャンペーン」の操作' }))[0]
  await act(async () => { fireEvent.click(moreButton) })
  const deleteItem = await screen.findByRole('menuitem', { name: '保管する' })
  await act(async () => { fireEvent.click(deleteItem) })
  await screen.findByText('「旧キャンペーン」を保管しますか？')
  const input = screen.getByPlaceholderText('旧キャンペーン')
  await act(async () => { fireEvent.change(input, { target: { value: '旧キャンペーン' } }) })
}

describe('#708 保管の確定直前にほかが保管したとき', () => {
  test('already_archived は赤い失敗ではなく「すでに整理されています」で出て、一覧を読み直す', async () => {
    const { ApiError } = await import('@/lib/api')
    fixture.archive = vi.fn(async () => {
      throw new ApiError(409, 'このタグはすでに保管済みです。', 'already_archived')
    })
    await openDeleteDialog()

    const before = (fixture.tagsList as ReturnType<typeof vi.fn>).mock.calls.length
    const archiveButton = screen.getByRole('button', { name: 'このタグを保管する' })
    await act(async () => { fireEvent.click(archiveButton) })

    // 成功の通知として出る。赤い失敗（alertdialog の中の saveError）は出ない。
    expect(await screen.findByText('このタグはすでに保管済みです。')).toBeTruthy()
    // 確認窓は閉じる。
    await waitFor(() => {
      expect(screen.queryByText('「旧キャンペーン」を保管しますか？')).toBeNull()
    })
    // 一覧を読み直す（望んだ状態にはもう着いているので、画面も最新にする）。
    await waitFor(() => {
      expect((fixture.tagsList as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)
    })
  })

  test('受付に失敗した応答では確認窓を閉じず、成功を知らせない', async () => {
    fixture.archive = vi.fn(async () => ({ success: false, error: '保存できません' }))
    await openDeleteDialog()
    expect(fixture.archive).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'このタグを保管する' })) })
    expect(await screen.findByText('保管できませんでした。影響を読み直して、もう一度お試しください。')).toBeTruthy()
    expect(screen.getByText('「旧キャンペーン」を保管しますか？')).toBeTruthy()
    expect(screen.queryByText('「旧キャンペーン」を保管しました')).toBeNull()
  })

  test('ほかの 409 は今までどおり失敗として出る', async () => {
    const { ApiError } = await import('@/lib/api')
    fixture.archive = vi.fn(async () => {
      throw new ApiError(409, '別の人が先にタグを更新しました', 'version_conflict')
    })
    await openDeleteDialog()

    const archiveButton = screen.getByRole('button', { name: 'このタグを保管する' })
    await act(async () => { fireEvent.click(archiveButton) })

    expect(await screen.findByText('保管できませんでした。影響を読み直して、もう一度お試しください。')).toBeTruthy()
    expect(screen.queryByText('このタグはすでに保管済みです。')).toBeNull()
    // 失敗なので確認窓は開いたまま。
    expect(screen.getByText('「旧キャンペーン」を保管しますか？')).toBeTruthy()
  })
})

describe('R190 保管済みの行に同じ確認を繰り返さない', () => {
  test('保管済みの行の「…」に保管メニューは無い', async () => {
    clearToastsForTest()
    fixture.tagsList = vi.fn(async () => ({
      success: true,
      data: [{ ...TAGS[0], status: 'archived' }],
    }))
    render(<><TagsList accountId="account-a" /><ToastHost /></>)
    fireEvent.click(await screen.findByRole('button', { name: '保管' }))
    expect((await screen.findAllByText('旧キャンペーン')).length).toBeGreaterThan(0)
    // 保管済みでも編集は「…」に残し、保管を繰り返す口は出さない。
    fireEvent.click(screen.getAllByRole('button', { name: 'タグ「旧キャンペーン」の操作' })[0])
    expect(screen.queryByRole('menuitem', { name: '保管する' })).toBeNull()
    // 編集への道は残す。保管済みでも名前・説明の訂正はできる（#710）。
    expect(screen.getByRole('menuitem', { name: '編集する' })).toBeTruthy()
  })
})

test('保管が完了したら対象の名前を知らせて一覧を読み直す', async () => {
  fixture.archive = vi.fn(async () => ({ success: true }))
  await openDeleteDialog()
  fireEvent.click(screen.getByRole('button', { name: 'このタグを保管する' }))
  await screen.findByText('「旧キャンペーン」を保管しました')
  await waitFor(() => expect(fixture.tagsList).toHaveBeenCalledTimes(2))
})
