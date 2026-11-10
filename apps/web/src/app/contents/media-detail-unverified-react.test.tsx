// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import type { MediaItem } from '@line-crm/shared'

/*
 * R34: 未確認（verified false）は「どこでも使っていない」と分けて出す。
 * 0件の未確認は未使用にせず、確かめた時刻と読み直しを出す。
 */

const fixture = vi.hoisted(() => ({
  impact: null as Record<string, unknown> | null,
}))

class ApiError extends Error {
  constructor(readonly status?: number, message = 'API error') {
    super(message)
  }
}

const BASE_IMPACT = {
  media: { id: 'media-a', filename: 'a.png', kind: 'image' },
  usageCount: 0,
  references: [],
  versions: [],
  liveUrl: 'https://example.test/a.png',
  checkedAt: '2026-09-27T10:00:00+09:00',
  lastScannedAt: null,
  canDelete: false,
  recommendedAction: 'review_references',
}

vi.mock('@/lib/api', () => ({
  ApiError,
  fetchApi: () => Promise.resolve({ success: true, data: {} }),
  api: {
    media: {
      deleteImpact: () => Promise.resolve({
        success: true,
        data: fixture.impact ?? { ...BASE_IMPACT, verified: true, canDelete: true, recommendedAction: 'delete' },
      }),
      contentUrl: () => '/api/media/media-a/content?accountId=account-a',
      download: () => Promise.resolve(new Blob()),
    },
  },
}))

vi.mock('@/v8/contents/media-direct-upload', () => ({
  extractMediaMetadata: () => Promise.resolve({}),
  fileMatchesMediaKind: () => true,
  mediaAcceptForKind: () => 'image/png',
  putMediaFile: () => Promise.resolve('etag-1'),
  validateMediaFile: () => null,
}))

const { default: MediaDetailDialog } = await import('@/v8/contents/media-detail-dialog')

const ITEM: MediaItem = {
  id: 'media-a',
  lineAccountId: 'account-a',
  folderId: null,
  kind: 'image',
  filename: 'a.png',
  mimeType: 'image/png',
  sizeBytes: 1200,
  width: 100,
  height: 50,
  durationMs: null,
  url: 'https://example.test/a.png',
  uploadedBy: 'staff-1',
  createdAt: '2026-09-27T10:00:00+09:00',
  usageCount: 0,
}

let host: HTMLDivElement
let root: Root

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function renderDialog(item: MediaItem = ITEM) {
  await act(async () => {
    root.render(
      <MediaDetailDialog
        item={item}
        accountId="account-a"
        folderName=""
        canManage
        onClose={() => undefined}
        onOpenReplacement={() => undefined}
        onVersionCreated={() => undefined}
      />,
    )
    await settle()
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.impact = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

describe('使用箇所の未確認（R34、実React）', () => {
  it('0件の未確認は「どこでも使っていない」にしない', async () => {
    fixture.impact = { ...BASE_IMPACT, verified: false }
    await renderDialog()

    expect(host.textContent).toContain('使われている場所を確かめられませんでした。')
    expect(host.textContent).not.toContain('どこでも使われていません')
    // 件数は「—」で出し、0か所と断定しない。
    expect(host.textContent).not.toContain('0か所')
    // 確かめた時刻と読み直しは出す。
    expect(host.textContent).toContain('時点')
    expect(host.textContent).toContain('もう一度読み込む')
  })

  it('確かめた未使用は従来どおり「どこでも使っていない」', async () => {
    fixture.impact = { ...BASE_IMPACT, verified: true, canDelete: true, recommendedAction: 'delete' }
    await renderDialog()

    expect(host.textContent).toContain('どこでも使われていません')
    expect(host.textContent).not.toContain('確かめられませんでした')
  })
})

describe('入れた人の表示（R35、実React）', () => {
  it('内部IDではなく担当者の表示名を出す', async () => {
    fixture.impact = { ...BASE_IMPACT, verified: true, canDelete: true, recommendedAction: 'delete' }
    await renderDialog({ ...ITEM, uploadedBy: 'c0ffee-uuid', uploadedByName: '見本 141' })

    expect(host.textContent).toContain('見本 141')
    expect(host.textContent).not.toContain('c0ffee-uuid')
  })

  it('退職・削除済みで引けないときは人に分かる言葉にし、IDは出さない', async () => {
    fixture.impact = { ...BASE_IMPACT, verified: true, canDelete: true, recommendedAction: 'delete' }
    await renderDialog({ ...ITEM, uploadedBy: 'gone-uuid', uploadedByName: null })

    expect(host.textContent).toContain('削除された担当者')
    expect(host.textContent).not.toContain('gone-uuid')
  })

  it('記録が無いときは未取得と出す', async () => {
    fixture.impact = { ...BASE_IMPACT, verified: true, canDelete: true, recommendedAction: 'delete' }
    await renderDialog({ ...ITEM, uploadedBy: null, uploadedByName: null })

    expect(host.textContent).toContain('—（未取得）')
  })
})
