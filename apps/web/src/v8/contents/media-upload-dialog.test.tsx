// @vitest-environment happy-dom
/*
 * ★V8 メディアを入れる窓（src/v8/contents/media-upload-dialog.tsx）の動き。
 * 署名付きの保存先へ直接送り、1件ずつ進みを出し、失敗した1件だけを登録待ちへ戻して送り直せることを、
 * 窓を描いてファイルを選び、API と送信の呼び出しで確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const calls = vi.hoisted(() => ({
  prepare: [] as Array<{ accountId: string; files: Array<{ filename: string }> }>,
  put: [] as string[],
  complete: [] as Array<[string, { accountId: string; etag: string }]>,
  /** 送信の返事を握る口。ファイル名ごと。 */
  putAnswer: new Map<string, (progress: (value: number) => void) => Promise<string>>(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      media: {
        ...actual.api.media,
        prepareUploads: async (input: { accountId: string; files: Array<{ filename: string }> }) => {
          calls.prepare.push(input)
          return { success: true, data: { sessions: input.files.map((file) => ({ id: `session-${file.filename}`, filename: file.filename, uploadUrl: 'https://r2.example.test/put', method: 'PUT', requiredHeaders: {}, expiresAt: '2099-01-01T00:00:00.000Z' })) } }
        },
        completeUpload: async (sessionId: string, input: { accountId: string; etag: string }) => {
          calls.complete.push([sessionId, input])
          return { success: true, data: { uploadSessionId: sessionId, status: 'completed', mediaId: null } }
        },
      },
    },
  }
})
vi.mock('./media-direct-upload', async (importOriginal: () => Promise<typeof import('./media-direct-upload')>) => ({
  ...(await importOriginal()),
  extractMediaMetadata: async () => ({}),
  putMediaFile: (session: { id: string; filename: string }, _file: File, onProgress: (value: number) => void) => {
    calls.put.push(session.id)
    const answer = calls.putAnswer.get(session.filename)
    return answer ? answer(onProgress) : Promise.resolve(`etag-${session.filename}`)
  },
}))

import MediaUploadDialog from './media-upload-dialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let onComplete = vi.fn()
let onClose = vi.fn()

beforeEach(() => {
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn((file: File) => `blob:preview-${file.name}`)
    static revokeObjectURL = vi.fn()
  })
  calls.prepare.length = 0
  calls.put.length = 0
  calls.complete.length = 0
  calls.putAnswer.clear()
  onComplete = vi.fn()
  onClose = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const render = async () => {
  await act(async () => root.render(
    <MediaUploadDialog open accountId="account-a" folders={[]} initialFolderId="" onClose={onClose} onComplete={onComplete} />,
  ))
  await settle()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const pick = async (...files: File[]) => {
  const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}
const press = async (text: string) => {
  const target = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
  if (!target) throw new Error(`ボタンがありません: ${text}`)
  await act(async () => { target.click() })
  await settle()
}
const png = (name: string) => new File(['x'], name, { type: 'image/png' })

describe('メディアを入れる窓', () => {
  it('LINEで送れる大きさと、保存先へ直接送ることを先に書く', async () => {
    await render()
    const text = dialog().textContent ?? ''
    expect(text).toContain('音声 MP3・M4A：200MBまで')
    expect(text).toContain('動画 MP4：200MBまで')
    expect(text).toContain('大きなファイルも管理画面を経由せず、保存先へ直接送ります。')
  })

  it('送信直前に1件ずつ予約し、保存先へ直接送ってから確認を頼む', async () => {
    await render()
    await pick(png('a.png'), png('b.png'))
    await press('2件を登録する')
    expect(calls.prepare).toHaveLength(2)
    expect(calls.prepare[0].accountId).toBe('account-a')
    expect(calls.prepare.map((call) => call.files.map((file) => file.filename))).toEqual([['a.png'], ['b.png']])
    expect(calls.put).toEqual(['session-a.png', 'session-b.png'])
    expect(calls.complete).toEqual([
      ['session-a.png', { accountId: 'account-a', etag: 'etag-a.png' }],
      ['session-b.png', { accountId: 'account-a', etag: 'etag-b.png' }],
    ])
    expect(dialog().textContent).toContain('2 件を登録しました')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('選んだ写真を送信前に実画像で確認でき、添付一覧を選択欄の直下に表示する', async () => {
    await render()
    await pick(png('photo.png'))
    const image = dialog().querySelector<HTMLImageElement>('img[alt="photo.pngの登録前プレビュー"]')
    expect(image?.src).toBe('blob:preview-photo.png')
    expect(dialog().textContent).toContain('選択したファイル（1 / 10件）')
    expect(calls.prepare).toHaveLength(0)
    await press('写真を大きく見る')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    expect(document.body.querySelector<HTMLImageElement>('img[alt="photo.png"]')?.src).toBe('blob:preview-photo.png')
  })

  it('1回に10件まで表示し、11件目以降は選択に含めない', async () => {
    await render()
    await pick(...Array.from({ length: 11 }, (_, index) => png(`${index}.png`)))
    expect(dialog().textContent).toContain('先頭の10件を表示しています')
    expect(dialog().textContent).toContain('選択したファイル（10 / 10件）')
    expect(dialog().textContent).not.toContain('10.png')
  })

  it('前の大きなファイルを送っている間は次の署名URLを発行しない', async () => {
    let release: () => void = () => {}
    calls.putAnswer.set('a.png', () => new Promise((resolve) => { release = () => resolve('etag-a') }))
    await render()
    await pick(png('a.png'), png('b.png'))
    await press('2件を登録する')
    expect(calls.prepare.map((call) => call.files[0].filename)).toEqual(['a.png'])
    await act(async () => { release() })
    await settle()
    expect(calls.prepare.map((call) => call.files[0].filename)).toEqual(['a.png', 'b.png'])
  })

  it('送っている間は1件ごとの進みを読み上げ欄に出す', async () => {
    let release: () => void = () => {}
    calls.putAnswer.set('a.png', (progress) => {
      progress(40)
      return new Promise((resolve) => { release = () => resolve('etag-a') })
    })
    await render()
    await pick(png('a.png'))
    await press('1件を登録する')
    const row = dialog().querySelector('li[aria-live="polite"]')
    expect(row?.textContent).toContain('送信中 40%')
    expect(dialog().querySelector('[role=progressbar][aria-label=登録しています]')?.getAttribute('aria-valuenow')).toBe('40')
    expect(dialog().textContent).not.toContain('ほかの欄を入れて進めます')
    await act(async () => { release() })
    await settle()
    expect(dialog().textContent).toContain('1 件を登録しました')
  })

  it('送れなかった1件だけを「もう一度試す」で登録待ちへ戻し、その1件だけを送り直す', async () => {
    calls.putAnswer.set('b.png', () => Promise.reject(new Error('network')))
    await render()
    await pick(png('a.png'), png('b.png'))
    await press('2件を登録する')
    expect(dialog().textContent).toContain('1 件を登録し、1 件は入りませんでした')
    expect(calls.complete.map(([session]) => session)).toEqual(['session-a.png'])
    expect(onComplete).toHaveBeenCalledTimes(1)

    calls.putAnswer.delete('b.png')
    await act(async () => { dialog().querySelector<HTMLButtonElement>('button[aria-label="「b.png」をもう一度試す"]')!.click() })
    await settle()
    await press('1件を登録する')
    expect(calls.prepare.at(-1)?.files.map((file) => file.filename)).toEqual(['b.png'])
    expect(calls.complete.map(([session]) => session)).toEqual(['session-a.png', 'session-b.png'])
  })

  it('登録前のファイルを選んで移動すると確認し、続けると選択を残す', async () => {
    await render()
    await pick(png('draft.png'))
    const link = document.createElement('a')
    link.href = '/templates'
    document.body.appendChild(link)
    await act(async () => { link.click() })
    await settle()
    const confirmation = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => element.textContent?.includes('保存していない変更があります'))
    expect(confirmation).toBeTruthy()
    const keep = [...confirmation!.querySelectorAll('button')].find(button => button.textContent?.includes('編集を続ける'))!
    await act(async () => { keep.click() })
    expect(dialog().textContent).toContain('draft.png')
    expect(calls.prepare).toHaveLength(0)
    link.remove()
  })


  it('選択中のファイルがあれば戻るを止める', async () => {
    await render()
    await pick(png('draft.png'))
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledWith(1)
    expect(document.body.textContent).toContain('保存していない変更があります')
    go.mockRestore()
  })

  it('閉じる時も未登録ファイルの破棄を確認する', async () => {
    await render()
    await pick(png('draft.png'))
    await act(async () => { dialog().querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!.click() })
    await settle()
    const confirmation = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => element.textContent?.includes('入力を破棄しますか？'))
    expect(confirmation).toBeTruthy()
    expect(document.body.textContent).not.toContain('保存していない変更があります')
    const discard = [...confirmation!.querySelectorAll('button')].find(button => button.textContent?.trim() === '破棄する')!
    await act(async () => { discard.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(calls.prepare).toHaveLength(0)
  })

  it('全ファイルの登録後は離脱確認しない', async () => {
    await render()
    await pick(png('done.png'))
    await press('1件を登録する')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })


  it('登録中は戻るを止め、応答後に離脱確認を解除する', async () => {
    let release: () => void = () => {}
    calls.putAnswer.set('draft.png', () => new Promise(resolve => { release = () => resolve('etag') }))
    await render()
    await pick(png('draft.png'))
    await press('1件を登録する')
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledWith(1)
    expect(document.body.textContent).not.toContain('保存していない変更があります')
    await act(async () => { release() })
    await settle()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    go.mockRestore()
  })

})


it('すべて登録後は件数を完了と示し、完了ボタンで閉じる', async () => {
  await render()
  await pick(png('done.png'))
  await press('1件を登録する')
  expect(dialog().textContent).not.toContain('1件を選択中')
  expect(dialog().textContent).not.toContain('0件を登録する')
  await press('完了')
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onComplete).toHaveBeenCalledTimes(1)
})
