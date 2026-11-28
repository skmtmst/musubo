// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { GooglePost } from '@/lib/restaurant-google-api'

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

import { PostConfirm } from './posts'
import { ApiError } from '@/lib/api'

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


const details = (id: string, title: string, status: GooglePost['status'] = 'draft') => ({ post: makePost(id, title, status), store: { id: 's1', name: '本店' }, writeEnabled: true, canPublish: true })
beforeEach(() => { vi.resetAllMocks(); verifiedStaffRole('owner') })
afterEach(() => { cleanup(); forgetStaffIdentity() })

it('送信中に別の投稿へ移り、両方の応答が逆順でも新しい投稿だけを表示する', async () => {
  const oldSend = deferred<{ post: GooglePost; alreadyPublished: boolean }>()
  const newSend = deferred<{ post: GooglePost; alreadyPublished: boolean }>()
  gApi.post.mockImplementation(async (_account: string, id: string) => details(id, id === 'old' ? '前の投稿' : '次の投稿'))
  gApi.publishPost.mockReturnValueOnce(oldSend.promise).mockReturnValueOnce(newSend.promise)
  const view = render(<PostConfirm accountId="acc-1" id="old" go={vi.fn()} />)
  await screen.findByText('前の投稿')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(gApi.publishPost).toHaveBeenCalledWith('acc-1', 'old'))
  view.rerender(<PostConfirm accountId="acc-1" id="new" go={vi.fn()} />)
  await screen.findByText('次の投稿')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(gApi.publishPost).toHaveBeenCalledWith('acc-1', 'new'))
  await act(async () => oldSend.resolve({ post: makePost('old', '前の投稿', 'accepted'), alreadyPublished: false }))
  expect(screen.queryByText('前の投稿')).toBeNull()
  expect(screen.getByText('次の投稿')).toBeTruthy()
  expect(screen.getByRole('button', { name: '送信中…' })).toBeTruthy()
  await act(async () => newSend.resolve({ post: makePost('new', '次の投稿', 'accepted'), alreadyPublished: false }))
  expect(screen.getByText('次の投稿')).toBeTruthy()
  expect(screen.getByText('この投稿をGoogleに送信しました')).toBeTruthy()
})

it('別の投稿に移った後、前の送信が502でも新しい投稿へ失敗や読み直しを持ち込まない', async () => {
  const oldSend = deferred<{ post: GooglePost; alreadyPublished: boolean }>()
  gApi.post.mockImplementation(async (_account: string, id: string) => details(id, id === 'old' ? '前の投稿' : '次の投稿'))
  gApi.publishPost.mockReturnValue(oldSend.promise)
  const view = render(<PostConfirm accountId="acc-1" id="old" go={vi.fn()} />)
  await screen.findByText('前の投稿')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(gApi.publishPost).toHaveBeenCalledTimes(1))
  view.rerender(<PostConfirm accountId="acc-1" id="new" go={vi.fn()} />)
  await screen.findByText('次の投稿')
  await act(async () => oldSend.reject(new ApiError(502, 'failed')))
  expect(screen.getByText('次の投稿')).toBeTruthy()
  expect(screen.queryByText(/Googleへの送信結果を確認できませんでした/)).toBeNull()
  expect(gApi.post).toHaveBeenCalledTimes(2)
})

it('送信中に別の投稿を開いて戻っても、前の応答を新しい画面に反映しない', async () => {
  const oldSend = deferred<{ post: GooglePost; alreadyPublished: boolean }>()
  gApi.post.mockImplementation(async (_account: string, id: string) => details(id, id === 'old' ? '戻った投稿' : '別の投稿'))
  gApi.publishPost.mockReturnValue(oldSend.promise)
  const view = render(<PostConfirm accountId="acc-1" id="old" go={vi.fn()} />)
  await screen.findByText('戻った投稿')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(gApi.publishPost).toHaveBeenCalledTimes(1))
  view.rerender(<PostConfirm accountId="acc-1" id="new" go={vi.fn()} />)
  await screen.findByText('別の投稿')
  view.rerender(<PostConfirm accountId="acc-1" id="old" go={vi.fn()} />)
  await screen.findByText('戻った投稿')
  await act(async () => oldSend.resolve({ post: makePost('old', '古い送信結果', 'accepted'), alreadyPublished: false }))
  expect(screen.getByText('戻った投稿')).toBeTruthy()
  expect(screen.queryByText('古い送信結果')).toBeNull()
  expect(screen.queryByText('この投稿をGoogleに送信しました')).toBeNull()
})

it('投稿IDが同じでもアカウントを切り替えた後は前の送信結果を反映しない', async () => {
  const oldSend = deferred<{ post: GooglePost; alreadyPublished: boolean }>()
  gApi.post.mockImplementation(async (account: string, id: string) => details(id, account === 'acc-1' ? '本店の投稿' : '支店の投稿'))
  gApi.publishPost.mockReturnValue(oldSend.promise)
  const view = render(<PostConfirm accountId="acc-1" id="same" go={vi.fn()} />)
  await screen.findByText('本店の投稿')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(gApi.publishPost).toHaveBeenCalledWith('acc-1', 'same'))
  view.rerender(<PostConfirm accountId="acc-2" id="same" go={vi.fn()} />)
  await screen.findByText('支店の投稿')
  await act(async () => oldSend.resolve({ post: makePost('same', '本店の送信結果', 'accepted'), alreadyPublished: false }))
  expect(screen.getByText('支店の投稿')).toBeTruthy()
  expect(screen.queryByText('本店の送信結果')).toBeNull()
  expect(screen.queryByText('この投稿をGoogleに送信しました')).toBeNull()
})
