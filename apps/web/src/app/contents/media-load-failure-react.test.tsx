// @vitest-environment happy-dom
/*
 * R587・R588：登録メディアの取得失敗を分けて案内する。
 *
 * R587：フォルダだけ503でも、取得済みのメディア一覧と容量は見せる。
 * フォルダ欄だけ失敗と再試行を示す。メディア自体が失敗したときは
 * 一覧全体の失敗と再試行になる（両者を混同しない）。
 * R588：詳細GETの503は通信失敗＋同じIDの再試行、404は対象なし、
 * 403は権限案内として区別する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

import type { MediaItem } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  mediaBehavior: 'ok' as 'ok' | 'fail503' | 'failFalse' | 'empty' | 'twoItems',
  countsFailed: false,
  countsShape: 'ok' as 'ok' | 'array',
  quotaGate: null as Promise<void> | null,
  listCalls: [] as Array<{ kind?: string; unusedOnly?: boolean; archived?: string; limit?: number }>,
  foldersBehavior: 'ok' as 'ok' | 'fail503',
  detailBehavior: 'ok' as 'ok' | 'fail503' | 'fail404' | 'fail403' | 'failFalse',
  detailCalls: [] as Array<{ id: string; accountId: string }>,
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

// m26m: 絞り込み前後の総数の描画確認用。画像とは別の種別にする。
const MEDIA_B: MediaItem = {
  id: 'media-b',
  lineAccountId: 'account-a',
  folderId: null,
  kind: 'video',
  filename: 'Bの動画.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 2400,
  width: null,
  height: null,
  durationMs: 5000,
  url: 'https://example.test/b.mp4',
  uploadedBy: '管理者',
  createdAt: '2026-09-16T10:00:00+09:00',
  usageCount: 0,
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number | undefined
    constructor(status?: number, message = 'API error') {
      super(message)
      this.status = status
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
        list: () => {
          if (fixture.foldersBehavior === 'fail503') {
            return Promise.reject(new ApiError(503, 'Service Unavailable'))
          }
          return Promise.resolve({
            success: true,
            data: [{ id: 'folder-1', kind: 'media', name: '商品' }],
            unfiledCount: 1,
          })
        },
      },
      media: {
        counts: () => {
          if (fixture.countsFailed) return Promise.reject(new ApiError(503, 'Service Unavailable'))
          if (fixture.countsShape === 'array') return Promise.resolve({ success: true, data: [] })
          if (fixture.mediaBehavior === 'fail503') return Promise.reject(new ApiError(503, 'Service Unavailable'))
          if (fixture.mediaBehavior === 'failFalse') return Promise.resolve({ success: false, error: 'unknown failure' })
          const total = fixture.mediaBehavior === 'empty' ? 0 : fixture.mediaBehavior === 'twoItems' ? 2 : 1
          return Promise.resolve({ success: true, data: { total, byKind: { image: total > 0 ? 1 : 0, video: total === 2 ? 1 : 0, audio: 0, file: 0 }, unused: total, archived: 0 } })
        },
        list: (accountId: string, params?: { kind?: string; unusedOnly?: boolean; archived?: string; limit?: number }) => {
          void accountId
          fixture.listCalls.push(params ?? {})
          if (fixture.mediaBehavior === 'fail503') {
            return Promise.reject(new ApiError(503, 'Service Unavailable'))
          }
          if (fixture.mediaBehavior === 'failFalse') {
            return Promise.resolve({ success: false, error: 'unknown failure' })
          }
          if (fixture.mediaBehavior === 'empty') {
            return Promise.resolve({
              success: true,
              data: { items: [], total: 0, limit: 20, offset: 0 },
            })
          }
          if (fixture.mediaBehavior === 'twoItems') {
            // 種別で絞った呼び出しだけ1件にする。絞り込み前の総数取り
            // （overallTotal 用の limit: 1 の呼び出し）は2件のまま。
            if (params?.kind === 'image') {
              return Promise.resolve({
                success: true,
                data: { items: [MEDIA_A], total: 1, limit: 20, offset: 0 },
              })
            }
            return Promise.resolve({
              success: true,
              data: { items: [MEDIA_A, MEDIA_B], total: 2, limit: 20, offset: 0 },
            })
          }
          return Promise.resolve({
            success: true,
            data: { items: [MEDIA_A], total: 1, limit: 20, offset: 0 },
          })
        },
        quota: async () => { await fixture.quotaGate; return {
          success: true,
          data: {
            usageBytes: 1200,
            reservedBytes: 0,
            limitBytes: 10000,
            remainingBytes: 8800,
            usageRate: 0.12,
            state: 'normal',
          },
        } },
        detail: (id: string, accountId: string) => {
          fixture.detailCalls.push({ id, accountId })
          if (fixture.detailBehavior === 'fail503') {
            return Promise.reject(new ApiError(503, 'Service Unavailable'))
          }
          if (fixture.detailBehavior === 'fail404') {
            return Promise.reject(new ApiError(404, 'Not found'))
          }
          if (fixture.detailBehavior === 'fail403') {
            return Promise.reject(new ApiError(403, 'Forbidden'))
          }
          if (fixture.detailBehavior === 'failFalse') {
            return Promise.resolve({ success: false, error: 'unknown failure' })
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

async function waitForText(text: string) {
  for (let index = 0; index < 30 && !host.textContent?.includes(text); index += 1) {
    await act(async () => { await settle() })
  }
  expect(host.textContent).toContain(text)
}

function folderPanel(): HTMLElement {
  const panel = host.querySelector<HTMLElement>('aside[aria-label="フォルダ"]')
  if (!panel) throw new Error('フォルダパネルがありません')
  return panel
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.mediaBehavior = 'ok'
  fixture.countsFailed = false
  fixture.countsShape = 'ok'
  fixture.quotaGate = null
  fixture.listCalls.length = 0
  fixture.foldersBehavior = 'ok'
  fixture.detailBehavior = 'ok'
  fixture.detailCalls.length = 0
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

describe('R587 フォルダだけの失敗は一覧と容量を隠さない', () => {
  it('フォルダ503でもメディア一覧と容量は見せ、フォルダ欄だけ失敗と再試行を出す', async () => {
    fixture.foldersBehavior = 'fail503'
    await renderPage()
    // 取得済みの一覧と容量は見せる。
    await waitForText(MEDIA_A.filename)
    expect(host.textContent).toContain('使っている容量')
    expect(host.querySelector('[data-list-state="error"]')).toBeNull()
    // フォルダ欄だけ失敗と再試行。
    const panel = folderPanel()
    expect(panel.textContent).toContain('フォルダを読み込めませんでした')
    const retry = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
  })

  it('集計の形が違っても一覧を落とさず、数の帯は「—」にして一覧の口を読み足さない', async () => {
    fixture.countsShape = 'array'
    await renderPage()
    await waitForText(MEDIA_A.filename)
    expect(host.querySelector('[data-list-state="error"]')).toBeNull()
    const total = [...host.querySelectorAll('[data-kpi-label]')]
      .find((element) => element.textContent?.startsWith('登録メディア'))!.closest('[data-kpi-presentation]')!
    expect(total.textContent).toContain('—')
    expect(total.textContent).not.toContain('1件')
    // 一覧の口は最初の1回だけ。集計を作るための種別・未使用・保管済みの読み足しはしない。
    expect(fixture.listCalls).toHaveLength(1)
    expect(fixture.listCalls.every((call) =>
      call.kind == null && call.unusedOnly !== true && call.archived == null)).toBe(true)
  })

  it('集計が失敗しても一覧は出し、数の帯は「—」にする', async () => {
    fixture.countsFailed = true
    await renderPage()
    await waitForText(MEDIA_A.filename)
    expect(host.querySelector('[data-list-state="error"]')).toBeNull()
    const total = [...host.querySelectorAll('[data-kpi-label]')]
      .find((element) => element.textContent?.startsWith('登録メディア'))!.closest('[data-kpi-presentation]')!
    expect(total.textContent).toContain('—')
    expect(fixture.listCalls).toHaveLength(1)
  })

  it('フォルダ欄の再試行で復旧する', async () => {
    fixture.foldersBehavior = 'fail503'
    await renderPage()
    await waitForText('フォルダを読み込めませんでした')

    fixture.foldersBehavior = 'ok'
    const retry = [...folderPanel().querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')!
    await act(async () => { retry.click(); await settle() })
    await waitForText('商品')
    expect(folderPanel().textContent).not.toContain('フォルダを読み込めませんでした')
    // 一覧はそのまま残る。
    expect(host.textContent).toContain(MEDIA_A.filename)
  })

  it('一覧の失敗でも容量は未取得と偽らない（容量の取得は残る）', async () => {
    fixture.mediaBehavior = 'fail503'
    await renderPage()
    await waitForText('読み込めませんでした')
    // 容量の取得自体は生きているので「—（未取得）」にしない。
    expect(host.textContent).toContain('使っている容量')
    const capacity = [...host.querySelectorAll('[data-kpi-presentation]')].find(el => el.textContent?.startsWith('使っている容量'))!
    expect(capacity).toBeTruthy()
    expect(capacity.textContent).toContain('12%')
    expect(capacity.textContent).not.toContain('未取得')
  })

  it('一覧が失敗を返しても全体の失敗と再試行になる', async () => {
    fixture.mediaBehavior = 'failFalse'
    await renderPage()
    await waitForText('読み込めませんでした')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
    expect(host.textContent).toContain('商品')
  })

  it('メディア自体の失敗は一覧全体の失敗と再試行になる', async () => {
    fixture.mediaBehavior = 'fail503'
    await renderPage()
    await waitForText('読み込めませんでした')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
    // 取得できたフォルダは見せたままにする。
    expect(host.textContent).toContain('商品')

    fixture.mediaBehavior = 'ok'
    await act(async () => { retry!.click(); await settle() })
    await waitForText(MEDIA_A.filename)
  })
})

describe('R588 詳細の失敗は理由で案内を分ける', () => {
  it('詳細503は通信失敗として同じIDの再試行を出す', async () => {
    window.history.replaceState({}, '', '/contents?id=media-a')
    fixture.detailBehavior = 'fail503'
    await renderPage()
    await waitForText('読み込めませんでした')
    expect(host.textContent).toContain('通信が切れたか、サーバが応えませんでした')
    expect(host.textContent).not.toContain('存在しないか、このLINEアカウントでは表示できません')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()

    // 同じIDで読み直すと開ける。
    fixture.detailBehavior = 'ok'
    await act(async () => { retry!.click(); await settle() })
    await waitForText('ファイルのこと')
    expect(new URLSearchParams(window.location.search).get('id')).toBe('media-a')
  })

  it('詳細が原因不明の失敗を返しても存在しないと断定せず再試行を出す', async () => {
    window.history.replaceState({}, '', '/contents?id=media-a')
    fixture.detailBehavior = 'failFalse'
    await renderPage()
    await waitForText('読み込めませんでした')
    expect(host.textContent).toContain('通信が切れたか、サーバが応えませんでした')
    expect(host.textContent).not.toContain('存在しないか、このLINEアカウントでは表示できません')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
  })

  it('詳細404は対象なしの案内で再読み込みを出す', async () => {
    window.history.replaceState({}, '', '/contents?id=unknown-id')
    fixture.detailBehavior = 'fail404'
    await renderPage()
    await waitForText('メディアの詳細を開けません')
    expect(host.textContent).toContain('存在しないか、このLINEアカウントでは表示できません')
    expect(host.textContent).not.toContain('通信が切れたか')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeUndefined()
  })

  it('詳細403は権限案内で再読み込みを出す', async () => {
    window.history.replaceState({}, '', '/contents?id=media-a')
    fixture.detailBehavior = 'fail403'
    await renderPage()
    await waitForText('権限がありません')
    expect(host.textContent).toContain('オーナーか管理者に頼んでください')
    expect(host.textContent).not.toContain('存在しないか、このLINEアカウントでは表示できません')
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
  })
})

describe('m26m 初回503の偽ゼロを出さない', () => {
  function folderRowButton(label: string): HTMLButtonElement {
    const found = [...folderPanel().querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === label || button.textContent?.startsWith(label))
    if (!found) throw new Error(`フォルダ行「${label}」がありません`)
    return found
  }

  it('初回一覧503では「すべて」に件数を出さず、表の下に0件も出さない', async () => {
    fixture.mediaBehavior = 'fail503'
    await renderPage()
    await waitForText('読み込めませんでした')
    // 総数不明なので「すべて0」とは出さない（数は出さない約束）。
    expect(folderRowButton('すべて').textContent).toBe('すべて')
    // 表の下の件数も偽ゼロにしない（「20件表示」の選択欄と混同しないよう完全一致で見る）。
    const zeroRanges = [...host.querySelectorAll('span')].filter((element) => element.textContent === '0件')
    expect(zeroRanges).toHaveLength(0)
    expect(host.textContent).not.toContain('件中')
    // 容量の取得は生きているので残る。
    expect(host.textContent).toContain('使っている容量')
    const capacity = [...host.querySelectorAll('[data-kpi-presentation]')].find(el => el.textContent?.startsWith('使っている容量'))!
    expect(capacity).toBeTruthy()
    expect(capacity.textContent).toContain('12%')
    expect(capacity.textContent).not.toContain('未取得')
  })

  it('一覧503後の読み直しで正しい件数が戻る', async () => {
    fixture.mediaBehavior = 'fail503'
    await renderPage()
    await waitForText('読み込めませんでした')
    expect(folderRowButton('すべて').textContent).toBe('すべて')

    fixture.mediaBehavior = 'ok'
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'もう一度読み込む')!
    await act(async () => { retry.click(); await settle() })
    await waitForText(MEDIA_A.filename)
    // 復旧後は実件数に戻る。
    expect(folderRowButton('すべて').textContent).toBe('すべて1')
    expect(host.textContent).toContain('1件中 1〜1件')
  })

  it('成功時の純粋0件は0と出す（不明と区別する）', async () => {
    fixture.mediaBehavior = 'empty'
    await renderPage()
    await waitForText('まだメディアがありません')
    // 成功確定の0はそのまま出す。
    expect(folderRowButton('すべて').textContent).toBe('すべて0')
    const zeroRanges = [...host.querySelectorAll('span')].filter((element) => element.textContent === '0件')
    expect(zeroRanges.length).toBeGreaterThan(0)
  })

  it('種別で絞っても「すべて」は絞り込み前の総数のまま', async () => {
    fixture.mediaBehavior = 'twoItems'
    await renderPage()
    await waitForText(MEDIA_B.filename)
    // 絞る前は総数2。
    expect(folderRowButton('すべて').textContent).toBe('すべて2')

    const imageChips = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => /^画像(?:\s+\d+)?$/.test(button.textContent ?? ''))
    expect(imageChips).toHaveLength(1)
    await act(async () => { imageChips[0].click(); await settle() })
    await waitForText('1件中 1〜1件')
    // 「すべて」は絞り込み前の総数（overallTotal）のまま。絞り込み後の1件を入れない。
    expect(folderRowButton('すべて').textContent).toBe('すべて2')
    expect(host.textContent).toContain(MEDIA_A.filename)
    expect(host.textContent).not.toContain(MEDIA_B.filename)
  })

  it('一括件数だけ失敗したら、表示できた行の数を総数として代用しない', async () => {
    fixture.mediaBehavior = 'twoItems'
    fixture.countsFailed = true
    let releaseQuota!: () => void
    fixture.quotaGate = new Promise<void>(resolve => { releaseQuota = resolve })
    await renderPage()
    await waitForText(MEDIA_B.filename)
    await act(async () => { releaseQuota(); await settle() })
    expect(folderRowButton('すべて').textContent).toBe('すべて')
    const registered = [...host.querySelectorAll('[data-kpi-presentation]')]
      .find(element => element.textContent?.startsWith('登録メディア'))!
    expect(registered.textContent).toContain('—')
    expect(host.textContent).toContain('12%')
  })
})
