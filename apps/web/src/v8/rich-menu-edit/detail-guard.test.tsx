// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/rich-menus/edit/" }
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  get: vi.fn(),
  progress: vi.fn(),
  runs: vi.fn(),
  reconcile: vi.fn(),
  preview: vi.fn(),
  taps: vi.fn(),
}))

const account = { id: 'account-1', name: '店A' }
const baseGroup = {
  id: 'g1', accountId: 'account-1', name: 'メニュー1', chatBarText: 'メニュー',
  size: 'large', defaultPageId: 'p1', isDefaultForAll: true, status: 'published',
  targetingCondition: null, targetingPriority: 1, targetingEnabled: false,
  folderId: null, defaultOpen: true, version: 1, publicationGeneration: 1, confirmationRevision: 1,
  pages: [{ id: 'p1', orderIndex: 0, name: '1枚目', aliasId: '', lineRichmenuId: null, imageR2Key: 'img', imageContentType: 'image/jpeg', areas: [] }],
}

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: account, selectedAccountId: account.id, accounts: [account], loading: false }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) },
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        get: net.get,
        publishProgress: net.progress,
        publishRuns: net.runs,
        reconcile: net.reconcile,
        previewTargets: net.preview,
        audienceSummary: net.preview,
        tapStats: net.taps,
      },
    },
  }
})

import RichMenuDetailV8 from './detail'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  net.get.mockImplementation(async (id: string) => ({ success: true, data: { ...baseGroup, id, name: id === 'g1' ? 'メニュー1' : 'メニュー2' } }))
  net.progress.mockResolvedValue({ success: true, data: { steps: [], run: null, message: null } })
  net.runs.mockResolvedValue({ success: true, data: { runs: [] } })
  net.reconcile.mockResolvedValue({ success: true, data: { dryRun: true, diffs: [] } })
  net.preview.mockResolvedValue({ success: true, data: { effective: { value: 10 } } })
  net.taps.mockResolvedValue({ success: true, data: { byGroup: [{ groupId: 'g1', taps: 5 }] } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

describe('RichMenuDetailV8 古い進捗応答破棄・異常件数防御・未知実行状態表示', () => {
  it('負数や NaN の対象人数・タップ数に単位付きの異常表記を出さず、未知の実行状態を実行中と断定しない', async () => {
    net.preview.mockResolvedValueOnce({ success: true, data: { effective: { value: -5 } } })
    net.taps.mockResolvedValueOnce({ success: true, data: { byGroup: [{ groupId: 'g1', taps: Number.NaN }] } })
    net.runs.mockResolvedValueOnce({
      success: true,
      data: {
        runs: [
          {
            id: 'run-unknown',
            status: 'cancelled',
            createdAt: '2026-11-27T01:00:00Z',
            updatedAt: '2026-11-27T01:05:00Z',
            version: { name: 'メニュー1', pageCount: 1, isDefaultForAll: true, targetingEnabled: false },
          },
        ],
      },
    })

    await act(async () => { root.render(<RichMenuDetailV8 groupId="g1" />) })
    expect(await screen.findByText('状態を確認できません')).toBeTruthy()
    expect(container.textContent).not.toContain('-5 人')
    expect(container.textContent).not.toContain('— 回')
    expect(container.textContent).not.toContain('— 人')
    expect(screen.queryByText('実行中')).toBeNull()
  })

  it('別メニューへ切り替えた後に届いた古い公開進捗応答で新しい画面を上書きしない', async () => {
    let resolveOldProgress!: (v: unknown) => void
    net.progress.mockImplementation((id: string) =>
      id === 'g1'
        ? new Promise((resolve) => { resolveOldProgress = resolve })
        : Promise.resolve({
            success: true,
            data: {
              steps: [{ key: 's-new', label: '新しいメニューの公開段', status: 'done' }],
              run: { status: 'succeeded' },
              message: null,
            },
          }),
    )

    await act(async () => { root.render(<RichMenuDetailV8 groupId="g1" />) })
    await waitFor(() => expect(net.progress).toHaveBeenCalledWith('g1'))

    await act(async () => { root.render(<RichMenuDetailV8 groupId="g2" />) })
    expect(await screen.findByText('新しいメニューの公開段')).toBeTruthy()

    await act(async () => {
      resolveOldProgress({
        success: true,
        data: {
          steps: [{ key: 's-old', label: '古いメニューの失敗段', status: 'failed' }],
          run: { status: 'failed' },
          message: '古い失敗メッセージ',
        },
      })
    })
    expect(screen.queryByText('古いメニューの失敗段')).toBeNull()
    expect(screen.queryByText('古い失敗メッセージ')).toBeNull()
    expect(screen.getByText('新しいメニューの公開段')).toBeTruthy()
  })
})
