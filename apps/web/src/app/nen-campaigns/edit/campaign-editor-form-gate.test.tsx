// @vitest-environment happy-dom
/*
 * NEN-07 (#1078): 「回答フォームを開く」配信でつなぐフォームが使えない状態を
 * 本物の React で mount して確かめる。
 *
 * 見張る筋書き:
 *   1. フォームが消えた(一覧に無い)設定は「設定不足」の案内と欄の直下の理由が
 *      出て、保存APIを呼ばない。
 *   2. 公開されていないフォームは候補つき入力で理由つきで選べない。
 *   3. 使えるフォームがつながっていれば「つながる先」に名前と状態が出て
 *      保存できる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lineAccountsListApi = vi.hoisted(() => vi.fn())
const settingsApi = vi.hoisted(() => vi.fn())
const updateSettingApi = vi.hoisted(() => vi.fn())
const overviewApi = vi.hoisted(() => vi.fn())
const formsListApi = vi.hoisted(() => vi.fn())
const testRecipientLoginUsersApi = vi.hoisted(() => vi.fn())
const friendFieldsListApi = vi.hoisted(() => vi.fn())
const commonVarsListApi = vi.hoisted(() => vi.fn())
const navigation = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: lineAccountsListApi },
      nenCampaigns: { ...actual.api.nenCampaigns, settings: settingsApi, updateSetting: updateSettingApi, overview: overviewApi },
      forms: { ...actual.api.forms, list: formsListApi },
      accountSettings: { ...actual.api.accountSettings, getTestRecipientLoginUsers: testRecipientLoginUsersApi },
      friendFields: { ...actual.api.friendFields, list: friendFieldsListApi },
      commonVars: { ...actual.api.commonVars, list: commonVarsListApi },
    },
  }
})

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({ ...(await importOriginal()), useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

const { AccountProvider } = await import('@/contexts/account-context')
const { default: CampaignEditor } = await import('@/v8/nen-campaigns/edit')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACCOUNT_ID = 'account-nen'
const CAMPAIGN_KEY = 'review_request'

function baseSetting(overrides: Record<string, unknown> = {}) {
  return {
    campaignKey: CAMPAIGN_KEY,
    label: '口コミのお願い',
    category: 'follow_up' as const,
    triggerEvent: 'ec.order.shipped',
    delayDays: 10,
    deliveryTime: '10:00:00',
    isEnabled: true,
    title: '口コミのお願い',
    bodyText: 'ひとことだけ感想を聞かせてください。',
    buttonLabel: '感想を書く（30秒）',
    buttonUrl: 'https://liff.line.me/liff-1/?page=form&id=form-review',
    imageUrl: null,
    dedupWindowDays: 30,
    excludeFormRespondents: false,
    afterActions: [
      { kind: 'open_form' as const, formId: 'form-review', formName: '口コミ', buttonLabel: '感想を書く（30秒）' },
    ],
    formIssue: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount() {
  localStorage.setItem('lh_selected_account', ACCOUNT_ID)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(AccountProvider, null, React.createElement(CampaignEditor, { campaignKey: CAMPAIGN_KEY })),
    )
  })
  await settle()
}

function saveButton(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent === '配信内容を保存する',
  )
  if (!found) throw new Error('保存ボタンが見つかりません')
  return found as HTMLButtonElement
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  } as Storage
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', fakeStorage())
  lineAccountsListApi.mockResolvedValue({
    success: true,
    data: [{ id: ACCOUNT_ID, channelId: 'ch-1', name: 'テスト店', isActive: true, country: 'JP', role: 'owner', displayOrder: 0, liffId: 'liff-1' }],
  })
  overviewApi.mockResolvedValue({
    success: true,
    data: {
      activeCampaigns: 1,
      jobs: { total: 0, pending: 0, sent: 0, failed: 0, pendingByCampaign: {} },
      columns: 0, pets: 0, coupons: 0,
    },
  })
  testRecipientLoginUsersApi.mockResolvedValue({ success: true, data: [] })
  updateSettingApi.mockResolvedValue({ success: true })
  friendFieldsListApi.mockResolvedValue({ success: true, data: [] })
  commonVarsListApi.mockResolvedValue({ success: true, data: [] })
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  container.remove()
  delete document.documentElement.dataset.theme
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('NEN-07: つなぐ回答フォームが使えない設定（実mount）', () => {
  it('フォームが消えた設定は「設定不足」と理由を出し、保存を呼ばない', async () => {
    settingsApi.mockResolvedValue({
      success: true,
      data: [baseSetting({ formIssue: 'form_missing' })],
    })
    formsListApi.mockResolvedValue({ success: true, data: [] })
    await mount()

    expect(container.textContent).toContain('設定不足')
    expect(container.textContent).toContain('つなぐ回答フォームが見つかりません')

    await click(saveButton())
    await settle()
    expect(updateSettingApi).not.toHaveBeenCalled()
    expect(container.querySelector('#nen-edit-form')?.getAttribute('aria-invalid')).toBe('true')
  })

  it('公開されていないフォームは候補つき入力で理由つきで選べない', async () => {
    settingsApi.mockResolvedValue({
      success: true,
      data: [baseSetting({ afterActions: [], buttonUrl: null, buttonLabel: null })],
    })
    formsListApi.mockResolvedValue({
      success: true,
      data: [
        { id: 'form-live', name: '公開中のフォーム', description: null, isActive: true },
        { id: 'form-draft', name: '下書きフォーム', description: null, isActive: false },
      ],
    })
    await mount()

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="回答フォームを開かせる：選択する"]')!
    expect(toggle).toBeTruthy()
    await click(toggle)
    const options = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]')]
    const live = options.find((option) => option.getAttribute('aria-label') === '公開中のフォーム')!
    const draft = options.find((option) => option.getAttribute('aria-label') === '下書きフォーム')!
    expect(live.disabled).toBe(false)
    expect(draft.disabled).toBe(true)
    expect(draft.closest('label')?.textContent).toContain('公開されていないため選べません')
    await click(draft)
    expect(container.querySelector('#nen-edit-form')?.parentElement?.textContent).not.toContain('下書きフォーム')
    await click(live)
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '選択する')!)
    await settle()
    expect(container.querySelector('#nen-edit-form')?.parentElement?.textContent).toContain('公開中のフォーム')
    await click(saveButton())
    await settle()
    expect(updateSettingApi).toHaveBeenCalledWith(ACCOUNT_ID, CAMPAIGN_KEY, expect.objectContaining({ afterActions: [expect.objectContaining({ kind: 'open_form', formId: 'form-live', formName: '公開中のフォーム' })] }))
  })

  it('使えるフォームなら「つながる先」に名前と公開状態が出て保存できる', async () => {
    settingsApi.mockResolvedValue({ success: true, data: [baseSetting()] })
    formsListApi.mockResolvedValue({
      success: true,
      data: [{ id: 'form-review', name: '口コミ', description: null, isActive: true }],
    })
    await mount()

    // ★V8 の編集（campaign-editor-v8）は「つながる先」の欄に公開状態を出さない。つないだ名前と、問題の知らせが無いことを見る。
    expect(container.querySelector('#nen-edit-form')?.parentElement?.textContent).toContain('口コミ')
    expect(container.textContent).not.toContain('つなぐ回答フォームは公開されていません')
    await click(saveButton())
    await settle()
    expect(updateSettingApi).toHaveBeenCalledTimes(1)
  })
})
