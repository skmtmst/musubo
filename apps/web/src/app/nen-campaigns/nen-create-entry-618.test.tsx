// @vitest-environment happy-dom
/*
 * #618: NEN配信のコラムタブに新規作成入口が無かった。
 * 監査実測（自動配信4件・コラム5件）と同じく一覧に件数があっても、
 * 何も選んでいない状態でヘッダーから「コラムを書く」へ届くことを、
 * 実ページの mount で確かめる。2つ目は日時あり下書きの保存→一覧への
 * 戻り（再読込で読める形で送ること）を実作成画面の mount で確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner',
}))
import type { NenCampaignSetting, NenColumn } from '../../lib/api'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
const network = vi.hoisted(() => ({
  columns: vi.fn(),
  settings: vi.fn(),
  flowMetrics: vi.fn(),
  columnMetrics: vi.fn(),
  deliveries: vi.fn(),
  birthdayCoupon: vi.fn(),
  columnAudience: vi.fn(),
  updateColumnMessage: vi.fn(),
  testRecipients: vi.fn(),
  createColumn: vi.fn(),
  tagsList: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => '/nen-campaigns',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }),
}))

/*
 * 時刻の選び欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * 下書き保存の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      tags: { ...actual.api.tags, list: network.tagsList },
      nenCampaigns: {
        ...actual.api.nenCampaigns,
        settings: network.settings,
        columns: network.columns,
        flowMetrics: network.flowMetrics,
        columnMetrics: network.columnMetrics,
        deliveries: network.deliveries,
        birthdayCoupon: network.birthdayCoupon,
        columnAudience: network.columnAudience,
        updateColumnMessage: network.updateColumnMessage,
        createColumn: network.createColumn,
      },
      accountSettings: {
        ...actual.api.accountSettings,
        getTestRecipients: network.testRecipients,
      },
    },
  }
})

const { default: NenCampaignsPage } = await import('./page')
const { default: NewNenColumnPage } = await import('./columns/new/page')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const columnSetting = (): NenCampaignSetting => ({
  campaignKey: 'column',
  label: 'NENコラム',
  category: 'column',
  triggerEvent: null,
  delayDays: 0,
  deliveryTime: '10:00',
  isEnabled: true,
  title: 'コラム',
  bodyText: '本文',
  buttonLabel: 'コラムを読む',
  buttonUrl: null,
  imageUrl: null,
  dedupWindowDays: 0,
  excludeFormRespondents: false,
  afterActions: [],
})

const autoSetting = (key: string): NenCampaignSetting => ({ ...columnSetting(), campaignKey: key, label: `自動${key}`, category: 'order' })

const column = (id: string, over: Partial<NenColumn> = {}): NenColumn => ({
  id,
  externalId: null,
  slug: `slug-${id}`,
  title: `題名${id}`,
  category: '食事',
  excerpt: '概要',
  introText: `紹介文${id}`,
  articleUrl: 'https://example.com/a',
  imageUrl: null,
  publishedAt: '2026-08-01T00:00:00Z',
  deliveryStatus: 'draft',
  deliveryAt: null,
  lineAccountId: 'account-a',
  updatedAt: '2026-08-01T00:00:00Z',
  targetMode: 'all',
  targetTagId: null,
  completionEventName: null,
  completionTagId: null,
  sourceColumnId: null,
  ...over,
})

let container: HTMLDivElement
let root: Root

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  await settle()
}

async function unmount() {
  if (root) await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
}

async function click(element: HTMLElement) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function setInputReact(input: HTMLInputElement, value: string) {
  await act(async () => { setInput(input, value) })
  await settle()
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  // 監査実測どおり: 自動配信4件・コラム5件。
  network.settings.mockResolvedValue({
    success: true,
    data: [autoSetting('a1'), autoSetting('a2'), autoSetting('a3'), autoSetting('a4'), columnSetting()],
  })
  network.columns.mockResolvedValue({
    success: true,
    data: [column('c1'), column('c2'), column('c3'), column('c4'), column('c5')],
    pagination: { total: 5, limit: 200, offset: 0 },
  })
  network.flowMetrics.mockResolvedValue({ success: true, data: { summary: { associatedConversions: 0, associatedConversionAmount: 0 }, flows: [] } })
  network.columnMetrics.mockResolvedValue({ success: true, data: { columns: [] } })
  network.deliveries.mockResolvedValue({
    success: true,
    data: {
      range: { days: 30, from: '2026-08-01', to: '2026-09-01' },
      summary: { pending: 0, processing: 0, sent: 0, skipped: 0, failed: 0, cancelled: 0, retryRequired: 0, unmetReasons: {}, skippedReasons: {} },
      deliveries: [],
      pagination: { total: 0, limit: 20, cursor: '0', nextCursor: null },
    },
  })
  network.birthdayCoupon.mockResolvedValue({ success: true, data: { isEnabled: false, codePrefix: '', benefitLabel: '', discountAmount: 0, validityDays: 0, leapYearPolicy: 'feb28', updatedAt: '' } })
  network.columnAudience.mockResolvedValue({ success: true, data: { count: 5, targetMode: 'all', targetTagId: null } })
  network.updateColumnMessage.mockResolvedValue({ success: true })
  network.testRecipients.mockResolvedValue({ success: true, data: [] })
  network.tagsList.mockResolvedValue({ success: true, data: [] })
  network.createColumn.mockResolvedValue({ success: true, data: { id: 'new-id', queued: 0 } })
})

afterEach(async () => { await unmount(); delete document.documentElement.dataset.theme })

describe('NEN新規作成入口（#618）', () => {
  it('コラムが5件あっても未選択でも、ヘッダーから「コラムを書く」へ届く', async () => {
    await mount(React.createElement(NenCampaignsPage))
    const tab = Array.from(container.querySelectorAll('button'))
      .find((b) => /^コラム\s*\d*$/.test(b.textContent ?? ''))
    if (!tab) throw new Error('コラムのタブが見つかりません')
    await click(tab)

    // 何も選んでいない状態でもヘッダーに入口がある（監査の欠落点）。
    const entry = container.querySelector('a[href^="/nen-campaigns/columns/new"]')
    expect(entry).not.toBeNull()
    expect(entry!.textContent).toContain('コラムを書く')
  })

  it('日時あり下書きを保存してコラム一覧へ戻る（再読込で読める形）', async () => {
    await mount(React.createElement(NewNenColumnPage))
    const inputs = Array.from(container.querySelectorAll('input'))
    const byPlaceholder = (text: string) => inputs.find((i) => i.placeholder.includes(text))
    const titleInput = container.querySelector<HTMLInputElement>('input[aria-label="題名"]')
    const urlInput = byPlaceholder('https://example.com/columns/')
    if (!titleInput || !urlInput) throw new Error('題名または記事URLの入力欄が見つかりません')
    await setInputReact(titleInput, '専用データの題名618')
    await setInputReact(urlInput, 'https://example.com/columns/618-draft')

    // 現役の日時選択で60日先の日本時間を記録する。
    const ahead = new Date()
    ahead.setDate(ahead.getDate() + 60)
    const future = {
      y: ahead.getFullYear(),
      mo: ahead.getMonth() + 1,
      d: ahead.getDate(),
      iso: `${ahead.getFullYear()}-${String(ahead.getMonth() + 1).padStart(2, '0')}-${String(ahead.getDate()).padStart(2, '0')}T10:30`,
    }
    const futureWeek = '日月火水木金土'[new Date(future.y, future.mo - 1, future.d).getDay()]
    const scheduleLabel = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.includes('配信日時（日本時間）'),
    )
    const trigger = scheduleLabel?.htmlFor ? container.querySelector(`#${scheduleLabel.htmlFor.replace(/:/g, '\\:')}`) : null
    if (!trigger) throw new Error('配信日時の入力欄が見つかりません')
    await click(trigger as HTMLElement)
    // 日時の選択箱は最上層（MenuPortal→document.body）に出る。器の中にはいない。
    const picker = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')
    if (!picker) throw new Error('日時の選択箱が開きません')
    for (let i = 0; i < 12; i += 1) {
      const grid = document.querySelector('[role="grid"]')
      if (grid?.getAttribute('aria-label') === `${future.y}年${future.mo}月`) break
      const next = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '次の月')
      if (!next) throw new Error('暦が見つかりません')
      await click(next as HTMLElement)
    }
    const day = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith(`${future.y}年${future.mo}月${future.d}日（${futureWeek}）`),
    )
    if (!day) throw new Error('未来の日が見つかりません')
    await click(day as HTMLElement)
    // 時刻は文字を入れ、blurで確定する。
    await act(async () => {
      const time = picker.querySelector<HTMLInputElement>('input[type="text"]')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(time, '10:30')
      time.dispatchEvent(new Event('input', { bubbles: true }))
      time.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await settle()
    await click(Array.from(picker.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!)

    const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '下書きを保存')
    if (!save) throw new Error('下書きに保存ボタンが見つかりません')
    await click(save)

    expect(network.createColumn).toHaveBeenCalledTimes(1)
    const [accountId, body] = network.createColumn.mock.calls[0] as [string, Record<string, unknown>]
    expect(accountId).toBe('account-a')
    expect(body.title).toBe('専用データの題名618')
    // 日時あり: 日本時間として +09:00 で送る（再読込で日本時間に読める）。
    expect(body.scheduledAt).toBe(`${future.iso}:00+09:00`)
    expect(navigation.push).toHaveBeenCalledWith('/nen-campaigns?tab=columns&highlight=new-id')

    // 保存後の再読込: 一覧にその下書きが並ぶ。
    await unmount()
    network.columns.mockResolvedValue({
      success: true,
      data: [column('new-id', { title: '専用データの題名618', deliveryAt: '2099-05-01T01:30:00.000Z' }), column('c1')],
      pagination: { total: 2, limit: 200, offset: 0 },
    })
    await mount(React.createElement(NenCampaignsPage))
    const tab = Array.from(container.querySelectorAll('button'))
      .find((b) => /^コラム\s*\d*$/.test(b.textContent ?? ''))
    if (!tab) throw new Error('コラムのタブが見つかりません')
    await click(tab)
    expect(container.textContent).toContain('専用データの題名618')
  })
})
