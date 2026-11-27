// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hq = vi.hoisted(() => ({
  list: vi.fn(),
  folders: vi.fn(),
  updateFolder: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
}))

vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: hq }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

import HqBroadcastList from './list'
import { flushListUrlState } from '@/components/shared/list-url-state'

const RUN = {
  id: 'run-1',
  title: '春キャンペーン配信',
  status: 'scheduled',
  version: 1,
  scheduledAt: null,
  input: {
    title: '春キャンペーン配信',
    messageType: 'text',
    messageContent: '本文',
    audience: { kind: 'all' },
    accountIds: ['acc-1'],
    accountTagIds: [],
    excludedAccountIds: [],
    requestId: 'req-1',
    scheduledAt: null,
    folderId: 'f-1',
  },
  targets: [
    {
      accountId: 'acc-1',
      accountName: '本店',
      audienceCount: 100,
      remaining: 900,
      connected: true,
      paused: false,
      blockedReasons: [],
      excluded: false,
      broadcastId: 'b-1',
      failureReasons: [],
      status: 'sent',
      version: 1,
      successCount: 100,
      totalCount: 100,
      openedCount: 40,
      clickedCount: 10,
      reactionCount: 0,
      retryableCount: 0,
      stopped: false,
    },
  ],
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  flushListUrlState()
  window.history.replaceState(null, '', '/hq/broadcasts')
  hq.list.mockReset()
  hq.folders.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete document.documentElement.dataset.theme
})

describe('統括 一括配信の一覧：読み込み失敗表示とその場復旧', () => {
  it('フォルダ取得だけが失敗しても配信一覧は保ち、注意帯の「フォルダを読み直す」でフォルダをその場復旧できる', async () => {
    hq.list.mockResolvedValue({ success: true, data: [RUN] })
    hq.folders
      .mockRejectedValueOnce(new Error('folders offline'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'f-1', name: '季節キャンペーン', revision: 1, item_count: 1, color: '#3b82f6' }],
      })

    render(<HqBroadcastList />)
    await screen.findByText('春キャンペーン配信')
    await screen.findByText(/フォルダを読み込めませんでした/)

    expect(hq.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'フォルダを読み直す' }))

    await waitFor(() => expect(screen.getAllByText('季節キャンペーン').length).toBeGreaterThan(0))
    expect(screen.queryByText(/フォルダを読み込めませんでした/)).toBeNull()
    expect(hq.list).toHaveBeenCalledTimes(1)
    expect(hq.folders).toHaveBeenCalledTimes(2)
  })

  it('フォルダ再読み込み中の二重押しを防ぎ、HTTP 200 success:false も失敗として扱う', async () => {
    let finishFolders!: (value: unknown) => void
    hq.list.mockResolvedValue({ success: true, data: [RUN] })
    hq.folders
      .mockResolvedValueOnce({ success: false, error: 'folders unavailable' })
      .mockImplementationOnce(() => new Promise((resolve) => { finishFolders = resolve }))

    render(<HqBroadcastList />)
    await screen.findByText('春キャンペーン配信')
    const retryBtn = await screen.findByRole('button', { name: 'フォルダを読み直す' })

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(hq.folders).toHaveBeenCalledTimes(2)

    await act(async () => {
      finishFolders({ success: true, data: [{ id: 'f-2', name: '定番案内', revision: 1, item_count: 0, color: '#10b981' }] })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getAllByText('定番案内').length).toBeGreaterThan(0))
  })

  it('一覧の読み込み中は4つのKPIカードがローディングになり、失敗時はKPIに失敗文言を出して再読み込みで復旧できる', async () => {
    let finishFirst!: (value: unknown) => void
    hq.folders.mockResolvedValue({ success: true, data: [] })
    hq.list
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce({ success: true, data: [RUN] })

    const { container } = render(<HqBroadcastList />)
    await waitFor(() => expect(hq.list).toHaveBeenCalledTimes(1))

    const statsRegion = container.querySelector('[data-template-region="stats"]') ?? container
    expect(statsRegion.querySelectorAll('[aria-busy="true"]').length).toBe(4)

    await act(async () => {
      finishFirst({ success: false, error: 'list unavailable' })
      await Promise.resolve()
    })

    await waitFor(() => expect(statsRegion.textContent).toContain('読み込めませんでした'))
    const retryBtn = await screen.findByRole('button', { name: /もう一度読み込む|再読み込み/ })
    fireEvent.click(retryBtn)

    await screen.findByText('春キャンペーン配信')
    expect(statsRegion.textContent).toContain('100人に届いた')
    expect(statsRegion.textContent).not.toContain('読み込めませんでした')
  })
})
