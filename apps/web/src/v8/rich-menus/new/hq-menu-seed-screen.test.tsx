// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:9'
})

vi.mock('@/lib/hq-rich-menu-draft-store', () => ({
  readHqRichMenuDraft: async () => undefined,
  writeHqRichMenuDraft: async () => undefined,
  clearHqRichMenuDraft: async () => undefined,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '店舗A' }, loading: false }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/rich-menus/new',
}))

import RichMenuCreateV8 from './create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import { getPageAction } from '@/test-utils/page-action'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let hostEl: HTMLDivElement
let root: Root

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const parsed = new URL(String(url), 'http://localhost')
    if (parsed.pathname === '/api/staff/me') {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
  hostEl = document.createElement('div')
  document.body.appendChild(hostEl)
  root = createRoot(hostEl)
})

afterEach(() => {
  act(() => root.unmount())
  hostEl.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('統括リッチメニュー作成画面の既定ページ未存在ガード', () => {
  it('既定の面が pages に無いと保存されず案内が出続け、選び直すと選んだ面で保存できる', async () => {
    const onSave = vi.fn()
    const initial: HqRichMenuSeed = {
      id: 'hq-tpl-1',
      name: '本部メニュー',
      chatBarText: 'メニュー',
      folderId: '   ',
      size: 'large',
      displayAudience: 'all',
      displayTagName: '',
      defaultOpen: true,
      displayOrder: 1,
      defaultPageId: 'deleted-page',
      pages: [
        { id: 'page-a', name: 'トップ', imageR2Key: 'img-a', areas: [] },
        { id: 'page-b', name: '会員メニュー', imageR2Key: 'img-b', areas: [] },
      ],
    }
    const hqHost: RichMenuCreateHost = {
      backHref: '/hq/templates',
      onCancel: vi.fn(),
      canOperate: true,
      folders: [],
      references: { tags: [], templates: [], forms: [] },
      initial,
      uploadImage: vi.fn(async () => ({ r2Key: 'img-up' })),
      imageUrl: (key) => `https://cdn.example/${key}`,
      distribute: null,
      selectedCount: 1,
      selectedIds: ['acc-1'],
      friendTotal: 10,
      busy: false,
      onSave,
    }

    await act(async () => {
      root.render(<RichMenuCreateV8 host={hqHost} initialStep="publish" />)
    })
    await settle()

    // 既定の面が pages に無い状態では保存ボタンを押しても onSave（API）は呼ばれない
    expect(screen.getByText('最初に出す面を選び直してください')).toBeTruthy()
    await act(async () => {
      fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    })
    await settle()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('最初に出す面を選び直してください')).toBeTruthy()

    // 2枚目の面を明示的に選び直すと案内が消え、選んだ面で保存できる
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '会員メニューを最初に出す面にする' }))
    })
    await settle()
    expect(screen.queryByText('最初に出す面を選び直してください')).toBeNull()

    await act(async () => {
      fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    })
    await settle()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({
      defaultPageId: 'page-b',
      folderId: null,
      size: 'large',
    })
  })
})
