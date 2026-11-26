// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ prepare: vi.fn(), put: vi.fn(), complete: vi.fn(), detail: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), publish: vi.fn() }))

vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    media: { prepareUploads: calls.prepare, completeUpload: calls.complete, detail: calls.detail },
    templates: { create: calls.create, update: calls.update, get: calls.get, publish: calls.publish },
    folders: { list: async () => ({ success: true, data: [] }) },
  },
}))
vi.mock('../contents/media-direct-upload', async (original) => ({
  ...await original<Record<string, unknown>>(),
  extractMediaMetadata: async () => ({ width: 1040, height: 1040 }),
  putMediaFile: calls.put,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=tpl-1'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a-1', selectedAccount: { name: '店' }, accounts: [] }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
}))
vi.mock('@/components/auto-replies/inline-action-list', () => ({
  useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [] }),
}))

import Carousel from './carousel'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'

beforeEach(() => {
  verifiedStaffRole('owner')
  calls.get.mockReset()
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  vi.resetAllMocks()
})

describe('カルーセル編集の読み込み失敗時再読み込み', () => {
  it('既存カルーセルの読み込みに失敗しても画面を開き直さずその場でもう一度読み込める', async () => {
    calls.get
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'tpl-1',
          name: '夏の定番カルーセル',
          accountId: 'a-1',
          folderId: null,
          publishedVersion: 1,
          draftRevision: 1,
          carouselTapLimitMode: 'none',
          carouselTapLimitText: null,
          carouselActions: null,
          messageContent: JSON.stringify([{ title: '1枚目', text: '夏のおすすめ', actions: [{ type: 'message', label: '詳しく見る', text: '詳細' }] }]),
        },
      })

    render(<Carousel />)

    await screen.findByText(/読み込めませんでした/)
    const draftBtn = screen.getByRole('button', { name: '下書きを保存' }) as HTMLButtonElement
    expect(draftBtn.disabled).toBe(true)

    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    await waitFor(() => expect((screen.getByPlaceholderText('例：夏の定番5点') as HTMLInputElement).value).toBe('夏の定番カルーセル'))
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
    expect(draftBtn.disabled).toBe(false)
    expect(calls.get).toHaveBeenCalledTimes(2)
  })
})
