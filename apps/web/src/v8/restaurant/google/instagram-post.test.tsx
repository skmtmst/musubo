import { beforeEach as seedIdentity } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
/*
 * Instagram 同時投稿の見え方（★V8-B `U1X7T2`・`HEEN9`／2026-10-07 利用者承認）。
 * 守るのは BEHAVIOR.md に書いた決めごと：
 *  - 札のことばは3つだけ。送る前（出す設定だがまだ結果が無い）と `instagram === null` は札を出さない。
 *  - 「Instagram へ再送」は失敗したときだけ。
 *  - 投稿を作る画面の区画は、Instagram をつないでいるときだけ出す（「出す＝使える」）。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import type { GooglePost, GooglePostInstagram, GooglePostListData } from '@/lib/restaurant-google-api'
import { PostConfirm, PostEditor, PostsBoard } from './posts'

const fixture = vi.hoisted(() => ({
  posts: vi.fn(),
  post: vi.fn(),
  syncPosts: vi.fn(),
  cancelPost: vi.fn(),
  removePost: vi.fn(),
  retryInstagram: vi.fn(),
  createPost: vi.fn(),
  savePost: vi.fn(),
  publishPost: vi.fn(),
  igConnection: vi.fn(),
  mediaList: vi.fn(),
  mediaDownload: vi.fn(),
  mediaReadContent: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: {
    posts: fixture.posts,
    post: fixture.post,
    syncPosts: fixture.syncPosts,
    cancelPost: fixture.cancelPost,
    removePost: fixture.removePost,
    retryInstagram: fixture.retryInstagram,
    createPost: fixture.createPost,
    savePost: fixture.savePost,
    publishPost: fixture.publishPost,
  },
}))

vi.mock('@/lib/api', () => ({
  api: {
    instagram: { connection: fixture.igConnection },
    media: { list: fixture.mediaList, download: fixture.mediaDownload, readContent: fixture.mediaReadContent, contentUrl: (id: string) => `https://example.test/media/${id}` },
  },
  ApiError: class ApiError extends Error {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/restaurant-test/google',
  useSearchParams: () => new URLSearchParams(),
}))

const go = vi.fn()

function ig(patch: Partial<GooglePostInstagram>): GooglePostInstagram {
  return { enabled: true, caption: null, mediaId: null, status: 'none', permalink: null, error: null, ...patch }
}

function post(id: string, patch: Partial<GooglePost>): GooglePost {
  return {
    id,
    kind: 'standard',
    origin: 'admin',
    summary: `本文 ${id}`,
    title: null,
    schedule: null,
    cta: null,
    offer: null,
    media: [],
    instagram: null,
    publishMode: 'now',
    status: 'draft',
    googleState: null,
    searchUrl: null,
    staffName: null,
    error: null,
    createdAt: '2026-10-07T01:00:00.000Z',
    sentAt: null,
    publishedAt: null,
    updatedAt: '2026-10-07T01:00:00.000Z',
    ...patch,
  }
}

function listOf(posts: GooglePost[]): GooglePostListData {
  return {
    success: true,
    posts,
    page: 1,
    perPage: 20,
    total: posts.length,
    counts: { all: posts.length, draft: 0, published: 0, attention: 0, scheduled: 0 },
    writeEnabled: true,
    permissions: { canPublish: true },
  }
}

function connection(state: InstagramConnectionStatus['state']) {
  return Promise.resolve({ success: true as const, data: { state, replyEnabled: false as const } })
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const registeredImage = {
  id: 'media-1', lineAccountId: 'acc-1', folderId: null, kind: 'image',
  filename: '料理写真.jpg', mimeType: 'image/jpeg', sizeBytes: 12,
  width: 1200, height: 900, durationMs: null, url: '', uploadedBy: null,
  createdAt: '2026-10-29T00:00:00Z',
}

describe('投稿一覧の Instagram の札（★V8-B `HEEN9`）', () => {
  it('絵のことば3つだけを出し、送る前と未対応の投稿には札を出さない', async () => {
    fixture.posts.mockResolvedValue(listOf([
      post('p-done', { status: 'published', instagram: ig({ status: 'published' }) }),
      post('p-failed', { status: 'published', instagram: ig({ status: 'failed', error: '画像を読めませんでした' }) }),
      post('p-off', { instagram: ig({ enabled: false }) }),
      post('p-before', { instagram: ig({ status: 'none' }) }),
      post('p-unsupported', { instagram: null }),
    ]))

    render(<PostsBoard accountId="acc-1" go={go} />)

    expect(await screen.findByText('Instagram 済み')).toBeTruthy()
    expect(screen.getByText('Instagram 失敗・もう一度送る')).toBeTruthy()
    expect(screen.getByText('Instagram なし')).toBeTruthy()
    // 送る前（p-before）と未対応（p-unsupported）の分は増えない。
    expect(screen.queryAllByText(/^Instagram (済み|失敗・もう一度送る|なし)$/)).toHaveLength(3)
  })

  it('失敗した投稿の「…」にだけ「Instagram へ再送」が出て、押すと再送の口を呼ぶ', async () => {
    fixture.posts.mockResolvedValue(listOf([
      post('p-failed', { summary: '失敗した投稿', status: 'published', instagram: ig({ status: 'failed' }) }),
      post('p-done', { summary: '出せた投稿', status: 'published', instagram: ig({ status: 'published' }) }),
    ]))
    fixture.retryInstagram.mockResolvedValue({ success: true })

    render(<PostsBoard accountId="acc-1" go={go} />)

    fireEvent.click(await screen.findByRole('button', { name: '投稿「出せた投稿」の操作' }))
    expect(screen.queryByText('Instagram へ再送')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '投稿「失敗した投稿」の操作' }))
    fireEvent.click(screen.getByText('Instagram へ再送'))
    await waitFor(() => expect(fixture.retryInstagram).toHaveBeenCalledWith('acc-1', 'p-failed'))
  })
})

describe('投稿を作る画面の Instagram の区画（★V8-B `U1X7T2`）', () => {
  it.each(['Google', 'Instagram'] as const)('%s の登録メディアを閲覧経路で読み、切り取り確認へ進む', async (target) => {
    fixture.igConnection.mockReturnValue(connection('connected'))
    fixture.mediaList.mockResolvedValue({ success: true, data: { items: [registeredImage], total: 1, limit: 20, offset: 0 } })
    fixture.mediaReadContent.mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }))
    fixture.mediaDownload.mockRejectedValue(new Error('追加の本人確認が必要です'))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL() { return 'blob:test-image' }
      static revokeObjectURL() {}
    })

    render(<PostEditor accountId="acc-1" kind="standard" postId={null} go={go} />)
    await screen.findByRole('switch', { name: 'Instagram にも投稿する' })
    const picks = screen.getAllByRole('button', { name: '登録メディアから選ぶ' })
    fireEvent.click(picks[target === 'Google' ? 0 : 1])
    await screen.findByRole('dialog', { name: `${target}用画像を登録メディアから選ぶ` })
    fireEvent.click(await screen.findByRole('radio', { name: /料理写真.jpg/ }))
    fireEvent.click(screen.getByRole('button', { name: '切り取り位置を確認' }))
    await waitFor(() => expect(fixture.mediaReadContent).toHaveBeenCalledWith('media-1', 'acc-1'))
    expect(fixture.mediaDownload).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: `${target}用画像の切り取り位置を確認` })).toBeTruthy()
  })

  it('Google画像は投稿の詳細より前、Instagram画像はInstagram本文より後に置く', async () => {
    fixture.igConnection.mockReturnValue(connection('connected'))
    render(<PostEditor accountId="acc-1" kind="standard" postId={null} go={go} />)
    const instagramImage = await screen.findByText('Instagram 用の画像')
    const googleImage = screen.getByText('Google ビジネス用の画像')
    const details = screen.getByText('投稿の詳細')
    const caption = screen.getByLabelText('Instagram 用の文章（書き換えたいときだけ）')
    expect(googleImage.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(caption.compareDocumentPosition(instagramImage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('つないでいるときだけ出し、既定はオン。オフにすると文章の欄をたたむ', async () => {
    fixture.igConnection.mockReturnValue(connection('connected'))

    render(<PostEditor accountId="acc-1" kind="standard" postId={null} go={go} />)

    const toggle = await screen.findByRole('switch', { name: 'Instagram にも投稿する' })
    expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true)
    expect(screen.getByLabelText('Instagram 用の文章（書き換えたいときだけ）')).toBeTruthy()
    expect(screen.getByText('Instagram 用の画像')).toBeTruthy()

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByLabelText('Instagram 用の文章（書き換えたいときだけ）')).toBeNull())
  })

  it('つないでいないときは区画そのものを出さない', async () => {
    fixture.igConnection.mockReturnValue(connection('unconfigured'))

    render(<PostEditor accountId="acc-1" kind="standard" postId={null} go={go} />)

    await screen.findByText('投稿を作る')
    expect(screen.queryByRole('switch', { name: 'Instagram にも投稿する' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Instagram にも投稿する' })).toBeNull()
    expect(screen.queryByText('Instagram 用の画像')).toBeNull()
    expect(screen.queryByText(/Instagram には画像が 1 枚必要です/)).toBeNull()
  })
})

describe('公開前の確認の Instagram の行（★V8-B `U1X7T2`）', () => {
  it('まだ出していないときは「Google と同時に出します」と伝える', async () => {
    fixture.post.mockResolvedValue({
      success: true,
      post: post('p-1', { instagram: ig({ status: 'none' }) }),
      store: { name: '然カフェ 本店' },
      writeEnabled: true,
      canPublish: true,
    })

    render(<PostConfirm accountId="acc-1" id="p-1" go={go} />)

    expect(await screen.findByText('Google と同時に出します（本文をそのまま使います）')).toBeTruthy()
    expect(screen.getByText('Instagram')).toBeTruthy()
  })

  it('失敗しているときは Google の公開が残っていることと再送の場所を伝える', async () => {
    fixture.post.mockResolvedValue({
      success: true,
      post: post('p-1', { status: 'published', instagram: ig({ status: 'failed', error: '画像を読めませんでした' }) }),
      store: { name: '然カフェ 本店' },
      writeEnabled: true,
      canPublish: true,
    })

    render(<PostConfirm accountId="acc-1" id="p-1" go={go} />)

    expect(await screen.findByText('出せませんでした（再送できます）')).toBeTruthy()
    expect(screen.getByText(/Google への公開はそのまま残っています/)).toBeTruthy()
    expect(screen.getByText(/「Instagram へ再送」でもう一度送れます/)).toBeTruthy()
  })
})

seedIdentity(() => { verifiedStaffRole('owner') })

it.each([{ canPublish: false }, { writeEnabled: false }])('投稿の送信結果が未確認でも送れない時は押せない操作を案内しない %o', async restriction => {
  fixture.post.mockResolvedValue({ post: post('p-1', { status: 'pending_confirm' }), store: { id: 'store', name: '然カフェ 本店' }, writeEnabled: true, canPublish: true, ...restriction })
  render(<PostConfirm accountId="acc-1" id="p-1" go={go} />)
  const notice = await screen.findByText(/前回の送信結果を確認できていません/)
  expect(notice.textContent).toContain('Google側の状態を確認してください。')
  expect(notice.textContent).not.toContain('を押すと')
  expect(fixture.publishPost).not.toHaveBeenCalled()
})

it('Instagram失敗の確認を閲覧のみで開いても、押せない再送操作は案内しない', async () => {
  fixture.post.mockResolvedValue({ post: post('p-1', { status: 'published', instagram: ig({ status: 'failed', error: '画像を読めませんでした' }) }), store: { id: 'store', name: '然カフェ 本店' }, writeEnabled: true, canPublish: false })
  render(<PostConfirm accountId="acc-1" id="p-1" go={go} />)
  const notice = await screen.findByText(/Google への公開はそのまま残っています/)
  expect(notice.textContent).toContain('管理者に確認を依頼してください')
  expect(notice.textContent).not.toContain('「Instagram へ再送」')
  expect(fixture.retryInstagram).not.toHaveBeenCalled()
})

it('Googleの審査で公開されなかった投稿を閲覧のみで見た時は、作り直しを管理者に依頼する', async () => {
  verifiedStaffRole('viewer')
  fixture.post.mockResolvedValue({ post: post('p-1', { status: 'rejected' }), store: { id: 'store', name: '然カフェ 本店' }, writeEnabled: true, canPublish: true })
  render(<PostConfirm accountId="acc-1" id="p-1" go={go} />)
  const notice = await screen.findByText(/Googleの審査で公開されませんでした/)
  expect(notice.textContent).toContain('管理者に内容の確認を依頼してください')
  expect(fixture.publishPost).not.toHaveBeenCalled()
})
