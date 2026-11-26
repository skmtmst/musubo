// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@line-crm/shared'

/**
 * N-193: テンプレート作成の「登録メディアから選択する」は押しても
 * API呼出0・選択窓なしだった。実Reactで、開く→読む→選ぶ→保存値へ
 * ID・種別が載るところまでを直接証明する。
 */
const fixture = vi.hoisted(() => ({
  /** useAccount が返すアカウント。試験の途中で切り替えられるよう変数にする。 */
  accountId: 'account-a',
  listCalls: [] as Array<{ accountId: string; params?: { kind?: string } }>,
  createCalls: [] as Array<{ lineAccountId: string; kind: string; name: string; payload: Record<string, unknown> }>,
}))

const MEDIA: MediaItem = {
  id: 'media-9',
  lineAccountId: 'account-a',
  folderId: null,
  kind: 'image',
  filename: 'キャンペーン画像.png',
  mimeType: 'image/png',
  sizeBytes: 2400,
  width: 1040,
  height: 1040,
  durationMs: null,
  url: 'https://cdn.example.test/campaign.png',
  uploadedBy: '管理者',
  createdAt: '2026-09-16T09:00:00+09:00',
  usageCount: 0,
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, accounts: [{ id: 'account-a', name: 'A' }, { id: 'account-b', name: 'B' }], loading: false }),
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
const emptyList = () => Promise.resolve({ success: true, data: [] })

vi.mock('@/lib/api', () => ({
  api: {
    folders: { list: emptyList },
    broadcastMessageAssets: {
      folders: { list: emptyList },
      create: (input: { lineAccountId: string; kind: string; name: string; payload: Record<string, unknown> }) => {
        fixture.createCalls.push(input)
        return Promise.resolve({ success: true, data: { id: 'asset-1' } })
      },
    },
    media: {
      list: (accountId: string, params?: { kind?: string }) => {
        fixture.listCalls.push({ accountId, params })
        return Promise.resolve({ success: true, data: { items: [MEDIA], total: 1, limit: 20, offset: 0 } })
      },
      contentUrl: (id: string, accountId: string) => `/api/media/${id}/content?accountId=${accountId}`,
    },
    /*
     * NEXT-17〜19 でアクション編集（InlineActionList / useActionOptions）を
     * 載せたので、そこが読む候補APIも空で返す。モックしないと実ネットワークへ
     * 出るか、未定義呼出で落ちる。
     */
    tags: { list: emptyList },
    friendFields: { list: emptyList },
    supportMarks: { list: emptyList },
    scenarios: { list: emptyList },
    commonVars: { list: emptyList },
    featureSettings: { visibility: () => Promise.resolve({ success: true, data: { features: {} } }) },
  },
}))

const { default: TemplateRichEditor } = await import('@/v8/template-edit/rich')
const { default: TemplateAssetEditorV8 } = await import('@/v8/template-edit/asset')
function TemplateAssetEditor({ kind }: { kind: 'rich_message' | 'coupon' | 'research' }) {
  return kind === 'rich_message' ? <TemplateRichEditor /> : <TemplateAssetEditorV8 kind={kind} />
}

let host: HTMLDivElement
let root: Root

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function renderEditor(kind: 'rich_message' | 'coupon' | 'research') {
  await act(async () => {
    root.render(<TemplateAssetEditor kind={kind} />)
    await settle()
  })
}

function buttonByText(text: string, scope: ParentNode = host): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`ボタンがありません: ${text}`)
  return button
}

function dialog(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('ダイアログが開いていません')
  return node
}

async function waitForDialogText(text: string) {
  for (let index = 0; index < 30 && !dialog().textContent?.includes(text); index += 1) {
    await act(async () => { await settle() })
  }
  expect(dialog().textContent).toContain(text)
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.listCalls.length = 0
  fixture.createCalls.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('テンプレート作成の「登録メディアから選択する」（N-193）', () => {
  it('リッチメッセージ: 押すと選択窓が開き、選んだID・種別・URLが保存値へ載る', async () => {
    await renderEditor('rich_message')
    expect(fixture.listCalls).toEqual([])

    // 無反応だった操作: 押すとメディア一覧を読み、選択窓が開く。
    await act(async () => { buttonByText('登録メディアから選択する').click(); await settle() })
    expect(fixture.listCalls).toEqual([{ accountId: 'account-a', params: { kind: 'image', query: undefined, limit: 20, offset: 0 } }])
    await waitForDialogText('キャンペーン画像.png')

    // 選ぶと窓が閉じ、画面の保存対象（画像URL欄）へ反映される。
    await act(async () => {
      ;[...dialog().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent?.includes('キャンペーン画像.png'))!.click()
      await settle()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    const urlInput = host.querySelector<HTMLInputElement>('input[aria-label="画像のURL"]')!
    expect(urlInput.value).toBe('https://cdn.example.test/campaign.png')

    // 名前を入れて保存すると、選んだメディアのID・種別も保存値へ載る。
    const nameInput = host.querySelector<HTMLInputElement>('input[type="text"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(nameInput, '夏のキャンペーン告知')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    })
    await act(async () => { buttonByText('下書きを保存').click(); await settle() })
    expect(fixture.createCalls).toHaveLength(1)
    expect(fixture.createCalls[0].payload).toMatchObject({
      imageUrl: 'https://cdn.example.test/campaign.png',
      imageMediaId: 'media-9',
      imageMediaKind: 'image',
    })
  })

  it('クーポン: 「登録メディアから選択する」が同じ選択窓へ繋がる', async () => {
    await renderEditor('coupon')
    await act(async () => { buttonByText('登録メディアから選択する').click(); await settle() })
    expect(fixture.listCalls).toHaveLength(1)
    await waitForDialogText('キャンペーン画像.png')
    await act(async () => {
      ;[...dialog().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent?.includes('キャンペーン画像.png'))!.click()
      await settle()
    })
    expect(host.textContent).toContain('選択中：キャンペーン画像.png')
  })

  it('アカウントを切り替えると、前のアカウントで選んだ候補は保存対象から外れる', async () => {
    await renderEditor('rich_message')
    await act(async () => { buttonByText('登録メディアから選択する').click(); await settle() })
    await waitForDialogText('キャンペーン画像.png')
    await act(async () => {
      ;[...dialog().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent?.includes('キャンペーン画像.png'))!.click()
      await settle()
    })
    expect(host.textContent).toContain('選択中：キャンペーン画像.png')

    // account-b へ切り替えると、「選択中」表示とURL欄のピック値が消える。
    fixture.accountId = 'account-b'
    await act(async () => {
      root.render(<TemplateAssetEditor kind="rich_message" />)
      await settle()
    })
    expect(host.textContent).not.toContain('選択中：')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="画像のURL"]')!.value).toBe('')

    // そのまま保存しても、別アカウントのメディアID・種別は保存値へ載らない。
    // （#989: 画像なしでは保存しない。URL欄へ直接入れて保存する。）
    const nameInput = host.querySelector<HTMLInputElement>('input[type="text"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(nameInput, '夏のキャンペーン告知')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(host.querySelector<HTMLInputElement>('input[aria-label="画像のURL"]')!, 'https://cdn.example.test/other.png')
      host.querySelector<HTMLInputElement>('input[aria-label="画像のURL"]')!.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    })
    await act(async () => { buttonByText('下書きを保存').click(); await settle() })
    expect(fixture.createCalls).toHaveLength(1)
    expect(fixture.createCalls[0].lineAccountId).toBe('account-b')
    expect(fixture.createCalls[0].payload.imageMediaId).toBeNull()
    expect(fixture.createCalls[0].payload.imageMediaKind).toBeNull()
  })
})
