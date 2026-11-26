import { beforeEach as seedIdentity } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * ★V8 GB-8補足: 投稿の画像を端末（PC/スマホ）から直接アップロードできる。
 *
 * 押さえる契約:
 *  1. 「端末からアップロード」ボタンと隠しファイル入力がある
 *  2. 選んだファイルは登録メディアAPI（prepareUploads→PUT→completeUpload）で登録され、
 *     その場で投稿の画像として選ばれる（＝登録メディアにも残る）
 *  3. 失敗時はエラー文を出し、フォームは壊さない
 */

const fixture = vi.hoisted(() => ({
  prepared: [] as Array<Record<string, unknown>>,
  completeFails: false,
  detailItem: { id: 'media-new', filename: 'photo.png', url: 'https://cdn.example.test/media-new.png' } as Record<string, unknown>,
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
      list: () => Promise.resolve({ success: true, data: { items: [], total: 0, limit: 60, offset: 0 } }),
      detail: () => Promise.resolve({ success: true, data: { item: fixture.detailItem, folderName: null } }),
      prepareUploads: (input: { files: Array<Record<string, unknown>> }) => {
        fixture.prepared.push(...input.files)
        return Promise.resolve({
          success: true,
          data: {
            sessions: [{
              id: 'upload-1',
              filename: 'photo.png',
              sizeBytes: 10,
              targetMediaId: null,
              method: 'PUT',
              uploadUrl: 'https://r2.example.test/upload',
              requiredHeaders: {},
              expiresAt: '2099-01-01T00:00:00.000Z',
            }],
          },
        })
      },
      completeUpload: () => fixture.completeFails
        ? Promise.resolve({ success: false, error: '登録できませんでした' })
        : Promise.resolve({ success: true, data: { uploadSessionId: 'upload-1', status: 'verified', mediaId: 'media-new' } }),
    },
    /* この試験は画像の添付だけを見る。Instagram は未設定にして同時投稿の区画を出さない。 */
    instagram: {
      connection: () => Promise.resolve({ success: true, data: { state: 'unconfigured', connection: null } }),
    },
  },
}))

vi.mock('@/app/contents/media-direct-upload', () => ({
  extractMediaMetadata: () => Promise.resolve({ width: 200, height: 100 }),
  mediaAcceptForKind: () => 'image/png,image/jpeg,image/gif,image/webp',
  putMediaFile: () => Promise.resolve('etag-1'),
  validateMediaFile: () => '',
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/restaurant-test/google',
}))

vi.mock('@/v8/restaurant/google/post-image-crop', () => ({
  PostImageCrop: ({ source, onConfirm }: { source: { name: string }; onConfirm: (file: File) => Promise<void> }) => (
    <button type="button" onClick={() => void onConfirm(new File(['cropped'], source.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })).catch(() => {})}>この位置で確定</button>
  ),
}))

const { PostEditor } = await import('@/v8/restaurant/google/posts')
const { extractMediaMetadata, mediaAcceptForKind, putMediaFile, validateMediaFile } = await import('@/app/contents/media-direct-upload')

let container: HTMLDivElement
let root: Root

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function render() {
  await act(async () => {
    root.render(<PostEditor accountId="account-2" kind="standard" postId={null} go={() => undefined} mediaUpload={{ accept: mediaAcceptForKind('image'), extractMetadata: extractMediaMetadata, validate: validateMediaFile, put: putMediaFile }} />)
    await settle()
  })
}

async function pickFile() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('ファイル入力がありません')
  const file = new File(['x'], 'photo.png', { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  })
}

async function confirmCrop() {
  await act(async () => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'この位置で確定')
    button?.click()
    await settle()
  })
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  fixture.prepared = []
  fixture.completeFails = false
  fixture.detailItem = { id: 'media-new', filename: 'photo.png', url: 'https://cdn.example.test/media-new.png' }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('投稿画像の端末アップロード', () => {
  it('画像を選択するボタンと隠しファイル入力がある', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('画像を選択する')
    expect(text).toContain('登録メディアから選択する')
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input?.accept).toContain('image/png')
  })

  it('選んだファイルを登録メディアへ登録し、投稿の画像として選ぶ', async () => {
    await render()
    await pickFile()

    expect(fixture.prepared).toHaveLength(0)
    await confirmCrop()

    expect(fixture.prepared).toHaveLength(2)
    expect(fixture.prepared[0]).toMatchObject({ filename: 'photo.png', mimeType: 'image/png' })
    expect(fixture.prepared[1]).toMatchObject({ filename: 'photo.jpg', mimeType: 'image/jpeg' })
    expect(container.textContent).toContain('切り取り位置を確認済み')
  })

  it('登録に失敗したらエラー文を出し、画像は選ばれたままにしない', async () => {
    fixture.completeFails = true
    await render()
    await pickFile()
    await confirmCrop()

    expect(container.textContent).toContain('画像を保存できませんでした')
    expect(container.textContent).not.toContain('切り取り位置を確認済み')
  })
})

seedIdentity(() => { verifiedStaffRole('owner') })
