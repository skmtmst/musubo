// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixture = vi.hoisted(() => ({
  search: '',
  list: vi.fn(),
  tenants: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(fixture.search),
  usePathname: () => '/ops/announcements/new',
}))

vi.mock('./use-ops-read-only', () => ({
  OPS_READONLY_LOCK_REASON: '閲覧のみです',
  useOpsReadOnlyState: () => 'writer',
}))

vi.mock('@/lib/line-accounts-cache', () => ({
  loadLineAccounts: async () => ({ success: true, data: [] }),
}))

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: {
        ...actual.api.ops,
        tenants: fixture.tenants,
        announcements: {
          ...actual.api.ops.announcements,
          list: fixture.list,
          preview: fixture.preview,
        },
      },
    },
  }
})

import OpsAnnouncementEditV8 from './announcement-edit'

beforeEach(() => {
  fixture.search = ''
  fixture.list.mockReset().mockResolvedValue({ success: true, noticeLineConfigured: true, data: [] })
  fixture.tenants.mockReset().mockResolvedValue({ success: true, data: [] })
  fixture.preview.mockReset().mockResolvedValue({ success: true, data: { tenants: 3, staff: 5, withEmail: 4, lineLinked: 2 } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OpsAnnouncementEditV8 の読み込み失敗と未知値の扱い', () => {
  it('契約先一覧の読み込み失敗時にエラーと再読み込みボタンを出し、再試行で候補を表示できる', async () => {
    fixture.tenants
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        success: true,
        data: [
          { id: 't-1', name: 'テスト食堂', status: 'active' },
          { id: 't-arch', name: '終了店舗', status: 'archived' },
        ],
      })

    render(<OpsAnnouncementEditV8 />)
    fireEvent.click(await screen.findByLabelText('契約先を選ぶ'))

    expect(await screen.findByText(/契約先を読み込めませんでした/)).toBeTruthy()
    expect(screen.queryByText('契約先を読み込んでいます…')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByRole('button', { name: 'テスト食堂' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '終了店舗' })).toBeNull()
  })

  it('選べる契約先が 0 件のときは読み込み中で固まらず空の案内を出す', async () => {
    fixture.tenants.mockResolvedValue({ success: true, data: [{ id: 't-arch', name: '終了店舗', status: 'archived' }] })

    render(<OpsAnnouncementEditV8 />)
    fireEvent.click(await screen.findByLabelText('契約先を選ぶ'))

    expect(await screen.findByText('選べる契約先がありません。')).toBeTruthy()
    expect(screen.queryByText('契約先を読み込んでいます…')).toBeNull()
  })

  it('宛先プレビュー失敗時と未知プランキーで確認ダイアログが固まらず生英語を出さない', async () => {
    fixture.search = 'id=ann-1'
    fixture.list.mockResolvedValue({
      success: true,
      noticeLineConfigured: true,
      data: [{
        id: 'ann-1',
        subject: '重要なお知らせ',
        body: '本文テスト',
        status: 'draft',
        audienceKind: 'plan',
        audiencePlans: ['enterprise_legacy'],
        audienceTenantIds: [],
        channels: ['screen', 'email'],
        publishAt: null,
        updatedAt: '2026-11-27T00:00:00Z',
      }],
    })
    fixture.preview.mockRejectedValue(new Error('preview failed'))

    render(<OpsAnnouncementEditV8 />)
    await screen.findByDisplayValue('重要なお知らせ')

    fireEvent.click(screen.getByRole('button', { name: '今すぐ送る' }))
    expect(await screen.findByText('その他のプランの契約先（件数を取得できませんでした）')).toBeTruthy()
    expect(screen.getByText('画面のお知らせ・メール')).toBeTruthy()
    expect(document.body.textContent).not.toContain('enterprise_legacy')
    expect(document.body.textContent).not.toContain('数えています…')
  })
})
