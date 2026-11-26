// @vitest-environment happy-dom
/*
 * 統括のバナー生成（src/v8/hq-banners/list.tsx・project.tsx）の行き先と生成の流れを、描いて押して見る。
 * - プロジェクトは /hq/banners/project?id= で開く（動的な住所を作らない）。タブは ?tab= を履歴に積まずに書き換える
 * - 権限が無い（403）ときは共通の「権限がない」面、0件のときは最初のプロジェクトを作る口
 * - 生成は条件を登録して状態を読み直し、終わったら止める。「生成をやめる」は走っている生成を止める口へ送る
 * - 手元のファイルを参照画像にするときは、プロジェクトへ取り込んでから参照に足す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  presets: vi.fn(), stats: vi.fn(), listProjects: vi.fn(), listImages: vi.fn(), getProject: vi.fn(), upload: vi.fn(),
  listAccounts: vi.fn(), aiSettings: vi.fn(), createGeneration: vi.fn(), getGeneration: vi.fn(), cancel: vi.fn(), push: vi.fn(), replace: vi.fn(), query: '',
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      hqBanners: {
        ...actual.api.hqBanners,
        presets: mocks.presets,
        stats: mocks.stats,
        usage: vi.fn(async () => ({ success: false })),
        projects: { ...actual.api.hqBanners.projects, list: mocks.listProjects, get: mocks.getProject, upload: mocks.upload, createGeneration: mocks.createGeneration },
        images: { ...actual.api.hqBanners.images, list: mocks.listImages },
        generations: { ...actual.api.hqBanners.generations, get: mocks.getGeneration, cancel: mocks.cancel },
      },
      lineAccounts: { ...actual.api.lineAccounts, list: mocks.listAccounts },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [] } })) },
    },
  }
})
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ setSelectedAccountId: vi.fn() }) }))
vi.mock('@/lib/api/helpers/gap3', () => ({ accountAiFeaturesApi: { get: mocks.aiSettings } }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useTenantWideAccess: () => true, useStaffRole: () => 'owner' }))

import { ApiError } from '@/lib/api'
import { flushListUrlState } from '@/components/shared/list-url-state'
import HqBannersListV8 from '@/v8/hq-banners/list'
import HqBannerProjectV8 from '@/v8/hq-banners/project'

const project = (id: string, name: string) => ({
  id, name, description: null, isFavorite: false, archivedAt: null, imageCount: 1, runningCount: 0,
  createdBy: null, createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-30T10:00:00+09:00',
})
const PRESET = { key: 'line_rich_message', group: 'line', label: 'リッチメッセージ', note: '', aspectRatio: '1:1', apiSize: '1024x1024', targetWidth: 1040, targetHeight: 1040 }
const generation = (id: string, status: string) => ({
  id, projectId: 'p1', status, mode: 'banner', presetKey: 'line_rich_message', aspectRatio: '1:1', apiSize: '1024x1024', quality: 'medium',
  textLines: ['秋の新商品'], emphasisLines: [false], baseColor: null, mainColor: null, subColor: null, accentColor: null,
  personOption: 'without', customPrompt: null, freePrompt: null, finalPrompt: '', engine: 'openai', modelName: 'x', requestedCount: 1,
  doneCount: status === 'done' ? 1 : 0, failedCount: 0, unitsPerImage: 1, errorMessage: null, references: null, createdBy: null,
  createdAt: '2026-09-30T10:12:00+09:00', startedAt: null, finishedAt: null,
})
const uploaded = {
  id: 'img-up', projectId: 'p1', generationId: null, sequence: 9, source: 'upload', parentImageId: null, isFavorite: false, createdBy: null,
  createdAt: '2026-10-01T10:00:00+09:00', generation: null, deliveredAccountIds: [],
  media: { id: 'm-up', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 10, width: 100, height: 100, url: 'https://example.invalid/logo.png' },
}
const detail = (generations: unknown[] = []) => ({ success: true, data: { project: project('p1', '秋のキャンペーン'), images: [], generations } })

beforeEach(() => {
  vi.clearAllMocks()
  flushListUrlState()
  mocks.query = ''
  localStorage.removeItem('lh_hq_banner_ai_account')
  mocks.listAccounts.mockResolvedValue({ success: true, data: [{ id: 'a1', name: '本店', isActive: true }] })
  mocks.aiSettings.mockResolvedValue({ success: true, data: { items: [{ feature: 'banner', enabled: true }] } })
  window.history.replaceState(null, '', '/hq/banners')
  document.documentElement.dataset.theme = 'v8'
  mocks.presets.mockResolvedValue({ success: true, data: { presets: [PRESET], maxCount: 4, engineReady: true, usage: { month: { used: 1, limit: 150, remaining: 149 }, today: { used: 1, limit: 30, remaining: 29 }, paused: false, pausedReason: null } } })
  mocks.stats.mockResolvedValue({ success: true, data: { projects: { active: 1, archived: 0 }, deliveredImages: 0, deliveredAccounts: 0 } })
  mocks.listProjects.mockResolvedValue({ success: true, data: [project('p1', '秋のキャンペーン')] })
  mocks.listImages.mockResolvedValue({ success: true, data: [], nextBefore: null, counts: { all: 0, favorite: 0, delivered: 0, unused: 0 } })
  mocks.getProject.mockResolvedValue(detail())
  mocks.upload.mockResolvedValue({ success: true, data: uploaded })
  mocks.cancel.mockResolvedValue({ success: true, data: null })
})
afterEach(() => { cleanup(); flushListUrlState(); delete document.documentElement.dataset.theme })

describe('バナー生成の一覧', () => {
  it('プロジェクトは ?id= の住所で開く', async () => {
    render(<HqBannersListV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '秋のキャンペーン を開く' }))
    expect(mocks.push).toHaveBeenCalledWith('/hq/banners/project?id=p1')
  })

  it('タブは ?tab= を書き換え、履歴を積まない', async () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    render(<HqBannersListV8 />)
    await screen.findByRole('button', { name: '秋のキャンペーン を開く' })
    fireEvent.click(screen.getByRole('tab', { name: '画像ライブラリ' }))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/hq/banners?tab=library')
    fireEvent.click(screen.getByRole('tab', { name: 'プロジェクト一覧' }))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/hq/banners')
    expect(pushState).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    pushState.mockRestore()
  })

  it.each(['', 'tab=library'])('権限が無い（403）ときは共通の「権限がない」面を出す（%s）', async (query) => {
    mocks.query = query
    const forbidden = new ApiError(403, 'API error: 403')
    mocks.listProjects.mockRejectedValue(forbidden)
    mocks.listImages.mockRejectedValue(forbidden)
    const view = render(<HqBannersListV8 />)
    await waitFor(() => expect(view.container.querySelector('[data-list-state="forbidden"]')).not.toBeNull())
    expect(view.container.querySelector('[data-list-state="error"]')).toBeNull()
  })

  it('プロジェクトが0件なら、最初のプロジェクトを作る口から作る窓を開く', async () => {
    mocks.listProjects.mockResolvedValue({ success: true, data: [] })
    render(<HqBannersListV8 />)
    await screen.findByText('まだプロジェクトがありません')
    fireEvent.click(screen.getByRole('button', { name: '最初のプロジェクトを作る' }))
    expect(await screen.findByRole('button', { name: '作って開く' })).toBeTruthy()
  })
})

describe('バナー生成のプロジェクトの中', () => {
  beforeEach(() => { mocks.query = 'id=p1' })

  it('権限が無い（403）ときは共通の「権限がない」面と一覧へ戻る口を出す', async () => {
    mocks.getProject.mockRejectedValue(new ApiError(403, 'API error: 403'))
    const view = render(<HqBannerProjectV8 />)
    await waitFor(() => expect(view.container.querySelector('[data-list-state="forbidden"]')).not.toBeNull())
    expect(screen.getByRole('link', { name: 'プロジェクト一覧へ戻る' }).getAttribute('href')).toBe('/hq/banners')
  })

  it('ふだんは板 iMnph、生成中は板 p03ImY の外枠で出し、画像の並びに「画像を押すと詳細」と添える', async () => {
    const view = render(<HqBannerProjectV8 />)
    await screen.findByText('画像を押すと詳細')
    expect(view.container.querySelector('[data-design-node="iMnph"]')).not.toBeNull()
    cleanup()
    mocks.getProject.mockResolvedValue(detail([generation('g-run', 'running')]))
    mocks.getGeneration.mockImplementation(() => new Promise(() => {}))
    const running = render(<HqBannerProjectV8 />)
    await screen.findByRole('button', { name: '生成をやめる' })
    expect(running.container.querySelector('[data-design-node="p03ImY"]')).not.toBeNull()
  })

  it('生成するは条件を登録して状態を読み直し、終わったら読み直しを止める', { timeout: 10000 }, async () => {
    mocks.createGeneration.mockResolvedValue({ success: true, data: generation('g-new', 'queued') })
    mocks.getGeneration.mockResolvedValue({ success: true, data: generation('g-new', 'done') })
    render(<HqBannerProjectV8 />)
    const start = await screen.findByRole('button', { name: /^生成する（\d+ 枚）$/ })
    expect(start.closest('[data-shared-part="sticky-bar"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: '条件をクリア' }).closest('[data-shared-part="sticky-bar"]')).not.toBeNull()
    await screen.findByText('本店')
    expect(screen.queryByRole('button', { name: 'AI を使うアカウント' })).toBeNull()
    fireEvent.change(document.querySelector('input[placeholder]:not([type="file"])')!, { target: { value: '秋の新商品' } })
    await act(async () => { fireEvent.click(start) })
    await waitFor(() => expect(mocks.getGeneration).toHaveBeenCalledWith('g-new'))
    expect(mocks.createGeneration).toHaveBeenCalledWith('p1', expect.objectContaining({ presetKey: 'line_rich_message' }), { accountId: 'a1' })
    // 読み直しの間隔（1.5秒）より長く待っても、終わった生成をもう一度読まない。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1800)) })
    expect(mocks.getGeneration).toHaveBeenCalledTimes(1)
  })

  it('複数の候補から前回選んだ利用可能なアカウントを復元する', async () => {
    mocks.listAccounts.mockResolvedValue({ success: true, data: [{ id: 'a1', name: '本店', isActive: true }, { id: 'a2', name: '支店', isActive: true }, { id: 'a3', name: '停止店', isActive: true }] })
    mocks.aiSettings.mockImplementation(async (id: string) => ({ success: true, data: { items: [{ feature: 'banner', enabled: id !== 'a3' }] } }))
    localStorage.setItem('lh_hq_banner_ai_account', 'a2')
    mocks.createGeneration.mockResolvedValue({ success: true, data: generation('g-new', 'queued') })
    mocks.getGeneration.mockResolvedValue({ success: true, data: generation('g-new', 'done') })
    render(<HqBannerProjectV8 />)
    // 選ぶ部品（EntitySelect）は選んだ名前を押す所の外側の行に出す。
    expect((await screen.findByRole('button', { name: 'AI を使うアカウント' })).parentElement?.textContent).toContain('支店')
    fireEvent.change(document.querySelector('input[placeholder]:not([type="file"])')!, { target: { value: '秋の新商品' } })
    fireEvent.click(screen.getByRole('button', { name: /^生成する（\d+ 枚）$/ }))
    await waitFor(() => expect(mocks.createGeneration).toHaveBeenCalledWith('p1', expect.anything(), { accountId: 'a2' }))
  })

  it('利用できるアカウントがないと生成できず理由を表示する', async () => {
    mocks.aiSettings.mockResolvedValue({ success: true, data: { items: [{ feature: 'banner', enabled: false }] } })
    render(<HqBannerProjectV8 />)
    expect((await screen.findAllByText(/AI を使えるアカウントがありません/)).length).toBeGreaterThan(0)
    const start = screen.getByRole('button', { name: /^生成する（\d+ 枚）$/ }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(start)
    expect(mocks.createGeneration).not.toHaveBeenCalled()
  })

  it('設定を確認できないときは0件と区別して生成を止める', async () => {
    mocks.aiSettings.mockRejectedValue(new Error('offline'))
    render(<HqBannerProjectV8 />)
    expect((await screen.findAllByText(/AI を使うアカウントを確認できませんでした/)).length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: /^生成する（\d+ 枚）$/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('走っている生成は「生成をやめる」で止める口へ送る', async () => {
    mocks.getProject.mockResolvedValue(detail([generation('g-run', 'running')]))
    mocks.getGeneration.mockImplementation(() => new Promise(() => {}))
    render(<HqBannerProjectV8 />)
    const stop = await screen.findByRole('button', { name: '生成をやめる' })
    // 止める操作は下の帯だけに置く（生成パネルの中に置かない）。
    expect(stop.closest('[data-shared-part="sticky-bar"]')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: '生成をやめる' })).toHaveLength(1)
    await act(async () => { fireEvent.click(stop) })
    expect(mocks.cancel).toHaveBeenCalledWith('g-run')
  })

  it('手元のファイルを参照画像にするときは、プロジェクトへ取り込んでから参照に足す', async () => {
    render(<HqBannerProjectV8 />)
    await screen.findByRole('button', { name: /^生成する（\d+ 枚）$/ })
    const file = new File(['png'], 'logo.png', { type: 'image/png' })
    await act(async () => { fireEvent.change(document.querySelector('[data-design-node="L1ax1Y"] input[type="file"]')!, { target: { files: [file] } }) })
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1))
    expect(mocks.upload).toHaveBeenCalledWith('p1', expect.objectContaining({ filename: 'logo.png', mimeType: 'image/png' }))
    expect(await screen.findByRole('button', { name: /を外す$/ })).toBeTruthy()
  })
})
