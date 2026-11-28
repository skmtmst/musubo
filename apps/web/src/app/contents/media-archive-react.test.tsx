// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

import type { MediaItem } from '@line-crm/shared'

/**
 * 登録メディアの退避・復帰（N-201）。
 * 既定の一覧から外れ、「アーカイブ済み」棚でだけ見えること、
 * 理由必須・管理者限定・戻せることを画面で固定する。
 */
const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  role: 'owner' as 'owner' | 'admin' | 'staff',
  listCalls: [] as Array<{ accountId: string; params?: { archived?: string } }>,
  archiveCalls: [] as Array<{ id: string; accountId: string; reason: string }>,
  restoreCalls: [] as Array<{ id: string; accountId: string; reason: string }>,
  archiveResult: { success: true } as { success: boolean; error?: string; data?: unknown },
  archiveThrows: null as null | { status: number },
  archived: false,
  folders: [] as Array<{ id: string; name: string; color: string | null; displayOrder: number }>,
}))

const MEDIA: MediaItem = {
  id: 'media-1',
  lineAccountId: 'account-a',
  folderId: null,
  kind: 'image',
  filename: '店舗の画像.png',
  mimeType: 'image/png',
  sizeBytes: 1200,
  width: 100,
  height: 100,
  durationMs: null,
  url: 'https://example.test/a.png',
  uploadedBy: '管理者',
  createdAt: '2026-09-16T09:00:00+09:00',
  usageCount: 2,
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
        me: () => Promise.resolve({ success: true, data: { role: fixture.role } }),
      },
      folders: {
        list: () => Promise.resolve({ success: true, data: fixture.folders, unfiledCount: 0 }),
      },
      media: {
        counts: () => Promise.resolve({ success: true, data: { total: fixture.archived ? 0 : 1, byKind: { image: fixture.archived ? 0 : 1, video: 0, audio: 0, file: 0 }, unused: fixture.archived ? 0 : 1, archived: fixture.archived ? 1 : 0 } }),
        list: (accountId: string, params?: { archived?: string }) => {
          fixture.listCalls.push({ accountId, params })
          const items = params?.archived === 'only'
            ? (fixture.archived ? [{ ...MEDIA, archivedAt: '2026-09-07T01:00:00.000Z', archivedBy: 'u-1', archiveReason: '整理' }] : [])
            : (fixture.archived ? [] : [MEDIA])
          return Promise.resolve({
            success: true,
            data: { items, total: items.length, limit: 20, offset: 0 },
          })
        },
        quota: () => Promise.resolve({
          success: true,
          data: { usageBytes: 1200, reservedBytes: 0, limitBytes: 10000, remainingBytes: 8800, usageRate: 0.12, state: 'normal' },
        }),
        detail: () => Promise.reject(new ApiError(404, 'Not found')),
        archive: (id: string, accountId: string, reason: string) => {
          fixture.archiveCalls.push({ id, accountId, reason })
          return fixture.archiveThrows
            ? Promise.reject(new ApiError(fixture.archiveThrows.status, 'conflict'))
            : Promise.resolve(fixture.archiveResult)
        },
        restore: (id: string, accountId: string, reason: string) => {
          fixture.restoreCalls.push({ id, accountId, reason })
          return fixture.archiveThrows
            ? Promise.reject(new ApiError(fixture.archiveThrows.status, 'conflict'))
            : Promise.resolve(fixture.archiveResult)
        },
        contentUrl: (id: string, accountId: string) => `/api/media/${id}/content?accountId=${accountId}`,
      },
    },
  }
})

function setNativeValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

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

async function waitForText(text: string) {
  for (let index = 0; index < 20 && !host.textContent?.includes(text); index += 1) {
    await act(async () => { await settle() })
  }
  expect(host.textContent).toContain(text)
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label)
  if (!button) throw new Error(`ボタンがありません: ${label}`)
  return button
}

/*
 * V8: 編集・取得・アーカイブは札の「…」の中。開く操作と選ぶ操作は
 * 別の act に分ける（同じ act ではメニューの装着が間に合わない）。
 */
async function openCardMenu() {
  await act(async () => { buttonByLabel(`${MEDIA.filename}のその他操作`).click(); await settle() })
}

async function clickChip(label: string) {
  await act(async () => { buttonByLabel('よく使う絞り込み').click(); await settle() })
  const chip = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === `${label}だけ`)
  if (!chip) throw new Error(`絞り込みがありません: ${label}`)
  await act(async () => { chip.click(); await settle() })
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.accountId = 'account-a'
  fixture.role = 'owner'
  fixture.listCalls.length = 0
  fixture.archiveCalls.length = 0
  fixture.restoreCalls.length = 0
  fixture.archiveResult = { success: true, data: MEDIA }
  fixture.archiveThrows = null
  fixture.archived = false
  fixture.folders = []
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

describe('登録メディアの退避と復帰（N-201）', () => {
  it('既定の一覧は退避済みを外し、「アーカイブ済み」棚だけ archived=only で読む', async () => {
    await renderPage()
    await waitForText(MEDIA.filename)
    // : 数の tile が limit=1 の数え読みを2口足す（未使用・アーカイブ）。
    // 一覧本体の読み分けの約束は tile を除いて見る。
    const listReads = fixture.listCalls.filter((call) => call.params?.limit !== 1)
    expect(listReads.length).toBeGreaterThan(0)
    expect(listReads.every((call) => call.params?.archived === undefined)).toBe(true)

    await clickChip('アーカイブ済み')
    expect(fixture.listCalls.at(-1)?.params?.archived).toBe('only')
  })

  it('退避には理由が必須で、確定すると理由付きでAPIを呼ぶ', async () => {
    await renderPage()
    await waitForText(MEDIA.filename)

    await openCardMenu()
    await act(async () => { buttonByLabel('アーカイブ').click(); await settle() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('理由（あとから履歴で確認できます）')
    expect(dialog.textContent).toContain('必須')

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === 'アーカイブする')!
    expect(confirm).not.toBeNull()
    expect(confirm.disabled).toBe(true)

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="理由"]')
    expect(input).not.toBeNull()
    await act(async () => {
      setNativeValue(input!, '古いキャンペーン素材の整理')
      await settle()
    })
    expect(confirm.disabled).toBe(false)

    await act(async () => { confirm.click(); await settle() })
    expect(fixture.archiveCalls).toEqual([
      { id: 'media-1', accountId: 'account-a', reason: '古いキャンペーン素材の整理' },
    ])
  })

  it('退避済みの札は編集・削除・まとめ選択を出さず、「一覧へ戻す」だけを残す', async () => {
    fixture.archived = true
    await renderPage()
    await clickChip('アーカイブ済み')
    await waitForText(MEDIA.filename)

    expect(host.textContent).toContain('退避済み')
    expect(document.querySelector(`button[aria-label="${MEDIA.filename}の名前を変更する"]`)).toBeNull()
    expect(document.querySelector(`button[aria-label="${MEDIA.filename}を削除"]`)).toBeNull()
    const checkbox = document.querySelector<HTMLInputElement>(`input[aria-label="${MEDIA.filename}を選ぶ"]`)
    expect(checkbox?.disabled).toBe(true)

    await openCardMenu()
    await act(async () => { buttonByLabel('一覧へ戻す').click(); await settle() })
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="理由"]')!
    await act(async () => {
      setNativeValue(input, '再び使うため')
      await settle()
    })
    // 確認窓の確定ボタンは札の「一覧へ戻す」と同名なので、ダイアログ内だけを見る。
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const restoreConfirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '一覧へ戻す')!
    await act(async () => { restoreConfirm.click(); await settle() })
    expect(fixture.restoreCalls).toEqual([
      { id: 'media-1', accountId: 'account-a', reason: '再び使うため' },
    ])
  })

  it('staffには退避・復帰の押し口を出さない', async () => {
    fixture.role = 'staff'
    await renderPage()
    await waitForText(MEDIA.filename)
    expect(document.querySelector(`button[aria-label="${MEDIA.filename}をアーカイブ"]`)).toBeNull()
    expect(document.querySelector(`button[aria-label="${MEDIA.filename}を削除"]`)).toBeNull()
  })

  it('409（直前に退避済み）は失敗文を出しつつ一覧を読み直す', async () => {
    // fetchApi は非2xxで ApiError を投げる。{success:false} の返りでは来ない。
    fixture.archiveThrows = { status: 409 }
    await renderPage()
    await waitForText(MEDIA.filename)
    const callsBefore = fixture.listCalls.length

    await openCardMenu()
    await act(async () => { buttonByLabel('アーカイブ').click(); await settle() })
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="理由"]')!
    await act(async () => {
      setNativeValue(input, '整理')
      await settle()
    })
    await act(async () => { [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'アーカイブする')!.click(); await settle() })

    expect(document.body.textContent).toContain('既にアーカイブ済みです')
    expect(fixture.listCalls.length).toBeGreaterThan(callsBefore)
  })
})

async function tryLeave() {
  const link = document.createElement('a'); link.href = '/events'; link.textContent = 'イベントへ'; document.body.append(link)
  await act(async () => { link.click(); await settle() })
  expect(document.body.textContent).toContain('保存していない変更があります')
  link.remove()
}
it('メディア名を編集中は移動前に確認する', async () => {
  await renderPage(); await waitForText(MEDIA.filename); await openCardMenu()
  await act(async () => { buttonByLabel('名前を変更する').click(); await settle() })
  const input = document.querySelector<HTMLInputElement>('input[aria-label="ファイル名"]')!
  await act(async () => { setNativeValue(input, '編集中.png'); await settle() })
  await tryLeave()
})
it('アーカイブ理由を入力中は移動前に確認する', async () => {
  await renderPage(); await waitForText(MEDIA.filename); await openCardMenu()
  await act(async () => { buttonByLabel('アーカイブ').click(); await settle() })
  const input = document.querySelector<HTMLInputElement>('input[aria-label="理由"]')!
  await act(async () => { setNativeValue(input, '整理'); await settle() })
  await tryLeave()
})
it('移し先を選んだ後は移動前に確認する', async () => {
  fixture.folders = [{ id: 'folder-1', name: '広告', color: null, displayOrder: 0 }]
  await renderPage(); await waitForText(MEDIA.filename); await openCardMenu()
  await act(async () => { buttonByLabel('フォルダへ移す').click(); await settle() })
  await act(async () => { buttonByLabel('移し先のフォルダ').click(); await settle() })
  const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('広告'))!
  await act(async () => { (option.querySelector('button') as HTMLButtonElement).click(); await settle() })
  await tryLeave()
})
