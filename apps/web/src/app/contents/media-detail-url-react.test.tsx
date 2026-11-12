// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

import type { MediaItem } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  detailCalls: [] as Array<{ id: string; accountId: string }>,
  pendingDetail: null as null | { resolve: (value: unknown) => void },
}))

const MEDIA_A: MediaItem = {
  id: 'media-a',
  lineAccountId: 'account-a',
  folderId: null,
  kind: 'image',
  filename: 'Aの画像.png',
  mimeType: 'image/png',
  sizeBytes: 1200,
  width: 100,
  height: 100,
  durationMs: null,
  url: 'https://example.test/a.png',
  uploadedBy: '管理者',
  createdAt: '2026-09-16T09:00:00+09:00',
  usageCount: 0,
}

const MEDIA_B: MediaItem = {
  ...MEDIA_A,
  id: 'media-b',
  lineAccountId: 'account-b',
  filename: 'Bの画像.png',
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(readonly status?: number, message = 'API error') {
      super(message)
    }
  }
  return {
    ApiError,
    api: {
      featureSettings: {
        visibility: () => Promise.resolve({ success: true, data: { features: { media: true } } }),
      },
      staff: {
        me: () => Promise.resolve({ success: true, data: { role: 'owner' } }),
      },
      folders: {
        list: () => Promise.resolve({ success: true, data: [], unfiledCount: 0 }),
      },
      media: {
        counts: () => Promise.resolve({ success: true, data: { total: 1, byKind: { image: 1, video: 0, audio: 0, file: 0 }, unused: 1, archived: 0 } }),
        list: (accountId: string) => Promise.resolve({
          success: true,
          data: {
            items: [accountId === 'account-b' ? MEDIA_B : MEDIA_A],
            total: 1,
            limit: 20,
            offset: 0,
          },
        }),
        quota: () => Promise.resolve({
          success: true,
          data: {
            usageBytes: 1200,
            reservedBytes: 0,
            limitBytes: 10000,
            remainingBytes: 8800,
            usageRate: 0.12,
            state: 'normal',
          },
        }),
        detail: (id: string, accountId: string) => {
          fixture.detailCalls.push({ id, accountId })
          if (fixture.pendingDetail) {
            return new Promise((resolve) => {
              fixture.pendingDetail = { resolve }
            })
          }
          if (id === 'media-a' && accountId === 'account-a') {
            return Promise.resolve({ success: true, data: { item: MEDIA_A, folderName: null } })
          }
          return Promise.reject(new ApiError(404, 'Not found'))
        },
        deleteImpact: () => Promise.resolve({
          success: true,
          data: {
            media: { id: 'media-a', filename: 'Aの画像.png', kind: 'image' },
            usageCount: 0,
            references: [],
            versions: [],
            checkedAt: '2026-09-16T09:00:00+09:00',
            lastScannedAt: null,
            canDelete: true,
            recommendedAction: 'delete',
          },
        }),
        contentUrl: (id: string, accountId: string) => `/api/media/${id}/content?accountId=${accountId}`,
      },
    },
  }
})

const { default: ContentsPage } = await import('./page')

let host: HTMLDivElement
let root: Root
let mounted = false

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function renderPage() {
  await act(async () => {
    root.render(<ContentsPage />)
    await settle()
  })
}

async function remount() {
  await act(async () => { root.unmount() })
  host.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mounted = true
  await renderPage()
}

async function waitForText(text: string) {
  for (let index = 0; index < 20 && !host.textContent?.includes(text); index += 1) {
    await act(async () => { await settle() })
  }
  expect(host.textContent).toContain(text)
}

async function openDetailsFromUrl() {
  await act(async () => {
    window.history.pushState({}, '', '/contents?id=media-a')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await settle()
  })
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.detailCalls.length = 0
  fixture.pendingDetail = null
  window.history.replaceState({}, '', '/contents')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mounted = true
})

afterEach(async () => {
  if (mounted) await act(async () => { root.unmount() })
  host.remove()
  window.history.replaceState({}, '', '/contents')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('登録メディア詳細のURL復元（N-196）', () => {
  it('詳細を一意URLで開き、戻る・進むで一覧と同じ詳細を復元する', async () => {
    await renderPage()
    await waitForText(MEDIA_A.filename)

    await openDetailsFromUrl()
    expect(window.location.pathname).toBe('/contents')
    expect(new URLSearchParams(window.location.search).get('id')).toBe('media-a')
    await waitForText('ファイルのこと')

    await act(async () => { window.history.back(); await settle() })
    await waitForText('メディアを登録する')
    expect(new URLSearchParams(window.location.search).get('id')).toBeNull()

    await act(async () => { window.history.forward(); await settle() })
    await waitForText('ファイルのこと')
    expect(new URLSearchParams(window.location.search).get('id')).toBe('media-a')
  })

  it('共有URLを再マウントしてもAPIから同じ詳細を復元する', async () => {
    window.history.replaceState({}, '', '/contents?id=media-a')
    await renderPage()
    await waitForText('ファイルのこと')
    expect(fixture.detailCalls).toEqual([{ id: 'media-a', accountId: 'account-a' }])

    await remount()
    await waitForText('ファイルのこと')
    expect(fixture.detailCalls).toEqual([
      { id: 'media-a', accountId: 'account-a' },
      { id: 'media-a', accountId: 'account-a' },
    ])
  })

  it.each(['unknown-id', 'deleted-id', 'account-b-media'])(
    '%s は同じ安全な案内にして詳細情報を出さない',
    async (id) => {
      window.history.replaceState({}, '', `/contents?id=${id}`)
      await renderPage()
      await waitForText('メディアの詳細を開けません')
      expect(host.textContent).toContain('存在しないか、このLINEアカウントでは表示できません')
      expect(host.textContent).not.toContain('Aの画像.png')
      expect(host.textContent).not.toContain('Bの画像.png')
    },
  )

  it('account切替でURLと旧詳細を消し、遅い旧account応答も表示しない', async () => {
    window.history.replaceState({}, '', '/contents?id=media-a')
    fixture.pendingDetail = { resolve: () => undefined }
    await renderPage()
    expect(host.querySelector('[aria-busy="true"][aria-label="メディアの詳細を読み込んでいます"]')).toBeTruthy()

    const pending = fixture.pendingDetail
    fixture.accountId = 'account-b'
    await renderPage()
    await waitForText(MEDIA_B.filename)
    expect(new URLSearchParams(window.location.search).get('id')).toBeNull()

    await act(async () => {
      pending?.resolve({ success: true, data: { item: MEDIA_A, folderName: null } })
      await settle()
    })
    expect(host.textContent).not.toContain(MEDIA_A.filename)
    expect(host.textContent).toContain(MEDIA_B.filename)
  })
})

describe('登録メディア一覧の数の帯（O7hUt7）', () => {
  it('4つの数とアーカイブの案内が出る', async () => {
    await renderPage()
    await waitForText(MEDIA_A.filename)
    await waitForText('どこでも使っていない')
    await waitForText('使っている容量')
    await waitForText('一覧と新規選択から外したもの')
    // 画面の説明は題の横の「？」1つの中（洗い出し 74）。
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="この画面の説明"]')!.click() })
    await waitForText('使っているメディアは消せません')
  })
})
