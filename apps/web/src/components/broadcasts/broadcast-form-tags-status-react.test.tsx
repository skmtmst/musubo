
// @vitest-environment happy-dom
/*
 * 配信対象のタグ候補の取得失敗と真の0件の分け方（監査 R581）。
 *
 * 再現: タグ候補GETを失敗させると、候補欄が空のまま「候補はありません」と
 * 出て、通信失敗が「タグが無い」と誤って伝わっていた。
 *
 * 見る筋書き:
 *   失敗 … 失敗の理由と「もう一度読み込む」が出て、候補欄は開かせない。
 *           再試行を押すと取り直し、書きかけ（配信名）は消えない。
 *   真の0件 … 「タグはまだありません」と作り先だけを案内する。
 *   復旧 … 候補が戻ると選べる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

const createApi = vi.hoisted(() => vi.fn())
const updateApi = vi.hoisted(() => vi.fn())
const getApi = vi.hoisted(() => vi.fn())
const onRetryTags = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const emptyList = async () => ({ success: true, data: [] })
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        create: createApi,
        update: updateApi,
        get: getApi,
        list: async () => ({ success: true, data: [] }),
        preflight: async () => ({ success: true, data: { audienceCount: 10 } }),
        previewCount: async () => ({ success: true, data: { count: 10 } }),
      },
      folders: { list: emptyList },
      scenarios: { list: emptyList },
      commonVars: { list: emptyList },
      friendFields: { list: emptyList },
      broadcastMessageAssets: { list: emptyList, upload: emptyList },
      templates: { list: emptyList },
      commonActions: { resources: async () => ({ success: true, data: [] }) },
      accountSettings: { getTestRecipients: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/broadcasts/new',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import BroadcastForm from './broadcast-form'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAGS: Tag[] = [
  { id: 't-vip', name: 'VIP', color: '#e5484d', createdAt: '2026-01-01T00:00:00.000Z' },
]

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) await Promise.resolve()
  })
}

async function renderForm(
  tags: Tag[],
  tagsStatus: 'loading' | 'ready' | 'error',
  step: 'audience' | undefined = 'audience',
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <BroadcastForm
        tags={tags}
        tagsStatus={tagsStatus}
        onRetryTags={onRetryTags}
        onSuccess={() => {}}
        onCancel={() => {}}
        currentStep={step}
        onStepChange={() => {}}
      />,
    )
  })
  await flush()
}

async function rerenderForm(
  tags: Tag[],
  tagsStatus: 'loading' | 'ready' | 'error',
  step: 'audience' | undefined = 'audience',
) {
  await act(async () => {
    root.render(
      <BroadcastForm
        tags={tags}
        tagsStatus={tagsStatus}
        onRetryTags={onRetryTags}
        onSuccess={() => {}}
        onCancel={() => {}}
        currentStep={step}
        onStepChange={() => {}}
      />,
    )
  })
  await flush()
}

function unmount() {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
}

/** 対象者の選び方を「タグで絞り込む」へ切り替える。 */
async function selectTagMode() {
  const radio = container.querySelector(
    'input[name="broadcast-target-mode"][value="tag"]',
  ) as HTMLInputElement | null
  expect(radio, 'タグの選び方がありません').toBeTruthy()
  await act(async () => {
    radio!.click()
  })
  await flush()
}

function tagComboboxInput(): HTMLButtonElement | null { return container.querySelector('button[aria-label="どのタグ"]') }

function setNativeValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('タグ候補の失敗と0件の分け方（R581）', () => {
  it('失敗時は理由と再試行を出し、候補欄は開かせない', async () => {
    await renderForm([], 'error')
    try {
      await selectTagMode()
      expect(container.textContent).toContain('タグを読み込めませんでした')
      // 「候補なし」の誤案内は出さない。
      expect(container.textContent).not.toContain('タグはまだありません')
      const retry = [...container.querySelectorAll('button')].find(
        (item) => (item.textContent ?? '').includes('もう一度読み込む'),
      )
      expect(retry, '再試行がありません').toBeTruthy()
      expect(tagComboboxInput()?.disabled, '候補欄が開けてしまいます').toBe(true)
      await act(async () => {
        retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      expect(onRetryTags).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it('復旧後は候補を選べる', async () => {
    await renderForm([], 'error')
    try {
      await selectTagMode()
      await rerenderForm(TAGS, 'ready')
      await selectTagMode()
      expect(container.textContent).not.toContain('タグを読み込めませんでした')
      const input = tagComboboxInput()
      expect(input?.disabled).toBe(false)
      // 窓で選んで確定する。
      await act(async () => {
        input!.click()
      })
      await flush()
      expect(document.body.textContent).toContain('VIP')
      const option = [...document.querySelectorAll('input[type="radio"]')].find(
        (item) => item.getAttribute('aria-label') === 'VIP',
      )
      expect(option, 'VIPを選べません').toBeTruthy()
      await act(async () => {
        (option as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '選択する')!.click() })
      expect(input!.parentElement?.textContent).toContain('VIP')
    } finally {
      unmount()
    }
  })

  it('再取得で書きかけの配信名は消えない', async () => {
    // 段分けなしの従来フォームで書きかけを作り、再取得の前後で見る。
    await renderForm([], 'error', undefined)
    try {
      const title = container.querySelector(
        'input[placeholder="例：8月キャンペーンのお知らせ"]',
      ) as HTMLInputElement | null
      expect(title, '配信名の欄がありません').toBeTruthy()
      await act(async () => {
        setNativeValue(title!, '書きかけの配信名')
      })
      await flush()
      expect(title!.value).toBe('書きかけの配信名')
      // 親がタグを取り直して渡し直しても、フォームの入力は保たれる。
      await rerenderForm(TAGS, 'ready', undefined)
      const kept = container.querySelector(
        'input[placeholder="例：8月キャンペーンのお知らせ"]',
      ) as HTMLInputElement | null
      expect(kept?.value).toBe('書きかけの配信名')
    } finally {
      unmount()
    }
  })

  it('真の0件は「まだありません」と作り先だけを案内する', async () => {
    await renderForm([], 'ready')
    try {
      await selectTagMode()
      expect(container.textContent).toContain('タグはまだありません')
      expect(container.textContent).not.toContain('タグを読み込めませんでした')
      const link = container.querySelector('a[href="/tags"]')
      expect(link, '作り先への案内がありません').toBeTruthy()
      expect(tagComboboxInput()?.disabled).toBe(false)
    } finally {
      unmount()
    }
  })

  it('読み込み中はその旨を出し、候補欄は開かせない', async () => {
    await renderForm([], 'loading')
    try {
      await selectTagMode()
      expect(container.textContent).toContain('タグを読み込んでいます')
      expect(tagComboboxInput()?.disabled).toBe(true)
    } finally {
      unmount()
    }
  })
})
