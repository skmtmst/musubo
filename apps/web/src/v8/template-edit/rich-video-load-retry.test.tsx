// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { richVideoContent, type RichVideoDraft } from './rich-video-core'

const mocks = vi.hoisted(() => ({
  role: 'owner',
  account: 'a',
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  disarm: vi.fn(),
  guarded: vi.fn((action: () => void) => action()),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/templates/edit',
  useSearchParams: () => new URLSearchParams('kind=rich_video&id=r'),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => mocks.role,
  canManageRole: (role: string) => role === 'owner' || role === 'admin',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: mocks.account, accounts: [{ id: 'a', name: '本店' }] }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-unsaved-guard', () => ({
  useUnsavedGuard: () => ({ leaveTarget: null, disarm: mocks.disarm, guarded: mocks.guarded }),
}))
vi.mock('@/lib/unsaved-leave-dialog', () => ({ UnsavedLeaveDialog: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    templates: { get: mocks.get, create: mocks.create, update: mocks.update },
    folders: { list: async () => ({ success: true, data: [] }) },
  },
}))

import Editor from './rich-video'

const sampleDraft: RichVideoDraft = {
  name: '新メニュー紹介の動画',
  folderId: '',
  originalContentUrl: 'https://worker.example/images/video.mp4',
  previewImageUrl: 'https://worker.example/images/preview.jpg',
  height: 520,
  buttonEnabled: true,
  actionLabel: '詳しく見る',
  actionUrl: 'https://example.com/menu',
  altText: '新しい動画です',
}

function loadedResponse() {
  return {
    success: true as const,
    data: {
      id: 'r',
      accountId: 'a',
      name: sampleDraft.name,
      folderId: null,
      messageType: 'imagemap',
      messageContent: JSON.stringify({ ...richVideoContent(sampleDraft), baseUrl: 'https://worker.example/images/imagemaps/map' }),
      publishedVersion: 1,
      draftRevision: 0,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role = verifiedStaffRole('owner')
  mocks.account = 'a'
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
})

describe('リッチビデオ編集の読み込み失敗時再読み込み', () => {
  it('読み込み失敗時に別アカウント案内を誤表示せず、その場で再読み込みして復旧できる', async () => {
    mocks.get
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(loadedResponse())

    render(<Editor id="r" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('読み込めませんでした')
    expect(screen.queryByText(/このテンプレートのLINEアカウントに切り替えてから保存してください/)).toBeNull()
    expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByDisplayValue('新メニュー紹介の動画')
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
