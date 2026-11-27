// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { GooglePost, GooglePostListData } from '@/lib/restaurant-google-api'

const gApi = vi.hoisted(() => ({
  posts: vi.fn(),
  post: vi.fn(),
  syncPosts: vi.fn(),
  publishPost: vi.fn(),
  instagramConnection: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', async (original) => ({
  ...await original<typeof import('@/lib/restaurant-google-api')>(),
  restaurantGoogleApi: {
    posts: gApi.posts,
    post: gApi.post,
    syncPosts: gApi.syncPosts,
    publishPost: gApi.publishPost,
  },
}))

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: () => new Promise(() => {}) },
      instagram: { connection: gApi.instagramConnection },
      media: { ...actual.api.media, detail: vi.fn().mockResolvedValue({ success: false }) },
    },
  }
})

vi.mock('next/navigation', () => {
  const searchParams = new URLSearchParams()
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => searchParams,
    usePathname: () => '/restaurant-test/google',
  }
})

import { PostConfirm, PostEditor, PostsBoard } from './posts'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makePost(id: string, title: string, status: GooglePost['status'] = 'draft'): GooglePost {
  return {
    id,
    kind: 'standard',
    status,
    origin: 'local',
    title,
    summary: `${title}の本文`,
    schedule: null,
    cta: null,
    offer: null,
    media: [],
    instagram: null,
    searchUrl: null,
    publishedAt: null,
    updatedAt: '2026-11-28T01:00:00Z',
    confirmationRevision: 1,
  }
}

function makeList(posts: GooglePost[], overrides: Partial<GooglePostListData> = {}): GooglePostListData {
  return {
    success: true,
    posts,
    page: 1,
    perPage: 20,
    total: posts.length,
    counts: { all: posts.length, scheduled: 0, draft: posts.length, published: 0, attention: 0 },
    permissions: { canPublish: true },
    ...overrides,
  }
}

describe('Google投稿 一覧競合破棄・異常件数防御・編集/確認切替リセット', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    verifiedStaffRole('owner')
    gApi.posts.mockResolvedValue(makeList([]))
    gApi.syncPosts.mockResolvedValue({ success: true })
    gApi.instagramConnection.mockResolvedValue({ success: true, data: { state: 'unconfigured' } })
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
  })

  it('同一店舗で種類フィルタを切り替えた後に届いた古い一覧応答で新しい一覧を上書きしない', async () => {
    const first = deferred<GooglePostListData>()
    const second = deferred<GooglePostListData>()
    gApi.posts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(<PostsBoard accountId="acc-1" go={vi.fn()} />)
    await waitFor(() => expect(gApi.posts).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '種類で絞り込み' }))
    fireEvent.click(await screen.findByRole('button', { name: 'イベント' }))
    await waitFor(() => expect(gApi.posts).toHaveBeenCalledTimes(2))

    await act(async () => { second.resolve(makeList([makePost('p-new', '新しいイベント投稿')])) })
    expect(await screen.findByText('新しいイベント投稿')).toBeTruthy()

    await act(async () => { first.resolve(makeList([makePost('p-old', '古い全件投稿')])) })
    expect(screen.queryByText('古い全件投稿')).toBeNull()
    expect(screen.getByText('新しいイベント投稿')).toBeTruthy()
  })

  it('total が負数や NaN、perPage が 0 以下のときに確定件数や異常ページ数を出さない', async () => {
    gApi.posts.mockResolvedValue(makeList([makePost('p1', 'テスト投稿')], { total: -3, perPage: 0 }))
    render(<PostsBoard accountId="acc-1" go={vi.fn()} />)
    expect(await screen.findByText('投稿 件数を確認できません')).toBeTruthy()
    expect(screen.queryByText(/投稿 -3 件/)).toBeNull()
    expect(screen.queryByText(/Infinity/)).toBeNull()
  })

  it('PostEditor で読み込み失敗のあとに新規作成へ切り替えると編集可能な状態に戻る', async () => {
    gApi.post.mockRejectedValueOnce(new Error('取得失敗'))
    const view = render(<PostEditor accountId="acc-1" kind="standard" postId="p-bad" go={vi.fn()} />)
    expect(await screen.findByText('投稿を読み込めませんでした')).toBeTruthy()

    view.rerender(<PostEditor accountId="acc-1" kind="standard" postId={null} go={vi.fn()} />)
    const summaryField = await screen.findByLabelText(/本文/)
    expect((summaryField as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.queryByText('投稿を読み込めませんでした')).toBeNull()
  })

  it('PostConfirm で対象投稿を切り替えた後に届いた古い応答が画面を上書きせず確認チェックも引き継がない', async () => {
    const first = deferred<{ post: GooglePost; store: { id: string; name: string }; writeEnabled: boolean; canPublish: boolean }>()
    const second = deferred<{ post: GooglePost; store: { id: string; name: string }; writeEnabled: boolean; canPublish: boolean }>()
    gApi.post
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const view = render(<PostConfirm accountId="acc-1" id="p-old" go={vi.fn()} />)
    await waitFor(() => expect(gApi.post).toHaveBeenCalledWith('acc-1', 'p-old'))

    view.rerender(<PostConfirm accountId="acc-1" id="p-new" go={vi.fn()} />)
    await waitFor(() => expect(gApi.post).toHaveBeenCalledWith('acc-1', 'p-new'))

    await act(async () => {
      second.resolve({
        post: makePost('p-new', '新しい確認投稿'),
        store: { id: 's1', name: '本店' },
        writeEnabled: true,
        canPublish: true,
      })
    })
    expect(await screen.findByText('新しい確認投稿')).toBeTruthy()

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)

    await act(async () => {
      first.resolve({
        post: makePost('p-old', '古い確認投稿'),
        store: { id: 's1', name: '本店' },
        writeEnabled: true,
        canPublish: true,
      })
    })
    expect(screen.queryByText('古い確認投稿')).toBeNull()
    expect(screen.getByText('新しい確認投稿')).toBeTruthy()

    gApi.post.mockResolvedValueOnce({
      post: makePost('p-third', '3件目の確認投稿'),
      store: { id: 's1', name: '本店' },
      writeEnabled: true,
      canPublish: true,
    })
    view.rerender(<PostConfirm accountId="acc-1" id="p-third" go={vi.fn()} />)
    expect(await screen.findByText('3件目の確認投稿')).toBeTruthy()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})
