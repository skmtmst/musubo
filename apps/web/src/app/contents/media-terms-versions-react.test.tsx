// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import type { MediaItem } from '@line-crm/shared'

/*
 * IDEA-15 登録メディア。既知の利用期限・同意情報の表示と記録、
 * 版ごとの取り出し（元ファイルの復旧）を画面から確かめる。
 */

const fixture = vi.hoisted(() => ({
  updates: [] as Array<{ id: string; accountId: string; data: Record<string, unknown> }>,
  downloadedVersions: [] as Array<{ id: string; versionNo: number; accountId: string }>,
  itemUpdated: [] as MediaItem[],
}))

class ApiError extends Error {
  constructor(readonly status?: number, message = 'API error') {
    super(message)
  }
}

vi.mock('@/lib/api', () => ({
  ApiError,
  fetchApi: () => Promise.resolve({ success: true, data: {} }),
  api: {
    media: {
      deleteImpact: () => Promise.resolve({
        success: true,
        data: {
          media: { id: 'media-a', filename: 'a.png', kind: 'image' },
          usageCount: 0,
          references: [],
          versions: [
            {
              versionNo: 1,
              mimeType: 'image/png',
              sizeBytes: 1000,
              changeReason: null,
              createdAt: '2026-09-01T09:00:00+09:00',
              publishedAt: '2026-09-01T09:00:00+09:00',
              isCurrent: false,
            },
            {
              versionNo: 2,
              mimeType: 'image/png',
              sizeBytes: 1200,
              changeReason: '秋の写真へ更新',
              createdAt: '2026-09-16T09:00:00+09:00',
              publishedAt: '2026-09-16T09:00:00+09:00',
              isCurrent: true,
            },
          ],
          liveUrl: 'https://example.test/a.png',
          checkedAt: '2026-09-16T09:00:00+09:00',
          lastScannedAt: '2026-09-16T08:00:00+09:00',
          canDelete: true,
          recommendedAction: 'delete',
        },
      }),
      contentUrl: () => '/api/media/media-a/content?accountId=account-a',
      download: () => Promise.resolve(new Blob()),
      downloadVersion: (id: string, versionNo: number, accountId: string) => {
        fixture.downloadedVersions.push({ id, versionNo, accountId })
        return Promise.resolve(new Blob(['x']))
      },
      update: (id: string, accountId: string, data: Record<string, unknown>) => {
        fixture.updates.push({ id, accountId, data })
        const updated: MediaItem = {
          ...ITEM,
          revision: 4,
          usageExpiresAt: (data.usageExpiresAt as string | null) ?? null,
          usageConsentNote: (data.usageConsentNote as string | null) ?? null,
        }
        fixture.itemUpdated.push(updated)
        return Promise.resolve({ success: true, data: updated })
      },
      prepareUploads: () => Promise.resolve({ success: true, data: { sessions: [] } }),
      completeUpload: () => Promise.resolve({ success: true, data: { status: 'verified' } }),
      previewVersion: () => Promise.resolve({ success: true, data: { blockers: [], canReplace: true } }),
      createVersion: () => Promise.resolve({ success: true, data: { versionNo: 3 } }),
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
  revision: 3,
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

async function renderDialog(item: MediaItem = ITEM, canManage = true) {
  await act(async () => {
    root.render(
      <MediaDetailDialog
        item={item}
        accountId="account-a"
        folderName=""
        canManage={canManage}
        onClose={() => undefined}
        onVersionCreated={() => undefined}
        onItemUpdated={(next) => fixture.itemUpdated.push(next)}
      />,
    )
    await settle()
  })
}

function dialog(): HTMLElement {
  // 日付の選択箱は最上層（MenuPortal→document.body）に出る。器の中にはいない。
  return document.body
}

async function clickButton(text: string, index = 0) {
  const buttons = [...dialog().querySelectorAll('button')]
    .filter((b) => b.textContent?.includes(text))
  const button = buttons[index]
  if (!button) throw new Error(`${text} ボタン（${index}番目）がありません`)
  await act(async () => {
    button.click()
    await settle()
  })
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  })
}

/** 利用期限の日付の選択（★管理画面）で YYYY-MM-DD を選ぶ。値は今までどおりの文字列。 */
async function pickExpiresDate(iso: string) {
  const [y, mo, d] = iso.split('-').map(Number)
  const week = '日月火水木金土'[new Date(y, mo - 1, d).getDay()]
  await act(async () => {
    dialog().querySelector<HTMLElement>('[id$="-expires"]')!.click()
    await settle()
  })
  for (let i = 0; i < 36; i += 1) {
    const grid = dialog().querySelector('[role="grid"]')
    const label = grid?.getAttribute('aria-label')
    if (label === `${y}年${mo}月`) break
    const target = y * 12 + mo
    const currentLabel = /^(\d+)年(\d+)月$/.exec(label ?? '')
    const current = currentLabel ? Number(currentLabel[1]) * 12 + Number(currentLabel[2]) : target
    const nav = [...dialog().querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === (target > current ? '次の月' : '前の月'),
    )!
    await act(async () => {
      nav.click()
      await settle()
    })
  }
  await act(async () => {
    [...dialog().querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith(`${y}年${mo}月${d}日（${week}）`),
    )!.click()
    await settle()
  })
  await act(async () => { Array.from(document.querySelector('[role="dialog"][aria-label="日付を選ぶ"]')!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!.click(); await settle() })
}

/** 利用期限の日付の選択を空にする。 */
async function clearExpiresDate() {
  await act(async () => {
    dialog().querySelector<HTMLElement>('[id$="-expires"]')!.click()
    await settle()
  })
  const picker = dialog().querySelector('[role="dialog"][aria-label="日付を選ぶ"]')!
  await act(async () => {
    [...picker.querySelectorAll('button')].find((b) => b.textContent?.trim() === '消す')!.click()
    await settle()
  })
  await act(async () => { Array.from(document.querySelector('[role="dialog"][aria-label="日付を選ぶ"]')!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!.click(); await settle() })
}

beforeEach(() => {
  fixture.updates.length = 0
  fixture.downloadedVersions.length = 0
  fixture.itemUpdated.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // happy-dom には ObjectURL がない。保存の実体ではなく呼び出しだけ見る。
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
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

describe('IDEA-15 利用期限・同意の表示と記録', () => {
  it('記録がなければ期限も同意も「不明」と出し、推測で埋めない', async () => {
    await renderDialog()
    expect(dialog().textContent).toContain('利用の期限・同意')
    const unknowns = dialog().textContent?.match(/不明（記録なし）/g) ?? []
    expect(unknowns.length).toBe(2)
  })

  it('記録済みの期限と同意メモはそのまま出す', async () => {
    await renderDialog({
      ...ITEM,
      usageExpiresAt: '2027-03-31',
      usageConsentNote: '出演者の同意書を確認済み',
    })
    expect(dialog().textContent).toContain('2027/3/31')
    expect(dialog().textContent).toContain('出演者の同意書を確認済み')
    expect(dialog().textContent).not.toContain('不明（記録なし）')
  })

  it('過去の期限は「期限を過ぎています」と明示する', async () => {
    await renderDialog({ ...ITEM, usageExpiresAt: '2020-01-01' })
    expect(dialog().textContent).toContain('期限を過ぎています')
  })

  it('記録する→日付とメモを入れて保存するとPATCHへ渡し、一覧へ反映を返す', async () => {
    await renderDialog()
    await clickButton('記録する')

    const noteInput = dialog().querySelector<HTMLInputElement>('input[maxlength="500"]')
    if (!noteInput) throw new Error('記録フォームがありません')
    await pickExpiresDate('2027-03-31')
    await setInputValue(noteInput, '同意書確認済み')
    await clickButton('保存する')

    expect(fixture.updates).toEqual([{
      id: 'media-a',
      accountId: 'account-a',
      data: { expectedRevision: 3, usageExpiresAt: '2027-03-31', usageConsentNote: '同意書確認済み' },
    }])
    expect(fixture.itemUpdated.length).toBe(2) // updateの返り値とonItemUpdatedの両方
    expect(fixture.itemUpdated[1]?.usageExpiresAt).toBe('2027-03-31')
  })

  it('空欄で保存すると記録を消して「不明」へ戻す', async () => {
    await renderDialog({ ...ITEM, usageExpiresAt: '2027-03-31', usageConsentNote: '確認済み' })
    await clickButton('記録する')
    const noteInput = dialog().querySelector<HTMLInputElement>('input[maxlength="500"]')
    if (!noteInput) throw new Error('記録フォームがありません')
    await clearExpiresDate()
    await setInputValue(noteInput, '   ')
    await clickButton('保存する')

    expect(fixture.updates[0]?.data).toEqual({ expectedRevision: 3, usageExpiresAt: null, usageConsentNote: null })
  })

  it('staffには記録の入口を出さない', async () => {
    await renderDialog(ITEM, false)
    const buttons = [...dialog().querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons.some((t) => t?.includes('記録する'))).toBe(false)
  })
})

describe('IDEA-15 版と元ファイルの取り出し', () => {
  it('版一覧に第1版を元ファイルとして示す', async () => {
    await renderDialog()
    expect(dialog().textContent).toContain('版と元ファイル')
    expect(dialog().textContent).toContain('第1版（元ファイル）')
    expect(dialog().textContent).toContain('第2版（最新）')
    expect(dialog().textContent).toContain('変更理由：秋の写真へ更新')
  })

  it('第1版の取り出しは版番号1の口へ行き、a-v1.png で保存する', async () => {
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    await renderDialog()
    await clickButton('この版をダウンロード', 0)

    expect(fixture.downloadedVersions).toEqual([{ id: 'media-a', versionNo: 1, accountId: 'account-a' }])
    expect(downloads).toEqual(['a-v1.png'])
  })

  it('第2版の取り出しは版番号2の口へ行く', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await renderDialog()
    await clickButton('この版をダウンロード', 1)

    expect(fixture.downloadedVersions).toEqual([{ id: 'media-a', versionNo: 2, accountId: 'account-a' }])
  })
})
it('利用期限の編集を保存せず一覧へ戻る前に確認する', async () => {
  window.history.replaceState(null, '', '/contents')
  await renderDialog()
  await clickButton('記録する')
  const input = dialog().querySelector<HTMLInputElement>('input[id$="-consent"]')!
  await setInputValue(input, '確認した内容')
  const back = [...dialog().querySelectorAll('a')].find(a => a.textContent?.trim() === '登録メディア')!
  await act(async () => { back.click(); await settle() })
  expect(document.body.textContent).toContain('保存していない変更があります')
})
it('新しい版のファイルを選んだ後は一覧へ戻る前に確認する', async () => {
  window.history.replaceState(null, '', '/contents')
  await renderDialog()
  const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['test'], 'sample.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  })
  const back = [...dialog().querySelectorAll('a')].find(a => a.textContent?.trim() === '登録メディア')!
  await act(async () => { back.click(); await settle() })
  expect(document.body.textContent).toContain('保存していない変更があります')
})
it('期限と同意の入力だけを破棄しても選んだファイルは残る', async () => {
  await renderDialog()
  const fileInput = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['test'], 'sample.png', { type: 'image/png' })] })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  })
  await clickButton('記録する')
  await setInputValue(dialog().querySelector<HTMLInputElement>('input[id$="-consent"]')!, '確認した内容')
  await clickButton('キャンセル')
  expect(document.body.textContent).toContain('利用期限と同意の入力が消えます')
  await clickButton('破棄する')
  expect(document.body.textContent).toContain('選んだファイル：sample.png')
  expect(document.body.textContent).not.toContain('確認した内容')
})
