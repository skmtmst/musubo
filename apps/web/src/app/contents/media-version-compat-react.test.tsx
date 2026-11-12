// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import type { MediaItem } from '@line-crm/shared'
import type { MediaVersionBlocker } from '@/lib/api'

const fixture = vi.hoisted(() => ({
  preparedFiles: [] as Array<Record<string, unknown>>,
  previewBlockers: ['incompatible_dimensions'] as MediaVersionBlocker[],
  canReplace: false,
  createdVersions: [] as Array<Record<string, unknown>>,
  usageCount: 0,
  versionMessages: [] as string[],
}))

class ApiError extends Error {
  constructor(readonly status?: number, message = 'API error') {
    super(message)
  }
}

vi.mock('@/lib/api', () => ({
  ApiError,
  api: {
    media: {
      deleteImpact: () => Promise.resolve({
        success: true,
        data: {
          media: { id: 'media-a', filename: 'A.png', kind: 'image' },
          usageCount: fixture.usageCount,
          references: [],
          versions: [{ versionNo: 1 }],
          checkedAt: '2026-09-16T09:00:00+09:00',
          lastScannedAt: null,
        },
      }),
      contentUrl: () => '/api/media/media-a/content?accountId=account-a',
      download: () => Promise.resolve(new Blob()),
      prepareUploads: (input: { files: Array<Record<string, unknown>> }) => {
        fixture.preparedFiles.push(...input.files)
        return Promise.resolve({
          success: true,
          data: {
            sessions: [{
              id: 'upload-1',
              filename: 'b.png',
              sizeBytes: 10,
              targetMediaId: 'media-a',
              method: 'PUT',
              uploadUrl: 'https://r2.example.test/upload',
              requiredHeaders: {},
              expiresAt: '2099-01-01T00:00:00.000Z',
            }],
          },
        })
      },
      completeUpload: () => Promise.resolve({
        success: true,
        data: { uploadSessionId: 'upload-1', status: 'verified', targetMediaId: 'media-a' },
      }),
      previewVersion: () => Promise.resolve({
        success: true,
        data: {
          mediaId: 'media-a',
          uploadSessionId: 'upload-1',
          currentVersionNo: 1,
          previewToken: 'token-1',
          blockers: fixture.previewBlockers,
          canReplace: fixture.canReplace,
        },
      }),
      createVersion: (_id: string, input: Record<string, unknown>) => {
        fixture.createdVersions.push(input)
        return Promise.resolve({ success: true, data: { mediaId: 'media-a', versionNo: 2 } })
      },
    },
  },
}))

vi.mock('@/v8/contents/media-direct-upload', () => ({
  extractMediaMetadata: () => Promise.resolve({ width: 200, height: 100 }),
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
  filename: 'A.png',
  mimeType: 'image/png',
  sizeBytes: 1200,
  width: 100,
  height: 50,
  durationMs: null,
  url: 'https://example.test/a.png',
  uploadedBy: '管理者',
  createdAt: '2026-09-16T09:00:00+09:00',
  usageCount: 0,
}

let host: HTMLDivElement
let root: Root
let mounted = false

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function renderDialog() {
  await act(async () => {
    root.render(
      <MediaDetailDialog
        item={ITEM}
        accountId="account-a"
        folderName=""
        canManage
        onClose={() => undefined}
        onVersionCreated={(message) => { fixture.versionMessages.push(message) }}
      />,
    )
    await settle()
  })
}

function portal(): HTMLElement {
  const el = document.body.lastElementChild
  if (!(el instanceof HTMLElement)) throw new Error('ダイアログが開いていません')
  return el
}

async function pickFile() {
  const input = portal().querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('ファイル入力がありません')
  const file = new File(['x'], 'b.png', { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  })
}

async function clickButton(text: string) {
  const button = [...portal().querySelectorAll('button')]
    .find((b) => b.textContent?.includes(text))
  if (!button) throw new Error(`${text} ボタンがありません`)
  await act(async () => {
    button.click()
    await settle()
  })
}

beforeEach(() => {
  fixture.preparedFiles.length = 0
  fixture.createdVersions.length = 0
  fixture.previewBlockers = ['incompatible_dimensions']
  fixture.canReplace = false
  fixture.usageCount = 0
  fixture.versionMessages.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mounted = true
})

afterEach(async () => {
  if (mounted) await act(async () => { root.unmount() })
  host.remove()
  document.querySelectorAll('body > div').forEach((el) => {
    if (el !== host) el.remove()
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('使用中のメディアの詳細（voJtX）', () => {
  it('使っている数を添えて、版を足しても固定版は変わらない・使っているあいだは消せないと言う', async () => {
    fixture.usageCount = 2
    await renderDialog()
    const detail = document.querySelector('[data-design-node="voJtX"]')
    expect(detail).not.toBeNull()
    const text = detail?.textContent ?? ''
    expect(text).toContain('この画像を差し替える')
    expect(text).toContain('名前と管理用URLを保ったまま新しい版を追加します。')
    expect(text).toContain('現在このメディアを使っている2か所の固定版は変わりません')
    expect(text).toContain('使われているあいだは削除できません。先にこの2か所から外してください。')
    expect(text).not.toContain('使用先を差し替える')
  })

  it('使っていなければ「使用先を差し替える」と消せない理由を出さない', async () => {
    await renderDialog()
    const text = document.querySelector('[data-design-node="voJtX"]')?.textContent ?? ''
    expect(text).not.toContain('使われているあいだは削除できません')
    expect(text).not.toContain('使用先を差し替える')
  })
})

describe('メディア版追加の内容互換性（N-199）', () => {
  it('予約へ実ファイルから読んだ内容情報を載せる', async () => {
    await renderDialog()
    await pickFile()
    await clickButton('差し替え内容を確認')

    expect(fixture.preparedFiles).toHaveLength(1)
    expect(fixture.preparedFiles[0]).toMatchObject({
      filename: 'b.png',
      mimeType: 'image/png',
      targetMediaId: 'media-a',
      metadata: { width: 200, height: 100 },
    })
  })

  it('寸法が違うときは理由を示して追加ボタンを出さない', async () => {
    fixture.previewBlockers = ['incompatible_dimensions']
    await renderDialog()
    await pickFile()
    await clickButton('差し替え内容を確認')

    expect(portal().textContent).toContain('寸法が違うため')
    expect(portal().textContent).not.toContain('新しい版を追加する')
    expect(fixture.createdVersions).toHaveLength(0)
  })

  it('判定材料が足りないときは互換性未確認として拒否理由を示す', async () => {
    fixture.previewBlockers = ['metadata_missing']
    await renderDialog()
    await pickFile()
    await clickButton('差し替え内容を確認')

    expect(portal().textContent).toContain('内容情報（寸法・長さ・ページ数）が足りない')
    expect(fixture.createdVersions).toHaveLength(0)
  })

  it('互換なら変更理由を入れて新版を追加できる', async () => {
    fixture.previewBlockers = []
    fixture.canReplace = true
    await renderDialog()
    await pickFile()
    await clickButton('差し替え内容を確認')
    expect(portal().textContent).toContain('第2版へ追加できます')

    const reason = portal().querySelector<HTMLInputElement>('input[maxlength="500"]')
    if (!reason) throw new Error('変更理由の入力がありません')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(reason, '秋の写真へ更新')
      reason.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    })
    await clickButton('新しい版を追加する')
    expect(fixture.createdVersions).toEqual([expect.objectContaining({
      uploadSessionId: 'upload-1',
      previewToken: 'token-1',
      changeReason: '秋の写真へ更新',
    })])
  })
})

it('版を追加した後、期限と同意の未保存入力を残して編集を続けられる', async () => {
  fixture.previewBlockers = []
  fixture.canReplace = true
  await renderDialog()
  await clickButton('記録する')
  const consent = portal().querySelector<HTMLInputElement>('input[id$="-consent"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(consent, '同意を確認'); consent.dispatchEvent(new Event('input', { bubbles: true })); await settle() })
  await pickFile()
  await clickButton('差し替え内容を確認')
  const reason = document.querySelector<HTMLInputElement>('input[id$="-reason"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, '写真を更新'); reason.dispatchEvent(new Event('input', { bubbles: true })); await settle() })
  await clickButton('新しい版を追加する')
  expect(fixture.createdVersions).toHaveLength(1)
  expect(fixture.versionMessages).toHaveLength(0)
  expect(document.body.textContent).toContain('保存していない変更があります')
  const keep = [...document.querySelectorAll('button')].find(button => button.textContent === '編集を続ける')!
  await act(async () => { keep.click(); await settle() })
  expect(consent.value).toBe('同意を確認')
  expect(document.body.textContent).toContain('第2版を追加しました')
  expect(fixture.versionMessages).toHaveLength(0)
})
