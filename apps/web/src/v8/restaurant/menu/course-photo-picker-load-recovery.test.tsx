// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  foldersList: vi.fn(),
  mediaList: vi.fn(),
  fileScanForMedia: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: (...args: unknown[]) => net.foldersList(...args) },
      media: {
        ...actual.api.media,
        list: (...args: unknown[]) => net.mediaList(...args),
        contentUrl: (id: string) => `/mock-media/${id}`,
      },
      fileScan: { ...actual.api.fileScan, forMedia: (...args: unknown[]) => net.fileScanForMedia(...args) },
    },
  }
})

import CoursePhotoPicker from './course-photo-picker'

const SAMPLE_MEDIA = {
  id: 'img-1',
  lineAccountId: 'acc-1',
  kind: 'image' as const,
  filename: 'course-main.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 12000,
  width: 800,
  height: 800,
  durationMs: null,
  folderId: null,
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  net.foldersList.mockResolvedValue({ success: true, data: [{ id: 'f-1', name: 'ディナー写真', color: '#0a84ff' }] })
  net.mediaList.mockResolvedValue({ success: true, data: { items: [SAMPLE_MEDIA], total: 1 } })
  net.fileScanForMedia.mockResolvedValue({ success: true, data: { scan: { status: 'clean' } } })
})

afterEach(() => {
  cleanup()
})

describe('コースの写真を選ぶ：フォルダ・写真一覧の失敗表示と再読み込み', () => {
  it('フォルダ一覧の取得に失敗しても写真の選択を続けられ、エラー通知と再読み込みで回復し連打で重複送信しない', async () => {
    let resolveFolders: ((value: { success: true; data: Array<{ id: string; name: string; color: string }> }) => void) | null = null
    net.foldersList
      .mockRejectedValueOnce(new Error('フォルダ取得失敗'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFolders = resolve }))

    render(<CoursePhotoPicker accountId="acc-1" existing={[]} onClose={vi.fn()} onAdd={vi.fn()} />)

    const dialog = await screen.findByRole('dialog', { name: 'コースの写真を選ぶ' })
    expect(await within(dialog).findByText('フォルダ一覧を読み込めませんでした。写真の選択は続けられます。')).toBeTruthy()
    expect(await within(dialog).findByRole('checkbox', { name: 'course-main.jpg' })).toBeTruthy()

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(net.foldersList).toHaveBeenCalledTimes(2)

    resolveFolders!({ success: true, data: [{ id: 'f-1', name: 'ディナー写真', color: '#0a84ff' }] })
    await waitFor(() => {
      expect(within(dialog).queryByText('フォルダ一覧を読み込めませんでした。写真の選択は続けられます。')).toBeNull()
    })
  })

  it('写真一覧の取得失敗時に理由を表示し、再読み込みボタンの連打で重複送信せず回復できる', async () => {
    let resolveMedia: ((value: { success: true; data: { items: typeof SAMPLE_MEDIA[]; total: number } }) => void) | null = null
    net.mediaList
      .mockRejectedValueOnce(new Error('写真取得失敗'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMedia = resolve }))

    render(<CoursePhotoPicker accountId="acc-1" existing={[]} onClose={vi.fn()} onAdd={vi.fn()} />)

    const dialog = await screen.findByRole('dialog', { name: 'コースの写真を選ぶ' })
    expect(await within(dialog).findByText('写真を読み込めませんでした')).toBeTruthy()
    expect(within(dialog).getByText('写真取得失敗')).toBeTruthy()

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    await waitFor(() => expect(net.mediaList).toHaveBeenCalledTimes(2))

    resolveMedia!({ success: true, data: { items: [SAMPLE_MEDIA], total: 1 } })
    expect(await within(dialog).findByRole('checkbox', { name: 'course-main.jpg' })).toBeTruthy()
  })
})
