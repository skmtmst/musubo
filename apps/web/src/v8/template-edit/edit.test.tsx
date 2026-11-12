// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 テンプレートの作る・編集（src/v8/template-edit）の動きの試験。V8 のテーマで描いて確かめる。
 * 保存の口・断り方・保存の 409 の帯・差し込み・閲覧のみ（押せない操作を置かない）・クーポン／リサーチの保存。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const templatesApi = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn(), delete: vi.fn() }))
const assetsCreate = vi.hoisted(() => vi.fn())
const assetsPublish = vi.hoisted(() => vi.fn())
const assetsList = vi.hoisted(() => vi.fn())
const assetsUpdate = vi.hoisted(() => vi.fn())
const assetFoldersList = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'account-a' }))
const search = vi.hoisted(() => ({ value: '' }))
const loadExamples = vi.hoisted(() => vi.fn())
vi.mock('@/v8/templates/examples', () => ({ loadTemplateExamples: loadExamples }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      templates: { ...api.templates, ...templatesApi },
      broadcastMessageAssets: { ...api.broadcastMessageAssets, create: assetsCreate, publish: assetsPublish, list: assetsList, update: assetsUpdate, folders: { list: assetFoldersList } },
      folders: { ...api.folders, list: listFolders },
      friendFields: { list: async () => ({ success: true, data: [{ fieldKey: 'plan', name: 'プラン', canInsertText: true, defaultValue: '定期便' }] }) },
      commonVars: { list: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(search.value),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '然 - NEN -' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})
const narrow = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow.value }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/components/auto-replies/inline-action-list', async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [], notificationRules: [] }),
}))

import { ApiError } from '@/lib/api'
import TemplateEditV8 from './edit'
import TemplateMessageEditor from './message'
import TemplateAssetEditor from './asset'
import type { TemplateEditHost } from './host'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const detail = (patch: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    id: 'template-1', name: '予約前日のご案内', category: 'general', folderId: null, messageType: 'text',
    messageContent: '明日のご予約です。', accountId: 'account-a', publishedVersion: 3, draftRevision: 2,
    updatedAt: '2026-10-06T05:02:00Z',
    usedBy: { autoReplies: [], automations: [], scenarioSteps: [], reminderSteps: [], richMenuAreas: [], trackedLinks: [] },
    ...patch,
  },
})

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}
async function mount(query = '') {
  search.value = query
  await act(async () => { root.render(<TemplateEditV8 />) })
  await flush()
}
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } })

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'v8')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  account.id = 'account-a'
  narrow.value = false
  push.mockReset()
  for (const fn of Object.values(templatesApi)) fn.mockReset()
  assetsCreate.mockReset()
  assetsPublish.mockReset()
  assetsList.mockReset()
  assetsUpdate.mockReset()
  assetFoldersList.mockReset()
  assetFoldersList.mockResolvedValue({ success: true, data: [{ id: 'asset-folder-1', name: '販促' }] })
  assetsPublish.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 1, draftRevision: 0 } })
  listFolders.mockReset()
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'fol-1', kind: 'template', name: '予約', itemCount: 1 }] })
  templatesApi.get.mockResolvedValue(detail())
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

describe('V8 メッセージを作る・編集', () => {
  it('利用中のメッセージの公開確認に対象と環境を出す', async () => {
    templatesApi.get.mockResolvedValue(detail({ usedBy: { autoReplies: [], automations: [], scenarioSteps: [{ stepId: 's', scenarioId: 'scenario', scenarioName: 'ご案内', stepOrder: 1 }], reminderSteps: [], richMenuAreas: [], trackedLinks: [] } }))
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1', publishedVersion: 3, draftRevision: 3 } })
    await mount('id=template-1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'この内容を公開しますか？' })
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
  })
  it('アカウントを切り替えて戻しても古いメッセージ公開確認を使えない', async () => {
    templatesApi.get.mockResolvedValue(detail({ usedBy: { autoReplies: [], automations: [], scenarioSteps: [{ stepId: 's', scenarioId: 'scenario', scenarioName: 'ご案内', stepOrder: 1 }], reminderSteps: [], richMenuAreas: [], trackedLinks: [] } }))
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1', publishedVersion: 3, draftRevision: 3 } })
    await mount('id=template-1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'この内容を公開しますか？' })
    const button = within(dialog).getByRole('button', { name: '公開する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    account.id = 'account-b'; await act(async () => { root.render(<TemplateEditV8 />) })
    account.id = 'account-a'; await act(async () => { root.render(<TemplateEditV8 />) })
    await act(async () => { await oldClick({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(templatesApi.publish).not.toHaveBeenCalled()
  })
  it('新しいメッセージは形の切り替えを出さず、テキストで保存する', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'new-text' } })
    await mount()
    expect(screen.queryByRole('group', { name: 'メッセージの形' })).toBeNull()
    expect(screen.queryByText('形')).toBeNull()
    expect(screen.queryByText(/この形は新しく作れません/)).toBeNull()
    type(screen.getByLabelText('テンプレート名'), '新しい本文')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.create).toHaveBeenCalledWith(expect.objectContaining({ messageType: 'text', messageContent: 'こんにちは' }))
  })

  it.each([
    ['flex', JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '元の本文' }] } }), JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '直した本文' }] } })],
    ['image', 'https://img.example/old.png', 'https://img.example/new.png'],
  ])('既存の%sは帯を出し、形の切り替えなしで元の形のまま保存できる', async (messageType, messageContent, next) => {
    templatesApi.get.mockResolvedValue(detail({ messageType, messageContent }))
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1' } })
    await mount('id=template-1')
    expect(screen.getByText('この形は新しく作れません。新しく作るときはカルーセル・リッチメッセージを使ってください。')).toBeTruthy()
    expect(screen.queryByText('形')).toBeNull()
    type(screen.getByLabelText('メッセージ内容'), next)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenCalledWith('template-1', expect.objectContaining({ messageType, messageContent: next }))
  })

  it('見本から作る（?example=）：見本の名前と本文を入れて開き、保存はしない', async () => {
    loadExamples.mockResolvedValue([{ id: 'template-example-booking', name: '予約の受付', body: 'ご予約を受け付けました。' }])
    await mount('example=template-example-booking')
    expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('予約の受付')
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('ご予約を受け付けました。')
    expect(templatesApi.create).not.toHaveBeenCalled()
  })

  it('見本が見つからないときは白紙のまま、理由を出す', async () => {
    loadExamples.mockResolvedValue([])
    await mount('example=missing')
    expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('見本が見つかりませんでした。白紙から作れます。')).toBeTruthy()
  })

  it('作る：名前と本文を書いて下書きを保存すると、選んでいるアカウントで作って一覧へ戻る', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-new' } })
    await mount()
    expect(document.querySelector('[data-design-node="u5YC6"]')).toBeTruthy()
    type(screen.getByLabelText('テンプレート名'), '予約前日のご案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.create).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a', name: '予約前日のご案内', messageContent: 'こんにちは', folderId: null }))
    expect(push).toHaveBeenCalledWith('/templates?highlight=template-new')
  })

  it('1152 の幅でも共通の入口から見え方を1回で開き、閉じても入力を保つ', async () => {
    narrow.value = true
    await mount()
    expect(document.querySelector('[data-design-node="a1k3d"]')).toBeTruthy()
    type(screen.getByLabelText('テンプレート名'), '確認中の名前')
    type(screen.getByLabelText('本文'), '確認中の本文')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINEの見え方を確認' })) })
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'LINEの見え方' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: /見え方.*(?:見る|確認)/ })).toBeNull()
    expect(dialog.querySelector('[data-line-preview-part="phone"]')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getAllByRole('button', { name: '閉じる' })[0]) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('確認中の名前')
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('確認中の本文')
  })

  it('名前が空なら保存の口を呼ばず、理由を出す', async () => {
    await mount()
    type(screen.getByLabelText('本文'), 'こんにちは')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.create).not.toHaveBeenCalled()
    // 理由は上の帯ではなく、名前の欄の真下に出る。
    expect(screen.getByRole('alert').textContent).toContain('テンプレート名を入力してください')
    expect(screen.getByLabelText('テンプレート名').getAttribute('aria-invalid')).toBe('true')
  })

  it('名前と本文が空で保存すると、両方の欄が赤くなり真下に理由が出て、1つ目の欄へ移る。直すとその欄の赤は消える', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(templatesApi.create).not.toHaveBeenCalled()
    const nameInput = screen.getByLabelText('テンプレート名')
    expect(nameInput.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('te-name-error')?.textContent).toBe('テンプレート名を入力してください。')
    expect(document.getElementById('te-content-error')?.textContent).toBe('本文を入力してください。')
    expect(document.querySelector('#te-content')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameInput)
    expect(document.querySelector('[data-design-part="validation-summary"]')?.textContent).toContain('2か所直してください：テンプレート名・本文')
    type(nameInput, '予約前日のご案内')
    await flush()
    expect(nameInput.getAttribute('aria-invalid')).toBeNull()
    expect(document.getElementById('te-name-error')).toBeNull()
    expect(document.getElementById('te-content-error')?.textContent).toBe('本文を入力してください。')
    expect(document.querySelector('[data-design-part="validation-summary"]')).toBeNull()
  })

  it('差し込む「名前」を押すと本文へ {{name}} が入り、数が増える', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '名前' }))
    await flush()
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('{{name}}')
    expect(screen.getByText('8 / 5,000')).toBeTruthy()
    expect(screen.getByText('文字数は差し込み記号を含みます。実際の文字数は受け取る人ごとに変わります。')).toBeTruthy()
  })

  it('読んだ版で保存し、成功後の版を次の保存に使う', async () => {
    templatesApi.update
      .mockResolvedValueOnce({ success: true, data: { id: 'template-1', publishedVersion: 3, draftRevision: 3 } })
      .mockResolvedValueOnce({ success: true, data: { id: 'template-1', publishedVersion: 3, draftRevision: 4 } })
    await mount('id=template-1')
    type(screen.getByLabelText('本文'), '最初の変更')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenNthCalledWith(1, 'template-1', expect.objectContaining({ expectedVersion: 3, expectedDraftRevision: 2 }))
    type(screen.getByLabelText('本文'), '次の変更')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenNthCalledWith(2, 'template-1', expect.objectContaining({ expectedVersion: 3, expectedDraftRevision: 3 }))
  })

  it('編集で保存が 409 なら、競合の帯（NCbYn）を出し、主ボタンは「比べてから保存」、比べると違いが出る', async () => {
    templatesApi.update.mockRejectedValue(new ApiError(409, '下書きが書き換わっています'))
    await mount('id=template-1')
    templatesApi.get.mockResolvedValue(detail({ name: '店舗のご案内', messageContent: '最新の本文' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    const band = document.querySelector('[data-design-node="NCbYn"][role="alert"]')
    expect(band?.textContent).toContain('テンプレート「店舗のご案内」を保存しました')
    expect(band?.textContent).toContain('14:02')
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '比べてから保存' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '違いを比べる' })) })
    await flush()
    expect(document.body.textContent).toContain('本文が違います')
    expect(document.body.textContent).toContain('テンプレート名が違います')
  })

  it('閲覧のみ（staff）では保存・公開・キャンセルを置かず、帯で知らせる。押せないボタンも置かない', async () => {
    role.value = verifiedStaffRole('staff')
    await mount('id=template-1')
    expect(screen.getByText(/閲覧のみ：テンプレートの作成・変更はオーナーと管理者だけができます/)).toBeTruthy()
    for (const name of ['下書きを保存', '保存して公開', 'キャンセル']) expect(screen.queryByRole('button', { name })).toBeNull()
    const disabled = [...document.querySelectorAll('button')].filter((b) => (b as HTMLButtonElement).disabled)
    expect(disabled).toEqual([])
  })
})

describe('V8 テンプレートの下書き自動保存（一斉配信と同じ形）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  const status = () => document.querySelector('[data-autosave-status]')?.textContent ?? null

  it('作る：入力が止まって2秒で1件だけ作り、続きは同じテンプレートへ上書きする。帯に「下書き保存済み・n秒前」', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto' } })
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-auto' } })
    await mount()
    type(screen.getByLabelText('テンプレート名'), '予約前日のご案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    expect(status()).toBe('下書きはまだ保存していません')
    await wait(1900)
    expect(templatesApi.create).not.toHaveBeenCalled()
    await wait(200)
    await flush()
    expect(templatesApi.create).toHaveBeenCalledTimes(1)
    expect(status()).toBe('下書き保存済み・0秒前')
    expect(push).not.toHaveBeenCalled()
    await wait(10_000)
    expect(status()).toBe('下書き保存済み・10秒前')

    type(screen.getByLabelText('本文'), 'こんにちは。明日です')
    await wait(2100)
    await flush()
    expect(templatesApi.create).toHaveBeenCalledTimes(1)
    expect(templatesApi.update).toHaveBeenCalledWith('template-auto', expect.objectContaining({ messageContent: 'こんにちは。明日です' }))

    // 手の「下書きを保存」も同じ行への上書き（2件目を作らない）。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.create).toHaveBeenCalledTimes(1)
  })

  it('自動で作った下書きは変更が保存済みでもキャンセル時に確認する', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto', publishedVersion: 0, draftRevision: 1 } })
    await mount()
    type(screen.getByLabelText('テンプレート名'), '案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(2100)
    await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    expect(screen.getByRole('button', { name: '下書きを残して移る' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下書きを消して移る' })).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })

  it('下書きを残す選択では削除せずに移る', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto', publishedVersion: 0, draftRevision: 1 } })
    await mount()
    type(screen.getByLabelText('テンプレート名'), '案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(2100); await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを残して移る' })) })
    await flush()
    expect(templatesApi.delete).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalled()
  })

  it('下書きを消すときは作成した版を指定する', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto', publishedVersion: 0, draftRevision: 1 } })
    templatesApi.delete.mockResolvedValue({ success: true, data: null })
    await mount()
    type(screen.getByLabelText('テンプレート名'), '案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(2100); await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを消して移る' })) })
    await flush()
    expect(templatesApi.delete).toHaveBeenCalledWith('template-auto', 1)
    expect(push).toHaveBeenCalled()
  })

  it('削除結果が不明なら一覧で確認する操作を案内する', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto', publishedVersion: 0, draftRevision: 1 } })
    templatesApi.delete.mockRejectedValue(new Error('通信断'))
    await mount()
    type(screen.getByLabelText('テンプレート名'), '案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(2100); await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを消して移る' })) })
    await flush()
    expect(screen.getByText(/削除結果を確認できません/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下書きを残して移る' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '一覧で確認する' })) })
    expect(push).toHaveBeenCalledWith('/templates')
  })

  it('下書きの版が変わったら消さずに理由を表示して移らない', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-auto', publishedVersion: 0, draftRevision: 1 } })
    templatesApi.delete.mockRejectedValue(new ApiError(409, '版が変わりました'))
    await mount()
    type(screen.getByLabelText('テンプレート名'), '案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(2100); await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを消して移る' })) })
    await flush()
    expect(screen.getByText(/下書きの状態が変わったため消せません/)).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })

  it('名前が空のうちは送らず、帯は「まだ保存していません」のまま', async () => {
    await mount()
    type(screen.getByLabelText('本文'), 'こんにちは')
    await wait(5000)
    expect(templatesApi.create).not.toHaveBeenCalled()
    expect(status()).toBe('下書きはまだ保存していません')
  })

  it('保存に失敗したら帯に出し、同じ入力では繰り返さない。「下書きを保存」で手で保存できる', async () => {
    templatesApi.update.mockResolvedValueOnce({ success: false, error: 'サーバが応えませんでした' })
    await mount('id=template-1')
    type(screen.getByLabelText('本文'), '直した本文')
    await wait(2100)
    await flush()
    expect(templatesApi.update).toHaveBeenCalledTimes(1)
    expect(status()).toContain('自動保存できませんでした')
    expect(screen.queryByRole('alert')).toBeNull()
    await wait(10_000)
    expect(templatesApi.update).toHaveBeenCalledTimes(1)
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenCalledTimes(2)
  })

  it('閲覧のみ（staff）は自動保存しない', async () => {
    role.value = verifiedStaffRole('staff')
    await mount('id=template-1')
    await wait(5000)
    expect(templatesApi.update).not.toHaveBeenCalled()
    expect(status()).toBeNull()
  })
})

describe('V8 クーポン・リサーチを作る', () => {
  it('新規の種類は表示なしで、割引を選ぶと金額を入力できる', async () => {
    await mount('kind=coupon')
    expect(screen.getByLabelText('クーポンタイプ').textContent).toContain('種類の表示なし')
    expect(screen.queryByLabelText('割引額')).toBeNull()
    fireEvent.click(screen.getByLabelText('クーポンタイプ'))
    fireEvent.click(screen.getByRole('button', { name: '割引', exact: true }))
    expect(screen.getByLabelText('割引額')).toBeTruthy()
  })
  it('クーポン：期間が無ければ保存の口を呼ばない', async () => {
    await mount('kind=coupon')
    expect(document.querySelector('[data-design-node="S6FEuB"]')).toBeTruthy()
    type(screen.getByLabelText('テンプレート名'), '夏の20%オフ')
    type(screen.getByLabelText('クーポン名'), '夏の20%オフ')
    fireEvent.click(screen.getByLabelText('クーポンタイプ'))
    fireEvent.click(screen.getByRole('button', { name: '割引', exact: true }))
    type(screen.getByLabelText('割引額'), '500')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(assetsCreate).not.toHaveBeenCalled()
    /* ：帯ではなく、開始・終了の欄の真下に理由を出し、開始の欄へ移る。 */
    expect(document.getElementById('te-coupon-start-error')?.textContent).toBe('開始を入力してください')
    expect(document.getElementById('te-coupon-end-error')?.textContent).toBe('終了を入力してください')
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(document.getElementById('te-coupon-start')?.contains(document.activeElement) || document.activeElement?.id === 'te-coupon-start').toBe(true)
  })

  it('クーポン：見本の中身を保存した版で実際に公開する', async () => {
    assetsCreate.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 0, draftRevision: 1 } })
    await mount('kind=coupon&visual=1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    await flush()
    expect(assetsCreate).toHaveBeenCalledWith(expect.objectContaining({
      lineAccountId: 'account-a',
      folderId: null,
      kind: 'coupon',
      name: '夏の20%オフ',
      payload: expect.objectContaining({ title: '夏の20%オフ', startsAt: '2026-08-01T00:00', endsAt: '2026-08-31T23:59', oncePerFriend: true, folder: '', description: expect.any(String), instructions: expect.any(String), couponType: 'discount', discount: { mode: 'percent', percent: 20 } }),
    }))
    expect(assetsCreate.mock.calls[0][0].payload.description).toBe(assetsCreate.mock.calls[0][0].payload.instructions)
    expect(assetsPublish).toHaveBeenCalledWith('asset-1', { expectedVersion: 0, expectedDraftRevision: 1 }, expect.any(String))
    expect(push).toHaveBeenCalledWith('/templates?highlight=asset-1')
  })

  it('リサーチ：質問を足す・消すと問の数が変わり、選択肢の無い質問は保存を断る', async () => {
    await mount('kind=research')
    expect(document.querySelector('[data-design-node="EsYo4"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /質問を足す/ }))
    await flush()
    expect(screen.getByRole('region', { name: '問 2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '問 2 を消す' }))
    await flush()
    expect(screen.queryByRole('region', { name: '問 2' })).toBeNull()
    type(screen.getByLabelText('テンプレート名'), '満足度')
    type(screen.getByLabelText('質問文'), '続けますか？')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(assetsCreate).not.toHaveBeenCalled()
    /* ：選択肢の欄の真下に理由を出し、選択肢の1つ目へ移る。 */
    const choices = screen.getByRole('group', { name: '問 1 の選択肢' })
    expect(choices.nextElementSibling?.textContent).toBe('選択肢を1つ以上入力してください')
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(document.activeElement).toBe(screen.getByLabelText('問 1 の選択肢 1'))
  })

  it('リサーチ：質問の並べ替えは、つまみのドラッグ・上下キー・押して出る「上へ／下へ」で同じ結果になる', async () => {
    const texts = () => screen.getAllByLabelText('質問文').map((el) => (el as HTMLInputElement).value)
    const results: string[][] = []
    for (const how of ['drag', 'key', 'menu'] as const) {
      act(() => root.unmount())
      root = createRoot(host)
      await mount('kind=research')
      // 質問が1つのときは、つまみを出さず理由を言う。
      expect(screen.queryByRole('button', { name: /問 1 の並びを変える/ })).toBeNull()
      expect(document.querySelector('[data-reorder-disabled]')?.getAttribute('title')).toBe('質問が1つのときは並び替えできません')
      fireEvent.click(screen.getByRole('button', { name: /質問を足す/ }))
      await flush()
      type(screen.getAllByLabelText('質問文')[0], '一問目')
      type(screen.getAllByLabelText('質問文')[1], '二問目')
      const grip = screen.getByRole('button', { name: /問 1 の並びを変える/ })
      if (how === 'key') fireEvent.keyDown(grip, { key: 'ArrowDown' })
      if (how === 'menu') {
        fireEvent.click(grip)
        fireEvent.click(screen.getByRole('menuitem', { name: /^下へ/ }))
      }
      if (how === 'drag') {
        const target = screen.getByRole('region', { name: '問 2' })
        fireEvent.dragStart(grip)
        fireEvent.dragEnter(target)
        fireEvent.dragOver(target)
        fireEvent.drop(target)
      }
      await flush()
      results.push(texts())
    }
    expect(results).toEqual([['二問目', '一問目'], ['二問目', '一問目'], ['二問目', '一問目']])
  })
})

it('畳んだ右欄は共通の窓で見え方を読め、保存せずに閉じられる', async () => {
  await mount()
  expect(host.querySelector('[data-template-region="preview"]')?.getAttribute('data-preview-narrow')).toBe('hidden')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINEの見え方を確認' })) })
  expect(screen.getByRole('dialog', { name: 'LINEの見え方' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '閉じる' })) })
  expect(screen.queryByRole('dialog', { name: 'LINEの見え方' })).toBeNull()
  expect(templatesApi.create).not.toHaveBeenCalled()
  expect(templatesApi.update).not.toHaveBeenCalled()
})

it('リサーチ（EsYo4）：選択肢は札の並び。札を押すとその選択肢の「行うこと」が出て、届き方はお客さまが答える画面', async () => {
  await mount('kind=research&visual=1')
  // 問1 は「止めたい」に点数が入っているので、その行うことが出ている。
  const q1 = screen.getByRole('region', { name: '問 1' })
  expect(q1.textContent).toContain('選択肢「止めたい」が選ばれたら')
  expect(q1.textContent).toContain('スコアを足す')
  expect(within(q1).getByRole('switch', { name: '問 1 を必ず答えてもらう' }).getAttribute('aria-checked')).toBe('true')
  // 問2 は押すまで出さない。札を押すと出る。
  const q2 = screen.getByRole('region', { name: '問 2' })
  expect(q2.textContent).not.toContain('が選ばれたら')
  await act(async () => { fireEvent.focus(within(q2).getByLabelText('問 2 の選択肢 2')) })
  expect(q2.textContent).toContain('選択肢「おやつ」が選ばれたら')
  expect(within(q2).getByRole('button', { name: /行うことを足す/ })).toBeTruthy()
  // 届き方：LINE のトークではなく、答える画面（回答フォームの LIFF と同じ形）。
  const preview = host.querySelector('[data-liff-phone-frame]')
  expect(preview?.textContent).toContain('来月も定期便を続けたいと思いますか？')
  expect(preview?.textContent).toContain('答えを送る')
})

describe('V8 メッセージを作る：フォルダ・読み込めないとき・本文の見え方', () => {
  it('フォルダを選んで保存すると、選んだフォルダの番号を送る', async () => {
    templatesApi.create.mockResolvedValue({ success: true, data: { id: 'template-new' } })
    await mount()
    expect(listFolders).toHaveBeenCalledWith('template', 'account-a')
    type(screen.getByLabelText('テンプレート名'), '予約前日のご案内')
    type(screen.getByLabelText('本文'), 'こんにちは')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ' })) })
    const option = await screen.findByRole('option', { name: /予約/ })
    await act(async () => { fireEvent.click(within(option).getByRole('button')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.create).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'fol-1' }))
  })

  it('既存のテンプレートを読み込めないときは理由を出し、保存の口を押せない形にする', async () => {
    templatesApi.get.mockRejectedValue(new Error('network'))
    await mount('id=template-1')
    expect(document.body.textContent).toContain('読み込めませんでした。開き直してください。')
    for (const name of ['下書きを保存', '保存して公開']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(templatesApi.update).not.toHaveBeenCalled()
  })

  it('本文のURLを並べ、差し込みは見本の名前で見せ、値を確かめられない差し込みは知らせる', async () => {
    await mount()
    const hint = screen.getByText('URLを入れると、リンクごとの設定がここに出ます。')
    expect(hint.closest('[data-design-part="card"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: '本文の中のURL' })).toBeNull()
    type(screen.getByLabelText('本文'), '{{name}}さん、ご予約はこちら https://example.com/booking {{field.unknown_key}}')
    await flush()
    const tracking = screen.getByRole('switch', { name: 'https://example.com/bookingを短縮して数える（いつもオン）' }) as HTMLButtonElement
    expect(tracking.getAttribute('aria-checked')).toBe('true')
    expect(tracking.disabled).toBe(true)
    expect(tracking.parentElement?.textContent).toContain('短縮して数える（いつもオン・変更できません）')
    const preview = host.querySelector('[data-template-region="preview"]')!
    expect(preview.textContent).toContain('見本 141さん、ご予約はこちら')
    expect(preview.textContent).toContain('値を確認できない差し込みがあります：{{field.unknown_key}}')
  })
})

describe('本文URLの案内と下書き', () => {
  const hintText = 'URLを入れると、リンクごとの設定がここに出ます。'
  const url = 'https://example.com/booking'

  it('URLの追加・重複・削除で名前と本文を保ち、最後の本文だけを保存する', async () => {
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1' } })
    await mount('id=template-1')
    type(screen.getByLabelText('テンプレート名'), 'URLを確認した下書き')
    const content = screen.getByLabelText('本文')
    const withUrl = `ご予約はこちら ${url} 同じ案内 ${url}`
    type(content, withUrl)
    await flush()
    expect(screen.queryByText(hintText)).toBeNull()
    const heading = screen.getByRole('heading', { name: '本文の中のURL' })
    expect(heading.closest('[data-design-part="card"]')).toBeTruthy()
    const checks = screen.getAllByRole('switch', { name: `${url}を短縮して数える（いつもオン）` }) as HTMLButtonElement[]
    expect(checks).toHaveLength(1)
    expect(checks[0].getAttribute('aria-checked')).toBe('true')
    expect(checks[0].disabled).toBe(true)
    expect(screen.getAllByText('短縮して数える（いつもオン・変更できません）')).toHaveLength(1)
    expect((content as HTMLTextAreaElement).value).toBe(withUrl)
    type(content, 'URLを外してもご予約の本文は残ります。')
    await flush()
    expect(screen.getByText(hintText).closest('[data-design-part="card"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: '本文の中のURL' })).toBeNull()
    expect(screen.queryByText('短縮して数える（いつもオン・変更できません）')).toBeNull()
    expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('URLを確認した下書き')
    expect(templatesApi.update).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenCalledTimes(1)
    expect(templatesApi.update).toHaveBeenCalledWith('template-1', expect.objectContaining({ name: 'URLを確認した下書き', messageType: 'text', messageContent: 'URLを外してもご予約の本文は残ります。', folderId: null, expectedVersion: 3, expectedDraftRevision: 2 }))
    expect(templatesApi.create).not.toHaveBeenCalled()
    expect(templatesApi.publish).not.toHaveBeenCalled()
  })

  it('URLの固定設定を押しても本文を変えず、短縮前の文字列をそのまま保存する', async () => {
    const messageContent = `ご予約はこちら ${url}?from=message&day=1`
    templatesApi.get.mockResolvedValue(detail({ messageContent }))
    templatesApi.update.mockResolvedValue({ success: true, data: { id: 'template-1' } })
    await mount('id=template-1')
    const tracking = screen.getByRole('switch', { name: `${url}?from=message&day=1を短縮して数える（いつもオン）` }) as HTMLButtonElement
    expect(tracking.disabled).toBe(true)
    expect(tracking.getAttribute('aria-checked')).toBe('true')
    expect(tracking.parentElement?.textContent).toContain('短縮して数える（いつもオン・変更できません）')
    fireEvent.click(tracking)
    expect(templatesApi.update).not.toHaveBeenCalled()
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe(messageContent)
    type(screen.getByLabelText('テンプレート名'), 'URLを保つ下書き')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await flush()
    expect(templatesApi.update).toHaveBeenCalledExactlyOnceWith('template-1', { name: 'URLを保つ下書き', category: 'general', folderId: null, messageType: 'text', messageContent, expectedVersion: 3, expectedDraftRevision: 2 })
    expect(templatesApi.publish).not.toHaveBeenCalled()
  })

  it('親の保存口でもURL案内だけが切り替わり、店舗APIを呼ばない', async () => {
    const save = vi.fn()
    const parent: TemplateEditHost = { description: '統括のひな形', folders: [], folder: '', onFolderChange: vi.fn(), busy: false, onSave: save, onCancel: vi.fn(), primaryLabel: '親へ保存', initialMessage: { name: '親の下書き', messageType: 'text', messageContent: '元の本文' } }
    await act(async () => { root.render(<TemplateMessageEditor id={null} visual={false} host={parent} />) })
    await flush()
    expect(screen.getByText(hintText).closest('[data-design-part="card"]')).toBeNull()
    type(screen.getByLabelText('本文'), `元の本文 ${url}`)
    await flush()
    expect(screen.getByRole('heading', { name: '本文の中のURL' })).toBeTruthy()
    const check = screen.getByRole('switch', { name: `${url}を短縮して数える（いつもオン）` }) as HTMLButtonElement
    expect(check.getAttribute('aria-checked') === 'true' && check.disabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '親へ保存' })) })
    expect(save).toHaveBeenCalledExactlyOnceWith({ kind: 'message', name: '親の下書き', messageType: 'text', messageContent: `元の本文 ${url}` }, true)
    expect(templatesApi.create).not.toHaveBeenCalled()
    expect(templatesApi.update).not.toHaveBeenCalled()
    expect(templatesApi.publish).not.toHaveBeenCalled()
  })
})

describe('V8 テンプレートの公開と送信の違い', () => {
  const note = '公開しても、この操作では友だちに送信しません'

  it('［保存して公開］の手前に、友だちへ送信しない一言を出す', async () => {
    await mount('id=template-1')
    expect(screen.getByRole('button', { name: '保存して公開' })).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('素材（クーポン）でも注記を出す', async () => {
    await mount('kind=coupon&visual=1')
    expect(screen.getByRole('button', { name: '保存して公開' })).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('リッチメッセージでも注記を出す', async () => {
    await mount('kind=rich_message&visual=1')
    expect(screen.queryByText('配信日 10:00')).toBeNull()
    expect(screen.getByText('今日')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存して公開' })).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('組み込み（host）では出さない', async () => {
    const parent: TemplateEditHost = { description: '統括のひな形', folders: [], folder: '', onFolderChange: vi.fn(), busy: false, onSave: vi.fn(), onCancel: vi.fn(), primaryLabel: '親へ保存', initialMessage: { name: '親の下書き', messageType: 'text', messageContent: '元の本文' } }
    await act(async () => { root.render(<TemplateMessageEditor id={null} visual={false} host={parent} />) })
    await flush()
    expect(screen.queryByText(note)).toBeNull()
  })
})

describe('V8 クーポン・リサーチ：保存のあと', () => {
  it('クーポンは「使われたときに行うこと」、リサーチは「回答フォームとの使い分け」を同じ画面で読める', async () => {
    await mount('kind=coupon&visual=1')
    expect(screen.getByRole('heading', { name: 'クーポンを使ったときに行うこと' })).toBeTruthy()
    act(() => root.unmount())
    root = createRoot(host)
    await mount('kind=research&visual=1')
    expect(screen.getByRole('heading', { name: '回答フォームとの使い分け' })).toBeTruthy()
  })

  it('保存できたら「下書きを保存しました」と知らせ、押しても二度は作らない', async () => {
    let finish!: (value: unknown) => void
    assetsCreate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    clearToastsForTest()
    const toastHost = document.createElement('div')
    document.body.appendChild(toastHost)
    const toastRoot = createRoot(toastHost)
    await act(async () => { toastRoot.render(<ToastHost />) })
    try {
      await mount('kind=coupon&visual=1')
      const draft = screen.getByRole('button', { name: '下書きを保存' })
      await act(async () => { fireEvent.click(draft) })
      await act(async () => { fireEvent.click(draft) })
      expect((draft as HTMLButtonElement).disabled).toBe(true)
      expect(assetsCreate).toHaveBeenCalledTimes(1)
      await act(async () => { finish({ success: true, data: { id: 'asset-1' } }) })
      await flush()
      expect(toastHost.textContent).toContain('下書きを保存しました')
      expect(assetsPublish).not.toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith('/templates?highlight=asset-1')
      expect(assetsCreate).toHaveBeenCalledTimes(1)
    } finally {
      act(() => toastRoot.unmount())
      toastHost.remove()
      clearToastsForTest()
    }
  })
})

afterEach(() => { verifiedStaffRole(null) })


describe('クーポンの同じ編集画面と公開の失敗', () => {
  const payload = { title: '昔の券', description: '元の説明', instructions: '元のガイド', startsAt: '2026-01-01T00:00', endsAt: '2027-01-01T00:00', maxUsesPerFriend: 3, oncePerFriend: true, visibility: 'link', imageUrl: 'https://example.com/old.png', imageMediaId: 'media-old', imageMediaKind: 'image', useActions: [{ type: 'tag_add', tagId: 'tag-old', unknown: '保持' }], legacyNote: '保持', folder: '旧名' }
  const asset = { id: 'coupon-old', lineAccountId: 'account-a', kind: 'coupon', name: '昔の管理名', payload, folderId: 'asset-folder-1', publishedVersion: 2, draftRevision: 0 }
  it('一覧からの編集も同じ画面で、旧回数・処理・画像・未知の値を失わず保存する', async () => {
    assetsList.mockResolvedValue({ success: true, data: [asset] })
    assetsUpdate.mockResolvedValue({ success: true, data: { ...asset, draftRevision: 1 } })
    await mount('kind=coupon&id=coupon-old')
    expect(screen.getByRole('heading', { name: 'クーポンを編集する' })).toBeTruthy()
    expect((screen.getByLabelText('使うときの説明') as HTMLTextAreaElement).value).toBe('元のガイド')
    expect(screen.getByRole('button', { name: '1人3回' })).toBeTruthy()
    type(screen.getByLabelText('テンプレート名'), '管理名だけ変更')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    expect(assetsUpdate).toHaveBeenCalledWith('coupon-old', expect.objectContaining({ folderId: 'asset-folder-1', payload: expect.objectContaining(payload) }))
    expect(assetsUpdate.mock.calls[0][1].payload).not.toHaveProperty('couponType')
    expect(assetsCreate).not.toHaveBeenCalled(); expect(assetsPublish).not.toHaveBeenCalled()
  })
  it('利用ガイドを編集して公開するとLIFF互換の説明にも同じ本文を保存する', async () => {
    assetsList.mockResolvedValue({ success: true, data: [asset] })
    assetsUpdate.mockResolvedValue({ success: true, data: { ...asset, draftRevision: 1 } })
    await mount('kind=coupon&id=coupon-old')
    type(screen.getByLabelText('使うときの説明'), '3,000円以上で利用可')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    expect(assetsUpdate).toHaveBeenCalledWith('coupon-old', expect.objectContaining({payload:expect.objectContaining({description:'3,000円以上で利用可',instructions:'3,000円以上で利用可',maxUsesPerFriend:3,legacyNote:'保持'})}))
    expect(assetsPublish).toHaveBeenCalledWith('coupon-old', {expectedVersion:2,expectedDraftRevision:1}, expect.any(String))
  })
  it('新規の受け取れる人は文字だけで、抽選が無い数の行は出さない', async () => {
    await mount('kind=coupon&visual=1')
    expect(screen.getByText('友だちだけ')).toBeTruthy()
    expect(screen.queryByRole('button',{name:'友だちだけ'})).toBeNull()
    expect(screen.queryByText('当選した数')).toBeNull()
    expect(screen.getByRole('button',{name:'タグ・スコアを足す'}).closest('[data-design-part="card"]')).toBeTruthy()
  })
  it('金額2欄の誤りは行の下の1つにまとめ、両方の入力へ説明を結ぶ', async () => {
    assetsList.mockResolvedValue({success:true,data:[{...asset,payload:{...payload,couponType:'discount',discount:{mode:'price',beforeYen:1000,afterYen:500}}}]})
    await mount('kind=coupon&id=coupon-old')
    const before=screen.getByLabelText('割引前の金額'),after=screen.getByLabelText('割引後の金額')
    type(before,'0');await act(async()=>{fireEvent.blur(before)})
    const error=document.getElementById('coupon-benefit-error')!
    expect(error.textContent).toContain('割引前より低い')
    expect(error.closest('[data-form-row]')).toBeNull()
    for(const input of [before,after]){expect(input.getAttribute('aria-invalid')).toBe('true');expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)}
    type(before,'1000');expect(document.getElementById('coupon-benefit-error')).toBeNull()
    expect(assetsUpdate).not.toHaveBeenCalled()
  })
  it('使用記録時の2種類の処理を同じカードに置き、追加入口は枠付きでそろえる', async()=>{
    await mount('kind=coupon&visual=1')
    const card=screen.getByRole('heading',{name:'クーポンを使ったときに行うこと'}).closest('[data-design-part="card"]')!
    const add=within(card as HTMLElement).getByRole('button',{name:'タグ・スコアを足す'})
    expect(add.getAttribute('data-variant')).toBe('secondary')
    expect(within(card as HTMLElement).getByRole('button',{name:'行うことを足す'}).getAttribute('data-variant')).toBe('secondary')
    expect(screen.queryByRole('heading',{name:'ボタンを押されたときに行うこと'})).toBeNull()
  })
  it('公開409は下書きを作り直さず同じ確認キーで再試行し、成功前に一覧へ移らない', async () => {
    assetsCreate.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 0, draftRevision: 1 } })
    assetsPublish.mockRejectedValueOnce(new ApiError(409, '別の人が変更しました'))
    await mount('kind=coupon&visual=1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    expect(push).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('別の人が変更しました')
    const first = assetsPublish.mock.calls[0]
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
    expect(assetsCreate).toHaveBeenCalledTimes(1)
    expect(assetsPublish.mock.calls[1]).toEqual(first)
    expect(push).toHaveBeenCalledWith('/templates?highlight=asset-1')
  })
  it('閲覧のみでは欄と公開操作を残して灰色にし、保存の口を呼ばない', async () => {
    role.value = verifiedStaffRole('viewer')
    await mount('kind=coupon&visual=1')
    expect(screen.getByLabelText('クーポン名')).toBeTruthy()
    expect((screen.getByLabelText('クーポン名').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    for (const label of ['下書きを保存', '保存して公開']) {
      const button = screen.getByRole('button', { name: label })
      expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true)
      await act(async () => { fireEvent.click(button) })
    }
    expect(assetsCreate).not.toHaveBeenCalled(); expect(assetsPublish).not.toHaveBeenCalled()
  })
  it('閲覧のみの画像操作は灰色の理由付きで残り、欄は拒否したまま画像を変えない', async () => {
    role.value = verifiedStaffRole('viewer')
    assetsList.mockResolvedValue({success:true,data:[{...asset,payload:{...payload,couponType:'discount',discount:{mode:'price',beforeYen:1000,afterYen:500}}}]})
    await mount('kind=coupon&id=coupon-old')
    for(const name of ['差し替える','消す','URL で入れる','登録メディアから選ぶ']){
      const button=screen.getByRole('button',{name}) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      expect(button.closest('fieldset[disabled]')).toBeNull()
      expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.focus(button)
      expect(screen.getAllByRole('tooltip').at(-1)?.textContent).toContain('閲覧のみ')
      fireEvent.click(button);fireEvent.keyDown(button,{key:'Enter'});fireEvent.keyDown(button,{key:' '});fireEvent.blur(button)
    }
    expect((screen.getByLabelText('クーポン名').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect((screen.getByLabelText('割引前の金額').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect(screen.queryByLabelText('クーポン画像のURL')).toBeNull()
    expect(screen.getByAltText('クーポンの画像').getAttribute('src')).toBe('https://example.com/old.png')
    expect(assetsUpdate).not.toHaveBeenCalled();expect(assetsCreate).not.toHaveBeenCalled();expect(assetsPublish).not.toHaveBeenCalled()
  })
  it('統括の親へ保存する時も旧payloadを保ち、店の保存口やフォルダを呼ばない', async () => {
    const save = vi.fn().mockResolvedValue(false)
    const parent: TemplateEditHost = { description: '統括の見本', folders: [], folder: '', onFolderChange: vi.fn(), busy: false, onSave: save, onCancel: vi.fn(), initialContent: { kind: 'coupon', name: '親の券', payload } }
    await act(async () => { root.render(<TemplateAssetEditor kind="coupon" host={parent} />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'coupon', payload: expect.objectContaining(payload) }), true)
    expect(assetFoldersList).not.toHaveBeenCalled(); expect(assetsCreate).not.toHaveBeenCalled(); expect(assetsUpdate).not.toHaveBeenCalled()
  })
})

it.each(['', 'kind=coupon', 'kind=research'])('必須が空の主保存は押せず、下書きの欄検証の入口は保つ: %s', async query => {
  await mount(query);
  const save = screen.getByRole('button', { name: '保存して公開' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '下書きを保存' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByText('テンプレート名を入力してください。')).toBeTruthy();
  fireEvent.click(save);await flush();expect(templatesApi.create).not.toHaveBeenCalled();expect(assetsCreate).not.toHaveBeenCalled();
})

it.each(['rich_message', 'research'])('%s の「保存して公開」は下書き作成後にその版を公開する', async kind => {
  assetsCreate.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 0, draftRevision: 1 } })
  await mount(`kind=${kind}&visual=1`)
  if (kind === 'rich_message') type(screen.getByLabelText('画像のURL'), 'https://example.invalid/synthetic.png')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  await flush()
  expect(assetsCreate).toHaveBeenCalledOnce()
  expect(assetsPublish).toHaveBeenCalledWith('asset-1', { expectedVersion: 0, expectedDraftRevision: 1 }, expect.any(String))
  expect(push).toHaveBeenCalledWith('/templates?highlight=asset-1')
})

it.each(['rich_message', 'research'])('%s の公開失敗後は同じ下書きと受付番号で再試行する', async kind => {
  assetsCreate.mockResolvedValue({ success: true, data: { id: 'asset-1', publishedVersion: 0, draftRevision: 1 } })
  assetsPublish.mockRejectedValueOnce(new Error('通信できませんでした'))
  await mount(`kind=${kind}&visual=1`)
  if (kind === 'rich_message') type(screen.getByLabelText('画像のURL'), 'https://example.invalid/synthetic.png')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  await flush()
  expect(assetsCreate).toHaveBeenCalledOnce()
  expect(assetsPublish).toHaveBeenCalledOnce()
  expect(push).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  await flush()
  expect(assetsCreate).toHaveBeenCalledOnce()
  expect(assetsPublish).toHaveBeenCalledTimes(2)
  expect(assetsPublish.mock.calls[1]).toEqual(assetsPublish.mock.calls[0])
  expect(push).toHaveBeenCalledWith('/templates?highlight=asset-1')
})

it('利用中メッセージは確認後に版が変わっても確認時の版で公開する', async () => {
  const usedBy = { autoReplies: [], automations: [], scenarioSteps: [{ stepId:'s', scenarioId:'scenario', scenarioName:'ご案内', stepOrder:1 }], reminderSteps: [], richMenuAreas: [], trackedLinks: [] }
  templatesApi.get.mockReset().mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail({ publishedVersion:3, draftRevision:3, usedBy })).mockResolvedValue(detail({ publishedVersion:4, draftRevision:5, usedBy }))
  templatesApi.update.mockResolvedValue({ success:true, data:{ id:'template-1', publishedVersion:3, draftRevision:3 } })
  templatesApi.publish.mockResolvedValue({ success:true, data:{} })
  await mount('id=template-1')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name:'保存して公開' })) })
  await flush()
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name:'この内容を公開しますか？' })).getByRole('button',{name:'公開する'})) })
  expect(templatesApi.publish).toHaveBeenCalledWith('template-1',{expectedVersion:3,expectedDraftRevision:3})
})

it('メッセージ公開の窓を閉じた後は古い確定から公開しない', async () => {
  templatesApi.get.mockResolvedValue(detail({ usedBy:{ autoReplies:[], automations:[], scenarioSteps:[{ stepId:'s', scenarioId:'scenario', scenarioName:'ご案内', stepOrder:1 }], reminderSteps:[], richMenuAreas:[], trackedLinks:[] } }))
  templatesApi.update.mockResolvedValue({ success:true, data:{ id:'template-1', publishedVersion:3, draftRevision:3 } })
  await mount('id=template-1')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name:'保存して公開' })) })
  await flush()
  const dialog = within(screen.getByRole('dialog',{name:'この内容を公開しますか？'}))
  const button = dialog.getByRole('button',{name:'公開する'})
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
  await act(async () => { fireEvent.click(dialog.getByRole('button',{name:'キャンセル'})) })
  await act(async () => { await held({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(templatesApi.publish).not.toHaveBeenCalled()
})
