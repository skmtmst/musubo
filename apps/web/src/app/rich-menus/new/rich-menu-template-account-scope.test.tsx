import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * m18r: リッチメニュー作成のテンプレート候補は、いま選んでいるアカウントのものだけ。
 * 本物のReactで動かして見る。
 * - テンプレート一覧の取得に選択accountが付く（別アカウントのものが混ざらない）
 * - アカウントを切り替えたら、前の候補にしかない選択を外して知らせる
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

import NewRichMenuPage from '../../../v8/rich-menus/new/create'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const fetchUrls: string[] = []
const writes: string[] = []

const TEMPLATES_BY_ACCOUNT: Record<string, Array<{ id: string; name: string }>> = {
  'acc-1': [{ id: 'tpl-a1', name: 'お知らせ' }],
  'acc-2': [{ id: 'tpl-b2', name: '予約確認' }],
}

/** 指定のアカウントのテンプレート一覧を、外から返すまで止めておく。 */
let holdTemplatesFor: string | null = null
let releaseHeld: (() => void) | null = null

function stubFetch() {
  fetchUrls.length = 0
  writes.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') writes.push(String(url))
    const text = String(url)
    fetchUrls.push(text)
    const parsed = new URL(text, 'http://localhost')
    if (parsed.pathname === '/api/templates' && holdTemplatesFor && parsed.searchParams.get('account_id') === holdTemplatesFor) {
      holdTemplatesFor = null
      await new Promise<void>((resolve) => { releaseHeld = resolve })
    }
    if (parsed.pathname === '/api/rich-menu-groups') return { ok: true, status: 200, json: async () => ({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } }) }
    if (parsed.pathname === '/api/staff/me') return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
    if (parsed.pathname === '/api/rich-menu-groups/scope-draft') return { ok: true, status: 200, json: async () => ({ success: true, data: {"id":"scope-draft","accountId":"acc-1","name":"scope-test","chatBarText":"メニュー","size":"large","isDefaultForAll":true,"status":"draft","targetingPriority":0,"targetingEnabled":false,"targetingCondition":null,"folderId":null,"defaultOpen":true,"version":1,"defaultPageId":"p-1","pages":[{"id":"p-1","orderIndex":0,"name":"トップ","aliasId":"","lineRichmenuId":null,"imageR2Key":null,"imageContentType":null,"areas":[{"id":"area-1","boundsX":0,"boundsY":0,"boundsWidth":2500,"boundsHeight":1686,"actionType":"message","actionData":{"text":"hello"},"intent":"text","label":"ボタン","tagIds":[],"scoreChange":null,"templateId":null,"formId":null,"trackedLinkId":null}]}]} }) }
    if (parsed.pathname === '/api/templates') {
      const accountId = parsed.searchParams.get('account_id')
      return { ok: true, status: 200, json: async () => ({ success: true, data: accountId ? (TEMPLATES_BY_ACCOUNT[accountId] ?? []) : [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

function templateUrls() {
  return fetchUrls.filter((url) => new URL(url, 'http://localhost').pathname === '/api/templates')
}

function clickOption(label: string) {
  const option = (Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
    el.textContent?.includes(label),
  ) ?? querySupplementaryPageAction(label))
  if (!option) throw new Error(`選択肢「${label}」が見つかりません`)
  const button = option.querySelector('button') ?? option
  fireEvent.click(button as Element)
}

describe('m18r 作成画面のテンプレート候補は選択accountで絞る', () => {
  beforeEach(() => {
    holdTemplatesFor = null
    releaseHeld = null
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

  it('テンプレート一覧の取得に選択accountが付く', async () => {
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(100)
    expect(templateUrls().length).toBeGreaterThan(0)
    for (const url of templateUrls()) {
      expect(url).toContain('account_id=acc-1')
    }
  })

  it('編集の入口（?id=…&step=…）からでも、テンプレート一覧の取得に選択accountが付く', async () => {
    const { default: RichMenuEditPage } = await import('../edit/page')
    window.history.replaceState({}, '', '/rich-menus/edit?id=scope-draft&step=buttons')
    await act(async () => {
      root.render(<RichMenuEditPage />)
    })
    await settle(100)
    expect(templateUrls().length).toBeGreaterThan(0)
    for (const url of templateUrls()) expect(url).toContain('account_id=acc-1')
  })

  it('切り替える前のアカウントの候補が遅れて届いても、今のアカウントの候補に混ぜない', async () => {
    holdTemplatesFor = 'acc-1'
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(50)
    accountState.id = 'acc-2'
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(100)
    await act(async () => { releaseHeld?.() })
    await settle(100)
    await act(async () => {
      fireEvent.click(host.querySelector('input[type="radio"][aria-label="テンプレートを送る"]')!)
    })
    await settle(50)
    await act(async () => {
      fireEvent.click(host.querySelector('button[aria-label="送るテンプレート：選択する"]')!)
    })
    await settle(50)
    expect(document.querySelector('input[type="radio"][aria-label="予約確認"]')).not.toBeNull()
    expect(document.querySelector('input[type="radio"][aria-label="お知らせ"]')).toBeNull()
  })

  it('切り替えたら前の候補にしかない選択を外して知らせる', async () => {
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(100)
    // V8 keeps the active area editor open after resuming the draft.

    const intentTrigger = host.querySelector('input[type="radio"][aria-label="テンプレートを送る"]')
    expect(intentTrigger).toBeTruthy()
    await act(async () => {
      fireEvent.click(intentTrigger!)
    })
    await settle(50)
    // acc-1 のテンプレート「お知らせ」を選ぶ（選ぶ窓を開き、行を選んで［選ぶ］）
    const templateTrigger = host.querySelector('button[aria-label="送るテンプレート：選択する"]')
    expect(templateTrigger).toBeTruthy()
    await act(async () => {
      fireEvent.click(templateTrigger!)
    })
    await settle(50)
    const radio = document.querySelector('input[type="radio"][aria-label="お知らせ"]')
    expect(radio).toBeTruthy()
    await act(async () => {
      fireEvent.click(radio!)
    })
    const confirm = (Array.from(radio!.closest('[role="dialog"]')!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '選択する') ?? querySupplementaryPageAction('選択する'))
    expect(confirm).toBeTruthy()
    await act(async () => {
      fireEvent.click(confirm!)
    })
    await settle(50)
    // acc-2（テンプレート「予約確認」だけ）へ切り替える
    accountState.id = 'acc-2'
    await act(async () => {
      root.render(<NewRichMenuPage />)
    })
    await settle(150)
    expect(templateUrls().some((url) => url.includes('account_id=acc-2'))).toBe(true)
    expect(host.textContent).toContain('1件は、今のアカウントにないため外しました')
    const save = ([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
    expect(save).toBeTruthy()
    await act(async () => fireEvent.click(save))
    await settle(50)
    expect(writes).toHaveLength(0)
  })
})
