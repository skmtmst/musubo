import { querySupplementaryPageAction } from '@/test-utils/page-action'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewRichMenuPage from '../../../v8/rich-menus/new/create'

;
import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
/*
 * R23: リッチメニュー作成のタグ候補は、いま選んでいるアカウントのものだけ。
 * 本物のReactで動かして見る。
 * - タグ一覧の取得に選択accountが付く（別アカウントの同名タグが混ざらない）
 * - アカウントを切り替えたら、前の候補にしかない選択を外して知らせる
 */

const accountState = { id: 'acc-1' }
// 描画ごとに同じ参照を返す（本物のProviderと同じ）。新しい字面を作ると
// selectedAccount の同一性が変わり、取得処理が無限に回る。
const ACCOUNTS: Record<string, { id: string; name: string }> = {
  'acc-1': { id: 'acc-1', name: '店舗A' },
  'acc-2': { id: 'acc-2', name: '店舗B' },
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: accountState.id,
    selectedAccount: ACCOUNTS[accountState.id],
    loading: false,
  }),
}));

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/v8/contents/media-picker-dialog', () => ({
  default: ({ open, accountId, onSelect }: { open: boolean; accountId: string | null; onSelect: (item: object) => void }) => open
    ? React.createElement('button', { 'data-media-account': accountId, onClick: () => onSelect({ id: 'media-a', filename: '店Aの画像.png', width: 2500, height: 1686, sizeBytes: 1024 }) }, '登録画像を選ぶ（試験）')
    : null,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const fetchUrls: string[] = []
const writes: string[] = []

const TAGS_BY_ACCOUNT: Record<string, Array<{ id: string; name: string }>> = {
  'acc-1': [{ id: 'tag-a1', name: '会員' }],
  'acc-2': [{ id: 'tag-b2', name: '予約' }],
}

function stubFetch() {
  fetchUrls.length = 0
  writes.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') writes.push(String(url))
    const text = String(url)
    fetchUrls.push(text)
    const parsed = new URL(text, 'http://localhost')
    if (parsed.pathname === '/api/rich-menu-groups') return { ok: true, status: 200, json: async () => ({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } }) }
    if (parsed.pathname === '/api/staff/me') return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
    if (parsed.pathname === '/api/rich-menu-groups/scope-draft') return { ok: true, status: 200, json: async () => ({ success: true, data: {"id":"scope-draft","accountId":"acc-1","name":"scope-test","chatBarText":"メニュー","size":"large","isDefaultForAll":true,"status":"draft","targetingPriority":0,"targetingEnabled":false,"targetingCondition":null,"folderId":null,"defaultOpen":true,"version":1,"defaultPageId":"p-1","pages":[{"id":"p-1","orderIndex":0,"name":"トップ","aliasId":"","lineRichmenuId":null,"imageR2Key":null,"imageContentType":null,"areas":[{"id":"area-1","boundsX":0,"boundsY":0,"boundsWidth":2500,"boundsHeight":1686,"actionType":"message","actionData":{"text":"hello"},"intent":"text","label":"ボタン","tagIds":[],"scoreChange":null,"templateId":null,"formId":null,"trackedLinkId":null}]}]} }) }
    if (parsed.pathname === '/api/tags') {
      const accountId = parsed.searchParams.get('lineAccountId')
      return { ok: true, status: 200, json: async () => ({ success: true, data: accountId ? (TAGS_BY_ACCOUNT[accountId] ?? []) : [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

describe('R23 作成画面のタグ候補は選択accountで絞る', () => {
  beforeEach(() => {
    accountState.id = 'acc-1'
    document.documentElement.dataset.theme = 'v8'
    window.history.replaceState({}, '', '/rich-menus/new?id=scope-draft&step=buttons')
    stubFetch()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  it('タグ一覧の取得に選択accountが付く', async () => {
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(100)
    const tagUrls = fetchUrls.filter((url) => new URL(url, 'http://localhost').pathname === '/api/tags')
    expect(tagUrls.length).toBeGreaterThan(0)
    for (const url of tagUrls) {
      expect(url).toContain('lineAccountId=acc-1')
    }
  })

  it('切り替えたら前の候補にしかない選択を外して知らせる', async () => {
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(100)
    // V8 keeps the active area editor open after resuming the draft.

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '行うことを足す' })))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /タグを付ける/ })))
    const dialog = screen.getByRole('dialog', { name: 'タグを選ぶ' })
    await act(async () => fireEvent.click(within(dialog).getByRole('checkbox', { name: '会員' })))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' })))
    await settle(50)
    // acc-2（タグ「予約」だけ）へ切り替える
    accountState.id = 'acc-2'
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(150)
    const tagUrls = fetchUrls.filter((url) => new URL(url, 'http://localhost').pathname === '/api/tags')
    expect(tagUrls.some((url) => url.includes('lineAccountId=acc-2'))).toBe(true)
    expect(host.textContent).toContain('1件は、今のアカウントにないため外しました')
    const save = ([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
    expect(save).toBeTruthy()
    await act(async () => fireEvent.click(save))
    await settle(50)
    expect(writes).toHaveLength(0)
  })

  it('作る前の登録画像は店切替で外し、別店の画像として持ち込まない', async () => {
    window.history.replaceState({}, '', '/rich-menus/new')
    await act(async () => root.render(<NewRichMenuPage />))
    await settle(100)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' })))
    const picker = screen.getByRole('button', { name: '登録画像を選ぶ（試験）' })
    expect(picker.getAttribute('data-media-account')).toBe('acc-1')
    await act(async () => fireEvent.click(picker))
    expect(screen.getByAltText('選択中の画像: 店Aの画像.png')).toBeTruthy()
    expect(host.textContent).toContain('未保存の変更があります')
    accountState.id = 'acc-2'
    await act(async () => root.render(<NewRichMenuPage />))
    await settle(100)
    expect(screen.queryByAltText('選択中の画像: 店Aの画像.png')).toBeNull()
    expect(host.textContent).not.toContain('店Aの画像.png')
    expect(writes).toHaveLength(0)
  })
});
