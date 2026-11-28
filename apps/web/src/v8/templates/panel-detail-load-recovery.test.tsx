// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushListUrlState } from '@/components/shared/list-url-state'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fixture = vi.hoisted(() => ({
  get: vi.fn(),
  publish: vi.fn(),
  list: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [], loading: false }),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      templates: {
        ...actual.api.templates,
        list: fixture.list,
        get: fixture.get,
        publish: fixture.publish,
      },
      folders: {
        ...actual.api.folders,
        list: async () => ({ success: true, data: [] }),
      },
      broadcastMessageAssets: {
        ...actual.api.broadcastMessageAssets,
        counts: async () => ({ success: true, data: {} }),
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import TemplatesList from './list'

const template = {
  id: 'template-1',
  accountId: 'account-a',
  name: '予約のお礼',
  category: 'general',
  messageType: 'text',
  messageContent: 'ご予約ありがとうございます。',
  question: null,
  questionStatus: 'published' as const,
  folderId: null,
  hasDraft: true,
  publishedVersion: 2,
  draftRevision: 7,
  publishedAt: '2026-10-01T00:00:00Z',
  usageCount: 1,
  monthlySendCount: 10,
  totalSendCount: 10,
  tapCount: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  usedBy: {
    autoReplies: [{ id: 'reply-1', keyword: '予約確認', matchType: 'contains' as const, lineAccountId: 'account-a', templateVersion: null }],
    automations: [],
    scenarioSteps: [],
    reminderSteps: [],
    richMenuAreas: [],
    trackedLinks: [],
    broadcasts: [],
  },
}

async function openPanel() {
  render(<TemplatesList />)
  const row = (await within(await screen.findByRole('table')).findByText('予約のお礼')).closest('tr')!
  fireEvent.keyDown(row, { key: 'Enter' })
  return screen.findByRole('dialog')
}

describe('TemplatesList 詳細パネル読み込み失敗の分類と再読み込み復旧', () => {
  beforeEach(() => {
    flushListUrlState()
    window.history.replaceState(null, '', '/templates')
    document.documentElement.dataset.theme = 'v8'
    fixture.list.mockReset().mockResolvedValue({ success: true, data: [template] })
    fixture.get.mockReset()
    fixture.publish.mockReset().mockResolvedValue({ success: true, data: {} })
  })

  afterEach(() => {
    cleanup()
    flushListUrlState()
  })

  it('429 応答の待ち秒数をパネル内に出し、もう一度読み込むで使用先へ復旧できる', async () => {
    fixture.get
      .mockRejectedValueOnce(new ApiError(429, 'Too many requests', undefined, undefined, undefined, 30))
      .mockResolvedValueOnce({ success: true, data: template })

    const panel = await openPanel()

    expect(await within(panel).findByText(/混み合っています。30秒ほど待ってから、もう一度読み込んでください。/)).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect(within(panel).getByText('予約確認')).toBeTruthy()
    })
  })

  it('403 応答ではパネル内に権限案内を表示する', async () => {
    fixture.get.mockRejectedValueOnce(new ApiError(403, 'forbidden'))

    const panel = await openPanel()

    expect(await within(panel).findByText(/テンプレートの詳細を見る権限がありません/)).toBeTruthy()
    expect(within(panel).getByText(/オーナーか管理者に頼んでください/)).toBeTruthy()
  })
})
