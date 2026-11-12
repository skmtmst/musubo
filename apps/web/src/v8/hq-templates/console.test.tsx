import { getPageAction, findPageAction } from '@/test-utils/page-action'
import { findPickerDialog, pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
/*
 * 統括のテンプレート（・）：作るは店のテンプレートの作る画面（メッセージ ・クーポン ）を使い、
 * 下の帯の主ボタンは［保存する］。保存は統括の口（ひな形）へ、配るは「アカウントへ配る」へ進む。
 * 詳細は「配った先」（API-14 の配った先のアカウント名）と［配る］（読み上げは「〇〇を配る」）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => Object.fromEntries(['context', 'list', 'listByKind', 'kindCounts', 'accounts', 'get', 'create', 'update', 'remove', 'duplicate', 'preflight', 'distribute', 'result', 'messageReferences', 'folderList', 'deleteImage', 'uploadRichMessageImage', 'uploadImage', 'listStats', 'versions', 'receivedVersions', 'compareVersions', 'restoreVersion'].map((key) => [key, vi.fn()])))
const access = vi.hoisted(() => ({ canEdit: true }))
const push = vi.hoisted(() => vi.fn())
const selectAccount = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    lineAccounts: { ...actual.api.lineAccounts, list: vi.fn(async () => ({ success: true, data: [
      { id: 'a-1', name: '然 -NEN- 本店', folderId: 'direct' }, { id: 'a-2', name: '然 -NEN- 渋谷店', folderId: 'direct' },
    ] })) },
    lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [{ id: 'direct', name: '直営店', color: '#2563eb', displayOrder: 0 }] } })) },
  } }
})
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), TEMPLATE_TYPES: ['tag', 'template', 'rich_menu', 'form', 'scenario'], hqTemplatesApi: { ...calls, folders: { list: calls.folderList } } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/templates',
}))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => access.canEdit, useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, selectedAccount: null, setSelectedAccountId: selectAccount, loading: false }) }))
const chrome = vi.hoisted(() => ({ crumbs: null as Array<{ label: string; href?: string; onSelect?: () => void }> | null }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: (crumbs: typeof chrome.crumbs) => { chrome.crumbs = crumbs } }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], scenarios: [], templates: [], forms: [], reminders: [], richMenus: [] }) }))

import HqTemplatesV8 from './console'
import { folderDisplayColor } from '@/components/shared/folder-dot'

const message = {
  schemaVersion: 1,
  template: { id: 'hq-authored-message', name: '予約前日のご案内', category: 'general', messageType: 'text', messageContent: '{{name}}さん、明日のご予約です', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' },
  media: [],
}
const detail = (definition: unknown = message) => ({ template: { id: 't-1', name: '予約前日のご案内', description: '', template_type: 'template', folder_id: null, revision: 3, updated_at: '2026-08-21T09:02:00Z' }, definition })
const listRow = { ...detail().template, kind: 'message', content_summary: '本文', distributed_account_count: 4, distributed_account_names: ['然 -NEN- 本店', '然 -NEN- 渋谷店', '2025年イベント'], distributed_account_more: 1 }

beforeEach(() => {
  access.canEdit = true
  Object.values(calls).forEach((mock) => mock.mockReset())
  window.history.replaceState(null, '', '/hq/templates')
  window.sessionStorage.clear()
  calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
  calls.list.mockResolvedValue([listRow])
  calls.listByKind.mockResolvedValue([listRow])
  calls.kindCounts.mockResolvedValue({ message: 1, carousel: 0, rich_message: 0, question: 0, coupon: 0, research: 0 })
  calls.accounts.mockResolvedValue([{ id: 'a-1', name: '然 -NEN- 本店' }, { id: 'a-2', name: '然 -NEN- 渋谷店' }])
  calls.folderList.mockResolvedValue([{ id: 'f-1', name: '予約', revision: 1 }])
  calls.messageReferences.mockResolvedValue([])
  calls.listStats.mockResolvedValue({ thisMonthSentCount: 0, outdatedTemplateCount: 0 })
  calls.versions.mockResolvedValue([])
  calls.receivedVersions.mockResolvedValue([])
  calls.get.mockResolvedValue(detail())
  calls.create.mockImplementation(async (input: { name: string; definition: unknown }) => ({ template: { ...detail().template, id: 't-new', name: input.name }, definition: input.definition }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('統括のテンプレートを作る（店の作る画面＋保存後に配り先を選ぶ）', () => {
  it('リッチビデオの種類から店と同じ編集部品を統括で開ける', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /リッチビデオ/ }))
    await waitFor(() => expect(calls.listByKind).toHaveBeenCalledWith('rich_video'))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    expect(await screen.findByRole('heading', { name: 'リッチビデオを作る' })).toBeTruthy()
    expect(getPageAction({ name: '下書きを保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy()
    expect(screen.getByLabelText('テンプレート名')).toBeTruthy()
    expect(calls.create).not.toHaveBeenCalled()
  })

  it('作る画面から一覧へは、上の帯のパンくず「テンプレート」で戻る（同じ URL のまま段を替える）', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    fireEvent.click(await screen.findByRole('button', { name: "メッセージを作るの説明" }))
    expect(await screen.findByText('保存後に、配るアカウントを選べます。一覧の「…」からも配れます。')).toBeTruthy()
    const crumb = chrome.crumbs?.find((item) => item.label === 'テンプレート')
    expect(crumb?.href).toBe('/hq/templates')
    expect(crumb?.onSelect).toBeTypeOf('function')
    act(() => { crumb!.onSelect!() })
    await waitFor(() => expect(screen.queryByText('保存後に、配るアカウントを選べます。一覧の「…」からも配れます。')).toBeNull())
    expect((await screen.findAllByRole('button', { name: /テンプレートを作る/ })).length).toBeGreaterThan(0)
    // 一覧の段では、パンくずは「ホーム」だけ
    expect(chrome.crumbs?.some((item) => item.onSelect)).toBe(false)
  })
  it('作る画面を開くとURLにmode=createが付く（H-18）', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('mode')).toBe('create'))
  })
  it('?mode=createで開くと作る画面が直接開く（H-18）', async () => {
    window.history.replaceState(null, '', '/hq/templates?mode=create')
    render(<HqTemplatesV8 type="template" />)
    expect(await screen.findByRole('button', { name: '保存する' })).toBeTruthy()
    expect(screen.getByLabelText('テンプレート名')).toBeTruthy()
  })
  it('作る画面から一覧へは、下の帯の［キャンセル］でも戻る', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    fireEvent.click(await screen.findByRole('button', { name: "メッセージを作るの説明" }))
    expect(await screen.findByText('保存後に、配るアカウントを選べます。一覧の「…」からも配れます。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByText('保存後に、配るアカウントを選べます。一覧の「…」からも配れます。')).toBeNull())
    expect((await screen.findAllByRole('button', { name: /テンプレートを作る/ })).length).toBeGreaterThan(0)
  })
  it('メッセージは店の作る画面で作り、［保存する］で統括のひな形を作ってアカウントへ配るへ進む', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    fireEvent.click(await screen.findByRole('button', { name: "メッセージを作るの説明" }))
    expect(await screen.findByText('保存後に、配るアカウントを選べます。一覧の「…」からも配れます。')).toBeTruthy()
    // 板の頭の「← テンプレートへ」は無くした（2026-10-08）。一覧へは上の帯のパンくずで戻る。
    expect(screen.queryByText('← テンプレートへ')).toBeNull()
    expect(screen.queryByText('形')).toBeNull()
    expect(screen.queryByText(/この形は新しく作れません/)).toBeNull()
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '予約前日' } })
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '{{name}}さん、明日です' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    const [input, requestId] = calls.create.mock.calls[0]
    expect(requestId).toBeTruthy()
    expect(input).toMatchObject({ type: 'template', name: '予約前日', folderId: null })
    expect(input.definition.template).toMatchObject({ name: '予約前日', messageType: 'text', messageContent: '{{name}}さん、明日です' })
    /* 保存のあとは「アカウントへ配る」。 */
    expect(await screen.findByRole('checkbox', { name: /然 -NEN- 本店/ })).toBeTruthy()
  })

  it.each([
    ['flex', JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '元の本文' }] } }), JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '直した本文' }] } })],
    ['image', 'https://img.example/old.png', 'https://img.example/new.png'],
  ])('統括の既存%sも帯を出して元の形のまま保存できる', async (messageType, messageContent, next) => {
    calls.get.mockResolvedValue(detail({ ...message, template: { ...message.template, messageType, messageContent } }))
    calls.update.mockImplementation(async (_id: string, input: { definition: unknown }) => detail(input.definition))
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findByRole('link', { name: '予約前日のご案内' })).closest('tr')!)
    fireEvent.click(await screen.findByRole('button', { name: '編集する' }))
    expect(await screen.findByText('この形は新しく作れません。新しく作るときはカルーセル・リッチメッセージを使ってください。')).toBeTruthy()
    expect(screen.queryByText('形')).toBeNull()
    fireEvent.change(screen.getByLabelText('メッセージ内容'), { target: { value: next } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    expect(calls.update.mock.calls[0][1].definition.template).toMatchObject({ messageType, messageContent: next })
  })

  it('クーポンは店のクーポンを作る画面で作り、店と同じ形の payload を統括のひな形の素材にする（店のアカウントに結びつく欄は出さない）', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /クーポン/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    expect(await screen.findByRole('heading', { name: 'クーポンを作る' })).toBeTruthy()
    expect(screen.queryByText('使われたときに行うこと')).toBeNull()
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '冬の10%オフ' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    /* 期間が無いと口を呼ばない。 */
    await waitFor(() => expect(document.getElementById('te-coupon-start-error')?.textContent).toBe('開始を入力してください'))
    expect(calls.create).not.toHaveBeenCalled()
  })
})

describe('統括のテンプレートを作る（質問・カルーセル）', () => {
  it('質問は店の質問を作る画面で作り、質問の JSON を統括のひな形にする（押したときの動きは出さない）', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /質問/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    expect(await screen.findByRole('heading', { name: '質問を作る' })).toBeTruthy()
    expect(screen.queryByText('押されたら')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('例：継続の意思をうかがう'), { target: { value: '好みのコース' } })
    fireEvent.change(screen.getByLabelText(/^質問文/), { target: { value: 'どのコースが好きですか？' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    const definition = calls.create.mock.calls[0][0].definition
    expect(JSON.parse(definition.template.questionJson)).toMatchObject({ text: 'どのコースが好きですか？', tapMode: 'single' })
    expect(definition.asset).toBeUndefined()
  })

  it('カルーセルの画像は統括の口で受け取り、保存と後片付けの対象を正しく残す', async () => {
    const media = { id: 'image-1', kind: 'image', filename: 'card.png', mimeType: 'image/png', sizeBytes: 5, width: 1040, height: 1040, durationMs: null, r2Key: 'hq/card.png', publicUrl: 'https://img.test/card.png', versionId: 'v1', versionNo: 1, contentHash: 'hash' }
    calls.uploadImage.mockResolvedValue(media)
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /カルーセル/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    await screen.findByRole('heading', { name: 'カルーセルを作る' })
    fireEvent.change(screen.getByPlaceholderText('例：夏の定番5点'), { target: { value: '写真付きのご案内' } })
    fireEvent.change(screen.getByLabelText(/本文（/), { target: { value: '画像と本文' } })
    const file = new File(['image'], 'card.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('画像を追加（ファイル）'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByAltText('カードの画像').getAttribute('src')).toBe(media.publicUrl))
    expect(calls.uploadImage).toHaveBeenCalledWith(file, 'message')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    expect(calls.create.mock.calls[0][0].definition.media).toEqual([media])
    expect(JSON.parse(calls.create.mock.calls[0][0].definition.template.messageContent)[0].thumbnailImageUrl).toBe(media.publicUrl)
    await waitFor(() => expect(screen.queryByLabelText('画像を追加（ファイル）')).toBeNull())
    expect(calls.deleteImage).not.toHaveBeenCalledWith(media.r2Key)
  })

  it('カルーセルは店のカルーセルを作る画面で作り、ボタンは URL を開くだけ', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /カルーセル/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    expect(await screen.findByRole('heading', { name: 'カルーセルを作る' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('例：夏の定番5点'), { target: { value: '定期便のご案内' } })
    const save = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.getAttribute('aria-description')).toBe('カード 1 の本文を入力してください。')
    expect(screen.getAllByRole('status').some(status => status.textContent === 'カード 1 の本文を入力してください。')).toBe(true)
    fireEvent.click(save)
    expect(calls.create).not.toHaveBeenCalled()
    /* （オーナーの写真の指摘）：帯だけにせず、本文の欄を赤くして真下に理由を出し、そこへ移る。 */
    const body = document.getElementById('cr-text') as HTMLInputElement
    fireEvent.change(body, { target: { value: 'あ'.repeat(301) } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(body.getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById('cr-text-error')?.textContent).toBe('本文は120文字までです（いま301文字）')
    expect(screen.queryByText('すべてのカードに本文を入力してください')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(body))
    expect(calls.create).not.toHaveBeenCalled()
  })
})

describe('統括のテンプレートの詳細（pQ4fH）', () => {
  it('詳細の削除確認にも統括ひな形と環境を出す', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findByRole('link', { name: '予約前日のご案内' })).closest('tr')!)
    await screen.findByRole('heading', { name: '配った先' })
    fireEvent.click(screen.getByRole('button', { name: 'そのほかの操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '削除する' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('統括ひな形')).toBeTruthy()
    expect(within(confirm).getByText('環境')).toBeTruthy()
    expect(calls.remove).not.toHaveBeenCalled()
  })
  it('名前を押すと詳細。配った先のアカウント名と［このアカウントへ入る］・［配る］を出す', async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findByRole('link', { name: '予約前日のご案内' })).closest('tr')!)
    expect(await screen.findByRole('heading', { name: '配った先' })).toBeTruthy()
    const recipients = screen.getByRole('region', { name: '配った先' })
    const content = recipients.closest('[data-template-region="content"]')
    expect(content?.querySelector(':scope > section[aria-label="配った先"]')).toBe(recipients)
    expect(screen.getByText('4 アカウントに配りました。新しい版を配ると、4 アカウントのテンプレートが新しい版になります。')).toBeTruthy()
    expect(screen.getByText('ほか 1 アカウント')).toBeTruthy()
    const enter = screen.getAllByRole('button', { name: /このアカウントへ入る/ })
    expect(enter).toHaveLength(2)
    fireEvent.click(enter[0])
    expect(selectAccount).toHaveBeenCalledWith('a-1')
    expect(push).toHaveBeenCalledWith('/templates')
    const distribute = screen.getByRole('button', { name: '予約前日のご案内を配る' })
    expect(distribute.textContent?.trim()).toBe('配る')
    fireEvent.click(distribute)
    expect(await screen.findByRole('checkbox', { name: /然 -NEN- 渋谷店/ })).toBeTruthy()
  })
})

describe('統括のテンプレートの詳細の版（pQ4fH・API-18）', () => {
  it('配った先ごとの版と版の履歴を出し、前の版を比べる・この版に戻す', async () => {
    const version = (n: number, draft: boolean, current: boolean) => ({ id: `v${n}`, version: n, created_by: 's', creator_name: n === 2 ? 'Masato' : 'Demo Person', created_at: '2026-08-21T09:02:00Z', is_draft: draft, is_current: current })
    calls.versions.mockResolvedValue([version(3, true, true), version(2, false, false), version(1, false, false)])
    calls.receivedVersions.mockResolvedValue([
      { accountId: 'a-1', accountName: '然 -NEN- 本店', receivedAt: null, targetVersion: { version: 2, latestVersion: 3, status: 'older', label: '版2' } },
      { accountId: 'a-2', accountName: '然 -NEN- 渋谷店', receivedAt: null, targetVersion: { version: 3, latestVersion: 3, status: 'latest', label: '版3' } },
    ])
    calls.compareVersions.mockResolvedValue({ from: { version: version(1, false, false), definition: { schemaVersion: 1, template: { messageContent: '古い本文' } } }, to: { version: version(3, true, true), definition: { schemaVersion: 1, template: { messageContent: '新しい本文' } } }, changed: true })
    calls.restoreVersion.mockResolvedValue({ ...detail(), template: { ...detail().template, revision: 4 } })
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findByRole('link', { name: '予約前日のご案内' })).closest('tr')!)
    expect(await screen.findByText('版3（いまの版）')).toBeTruthy()
    expect(screen.getByText('新しい版を未配布')).toBeTruthy()
    expect(screen.getByText('配っていない変更があります')).toBeTruthy()
    expect(screen.getByText('下書き（まだ配っていない）')).toBeTruthy()
    expect(screen.getByText('いま使っている版')).toBeTruthy()
    const history = screen.getByRole('region', { name: '版の履歴' })
    fireEvent.click(within(history).getByRole('button', { name: '比べる' }))
    await waitFor(() => expect(calls.compareVersions).toHaveBeenCalledWith('t-1', 1, 3))
    expect(await screen.findByText('＋ 新しい本文')).toBeTruthy()
    fireEvent.click(within(history).getByRole('button', { name: /この版に戻す/ }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'この版に戻す' }))
    await waitFor(() => expect(calls.restoreVersion).toHaveBeenCalledWith('t-1', 1, 3))
  })
})

describe('統括の回答フォームの編集（u5MM7：店の回答フォームの編集画面＋配る口）', () => {
  const layout = {
    version: 2, header: [],
    sections: [{ id: 's-1', name: '来店について', blocks: [{ id: 'b-1', kind: 'input', type: 'radio', name: 'purpose', label: '今日のご来店の目的は？', required: true, choices: [{ id: 'c-1', label: 'トリミング' }] }] }],
    options: {},
  }
  const formDefinition = { schemaVersion: 1, form: { name: '来店アンケート', description: null, fields: [{ name: 'purpose', label: '今日のご来店の目的は？', type: 'radio', required: true, options: ['トリミング'] }], layout, on_submit_tag_id: null, on_submit_scenario_id: 'scn-keep', save_to_metadata: true } }
  const formRow = { id: 'f-t-1', name: '来店アンケート', description: null, template_type: 'form', folder_id: null, revision: 3, updated_at: '2026-08-21T09:02:00Z', content_summary: '質問 1', distributed_account_count: 3, distributed_account_names: ['本店', '渋谷店', 'イベント'], distributed_account_more: 0 }

  beforeEach(() => {
    calls.list.mockResolvedValue([formRow])
    calls.get.mockResolvedValue({ template: formRow, definition: formDefinition })
    calls.update.mockImplementation(async (_id: string, input: { name: string; definition: unknown }) => ({ template: { ...formRow, revision: 4, name: input.name }, definition: input.definition }))
  })

  it('名前を押すと店と同じ3つのタブの編集画面。右は「配った先」、［保存して配る］で統括のひな形を直してアカウントへ配るへ進む', async () => {
    render(<HqTemplatesV8 type="form" />)
    fireEvent.click((await screen.findByRole('link', { name: '来店アンケート' })).closest('tr')!)
    expect(await screen.findByRole('heading', { name: '配った先' })).toBeTruthy()
    expect(screen.getByText('3 アカウント（本店・渋谷店・イベント）に配っています。各アカウントでは回答フォームとして使えます。')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '答え終わったあと' })).toBeTruthy()
    /* 店の口（回答用URL・公開・公開前に試す）は出さない。 */
    expect(screen.queryByText('回答用URL')).toBeNull()
    expect(screen.queryByRole('button', { name: /この版を公開/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /公開前に試す/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '答え終わったあと' }))
    fireEvent.change(screen.getByLabelText('お礼の文'), { target: { value: '回答を受け付けました' } })
    fireEvent.click(screen.getByRole('button', { name: '保存して配る' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    const [id, input] = calls.update.mock.calls[0]
    expect(id).toBe('f-t-1')
    expect(input).toMatchObject({ type: 'form', name: '来店アンケート', expectedRevision: 3 })
    /* 画面に出ない設定（答えたあとのシナリオ）は落とさない。 */
    expect(input.definition.form).toMatchObject({ on_submit_scenario_id: 'scn-keep', fields: [{ name: 'purpose' }] })
    expect(input.definition.form.layout.options.thanksText).toBe('回答を受け付けました')
    expect(await screen.findByRole('checkbox', { name: /然 -NEN- 本店/ })).toBeTruthy()
  })

  it('［下書きを保存］は保存して一覧へ戻り、配るへは進まない', async () => {
    render(<HqTemplatesV8 type="form" />)
    fireEvent.click((await screen.findByRole('link', { name: '来店アンケート' })).closest('tr')!)
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    expect(screen.queryByRole('checkbox', { name: /然 -NEN- 本店/ })).toBeNull()
  })
})

describe('統括のテンプレートを作る（リッチメッセージ g8d6ai）', () => {
  it('リッチメッセージのタブから作ると店のリッチメッセージの作る画面。画像は統括の置き場へ送り、面と URL を統括のひな形の素材にする', async () => {
    const media = [240, 300, 460, 700, 1040].map((width) => ({ id: `m-${width}`, kind: 'image', filename: `${width}.png`, mimeType: 'image/png', sizeBytes: 1, width, height: width, durationMs: null, r2Key: `hq/rich/${width}`, publicUrl: null, versionId: 'v1', versionNo: 1, contentHash: 'h' }))
    calls.uploadRichMessageImage.mockResolvedValue({ media, payload: { imageUrl: 'https://img.test/rich/1040', baseUrl: 'https://img.test/rich', baseSize: { width: 1040, height: 1040 } } })
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('tab', { name: /リッチメッセージ/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    expect(await screen.findByRole('heading', { name: 'リッチメッセージを作る' })).toBeTruthy()
    /* 普通のメッセージの作る画面には入らない。 */
    expect(screen.queryByLabelText('本文')).toBeNull()
    expect(screen.queryByRole('button', { name: '登録メディアから選ぶ' })).toBeNull()
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '夏のキャンペーン告知' } })
    const file = new File(['png'], 'summer.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('画像を追加（ファイル）'), { target: { files: [file] } })
    await waitFor(() => expect(calls.uploadRichMessageImage).toHaveBeenCalledWith(file))
    fireEvent.click(screen.getByRole('radio', { name: '1面（面 A）' }))
    fireEvent.click(screen.getByRole('button', { name: '面 A を押したら' }))
    expect(screen.queryByRole('option', { name: '動きを実行する' })).toBeNull()
    fireEvent.click(within(await screen.findByRole('option', { name: 'URLを開く' })).getByRole('button'))
    fireEvent.change(screen.getByLabelText('面 A のURL'), { target: { value: 'https://nen.example/summer' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    const definition = calls.create.mock.calls[0][0].definition
    expect(definition.asset.kind).toBe('rich_message')
    expect(definition.asset.payload).toMatchObject({ baseUrl: 'https://img.test/rich', shape: '1', tapAreas: [{ actionType: 'uri', uri: 'https://nen.example/summer' }] })
    expect(definition.media).toHaveLength(5)
    expect(await screen.findByRole('checkbox', { name: /然 -NEN- 本店/ })).toBeTruthy()
  })
})

describe('統括のテンプレートを直す（質問・クーポン：店の作る画面で、保存してある中身から）', () => {
  const question = { text: 'どのコースが好きですか？', tapMode: 'single', choices: [{ label: '鹿肉', behavior: 'none' }, { label: '馬肉', behavior: 'none' }] }
  const questionDefinition = { ...message, template: { ...message.template, name: '好みのコース', questionJson: JSON.stringify(question), questionStatus: 'published' } }
  const coupon = { description: '会計時にご提示ください', startsAt: '2026-12-01T00:00', endsAt: '2026-12-31T23:59', oncePerFriend: true, visibility: 'friends', lottery: false }
  const couponDefinition = { ...message, asset: { kind: 'coupon', payload: coupon }, template: { ...message.template, name: '冬の10%オフ', messageContent: '' } }
  const open = async (definition: unknown, rowKind: string, rowName: string) => {
    const row = { ...listRow, name: rowName, kind: rowKind }
    calls.list.mockResolvedValue([row]); calls.listByKind.mockResolvedValue([row])
    calls.get.mockResolvedValue({ template: { ...detail().template, name: rowName }, definition })
    calls.update.mockImplementation(async (_id: string, input: { name: string; definition: unknown }) => ({ template: { ...detail().template, name: input.name, revision: 4 }, definition: input.definition }))
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findByRole('link', { name: rowName })).closest('tr')!)
    fireEvent.click(await screen.findByRole('button', { name: /編集する/ }))
  }

  it('質問は保存してある質問文・選択肢で店の質問の画面が開き、直して保存すると同じ形で統括のひな形を更新する', async () => {
    await open(questionDefinition, 'question', '好みのコース')
    expect(await screen.findByDisplayValue('どのコースが好きですか？')).toBeTruthy()
    expect(screen.getByDisplayValue('馬肉')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^質問文/), { target: { value: 'どのお肉が好きですか？' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    const [, input] = calls.update.mock.calls[0]
    expect(input.expectedRevision).toBe(3)
    expect(JSON.parse(input.definition.template.questionJson)).toMatchObject({ text: 'どのお肉が好きですか？', choices: [{ label: '鹿肉' }, { label: '馬肉' }] })
  })

  it('リッチビデオは保存済みの動画と画像の組から開き、統括へ保存して配り先を選べる', async () => {
    const videoUrl='https://worker.test/images/hq-templates/tenant-a/video.mp4'
    const previewUrl='https://worker.test/images/hq-templates/tenant-a/preview.jpg'
    const payload={altText:'動画の通知',baseUrl:'https://worker.test/images/hq-templates/tenant-a/map',baseSize:{width:1040,height:520},actions:[],video:{originalContentUrl:videoUrl,previewImageUrl:previewUrl,area:{x:0,y:0,width:1040,height:520}}}
    const video={id:'v',kind:'video',filename:'video.mp4',mimeType:'video/mp4',sizeBytes:3,width:null,height:null,durationMs:1000,r2Key:'hq-templates/tenant-a/video.mp4',publicUrl:videoUrl,versionId:'v',versionNo:1,contentHash:'a'.repeat(64)}
    const media=[video,{...video,id:'p',kind:'image',mimeType:'image/jpeg',publicUrl:previewUrl,r2Key:'hq-templates/tenant-a/preview.jpg',width:1040,height:520}]
    const definition={...message,template:{...message.template,messageType:'imagemap',name:'統括の動画',messageContent:JSON.stringify(payload)},media}
    await open(definition,'rich_video','統括の動画')
    expect(await screen.findByRole('heading',{name:'リッチビデオを作る'})).toBeTruthy()
    calls.update.mockRejectedValueOnce(new Error('保存できませんでした。もう一度お試しください。'))
    fireEvent.change(screen.getByLabelText('通知に出る文'),{target:{value:'直した通知'}})
    fireEvent.click(screen.getByRole('button',{name:'保存する'}))
    await screen.findByText('保存できませんでした。もう一度お試しください。')
    expect(screen.getByDisplayValue('直した通知')).toBeTruthy()
    expect(screen.queryByRole('checkbox',{name:/然 -NEN- 本店/})).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'保存する'}))
    await waitFor(()=>expect(calls.update).toHaveBeenCalledTimes(2))
    const saved=calls.update.mock.calls[0][1].definition
    expect(saved.media).toEqual(media);expect(saved.asset).toBeUndefined();expect(saved.template.messageType).toBe('imagemap')
    expect(JSON.parse(saved.template.messageContent)).toEqual({...payload,altText:'直した通知'})
    expect(await screen.findByRole('checkbox',{name:/然 -NEN- 本店/})).toBeTruthy()
  })
  it('クーポンは保存してある期間・説明で店のクーポンの画面が開き、そのまま保存しても期間を落とさない', async () => {
    await open(couponDefinition, 'coupon', '冬の10%オフ')
    expect(await screen.findByRole('heading', { name: 'クーポンを作る' })).toBeTruthy()
    expect(screen.getByDisplayValue('冬の10%オフ')).toBeTruthy()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    const [, input] = calls.update.mock.calls[0]
    expect(input.definition.asset).toMatchObject({ kind: 'coupon', payload: { description: '会計時にご提示ください', startsAt: '2026-12-01T00:00', endsAt: '2026-12-31T23:59' } })
  })
})


const distributionScreen = () => {
  const frame = document.querySelector<HTMLElement>('[data-page-template="distribution"]')
  expect(frame).not.toBeNull()
  return frame!
}

describe('G-3：保存が済んでから配るか選ぶ', () => {
  const author = async () => {
    render(<HqTemplatesV8 type="template" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '予約前日' } })
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '明日です' } })
  }
  const preflight = (ids: string[]) => ({ preflightId: 'pf-1', expiresAt: new Date(Date.now() + 60000).toISOString(), stores: ids.map((accountId) => ({ accountId, items: [], warnings: [] })) })
  it('保存成功前には窓を出さず、「あとで」は保存を保ったまま閉じる（配布は呼ばない）', async () => {
    let finish!: (value: unknown) => void
    calls.create.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await author()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { finish({ template: { ...detail().template, id: 't-new' }, definition: calls.create.mock.calls[0][0].definition }) })
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '然 -NEN- 本店' }).hasAttribute('disabled')).toBe(false))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('保存しました。アカウントに配りますか？')
    expect(within(dialog).getByRole('button', { name: '0 アカウントへ配る' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'あとで' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.preflight).not.toHaveBeenCalled()
    expect(calls.distribute).not.toHaveBeenCalled()
    expect(calls.create).toHaveBeenCalledOnce()
  })
  it('保存を拒否されたら編集画面に残り、配る窓も確認も出さない', async () => {
    calls.create.mockRejectedValueOnce(Object.assign(new Error('保存を拒否しました'), { requestNotApplied: true }))
    await author()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '失敗：保存を拒否しました')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.preflight).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('予約前日')).toBeTruthy()
  })
  it('配った版と上書きの注意を出し、検索で隠れた選択も確認へ引き継ぐ。保存の帯は出さない', async () => {
    calls.receivedVersions.mockResolvedValue([{ accountId: 'a-2', accountName: '然 -NEN- 渋谷店', targetVersion: { version: 2, status: 'older' } }])
    calls.preflight.mockImplementation(async (_id, ids) => preflight(ids))
    await author()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '然 -NEN- 本店' }).hasAttribute('disabled')).toBe(false))
    // Dialogは初期描画からportalへ移る。待つたびに現在の窓を取り直す。
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('版 2 を配布済み')).toBeTruthy())
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('配ると上書き')).toBeTruthy()
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: '直営店をまとめて選ぶ' }))
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'アカウントを探す' }), { target: { value: '本店' } })
    expect(within(dialog).getByText('選んだ 2 アカウント')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '2 アカウントへ配る' }))
    await waitFor(() => expect(calls.preflight).toHaveBeenCalledWith('t-new', ['a-1', 'a-2']))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(distributionScreen()).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '保存しました。アカウントに配りますか？' })).toBeNull()
    expect(screen.queryByText('ひな形を保存しました。')).toBeNull()
    expect(calls.distribute).not.toHaveBeenCalled()
    expect(calls.create).toHaveBeenCalledOnce()
  })
  it('確認の通信失敗は窓と選択を保ち、再確認でもひな形を再保存しない', async () => {
    calls.preflight.mockRejectedValueOnce(new Error('確認に失敗しました')).mockImplementationOnce(async (_id, ids) => preflight(ids))
    await author()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '然 -NEN- 本店' }).hasAttribute('disabled')).toBe(false))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: '然 -NEN- 本店' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '然 -NEN- 本店' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '1 アカウントへ配る' }))
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '失敗：確認に失敗しました')
    expect((within(dialog).getByRole('checkbox', { name: '然 -NEN- 本店' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '1 アカウントへ配る' }))
    await waitFor(() => expect(calls.preflight).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(distributionScreen()).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '保存しました。アカウントに配りますか？' })).toBeNull()
    expect(calls.create).toHaveBeenCalledOnce()
  })
  it('新規の下書きは保存して一覧へ戻る。配布状況が取れなくても未配布にはしない', async () => {
    await author()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup(); window.history.replaceState(null, '', '/hq/templates'); calls.create.mockClear()
    calls.receivedVersions.mockRejectedValue(new Error('通信失敗'))
    await author()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '然 -NEN- 本店' }).hasAttribute('disabled')).toBe(false))
    // 古い窓を保持せず、現在の窓の全アカウントの描画完了まで待つ。
    await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('配布状況を確認できません')).toHaveLength(2))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('未配布')).toBeNull()
  })
})

describe('フォルダの「…」からまとめて配る（G-7）', () => {
  const folderRows = () => [
    { ...listRow, folder_id: 'f-1' },
    { ...listRow, id: 't-2', name: '別の種類のひな形', folder_id: 'f-1', kind: 'carousel' },
  ]
  const checked = (id: string) => ({ preflightId: `run-${id}`, expiresAt: new Date(Date.now() + 60000).toISOString(), stores: [{ accountId: 'a-1', accountName: '然 -NEN- 本店', items: [{ sourceId: id, name: id, itemKind: 'template', duplicate: false, allowedModes: ['create'] }] }] })
  const delivered = (id: string) => ({ runId: `run-${id}`, status: 'completed', stores: [{ accountId: 'a-1', status: 'succeeded', counts: { created: 1, overwritten: 0, aliased: 0 } }] })
  /** 配る先の欄から共通の窓を開き、アカウントを選んで確定する（dJZ7Q）。 */
  async function pickStores(dialog: HTMLElement, names: string[]) {
    /* 絵 ：配る先は窓の中のアカウントのチェックの一覧。 */
    for (const name of names) fireEvent.click(await within(dialog).findByRole('checkbox', { name }))
  }
  async function selectFolder() {
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'このフォルダを配る' }))
    return findPickerDialog('フォルダ「予約」の 2 件を配る')
  }
  beforeEach(() => {
    document.documentElement.dataset.theme = 'v8'
    calls.list.mockResolvedValue(folderRows())
    calls.listByKind.mockResolvedValue([folderRows()[0]])
    calls.get.mockImplementation(async (id: string) => ({ ...detail(), template: folderRows().find((row) => row.id === id) }))
    calls.preflight.mockImplementation(async (id: string) => checked(id))
    calls.distribute.mockImplementation(async (id: string) => delivered(id))
  })
  afterEach(() => { delete document.documentElement.dataset.theme; window.history.replaceState(null, '', '/hq/templates') })
  it('全種類のフォルダ内ひな形は全選択で始まり、片方0なら配れない', async () => {
    render(<HqTemplatesV8 type="template" />)
    const dialog = await selectFolder()
    /* 絵 ：配るテンプレートは窓の中のチェックの一覧（種類の札つき）。 */
    expect((within(dialog).getByRole('checkbox', { name: '別の種類のひな形' }) as HTMLInputElement).checked).toBe(true)
    expect(within(dialog).getByText('本文')).toBeTruthy()
    expect(within(dialog).getByText('カルーセル')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '2 件を 0 アカウントへ配る' }).hasAttribute('disabled')).toBe(true)
    await pickStores(dialog, ['然 -NEN- 本店'])
    for (const name of ['予約前日のご案内', '別の種類のひな形']) fireEvent.click(within(dialog).getByRole('checkbox', { name }))
    expect(within(dialog).getByRole('button', { name: '0 件を 1 アカウントへ配る' }).hasAttribute('disabled')).toBe(true)
    expect(calls.preflight).not.toHaveBeenCalled()
  })
  it('すべての確認が済むまで配らず、順に配った結果を同じ窓へまとめる', async () => {
    render(<HqTemplatesV8 type="template" />)
    const dialog = await selectFolder()
    await pickStores(dialog, ['然 -NEN- 本店'])
    fireEvent.click(within(dialog).getByRole('button', { name: '2 件を 1 アカウントへ配る' }))
    fireEvent.click(await screen.findByRole('button', { name: '次のひな形を確かめる（1/2）' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(distributionScreen()).toBeTruthy()
    await waitFor(() => expect(calls.preflight).toHaveBeenCalledWith('t-2', ['a-1']))
    expect(calls.distribute).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '2 件を 1 アカウントへ配る' }))
    const result = await findPickerDialog('配った結果：フォルダ「予約」')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(result.style.getPropertyValue('--dialog-design-width')).toBe('720px')
    expect(within(result).getByText('1 アカウントへ配りました。成功 2・失敗 0。成功した所はもう使えます。')).toBeTruthy()
    expect(calls.distribute.mock.calls.map((call) => call[0])).toEqual(['t-1', 't-2'])
  })
  it('再読込後は記録した番号をGETで確認し、配り直さない', async () => {
    window.sessionStorage.setItem('hq-folder-distribution:tenant-a:owner:template', JSON.stringify([{ templateId: 't-1', accountIds: ['a-1'], runId: 'run-t-1' }]))
    calls.result.mockResolvedValue(delivered('t-1'))
    render(<HqTemplatesV8 type="template" />)
    expect(await screen.findByRole('dialog', { name: '配った結果：フォルダ「配布結果の再確認」' })).toBeTruthy()
    expect(calls.result).toHaveBeenCalledWith('t-1', 'run-t-1')
    expect(calls.distribute).not.toHaveBeenCalled()
  })

  it('失敗したひな形とアカウントだけ再確認し、先に成功した配布は送らない', async () => {
    calls.distribute.mockImplementationOnce(async () => delivered('t-1')).mockImplementationOnce(async () => ({ ...delivered('t-2'), status: 'failed', stores: [{ ...delivered('t-2').stores[0], status: 'failed', reason: '更新を確認してください' }] }))
    render(<HqTemplatesV8 type="template" />)
    const dialog = await selectFolder()
    await pickStores(dialog, ['然 -NEN- 本店'])
    fireEvent.click(within(dialog).getByRole('button', { name: '2 件を 1 アカウントへ配る' }))
    fireEvent.click(await screen.findByRole('button', { name: '次のひな形を確かめる（1/2）' }))
    fireEvent.click(await screen.findByRole('button', { name: '2 件を 1 アカウントへ配る' }))
    const result = await findPickerDialog('配った結果：フォルダ「予約」')
    fireEvent.click(within(result).getByRole('button', { name: '失敗した 1 件をやり直す' }))
    fireEvent.click(await screen.findByRole('button', { name: '1 件を 1 アカウントへ配る' }))
    await waitFor(() => expect(calls.distribute).toHaveBeenCalledTimes(3))
    expect(calls.distribute.mock.calls.map((call) => call[0])).toEqual(['t-1', 't-2', 't-2'])
    expect(calls.preflight.mock.calls.map((call) => [call[0], call[1]])).toEqual([['t-1', ['a-1']], ['t-2', ['a-1']], ['t-2', ['a-1']]])
  })

})


describe('統括タグの札は詳細から配布結果まで同じ色を保つ', () => {
  it.each([null, '#8b5cf6'])('一覧→詳細→配布の確認→配った結果でタグ札の色 %s を保ち、配布の操作も保つ', async (color) => {
    window.history.replaceState(null, '', '/hq/templates')
    const expectedColor = folderDisplayColor({ name: '予約', color })
    const tagRow = { ...listRow, name: 'VIP', template_type: 'tag', folder_id: 'f-1' }
    calls.list.mockResolvedValue([tagRow])
    calls.folderList.mockResolvedValue([{ id: 'f-1', name: '予約', revision: 1, color }])
    calls.get.mockResolvedValue({ template: tagRow, definition: { schemaVersion: 1, tag: { name: 'VIP', folderId: 'f-1' }, folders: [{ id: 'f-1', name: '予約', color }] } })
    calls.preflight.mockResolvedValue({ preflightId: 'tag-run', expiresAt: new Date(Date.now() + 60000).toISOString(), stores: [{ accountId: 'a-1', accountName: '然 -NEN- 本店', items: [{ sourceId: 't-1', itemKind: 'tag', name: 'VIP', duplicate: false, allowedModes: ['create'] }] }] })
    calls.distribute.mockResolvedValue({ runId: 'tag-run', status: 'completed', stores: [{ accountId: 'a-1', accountName: '然 -NEN- 本店', status: 'succeeded', counts: { created: 1, overwritten: 0, aliased: 0 } }] })
    render(<HqTemplatesV8 type="tag" />)
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'このフォルダを配る' }))
    const folderDialog = await screen.findByRole('dialog', { name: 'フォルダ「予約」の 1 件を配る' })
    expect(within(folderDialog).getByRole('checkbox', { name: /VIP/ })).toBeTruthy()
    expect(within(folderDialog).getByRole('group', { name: 'タグ「VIP」' }).querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain(expectedColor)
    fireEvent.click(within(folderDialog).getByRole('button', { name: 'キャンセル' }))
    const listName = await screen.findByRole('link', { name: 'VIP', exact: true })
    expect(within(listName).getByRole('img', { name: 'フォルダ：予約' }).getAttribute('style')).toContain(expectedColor)
    fireEvent.click(listName.closest('tr')!)
    const body = await screen.findByRole('region', { name: '本文' })
    const pill = within(body).getByRole('group', { name: 'タグ「VIP」' })
    expect(pill.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain(expectedColor)
    fireEvent.click(screen.getByRole('button', { name: 'VIPを配る' }))
    expect(within(distributionScreen()).getAllByRole('group', { name: 'タグ「VIP」' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('checkbox', { name: '然 -NEN- 本店', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '1アカウントの重複を確認' }))
    fireEvent.click(await screen.findByRole('button', { name: 'この内容で1アカウントへ配る' }))
    const result = await findPickerDialog('配った結果：VIP')
    expect(within(result).getByRole('group', { name: 'タグ「VIP」' }).querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain(expectedColor)
    expect(calls.distribute).toHaveBeenCalledOnce()
    expect(within(result).getByText('成功')).toBeTruthy()
  })
})

it('種類を替えると前の種類の行を隠し、遅い前の応答も表示しない', async () => {
  let resolveVideo!: (rows: typeof listRow[]) => void
  calls.listByKind.mockImplementation((kind: string) => kind === 'rich_video' ? new Promise(resolve => { resolveVideo = resolve }) : Promise.resolve([listRow]))
  render(<HqTemplatesV8 type="template" />)
  await screen.findByRole('link', { name: '予約前日のご案内' })
  fireEvent.click(screen.getByRole('tab', { name: /リッチビデオ/ }))
  await waitFor(() => expect(calls.listByKind).toHaveBeenCalledWith('rich_video'))
  expect(screen.queryByRole('link', { name: '予約前日のご案内' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: /^メッセージ/ }))
  await screen.findByRole('link', { name: '予約前日のご案内' })
  await act(async () => { resolveVideo([{ ...listRow, id: 'video-only', kind: 'rich_video', name: '動画だけの案内' }]) })
  expect(screen.queryByRole('link', { name: '動画だけの案内' })).toBeNull()
})

it('?mode=createの再読込でも結果不明の復旧依頼を保持する', async () => {
  const { persistCreationAttempt } = await import('@/lib/hq-template-create-attempt')
  persistCreationAttempt(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'template', {
    requestId: 'req-recovery-1',
    distribute: false,
    input: { type: 'template', name: '人工テスト', description: '', definition: message, folderId: null },
  })
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('人工テスト')).toBeTruthy()
  expect(await screen.findByText(/前回の保存結果がまだ確定していません/)).toBeTruthy()
})
it('作る画面のURLは一覧の種別（?type=）を引き継ぐ', async () => {
  window.history.replaceState(null, '', '/hq/templates?type=scenario')
  render(<HqTemplatesV8 type="template" />)
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('mode')).toBe('create'))
  expect(new URLSearchParams(window.location.search).get('type')).toBe('scenario')
})
it('結果不明の復旧時は指定したフォルダを表示する', async () => {
  const { persistCreationAttempt } = await import('@/lib/hq-template-create-attempt')
  persistCreationAttempt(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'template', {
    requestId: 'req-recovery-folder',
    distribute: false,
    input: { type: 'template', name: '人工テスト', description: '', definition: message, folderId: 'f-1' },
  })
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('人工テスト')).toBeTruthy()
  await waitFor(() => expect(document.body.textContent ?? '').toContain('予約'))
  expect(document.body.textContent ?? '').not.toContain('フォルダ：未分類')
})
it('メッセージの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  fireEvent.change(await screen.findByLabelText('テンプレート名'), { target: { value: '未保存の名前' } })
  fireEvent.change(await screen.findByLabelText('本文'), { target: { value: '未保存の本文' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:message') ?? '').toContain('未保存の本文'))
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存の名前')).toBeTruthy()
  /* 本文欄は札付き編集部品のため表示値照合ではなく中身で確かめる。 */
  expect((await screen.findByLabelText('本文')).textContent ?? '').toContain('未保存の本文')
})
it('一時下書きは取消で捨てられ別種別・別所属には混ざらない（H-18原文）', async () => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  render(<HqTemplatesV8 type="template" />)
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  fireEvent.change(await screen.findByLabelText('テンプレート名'), { target: { value: '捨てる入力' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:message')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:message')).toBeNull())
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'template', 'coupon', { kind: 'coupon', name: '別種の下書き', payload: {} })
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-b', actorId: 'owner' }, 'template', 'message', { kind: 'message', name: '別所属の下書き', messageType: 'text', messageContent: 'x' })
  // 再読込は最後の下書きの種類を復元するため、メッセージを新規作成して混入を調べる。
  window.history.replaceState(null, '', '/hq/templates')
  cleanup()
  render(<HqTemplatesV8 type="template" />)
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  const name = await screen.findByLabelText('テンプレート名') as HTMLInputElement
  expect(name.value).toBe('')
  expect(screen.queryByDisplayValue('別種の下書き')).toBeNull()
  expect(screen.queryByDisplayValue('別所属の下書き')).toBeNull()
  expect(screen.queryByDisplayValue('捨てる入力')).toBeNull()
  expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:coupon')).toContain('別種の下書き')
  expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-b:owner:template:message')).toContain('別所属の下書き')
})
it('カルーセルの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /カルーセル/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'カルーセルを作る' })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('例：夏の定番5点'), { target: { value: '未保存カルーセル' } })
  const body = document.getElementById('cr-text') as HTMLInputElement
  fireEvent.change(body, { target: { value: '未保存のカード本文' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:carousel') ?? '').toContain('未保存のカード本文'), { timeout: 5000 })
  const { loadEditorDraft: readCarouselDraft } = await import('@/lib/hq-template-create-attempt')
  const restoredCarousel = readCarouselDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'template', 'carousel')
  expect(restoredCarousel?.kind).toBe('carousel')
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  await waitFor(() => expect(document.body.textContent ?? '').toContain('カルーセルを作る'))
  expect(await screen.findByDisplayValue('未保存カルーセル')).toBeTruthy()
  expect((document.getElementById('cr-text') as HTMLInputElement).value).toContain('未保存のカード本文')
})
it('質問の通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /質問/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: '質問を作る' })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('例：継続の意思をうかがう'), { target: { value: '未保存の質問名' } })
  fireEvent.change(screen.getByLabelText(/^質問文/), { target: { value: '未保存の質問文ですか？' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:question') ?? '').toContain('未保存の質問文ですか？'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存の質問名')).toBeTruthy()
  expect((screen.getByLabelText(/^質問文/) as HTMLInputElement).value).toContain('未保存の質問文ですか？')
})
it('リッチメッセージの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const media = [1040].map((width) => ({ id: `m-${width}`, kind: 'image', filename: `${width}.png`, mimeType: 'image/png', sizeBytes: 1, width, height: width, durationMs: null, r2Key: `hq/rich/${width}`, publicUrl: null, versionId: 'v1', versionNo: 1, contentHash: 'h' }))
  calls.uploadRichMessageImage.mockResolvedValue({ media, payload: { imageUrl: 'https://img.test/rich/1040', baseUrl: 'https://img.test/rich', baseSize: { width: 1040, height: 1040 } } })
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /リッチメッセージ/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'リッチメッセージを作る' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '未保存リッチ' } })
  fireEvent.change(screen.getByLabelText('画像を追加（ファイル）'), { target: { files: [new File(['png'], 'rich.png', { type: 'image/png' })] } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:rich_message') ?? '').toContain('未保存リッチ'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存リッチ')).toBeTruthy()
})
it('リッチビデオの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /リッチビデオ/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'リッチビデオを作る' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '未保存ビデオ' } })
  fireEvent.change(screen.getByLabelText('通知に出る文'), { target: { value: '未保存の通知文' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:rich_video') ?? '').toContain('未保存の通知文'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存ビデオ')).toBeTruthy()
  expect((screen.getByLabelText('通知に出る文') as HTMLInputElement).value).toContain('未保存の通知文')
})
it('クーポンの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /クーポン/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'クーポンを作る' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '未保存クーポン' } })
  const dayLabel = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  const endDay = new Date(); endDay.setDate(endDay.getDate() + 30)
  fireEvent.click(screen.getByLabelText('使える期間の開始'))
  const startDialog = within(await screen.findByRole('dialog', { name: '日時を選ぶ' }))
  fireEvent.click(await screen.findByRole('button', { name: '今日' }))
  fireEvent.click(startDialog.getByRole('button', { name: '確定' }))
  fireEvent.click(screen.getByLabelText('使える期間の終了'))
  const endDialog = within(await screen.findByRole('dialog', { name: '日時を選ぶ' }))
  const endName = new RegExp(dayLabel(endDay))
  const calendar = endDialog
  for (let i = 0; i < 2 && !calendar.queryByRole('button', { name: endName }); i += 1) fireEvent.click(calendar.getByRole('button', { name: '次の月' }))
  fireEvent.click(calendar.getByRole('button', { name: endName }))
  fireEvent.click(endDialog.getByRole('button', { name: '確定' }))
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:coupon') ?? '').toContain('未保存クーポン'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存クーポン')).toBeTruthy()
})
it('リサーチの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  const { unmount } = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /リサーチ/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'リサーチを作る' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '未保存リサーチ' } })
  fireEvent.change(screen.getByLabelText('質問文'), { target: { value: '未保存の質問ですか？' } })
  fireEvent.change(screen.getByLabelText('問 1 の選択肢 1'), { target: { value: 'はい' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:template:research') ?? '').toContain('未保存の質問ですか？'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('未保存リサーチ')).toBeTruthy()
  expect((screen.getByLabelText('質問文') as HTMLInputElement).value).toContain('未保存の質問ですか？')
})
it('タグの通常入力は再読込後も一時下書きから復元する（H-18原文）', async () => {
  window.history.replaceState(null, '', '/hq/templates')
  calls.list.mockResolvedValue([])
  calls.folderList.mockResolvedValue([])
  const { unmount } = render(<HqTemplatesV8 type="tag" />)
  fireEvent.click((await screen.findAllByRole('button', { name: /タグを作る/ }))[0])
  expect(await screen.findByRole('heading', { name: 'タグのひな形を作る' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('タグ名'), { target: { value: '未保存タグ' } })
  await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_draft_v1:tenant-a:owner:tag:tag') ?? '').toContain('未保存タグ'), { timeout: 5000 })
  unmount()
  cleanup()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="tag" />)
  expect(await screen.findByDisplayValue('未保存タグ')).toBeTruthy()
})
it('未配布ありの1件を消すと数の帯を取り直す（B25）', async () => {
  calls.listStats
    .mockResolvedValueOnce({ thisMonthSentCount: 0, outdatedTemplateCount: 1 })
    .mockResolvedValue({ thisMonthSentCount: 0, outdatedTemplateCount: 0 })
  calls.remove.mockResolvedValue({})
  render(<HqTemplatesV8 type="form" />)
  await screen.findByRole('link', { name: '予約前日のご案内' })
  const loaded = calls.listStats.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: /予約前日のご案内.*の操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '削除する' }))
  const confirm = await screen.findByRole('alertdialog')
  expect(within(confirm).getByText('統括ひな形')).toBeTruthy()
  expect(within(confirm).getByText('環境')).toBeTruthy()
  fireEvent.click(within(confirm).getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(calls.listStats.mock.calls.length).toBeGreaterThan(loaded))
})

const formDraftKey = 'lh_hq_create_draft_v1:tenant-a:owner:form:form'
it('回答フォームの名前・設問以外の入力も未送信のまま再読込で復元し、保存成功で消す', async () => {
  calls.list.mockResolvedValue([])
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  const first = render(<HqTemplatesV8 type="form" />)
  fireEvent.change(await screen.findByLabelText('フォーム名'), { target: { value: ' 架空フォーム ' } })
  fireEvent.click(screen.getByRole('button', { name: /1行で書く/ }))
  fireEvent.change(screen.getByLabelText('質問文'), { target: { value: '架空の質問' } })
  fireEvent.click(screen.getByRole('tab', { name: '答え終わったあと' }))
  fireEvent.change(screen.getByLabelText('お礼の文'), { target: { value: '架空の回答ありがとうございます' } })
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toContain('架空の回答ありがとうございます'))
  expect(calls.create).not.toHaveBeenCalled()
  const stored = JSON.parse(window.sessionStorage.getItem(formDraftKey)!)
  stored.draft.folderId = 'f-1'
  window.sessionStorage.setItem(formDraftKey, JSON.stringify(stored))
  first.unmount()
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  expect((await screen.findByLabelText('フォーム名') as HTMLInputElement).value).toBe(' 架空フォーム ')
  fireEvent.click(screen.getByRole('tab', { name: '答え終わったあと' }))
  expect(await screen.findByDisplayValue('架空の回答ありがとうございます')).toBeTruthy()
  calls.create.mockImplementation(async (input) => ({ template: { ...detail().template, template_type: 'form', name: input.name }, definition: input.definition }))
  fireEvent.click(await findPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(calls.create.mock.calls.length, document.body.textContent ?? '').toBeGreaterThan(0))
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toBeNull())
  expect(calls.create.mock.calls[0][0].folderId).toBe('f-1')
})
it('回答フォームの取消で一時下書きを消し、次の新規作成へ持ち越さない', async () => {
  calls.list.mockResolvedValue([])
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  fireEvent.change(await screen.findByLabelText('フォーム名'), { target: { value: '取消する架空フォーム' } })
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toContain('取消する架空フォーム'))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toBeNull())
  fireEvent.click((await screen.findAllByRole('button', { name: /フォームを作る/ }))[0])
  expect((await screen.findByLabelText('フォーム名') as HTMLInputElement).value).toBe('')
})
it('既存回答フォームの編集入力は新規作成の一時下書きに保存しない', async () => {
  const { emptyLayout } = await import('@line-crm/shared')
  const form = { schemaVersion: 1, form: { name: '既存の架空フォーム', description: null, fields: [], layout: emptyLayout(), on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }
  calls.get.mockResolvedValue({ template: { ...detail().template, template_type: 'form', name: form.form.name, folder_id: 'new-folder-not-in-list' }, definition: form })
  window.history.replaceState(null, '', '/hq/form-submissions?item=t-1&mode=edit')
  render(<HqTemplatesV8 type="form" />)
  const unrelated = 'unrelated-form-draft'
  window.sessionStorage.setItem(formDraftKey, unrelated)
  fireEvent.change(await screen.findByLabelText('フォーム名'), { target: { value: '編集した架空フォーム' } })
  expect(window.sessionStorage.getItem(formDraftKey)).toBe(unrelated)
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  await waitFor(() => expect(screen.queryByLabelText('フォーム名')).toBeNull())
  expect(window.sessionStorage.getItem(formDraftKey)).toBe(unrelated)
})
it('回答フォームの未送信下書きより、結果不明の保存依頼の再確認を優先する', async () => {
  const { persistCreationAttempt, persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const { emptyLayout } = await import('@line-crm/shared')
  const scope = { tenantId: 'tenant-a', actorId: 'owner' }
  persistEditorDraft(window.sessionStorage, scope, 'form', 'form', { kind: 'form', name: '未送信の架空入力', description: '', onSubmitTagId: '', layout: emptyLayout() })
  const definition = { schemaVersion: 1 as const, form: { name: '結果不明の架空フォーム', description: null, fields: [], layout: emptyLayout(), on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }
  persistCreationAttempt(window.sessionStorage, scope, 'form', { requestId: 'req-form-uncertain', distribute: false, input: { type: 'form', name: definition.form.name, definition } })
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  expect(await screen.findByRole('button', { name: '前回の保存を再確認' })).toBeTruthy()
  expect(screen.queryByDisplayValue('未送信の架空入力')).toBeNull()
  expect(window.sessionStorage.getItem(formDraftKey)).toContain('未送信の架空入力')
  expect(calls.create).not.toHaveBeenCalled()
})

it('復元直後の取消も未保存の確認を出し、編集継続なら入力を保つ', async () => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const { emptyLayout } = await import('@line-crm/shared')
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'form', 'form', { kind: 'form', name: '復元の架空フォーム', description: '', onSubmitTagId: '', layout: emptyLayout() })
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  await screen.findByDisplayValue('復元の架空フォーム')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(await screen.findByRole('button', { name: '閉じる' }))
  expect(screen.getByDisplayValue('復元の架空フォーム')).toBeTruthy()
  expect(window.sessionStorage.getItem(formDraftKey)).toContain('復元の架空フォーム')
})
it('入力を空に戻すと古い回答フォームの下書きを消す', async () => {
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  const field = await screen.findByLabelText('フォーム名')
  fireEvent.change(field, { target: { value: '消す架空入力' } })
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toContain('消す架空入力'))
  fireEvent.change(field, { target: { value: '' } })
  await waitFor(() => expect(window.sessionStorage.getItem(formDraftKey)).toBeNull())
})

it('空の新規フォームは未保存の確認を出さずキャンセルできる', async () => {
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  render(<HqTemplatesV8 type="form" />)
  await screen.findByLabelText('フォーム名')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByLabelText('フォーム名')).toBeNull())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(window.sessionStorage.getItem(formDraftKey)).toBeNull()
})
it('フォームの保存中に離れても成功した作成の一時下書きは残さない', async () => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const { emptyLayout } = await import('@line-crm/shared')
  const layout = emptyLayout()
  layout.sections[0].blocks.push({ id: 'fake-block', kind: 'input', type: 'text', name: 'fake_answer', label: '架空の質問' })
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'form', 'form', { kind: 'form', name: '保存中の架空フォーム', description: '', onSubmitTagId: '', layout })
  let complete!: () => void
  calls.create.mockImplementation(input => new Promise(resolve => { complete = () => resolve({ template: { ...detail().template, template_type: 'form', name: input.name }, definition: input.definition }) }))
  window.history.replaceState(null, '', '/hq/form-submissions?mode=create')
  const view = render(<HqTemplatesV8 type="form" />)
  await screen.findByDisplayValue('保存中の架空フォーム')
  fireEvent.click(await findPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(calls.create).toHaveBeenCalled())
  view.unmount()
  await act(async () => { complete() })
  expect(window.sessionStorage.getItem(formDraftKey)).toBeNull()
})

it('既存フォームのフォルダが一覧に未掲載でも編集保存で外さない', async () => {
  const { emptyLayout } = await import('@line-crm/shared')
  const layout = emptyLayout()
  layout.sections[0].blocks.push({ id: 'fake-input', kind: 'input', type: 'text', name: 'fake_answer', label: '架空の質問' })
  const definition = { schemaVersion: 1, form: { name: '架空の既存フォーム', description: null, fields: [], layout, on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }
  const row = { ...detail().template, template_type: 'form', name: definition.form.name, folder_id: 'new-folder-not-in-list' }
  calls.get.mockResolvedValue({ template: row, definition })
  calls.update.mockImplementation(async (_id, input) => ({ template: row, definition: input.definition }))
  window.history.replaceState(null, '', '/hq/form-submissions?item=t-1&mode=edit')
  render(<HqTemplatesV8 type="form" />)
  await screen.findByDisplayValue(definition.form.name)
  fireEvent.click(await findPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(calls.update).toHaveBeenCalled())
  expect(calls.update.mock.calls[0][1].folderId).toBe('new-folder-not-in-list')
})

const scenarioDraftKey = 'lh_hq_create_draft_v1:tenant-a:owner:scenario:scenario'
async function scenarioCreate() {
  const { default: Editor } = await import('@/app/hq/templates/template-definition-editor')
  calls.list.mockResolvedValue([])
  window.history.replaceState(null, '', '/hq/templates?type=scenario&mode=create')
  return render(<HqTemplatesV8 type="scenario" DefinitionEditor={Editor} />)
}
it('シナリオの未送信入力・空のステップ・順序を復元し、保存成功で一時下書きを消す', async () => {
  const first = await scenarioCreate()
  fireEvent.change(await screen.findByLabelText('ひな形の名前'), { target: { value: ' 架空の案内 ' } })
  fireEvent.change(screen.getByLabelText('説明'), { target: { value: '架空の説明' } })
  fireEvent.change(screen.getByLabelText('ステップ1の本文'), { target: { value: '架空の本文' } })
  fireEvent.click(screen.getByRole('button', { name: 'ステップを追加' }))
  fireEvent.change(screen.getByLabelText('ステップ2の遅延'), { target: { value: '30' } })
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toContain('架空の説明'))
  const before = JSON.parse(window.sessionStorage.getItem(scenarioDraftKey)!).draft
  expect(before.definition.steps).toHaveLength(2)
  expect(calls.create).not.toHaveBeenCalled()
  first.unmount()
  await scenarioCreate()
  expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe(' 架空の案内 ')
  expect((screen.getByLabelText('説明') as HTMLTextAreaElement).value).toBe('架空の説明')
  expect((screen.getByLabelText('ステップ1の本文') as HTMLTextAreaElement).value).toBe('架空の本文')
  expect((screen.getByLabelText('ステップ2の本文') as HTMLTextAreaElement).value).toBe('')
  expect((screen.getByLabelText('ステップ2の遅延') as HTMLInputElement).value).toBe('30')
  fireEvent.change(screen.getByLabelText('ステップ2の本文'), { target: { value: '架空の続き' } })
  calls.create.mockImplementation(async input => ({ template: { ...detail().template, template_type: 'scenario', name: input.name }, definition: input.definition }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(calls.create).toHaveBeenCalled())
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull())
  expect(calls.create.mock.calls[0][0].definition.steps.map((step: { id: string }) => step.id)).toEqual(before.definition.steps.map((step: { id: string }) => step.id))
})
it('シナリオの取消で消去し、次の作成と空への戻しに古い入力を残さない', async () => {
  await scenarioCreate()
  const name = await screen.findByLabelText('ひな形の名前')
  fireEvent.change(name, { target: { value: '架空の取消' } })
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toContain('架空の取消'))
  fireEvent.change(name, { target: { value: '' } })
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull())
  fireEvent.change(name, { target: { value: '架空の取消' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull())
  cleanup()
  await scenarioCreate()
  expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('')
})
it('結果不明のシナリオ保存依頼を未送信下書きより優先する', async () => {
  const { persistCreationAttempt, persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const scope = { tenantId: 'tenant-a', actorId: 'owner' }
  const definition = { schemaVersion: 1 as const, scenario: { name: '架空の保存依頼', description: null }, steps: [{ id: 'step-1', delayMinutes: 0, messageType: 'text' as const, messageContent: '架空本文' }] }
  persistEditorDraft(window.sessionStorage, scope, 'scenario', 'scenario', { kind: 'scenario', name: '架空の未送信入力', description: '', folderId: null, definition })
  persistCreationAttempt(window.sessionStorage, scope, 'scenario', { requestId: 'scenario-request', distribute: false, input: { type: 'scenario', name: definition.scenario.name, definition } })
  await scenarioCreate()
  expect(await screen.findByRole('button', { name: '前回の保存を再確認' })).toBeTruthy()
  expect(screen.queryByDisplayValue('架空の未送信入力')).toBeNull()
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toContain('架空の未送信入力')
  expect(calls.create).not.toHaveBeenCalled()
})
it('既存シナリオの競合表示と取消は新規下書きを上書きも消去もしない', async () => {
  const { default: Editor } = await import('@/app/hq/templates/template-definition-editor')
  const definition = { schemaVersion: 1, scenario: { name: '架空の既存', description: null }, steps: [{ id: 'step-1', delayMinutes: 0, messageType: 'text', messageContent: '架空本文' }] }
  calls.get.mockResolvedValue({ template: { ...detail().template, template_type: 'scenario', name: '架空の既存' }, definition })
  calls.update.mockRejectedValue({ status: 409, message: '更新が競合しました' })
  window.sessionStorage.setItem(scenarioDraftKey, 'unrelated-create-draft')
  window.history.replaceState(null, '', '/hq/templates?type=scenario&item=t-1&mode=edit')
  render(<HqTemplatesV8 type="scenario" DefinitionEditor={Editor} />)
  fireEvent.change(await screen.findByLabelText('ステップ1の本文'), { target: { value: '架空の編集中' } })
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(calls.update).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: '違いを比べる' }))
  await screen.findByText(/内容：入力.*架空の編集中/)
  expect((screen.getByLabelText('ステップ1の本文') as HTMLTextAreaElement).value).toBe('架空の編集中')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toBe('unrelated-create-draft')
})
it('シナリオの保存中に離れても、成功後は一時下書きを消す', async () => {
  const view = await scenarioCreate()
  fireEvent.change(await screen.findByLabelText('ひな形の名前'), { target: { value: '架空の保存中' } })
  fireEvent.change(screen.getByLabelText('ステップ1の本文'), { target: { value: '架空本文' } })
  let complete!: () => void
  calls.create.mockImplementation(input => new Promise(resolve => { complete = () => resolve({ template: { ...detail().template, template_type: 'scenario', name: input.name }, definition: input.definition }) }))
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(calls.create).toHaveBeenCalled())
  view.unmount()
  await act(async () => { complete() })
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull()
})
it('壊れたシナリオ下書きは無視し、別所属の下書きは読み書きしない', async () => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const otherKey = scenarioDraftKey.replace('tenant-a', 'tenant-other')
  window.sessionStorage.setItem(otherKey, 'other-tenant-draft')
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'scenario', 'scenario', { kind: 'scenario', name: '壊れた架空入力', description: '', folderId: null, definition: { steps: [null] } })
  await scenarioCreate()
  expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('')
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull()
  expect(window.sessionStorage.getItem(otherKey)).toBe('other-tenant-draft')
})
it.each([false, true])('復元したシナリオのフォルダは一覧取得成功時だけ削除済みを外す（取得失敗=%s）', async failed => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const definition = { schemaVersion: 1, scenario: { name: '', description: null }, steps: [{ id: 'fake-step', delayMinutes: 0, messageType: 'text', messageContent: '架空本文' }] }
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'scenario', 'scenario', { kind: 'scenario', name: '架空フォルダ確認', description: '', folderId: 'missing-folder', definition })
  if (failed) calls.folderList.mockRejectedValue(new Error('mock unavailable'))
  await scenarioCreate()
  await screen.findByDisplayValue('架空フォルダ確認')
  calls.create.mockImplementation(async input => ({ template: { ...detail().template, template_type: 'scenario', name: input.name }, definition: input.definition }))
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(calls.create).toHaveBeenCalled())
  expect(calls.create.mock.calls[0][0].folderId).toBe(failed ? 'missing-folder' : null)
})
it('フォルダ絞り込みから作り直すと古いシナリオ下書きを消し、未入力では新たな下書きを作らない', async () => {
  const { default: Editor } = await import('@/app/hq/templates/template-definition-editor')
  calls.list.mockResolvedValue([])
  window.sessionStorage.setItem(scenarioDraftKey, 'stale-draft')
  window.history.replaceState(null, '', '/hq/templates?type=scenario&folderFilter=f-1')
  render(<HqTemplatesV8 type="scenario" DefinitionEditor={Editor} />)
  fireEvent.click((await screen.findAllByRole('button', { name: /シナリオを作る/ }))[0])
  const name = await screen.findByLabelText('ひな形の名前')
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull()
  fireEvent.change(name, { target: { value: '架空入力' } })
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toContain('架空入力'))
  expect(JSON.parse(window.sessionStorage.getItem(scenarioDraftKey)!).draft.folderId).toBe('f-1')
  fireEvent.change(name, { target: { value: '' } })
  await waitFor(() => expect(window.sessionStorage.getItem(scenarioDraftKey)).toBeNull())
})
it('閲覧のみではシナリオの未送信下書きを表示・変更・消去しない', async () => {
  access.canEdit = false
  window.sessionStorage.setItem(scenarioDraftKey, 'read-only-draft')
  await scenarioCreate()
  await waitFor(() => expect(calls.list).toHaveBeenCalled())
  await screen.findByRole('heading', { name: 'シナリオ' })
  const create = screen.getByRole('button', { name: /シナリオを作る/ })
  expect(create.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(create)
  expect(screen.queryByLabelText('ひな形の名前')).toBeNull()
  expect(window.sessionStorage.getItem(scenarioDraftKey)).toBe('read-only-draft')
  expect(calls.create).not.toHaveBeenCalled()
})

it.each([['coupon', 'クーポン'], ['research', 'リサーチ'], ['rich_message', 'リッチメッセージ']])('%sの未完成入力も最新の名前で復元する', async (kind, label) => {
  const view = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: new RegExp(label) }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  fireEvent.change(await screen.findByLabelText('テンプレート名'), { target: { value: '架空の途中入力' } })
  const key = `lh_hq_create_draft_v1:tenant-a:owner:template:${kind}`
  await waitFor(() => expect(window.sessionStorage.getItem(key)).toContain('架空の途中入力'))
  view.unmount()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('架空の途中入力')).toBeTruthy()
  expect(calls.create).not.toHaveBeenCalled()
})
it.each(['message', 'coupon', 'research', 'carousel', 'question', 'rich_message', 'rich_video'])('%sのフォルダは入力と一緒に復元する', async kind => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const { emptyQuestion } = await import('@/components/scenarios/question-editor')
  const messageContent = kind === 'carousel' ? JSON.stringify([{ text: '架空本文', actions: [] }])
    : kind === 'rich_video' ? JSON.stringify({ video: { originalContentUrl: '', previewImageUrl: '' }, baseSize: { height: 1040 } }) : ''
  const content = { kind, name: '架空のフォルダ入力', messageType: 'text', messageContent, payload: {}, media: [], question: emptyQuestion(), tapLimitMode: 'none' }
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'template', kind, { ...content, folderId: 'f-1' })
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  await screen.findByDisplayValue('架空のフォルダ入力')
  await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(`lh_hq_create_draft_v1:tenant-a:owner:template:${kind}`)!).draft.folderId).toBe('f-1'))
  expect(document.body.textContent).toContain('予約')
})
it.each(['template', 'tag'] as const)('%sは離脱後の保存成功でも一時下書きを消す', async type => {
  const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
  const kind = type === 'template' ? 'message' : 'tag'
  const content = type === 'template' ? { kind, name: '架空の保存中', messageType: 'text', messageContent: '架空本文' } : { kind, name: '架空の保存中', definition: { schemaVersion: 1, tag: { name: '架空の保存中', color: '#2563eb' }, folders: [] } }
  const key = `lh_hq_create_draft_v1:tenant-a:owner:${type}:${kind}`
  persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, type, kind, content)
  let complete!: () => void
  calls.create.mockImplementation(input => new Promise(resolve => { complete = () => resolve({ template: { ...detail().template, template_type: type, name: input.name }, definition: input.definition }) }))
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  const view = render(<HqTemplatesV8 type={type} />)
  await screen.findByDisplayValue('架空の保存中')
  fireEvent.click(await findPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(calls.create).toHaveBeenCalled())
  view.unmount()
  await act(async () => { complete() })
  expect(window.sessionStorage.getItem(key)).toBeNull()
})

it('壊れた一時下書きは破棄し、新規画面でも失敗通知を残す', async () => {
  window.sessionStorage.setItem('lh_hq_create_draft_v1:tenant-a:owner:template:message', '{broken')
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByText(/一時保存できなかった入力があります/)).toBeTruthy()
  expect((await screen.findByLabelText('テンプレート名') as HTMLInputElement).value).toBe('')
})
it('容量超過の新入力は古い内容を残さず画面で知らせる', async () => {
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  const name = await screen.findByLabelText('テンプレート名')
  fireEvent.change(name, { target: { value: '架空の旧入力' } })
  const key = 'lh_hq_create_draft_v1:tenant-a:owner:template:message'
  await waitFor(() => expect(window.sessionStorage.getItem(key)).toContain('架空の旧入力'))
  const setItem = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => { throw new Error('artificial quota') })
  try {
    fireEvent.change(name, { target: { value: '架空の最新入力' } })
    expect(await screen.findByText(/一時保存できなかった入力があります/)).toBeTruthy()
    expect(window.sessionStorage.getItem(key)).toBeNull()
  } finally { setItem.mockRestore() }
})
it('クーポンの空の割引額と未完成期間をそのまま復元し、保存では検査する', async () => {
  const view = render(<HqTemplatesV8 type="template" />)
  fireEvent.click(await screen.findByRole('tab', { name: /クーポン/ }))
  fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
  fireEvent.change(await screen.findByLabelText('テンプレート名'), { target: { value: '架空の未完成特典' } })
  fireEvent.change(screen.getByLabelText('クーポン名'), { target: { value: '架空の特典' } })
  fireEvent.click(screen.getByLabelText('クーポンタイプ'))
  fireEvent.click(screen.getByRole('button', { name: '割引', exact: true }))
  fireEvent.change(screen.getByLabelText('割引額'), { target: { value: '500' } })
  fireEvent.change(screen.getByLabelText('割引額'), { target: { value: '' } })
  view.unmount()
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  render(<HqTemplatesV8 type="template" />)
  await screen.findByDisplayValue('架空の未完成特典')
  expect((screen.getByLabelText('割引額') as HTMLInputElement).value).toBe('')
  fireEvent.click(await findPageAction({ name: '下書きを保存' }))
  expect(calls.create).not.toHaveBeenCalled()
})

it('本文未入力でもフォルダだけの変更を記録し、再読込で戻す', async () => {
  window.history.replaceState(null, '', '/hq/templates?mode=create')
  const view = render(<HqTemplatesV8 type="template" />)
  await screen.findByLabelText('テンプレート名')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ' }))
  fireEvent.click(within(await screen.findByRole('option', { name: '予約' })).getByRole('button'))
  const key = 'lh_hq_create_draft_v1:tenant-a:owner:template:message'
  await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(key)!).draft.folderId).toBe('f-1'))
  view.unmount()
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByRole('button', { name: 'フォルダ' })).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('予約'))
})


describe('H-18 必須再レビュー修正', () => {
  it('空名でもフォルダ入力のあるタグ下書きを再読込で消さない', async () => {
    const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
    const key = 'lh_hq_create_draft_v1:tenant-a:owner:tag:tag'
    const definition = { schemaVersion: 1, tag: { name: '', folderId: 'f-1' }, folders: [{ id: 'f-1', name: '架空フォルダ' }] }
    persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'tag', 'tag', { kind: 'tag', name: '', definition })
    window.history.replaceState(null, '', '/hq/templates?mode=create')
    render(<HqTemplatesV8 type="tag" />)
    await screen.findByLabelText('タグ名')
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toContain('f-1'))
    expect((screen.getByLabelText('タグ名') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: '所属フォルダ' }).textContent).toContain('予約')
  })

  it.each(['下書きを保存', '保存する'])('削除済みフォルダのタグ下書きを未分類で%s', async (label) => {
    const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
    const definition = { schemaVersion: 1, tag: { name: '架空の復元タグ', folderId: 'f-gone' }, folders: [{ id: 'f-gone', name: '架空の削除済み' }] }
    persistEditorDraft(window.sessionStorage, { tenantId: 'tenant-a', actorId: 'owner' }, 'tag', 'tag', { kind: 'tag', name: '架空の復元タグ', definition })
    window.history.replaceState(null, '', '/hq/templates?mode=create')
    render(<HqTemplatesV8 type="tag" />)
    await screen.findByDisplayValue('架空の復元タグ')
    fireEvent.click(await findPageAction({ name: label }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    expect(calls.create.mock.calls[0][0].folderId).toBeNull()
  })
})
